//! Brotli streaming compression and decompression.

use std::io::Write;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use brotli::enc::writer::CompressorWriterCustomAlloc;
use brotli::enc::{Allocator, BrotliAlloc, SliceWrapper, StandardAlloc};
use brotli::{BrotliDecompressStream, BrotliResult, BrotliState};

use crate::brotli::{BUFFER_SIZE, DEFAULT_QUALITY, LG_WINDOW_SIZE, QUALITY};
use crate::limited::LimitedVec;
use crate::{ComprsError, MemoryUsage};

/// Allocator for the brotli encoder and decoder states that counts the bytes
/// they hold, which the brotli crate does not report otherwise. Clones share
/// the count.
///
/// The states take all their memory from the allocator and return it with
/// `free_cell`, so the count follows them as they grow: the encoder holds a
/// few kilobytes before the first block and tens of megabytes at high
/// qualities, the decoder sizes its ring buffer from the stream's window.
#[derive(Clone, Default)]
struct CountingAlloc {
    allocated: Arc<AtomicUsize>,
}

impl CountingAlloc {
    /// Bytes allocated and not freed yet.
    fn allocated(&self) -> usize {
        self.allocated.load(Ordering::Relaxed)
    }

    fn add(&self, bytes: usize) {
        self.allocated.fetch_add(bytes, Ordering::Relaxed);
    }
}

impl<T: Clone + Default> Allocator<T> for CountingAlloc {
    type AllocatedMemory = <StandardAlloc as Allocator<T>>::AllocatedMemory;

    fn alloc_cell(&mut self, len: usize) -> Self::AllocatedMemory {
        self.add(len.saturating_mul(size_of::<T>()));
        StandardAlloc::default().alloc_cell(len)
    }

    fn free_cell(&mut self, data: Self::AllocatedMemory) {
        let bytes = size_of_val(data.slice());
        // Saturate rather than wrap should a state ever free memory that it
        // did not allocate here.
        let _ = self
            .allocated
            .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |allocated| {
                Some(allocated.saturating_sub(bytes))
            });
    }
}

impl BrotliAlloc for CountingAlloc {}

type Compressor = CompressorWriterCustomAlloc<
    Vec<u8>,
    <CountingAlloc as Allocator<u8>>::AllocatedMemory,
    CountingAlloc,
>;

/// Streaming brotli compression context.
pub struct CompressContext {
    compressor: Option<Compressor>,
    /// Shares its count with the compressor's allocator.
    alloc: CountingAlloc,
}

impl CompressContext {
    pub fn new(quality: Option<u32>) -> Result<Self, ComprsError> {
        let quality = QUALITY.check(quality.unwrap_or(DEFAULT_QUALITY))?;
        let mut alloc = CountingAlloc::default();
        let buffer = <CountingAlloc as Allocator<u8>>::alloc_cell(&mut alloc, BUFFER_SIZE);
        let compressor =
            Compressor::new(Vec::new(), buffer, alloc.clone(), quality, LG_WINDOW_SIZE);
        Ok(Self {
            compressor: Some(compressor),
            alloc,
        })
    }

    pub fn transform(&mut self, chunk: &[u8]) -> Result<Vec<u8>, ComprsError> {
        let compressor = self
            .compressor
            .as_mut()
            .ok_or(ComprsError::StreamFinished("brotli stream"))?;

        compressor
            .write_all(chunk)
            .map_err(|e| ComprsError::Operation {
                context: "brotli stream compress",
                source: e.into(),
            })?;

        // Drain whatever the compressor has flushed to the inner Vec
        let data = std::mem::take(compressor.get_mut());
        Ok(data)
    }

    pub fn flush(&mut self) -> Result<Vec<u8>, ComprsError> {
        let compressor = self
            .compressor
            .as_mut()
            .ok_or(ComprsError::StreamFinished("brotli stream"))?;

        compressor.flush().map_err(|e| ComprsError::Operation {
            context: "brotli stream flush",
            source: e.into(),
        })?;

        let data = std::mem::take(compressor.get_mut());
        Ok(data)
    }

    pub fn finish(&mut self) -> Result<Vec<u8>, ComprsError> {
        let compressor = self
            .compressor
            .take()
            .ok_or(ComprsError::StreamFinished("brotli stream"))?;

        // into_inner drops the CompressorWriter, which flushes remaining data
        // and writes the brotli stream end marker
        Ok(compressor.into_inner())
    }
}

impl MemoryUsage for CompressContext {
    fn memory_usage(&self) -> usize {
        self.compressor.as_ref().map_or(0, |compressor| {
            self.alloc.allocated() + compressor.get_ref().capacity()
        })
    }
}

/// Streaming brotli decompression context.
pub struct DecompressContext {
    inner: StreamDecoder,
}

impl DecompressContext {
    pub fn new(max_output_size: Option<f64>) -> Result<Self, ComprsError> {
        let max_size = crate::validate_max_output_size(max_output_size)?;
        Ok(Self {
            inner: StreamDecoder::new(
                Vec::new(),
                LimitedVec::new(max_size, "brotli stream decompress"),
                "brotli stream",
            ),
        })
    }

    pub fn transform(&mut self, chunk: &[u8]) -> Result<Vec<u8>, ComprsError> {
        self.inner.decompress(chunk, "brotli stream decompress")
    }

    pub fn flush(&mut self) -> Result<Vec<u8>, ComprsError> {
        self.inner.decompress(&[], "brotli stream flush")
    }

    /// Finalize the decompression stream, returning any remaining output.
    ///
    /// Fails with [`ComprsError::Truncated`] unless the input contained the
    /// complete brotli stream.
    pub fn finish(&mut self) -> Result<Vec<u8>, ComprsError> {
        self.inner.finish("brotli stream finish")
    }
}

impl MemoryUsage for DecompressContext {
    fn memory_usage(&self) -> usize {
        self.inner.memory_usage()
    }
}

/// Streaming brotli compression context with custom dictionary.
///
/// Buffers all input and compresses with the dictionary on `finish`.
/// This is necessary because the brotli CompressorWriter does not expose
/// a dictionary API; dictionary compression requires the low-level encoder.
pub struct CompressDictContext {
    dict: Option<Vec<u8>>,
    quality: u32,
    chunks: Vec<u8>,
}

impl CompressDictContext {
    pub fn new(dict: &[u8], quality: Option<u32>) -> Result<Self, ComprsError> {
        let quality = QUALITY.check(quality.unwrap_or(DEFAULT_QUALITY))?;
        Ok(Self {
            dict: Some(dict.to_vec()),
            quality,
            chunks: Vec::new(),
        })
    }

    /// Buffer a chunk of data for compression. Returns an empty Vec because
    /// all compression is deferred to `finish` (dictionary requires one-shot).
    pub fn transform(&mut self, chunk: &[u8]) -> Result<Vec<u8>, ComprsError> {
        if self.dict.is_none() {
            return Err(ComprsError::StreamFinished("brotli dict stream"));
        }
        self.chunks.extend_from_slice(chunk);
        Ok(Vec::new())
    }

    /// Flush returns empty Vec because all data is buffered until finish.
    pub fn flush(&mut self) -> Result<Vec<u8>, ComprsError> {
        if self.dict.is_none() {
            return Err(ComprsError::StreamFinished("brotli dict stream"));
        }
        Ok(Vec::new())
    }

    /// Finalize the compression. Compresses all buffered data with the dictionary.
    pub fn finish(&mut self) -> Result<Vec<u8>, ComprsError> {
        let dict = self
            .dict
            .take()
            .ok_or(ComprsError::StreamFinished("brotli dict stream"))?;

        let data = std::mem::take(&mut self.chunks);
        crate::brotli::compress_with_dict_inner(&data, &dict, self.quality).map_err(|e| {
            ComprsError::Operation {
                context: "brotli dict stream compress",
                source: e.into(),
            }
        })
    }
}

impl MemoryUsage for CompressDictContext {
    /// The dictionary and the buffered input. The encoder only exists while
    /// `finish` runs.
    fn memory_usage(&self) -> usize {
        self.dict.as_ref().map_or(0, Vec::capacity) + self.chunks.capacity()
    }
}

/// Streaming brotli decompression context with custom dictionary.
pub struct DecompressDictContext {
    inner: StreamDecoder,
}

impl DecompressDictContext {
    pub fn new(dict: &[u8], max_output_size: Option<f64>) -> Result<Self, ComprsError> {
        let max_size = crate::validate_max_output_size(max_output_size)?;
        Ok(Self {
            inner: StreamDecoder::new(
                dict.to_vec(),
                LimitedVec::new(max_size, "brotli dict stream decompress"),
                "brotli dict stream",
            ),
        })
    }

    pub fn transform(&mut self, chunk: &[u8]) -> Result<Vec<u8>, ComprsError> {
        self.inner
            .decompress(chunk, "brotli dict stream decompress")
    }

    pub fn flush(&mut self) -> Result<Vec<u8>, ComprsError> {
        self.inner.decompress(&[], "brotli dict stream flush")
    }

    /// Finalize the decompression stream, returning any remaining output.
    ///
    /// Fails with [`ComprsError::Truncated`] unless the input contained the
    /// complete brotli stream.
    pub fn finish(&mut self) -> Result<Vec<u8>, ComprsError> {
        self.inner.finish("brotli dict stream finish")
    }
}

impl MemoryUsage for DecompressDictContext {
    fn memory_usage(&self) -> usize {
        self.inner.memory_usage()
    }
}

type DecoderState = BrotliState<CountingAlloc, CountingAlloc, CountingAlloc>;

/// A decoder state with the custom dictionary `dict` (empty for none), whose
/// allocations `alloc` counts.
fn decoder_state(dict: Vec<u8>, alloc: &CountingAlloc) -> DecoderState {
    // The state owns the dictionary and frees it with the allocator.
    alloc.add(dict.len());
    let mut state = DecoderState::new_with_custom_dictionary(
        alloc.clone(),
        alloc.clone(),
        alloc.clone(),
        dict.into(),
    );
    // Decode RFC 7932 streams only: see `crate::brotli::reject_large_window`.
    state.large_window = false;
    state
}

/// Most output that one decoder call of [`decompress_all`] writes. The
/// output buffer is zeroed just before the decoder writes to it, a part of
/// this size at a time, so the zeroed part is still in the cache when the
/// decoder overwrites it.
const DECOMPRESS_ALL_CHUNK: usize = 64 * 1024;

/// Decompress the brotli stream at the start of `input`, with the custom
/// dictionary `dict` (empty for none), in one call.
///
/// The decoder gets all of `input` at once, so it sees how much output a
/// stream shorter than its window holds and sizes its ring buffer for that
/// rather than for the whole window (4 MiB at the default window size). It
/// writes straight into the output buffer, which starts with room for four
/// times the input and grows geometrically, but never past
/// `max_output_size` plus one byte. A failure to allocate that first
/// buffer is reported as an error, as in [`crate::decompress_with_limit`].
///
/// Like `brotli::Decompressor`, it ignores data after the end of the stream
/// and fails with "Invalid Data" on invalid and on truncated input; `context`
/// prefixes the errors. Exceeding `max_output_size` fails with
/// [`ComprsError::SizeLimit`].
pub(crate) fn decompress_all(
    input: &[u8],
    dict: Vec<u8>,
    max_output_size: usize,
    context: &'static str,
) -> Result<Vec<u8>, ComprsError> {
    let mut output = LimitedVec::new(max_output_size, context);
    output
        .try_reserve(input.len().saturating_mul(4))
        .map_err(|e| ComprsError::Operation {
            context,
            source: e.into(),
        })?;
    let mut state = decoder_state(dict, &CountingAlloc::default());
    let mut available_in = input.len();
    let mut input_offset = 0;
    let mut total_out = 0;
    loop {
        let result = output
            .append_with(input.len().saturating_mul(4), |buf| {
                let start = buf.len();
                let mut available_out = (buf.capacity() - start).min(DECOMPRESS_ALL_CHUNK);
                buf.resize(start + available_out, 0);
                let mut output_offset = start;
                let result = BrotliDecompressStream(
                    &mut available_in,
                    &mut input_offset,
                    input,
                    &mut available_out,
                    &mut output_offset,
                    buf,
                    &mut total_out,
                    &mut state,
                );
                buf.truncate(output_offset);
                Ok(result)
            })
            .map_err(|e| output.error(e, context))?;
        match result {
            BrotliResult::NeedsMoreOutput => {}
            BrotliResult::ResultSuccess => return Ok(crate::finish_output(output.take())),
            BrotliResult::NeedsMoreInput | BrotliResult::ResultFailure => {
                return Err(ComprsError::Operation {
                    context,
                    source: std::io::Error::new(std::io::ErrorKind::InvalidData, "Invalid Data")
                        .into(),
                });
            }
        }
    }
}

/// Decoder state shared by [`DecompressContext`] and [`DecompressDictContext`].
///
/// Drives `BrotliDecompressStream` directly rather than through
/// `brotli::DecompressorWriter`, whose `close()` cannot tell a complete stream
/// from one whose error it has already reported.
struct StreamDecoder {
    /// `None` once the stream is finished.
    state: Option<DecoderState>,
    /// Shares its count with the allocators of `state`.
    alloc: CountingAlloc,
    /// Buffer each decoder call fills before its output moves to `output`.
    buffer: Vec<u8>,
    total_out: usize,
    output: LimitedVec,
    /// Whether the decoder has reached the end of the brotli stream.
    ended: bool,
    /// Name reported by [`ComprsError::StreamFinished`].
    name: &'static str,
}

impl StreamDecoder {
    fn new(dict: Vec<u8>, output: LimitedVec, name: &'static str) -> Self {
        let alloc = CountingAlloc::default();
        Self {
            state: Some(decoder_state(dict, &alloc)),
            alloc,
            buffer: vec![0; BUFFER_SIZE],
            total_out: 0,
            output,
            ended: false,
            name,
        }
    }

    /// Decompress `input`, returning all output that is available so far.
    /// An empty `input` only drains the decoder.
    fn decompress(&mut self, input: &[u8], context: &'static str) -> Result<Vec<u8>, ComprsError> {
        let state = self
            .state
            .as_mut()
            .ok_or(ComprsError::StreamFinished(self.name))?;

        let mut available_in = input.len();
        let mut input_offset = 0;
        loop {
            let mut available_out = self.buffer.len();
            let mut output_offset = 0;
            let result = BrotliDecompressStream(
                &mut available_in,
                &mut input_offset,
                input,
                &mut available_out,
                &mut output_offset,
                &mut self.buffer,
                &mut self.total_out,
                state,
            );
            self.output
                .write_all(&self.buffer[..output_offset])
                .map_err(|e| self.output.error(e, context))?;
            match result {
                BrotliResult::NeedsMoreOutput => {}
                BrotliResult::NeedsMoreInput => break,
                BrotliResult::ResultSuccess => {
                    self.ended = true;
                    if input_offset < input.len() {
                        return Err(ComprsError::Operation {
                            context,
                            source: "unexpected data after the end of the stream".into(),
                        });
                    }
                    break;
                }
                BrotliResult::ResultFailure => {
                    return Err(ComprsError::Operation {
                        context,
                        source: "Invalid Data".into(),
                    });
                }
            }
        }

        Ok(self.output.take())
    }

    /// Drain the decoder and end the stream, failing unless the decoder
    /// reached the end of the brotli stream.
    fn finish(&mut self, context: &'static str) -> Result<Vec<u8>, ComprsError> {
        let output = self.decompress(&[], context);
        self.state = None;
        let output = output?;
        if !self.ended {
            return Err(ComprsError::Truncated("brotli"));
        }
        Ok(output)
    }

    /// The memory of the decoder state, including its ring buffer and the
    /// dictionary, and of the output buffers.
    fn memory_usage(&self) -> usize {
        self.alloc.allocated() + self.buffer.capacity() + self.output.capacity()
    }
}

#[cfg(test)]
mod tests {
    use super::{CompressContext, CompressDictContext, DecompressContext, DecompressDictContext};
    use crate::brotli::BUFFER_SIZE;
    use crate::{ComprsError, MemoryUsage};

    /// Decompression limit used by the size-limit tests.
    const LIMIT: usize = 64 * 1024;

    /// 8 MiB of zeros compress to a few hundred bytes: one chunk that
    /// expands more than 10,000x.
    fn bomb(dict: &[u8]) -> Vec<u8> {
        crate::brotli::compress_with_dict(&vec![0u8; 8 * 1024 * 1024], dict, Some(1)).unwrap()
    }

    #[test]
    fn decompress_context_stops_inflating_at_the_limit() {
        let mut ctx = DecompressContext::new(Some(LIMIT as f64)).unwrap();

        let err = ctx.transform(&bomb(&[])).unwrap_err();
        assert_eq!(
            err.to_string(),
            "brotli stream decompress exceeded maximum size of 65536 bytes"
        );
        // The output never grew past the limit (brotli adds one 4 KiB buffer).
        assert!(ctx.inner.output.capacity() <= LIMIT);
    }

    #[test]
    fn decompress_dict_context_stops_inflating_at_the_limit() {
        let dict = b"a small custom dictionary";
        let mut ctx = DecompressDictContext::new(dict, Some(LIMIT as f64)).unwrap();

        let err = ctx.transform(&bomb(dict)).unwrap_err();
        assert_eq!(
            err.to_string(),
            "brotli dict stream decompress exceeded maximum size of 65536 bytes"
        );
        assert!(ctx.inner.output.capacity() <= LIMIT);
    }

    /// Decompress `input` in chunks of `chunk_size` bytes, then finish.
    fn decompress_all(
        ctx: &mut DecompressContext,
        input: &[u8],
        chunk_size: usize,
    ) -> Result<Vec<u8>, ComprsError> {
        let mut output = Vec::new();
        for chunk in input.chunks(chunk_size) {
            output.extend(ctx.transform(chunk)?);
        }
        output.extend(ctx.flush()?);
        output.extend(ctx.finish()?);
        Ok(output)
    }

    /// 256 KiB of text-like data that brotli compresses well.
    fn text() -> Vec<u8> {
        (0..256 * 1024u32)
            .map(|i| b"lorem ipsum dolor sit amet "[(i * 7 % 27) as usize])
            .collect()
    }

    #[test]
    fn compress_context_reports_the_encoder_state() {
        let mut fast = CompressContext::new(Some(1)).unwrap();
        let mut strong = CompressContext::new(Some(9)).unwrap();
        let empty = strong.memory_usage();
        assert!(empty < 64 * 1024, "{empty} bytes");

        // The encoder allocates its ring buffer and hash tables as data
        // arrives, more of them at higher qualities.
        let data = text();
        fast.transform(&data).unwrap();
        strong.transform(&data).unwrap();
        assert!(
            fast.memory_usage() > data.len(),
            "{} bytes",
            fast.memory_usage()
        );
        assert!(
            strong.memory_usage() > 4 * fast.memory_usage(),
            "{} bytes at quality 9, {} at quality 1",
            strong.memory_usage(),
            fast.memory_usage()
        );

        strong.finish().unwrap();
        assert_eq!(strong.memory_usage(), 0);
        // The encoder returned all its memory to the allocator, except the
        // buffer of the writer, which drops it.
        assert_eq!(strong.alloc.allocated(), BUFFER_SIZE);
    }

    #[test]
    fn compress_dict_context_reports_the_buffered_input() {
        let dict = b"brotli dictionary ".repeat(100);
        let mut ctx = CompressDictContext::new(&dict, None).unwrap();
        ctx.transform(&text()).unwrap();
        assert!(ctx.memory_usage() >= dict.len() + text().len());
        ctx.finish().unwrap();
        assert_eq!(ctx.memory_usage(), 0);
    }

    #[test]
    fn decompress_context_reports_the_ring_buffer() {
        let data = text();
        let compressed = crate::brotli::compress(&data, None).unwrap();
        let mut ctx = DecompressContext::new(None).unwrap();
        let empty = ctx.memory_usage();

        assert_eq!(ctx.transform(&compressed).unwrap(), data);
        // The ring buffer holds up to a window of output.
        assert!(ctx.memory_usage() > empty + data.len());

        ctx.finish().unwrap();
        // Dropping the state returned all its memory to the allocator.
        assert_eq!(ctx.inner.alloc.allocated(), 0);
    }

    #[test]
    fn decompress_dict_context_reports_the_dictionary() {
        let dict = b"brotli dictionary ".repeat(1000);
        let compressed = crate::brotli::compress_with_dict(&dict, &dict, None).unwrap();
        let mut ctx = DecompressDictContext::new(&dict, None).unwrap();
        assert!(ctx.memory_usage() >= dict.len());

        assert_eq!(ctx.transform(&compressed).unwrap(), dict);
        ctx.finish().unwrap();
        assert_eq!(ctx.inner.alloc.allocated(), 0);
    }

    #[test]
    fn decompress_context_finishes_complete_streams() {
        let original = b"complete brotli stream ".repeat(500);
        let compressed = crate::brotli::compress(&original, None).unwrap();
        for chunk_size in [1, 7, compressed.len()] {
            let mut ctx = DecompressContext::new(None).unwrap();
            let output = decompress_all(&mut ctx, &compressed, chunk_size).unwrap();
            assert_eq!(output, original, "chunk size {chunk_size}");
        }
    }

    #[test]
    fn decompress_context_rejects_truncated_input() {
        let compressed = crate::brotli::compress(&b"truncated brotli ".repeat(500), None).unwrap();
        for len in [0, 1, compressed.len() / 2, compressed.len() - 1] {
            let mut ctx = DecompressContext::new(None).unwrap();
            let err = decompress_all(&mut ctx, &compressed[..len], 64).unwrap_err();
            assert_eq!(
                err.to_string(),
                "brotli stream is truncated: unexpected end of input",
                "input of {len} bytes"
            );
        }
    }

    #[test]
    fn decompress_dict_context_rejects_truncated_input() {
        let dict = b"brotli dictionary content ".repeat(20);
        let original = b"brotli dictionary content, compressed ".repeat(20);
        let compressed = crate::brotli::compress_with_dict(&original, &dict, None).unwrap();

        let mut ctx = DecompressDictContext::new(&dict, None).unwrap();
        let mut output = ctx.transform(&compressed).unwrap();
        output.extend(ctx.finish().unwrap());
        assert_eq!(output, original);

        let mut ctx = DecompressDictContext::new(&dict, None).unwrap();
        ctx.transform(&compressed[..compressed.len() - 1]).unwrap();
        assert!(matches!(
            ctx.finish(),
            Err(ComprsError::Truncated("brotli"))
        ));
    }

    #[test]
    fn decompress_contexts_reject_large_window_streams() {
        let compressed =
            crate::brotli::compress_large_window(&b"large window brotli ".repeat(50), 30);
        let dict = b"brotli dictionary";
        for chunk_size in [1, compressed.len()] {
            let mut ctx = DecompressContext::new(None).unwrap();
            let err = compressed
                .chunks(chunk_size)
                .find_map(|chunk| ctx.transform(chunk).err())
                .expect("a large-window stream decoded");
            assert_eq!(
                err.to_string(),
                "brotli stream decompress failed: Invalid Data",
                "chunk size {chunk_size}"
            );

            let mut ctx = DecompressDictContext::new(dict, None).unwrap();
            let err = compressed
                .chunks(chunk_size)
                .find_map(|chunk| ctx.transform(chunk).err())
                .expect("a large-window stream decoded");
            assert_eq!(
                err.to_string(),
                "brotli dict stream decompress failed: Invalid Data",
                "chunk size {chunk_size}"
            );
        }
    }

    #[test]
    fn decompress_context_rejects_data_after_the_stream() {
        let mut input = crate::brotli::compress(b"complete", None).unwrap();
        input.extend(b"trailing");
        let mut ctx = DecompressContext::new(None).unwrap();
        let err = ctx.transform(&input).unwrap_err();
        assert_eq!(
            err.to_string(),
            "brotli stream decompress failed: unexpected data after the end of the stream"
        );
    }

    #[test]
    fn decompress_context_does_not_finish_after_invalid_data() {
        let mut ctx = DecompressContext::new(None).unwrap();
        assert!(ctx.transform(&[0xff; 16]).is_err());
        assert!(ctx.finish().is_err());
    }

    #[test]
    fn decompress_context_cannot_be_used_after_finish() {
        let compressed = crate::brotli::compress(b"finished", None).unwrap();
        let mut ctx = DecompressContext::new(None).unwrap();
        ctx.transform(&compressed).unwrap();
        ctx.finish().unwrap();
        assert!(matches!(
            ctx.transform(&compressed),
            Err(ComprsError::StreamFinished("brotli stream"))
        ));
        assert!(matches!(ctx.finish(), Err(ComprsError::StreamFinished(_))));
    }

    #[test]
    fn decompress_context_accepts_output_at_the_limit() {
        let data = vec![7u8; LIMIT];
        let compressed = crate::brotli::compress(&data, None).unwrap();
        let mut ctx = DecompressContext::new(Some(LIMIT as f64)).unwrap();
        let mut output = ctx.transform(&compressed).unwrap();
        output.extend(ctx.flush().unwrap());
        assert_eq!(output, data);
    }

    /// The dictionary stream compresses on `finish` through the same encoder
    /// path as `compress_with_dict`, so it hits the same brotli 9.0.0 panic.
    #[test]
    fn compress_dict_context_survives_encoder_panic() {
        let data = [
            255, 164, 251, 255, 255, 240, 7, 0, 0, 0, 0, 0, 0, 0, 0, 41, 103, 0, 14,
        ];
        let dict = [254, 255];
        let mut ctx = super::CompressDictContext::new(&dict, None).unwrap();
        assert!(ctx.transform(&data).unwrap().is_empty());
        let compressed = ctx.finish().unwrap();
        let decompressed = crate::brotli::decompress_with_dict(&compressed, &dict).unwrap();
        assert_eq!(decompressed, data);
    }
}
