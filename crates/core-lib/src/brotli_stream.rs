//! Brotli streaming compression and decompression.

use std::io::Write;

use brotli::enc::StandardAlloc;
use brotli::{BrotliDecompressStream, BrotliResult, BrotliState};

use crate::ComprsError;
use crate::brotli::{BUFFER_SIZE, DEFAULT_QUALITY, LG_WINDOW_SIZE, QUALITY};
use crate::limited::LimitedVec;

/// Streaming brotli compression context.
pub struct CompressContext {
    compressor: Option<brotli::CompressorWriter<Vec<u8>>>,
}

impl CompressContext {
    pub fn new(quality: Option<u32>) -> Result<Self, ComprsError> {
        let quality = QUALITY.check(quality.unwrap_or(DEFAULT_QUALITY))?;
        let compressor =
            brotli::CompressorWriter::new(Vec::new(), BUFFER_SIZE, quality, LG_WINDOW_SIZE);
        Ok(Self {
            compressor: Some(compressor),
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

type DecoderState = BrotliState<StandardAlloc, StandardAlloc, StandardAlloc>;

/// Decoder state shared by [`DecompressContext`] and [`DecompressDictContext`].
///
/// Drives `BrotliDecompressStream` directly rather than through
/// `brotli::DecompressorWriter`, whose `close()` cannot tell a complete stream
/// from one whose error it has already reported.
struct StreamDecoder {
    /// `None` once the stream is finished.
    state: Option<DecoderState>,
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
        let state = DecoderState::new_with_custom_dictionary(
            StandardAlloc::default(),
            StandardAlloc::default(),
            StandardAlloc::default(),
            dict.into(),
        );
        Self {
            state: Some(state),
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
}

#[cfg(test)]
mod tests {
    use std::io::{Read, Write};

    use super::{DecompressContext, DecompressDictContext};
    use crate::ComprsError;
    use crate::brotli::{BUFFER_SIZE, DEFAULT_QUALITY, LG_WINDOW_SIZE};

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

    #[test]
    fn stream_round_trip() {
        let original = b"Hello, comprs streaming! ".repeat(100);

        // Compress in chunks using CompressorWriter<Vec<u8>>
        let mut compressor =
            brotli::CompressorWriter::new(Vec::new(), BUFFER_SIZE, DEFAULT_QUALITY, LG_WINDOW_SIZE);
        for chunk in original.chunks(256) {
            compressor.write_all(chunk).unwrap();
        }
        let compressed = compressor.into_inner();

        // Decompress using Decompressor
        let mut decompressor = brotli::Decompressor::new(compressed.as_slice(), BUFFER_SIZE);
        let mut decompressed = Vec::new();
        decompressor.read_to_end(&mut decompressed).unwrap();

        assert_eq!(original.as_slice(), decompressed.as_slice());
    }

    #[test]
    fn stream_empty_input() {
        let compressor =
            brotli::CompressorWriter::new(Vec::new(), BUFFER_SIZE, DEFAULT_QUALITY, LG_WINDOW_SIZE);
        let compressed = compressor.into_inner();

        // Should produce a valid (empty) brotli stream
        assert!(!compressed.is_empty());

        let mut decompressor = brotli::Decompressor::new(compressed.as_slice(), BUFFER_SIZE);
        let mut decompressed = Vec::new();
        decompressor.read_to_end(&mut decompressed).unwrap();
        assert!(decompressed.is_empty());
    }

    #[test]
    fn stream_decompressor_writer_round_trip() {
        let original = b"DecompressorWriter test data ".repeat(100);

        // Compress
        let mut compressor =
            brotli::CompressorWriter::new(Vec::new(), BUFFER_SIZE, DEFAULT_QUALITY, LG_WINDOW_SIZE);
        compressor.write_all(&original).unwrap();
        let compressed = compressor.into_inner();

        // Decompress in chunks using DecompressorWriter<Vec<u8>>
        let mut decompressor = brotli::DecompressorWriter::new(Vec::new(), BUFFER_SIZE);
        for chunk in compressed.chunks(64) {
            decompressor.write_all(chunk).unwrap();
        }
        decompressor.flush().unwrap();
        let decompressed = decompressor.into_inner().unwrap();

        assert_eq!(original.as_slice(), decompressed.as_slice());
    }
}
