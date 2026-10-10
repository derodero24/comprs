//! gzip, zlib and raw deflate streaming compression and decompression.

use std::io::{self, Write};

use flate2::Compression;
use flate2::write::{DeflateEncoder, GzEncoder, MultiGzDecoder, ZlibEncoder};

use crate::gzip::{
    self, DEFAULT_LEVEL, DEFLATE_LEVEL, FlateWrapper, GzipHeaderOptions, Inflater, LEVEL,
    StrictDecoder,
};
use crate::limited::LimitedVec;
use crate::{ComprsError, MemoryUsage};

// flate2 does not report the memory of its streams, but zlib-rs allocates a
// fixed amount for each, whatever the level and the data. The sizes below
// were measured with flate2 1.1.10 and zlib-rs 0.6.

/// Heap memory of a deflate stream: its 64 KiB window, hash chains and
/// pending output (371 KiB).
const DEFLATE_STATE_SIZE: usize = 380_032;

/// Heap memory of an inflate stream: its 32 KiB window and decoding tables.
const INFLATE_STATE_SIZE: usize = 47_552;

/// Buffer that flate2's `write` encoders and decoders keep.
const WRITER_BUFFER_SIZE: usize = 32 * 1024;

/// What the errors of a stream context call the stream and its operations.
struct Labels {
    /// The stream, for [`ComprsError::StreamFinished`].
    stream: &'static str,
    /// The error context of `transform`.
    transform: &'static str,
    flush: &'static str,
    finish: &'static str,
}

/// The [`Labels`] of the streams of the format named `$format`, whose
/// `transform` does `$operation`: "gzip stream", "gzip stream compress",
/// "gzip stream flush" and "gzip stream finish" for `labels!("gzip",
/// "compress")`.
macro_rules! labels {
    ($format:literal, $operation:literal) => {
        Labels {
            stream: concat!($format, " stream"),
            transform: concat!($format, " stream ", $operation),
            flush: concat!($format, " stream flush"),
            finish: concat!($format, " stream finish"),
        }
    };
}

/// Streaming gzip compression context.
pub struct GzipCompressContext {
    inner: FlateEncoder<GzEncoder<Vec<u8>>>,
}

impl GzipCompressContext {
    pub fn new(level: Option<u32>) -> Result<Self, ComprsError> {
        Self::with_header(level, &GzipHeaderOptions::default())
    }

    /// A context whose gzip header holds the fields of `header`, as
    /// [`gzip::compress_with_header`] writes them.
    pub fn with_header(
        level: Option<u32>,
        header: &GzipHeaderOptions,
    ) -> Result<Self, ComprsError> {
        let level = LEVEL.check(level.unwrap_or(DEFAULT_LEVEL))?;
        let encoder = gzip::header_builder(header)?.write(Vec::new(), Compression::new(level));
        Ok(Self {
            inner: FlateEncoder::new(encoder, labels!("gzip", "compress")),
        })
    }

    pub fn transform(&mut self, chunk: &[u8]) -> Result<Vec<u8>, ComprsError> {
        self.inner.transform(chunk)
    }

    pub fn flush(&mut self) -> Result<Vec<u8>, ComprsError> {
        self.inner.flush()
    }

    pub fn finish(&mut self) -> Result<Vec<u8>, ComprsError> {
        self.inner.finish()
    }
}

impl MemoryUsage for GzipCompressContext {
    fn memory_usage(&self) -> usize {
        self.inner.memory_usage()
    }
}

/// Streaming gzip decompression context.
pub struct GzipDecompressContext {
    decoder: Option<MultiGzDecoder<LimitedVec>>,
}

impl GzipDecompressContext {
    pub fn new(max_output_size: Option<f64>) -> Result<Self, ComprsError> {
        let max_size = crate::validate_max_output_size(max_output_size)?;
        let decoder = MultiGzDecoder::new(LimitedVec::new(max_size, "gzip stream decompress"));
        Ok(Self {
            decoder: Some(decoder),
        })
    }

    pub fn transform(&mut self, chunk: &[u8]) -> Result<Vec<u8>, ComprsError> {
        let decoder = self
            .decoder
            .as_mut()
            .ok_or(ComprsError::StreamFinished("gzip stream"))?;

        let mut pos = 0;
        while pos < chunk.len() {
            let n = decoder
                .write(&chunk[pos..])
                .map_err(|e| decoder.get_ref().error(e, "gzip stream decompress"))?;
            if n == 0 {
                break;
            }
            pos += n;
        }
        // The decoder keeps the output of its last write, up to 32 KiB, until
        // the next write: flush it, so that a chunk that ends mid-stream
        // returns all its output.
        decoder
            .flush()
            .map_err(|e| decoder.get_ref().error(e, "gzip stream decompress"))?;

        Ok(decoder.get_mut().take())
    }

    pub fn flush(&mut self) -> Result<Vec<u8>, ComprsError> {
        let decoder = self
            .decoder
            .as_mut()
            .ok_or(ComprsError::StreamFinished("gzip stream"))?;

        decoder
            .flush()
            .map_err(|e| decoder.get_ref().error(e, "gzip stream flush"))?;

        Ok(decoder.get_mut().take())
    }

    /// Finalize the decompression stream, returning any remaining output and
    /// verifying the CRC32 and size of the last member.
    ///
    /// Fails with [`ComprsError::Truncated`] when the input ended before the
    /// header of a member was complete, including empty input. Input that
    /// ends later in a member fails with flate2's checksum error, a
    /// [`ComprsError::Corrupt`]: `MultiGzDecoder` reports a missing trailer
    /// as it reports a mismatching one.
    pub fn finish(&mut self) -> Result<Vec<u8>, ComprsError> {
        let mut decoder = self
            .decoder
            .take()
            .ok_or(ComprsError::StreamFinished("gzip stream"))?;

        if decoder.header().is_none() {
            return Err(ComprsError::Truncated("gzip"));
        }
        decoder
            .try_finish()
            .map_err(|e| decoder.get_ref().error(e, "gzip stream finish"))?;

        Ok(decoder.get_mut().take())
    }
}

impl MemoryUsage for GzipDecompressContext {
    fn memory_usage(&self) -> usize {
        self.decoder.as_ref().map_or(0, |decoder| {
            INFLATE_STATE_SIZE + WRITER_BUFFER_SIZE + decoder.get_ref().capacity()
        })
    }
}

/// Streaming raw deflate compression context.
pub struct DeflateCompressContext {
    inner: FlateEncoder<DeflateEncoder<Vec<u8>>>,
}

impl DeflateCompressContext {
    pub fn new(level: Option<u32>) -> Result<Self, ComprsError> {
        let level = DEFLATE_LEVEL.check(level.unwrap_or(DEFAULT_LEVEL))?;
        let encoder = DeflateEncoder::new(Vec::new(), Compression::new(level));
        Ok(Self {
            inner: FlateEncoder::new(encoder, labels!("deflate", "compress")),
        })
    }

    pub fn transform(&mut self, chunk: &[u8]) -> Result<Vec<u8>, ComprsError> {
        self.inner.transform(chunk)
    }

    pub fn flush(&mut self) -> Result<Vec<u8>, ComprsError> {
        self.inner.flush()
    }

    pub fn finish(&mut self) -> Result<Vec<u8>, ComprsError> {
        self.inner.finish()
    }
}

impl MemoryUsage for DeflateCompressContext {
    fn memory_usage(&self) -> usize {
        self.inner.memory_usage()
    }
}

/// Streaming raw deflate decompression context.
pub struct DeflateDecompressContext {
    /// `None` once the stream is finished, or a call failed.
    inflater: Option<Inflater>,
    /// The error of a call that failed, which the later calls report again
    /// until `finish`.
    failed: Option<ComprsError>,
    output: LimitedVec,
}

impl DeflateDecompressContext {
    pub fn new(max_output_size: Option<f64>) -> Result<Self, ComprsError> {
        let max_size = crate::validate_max_output_size(max_output_size)?;
        Ok(Self {
            inflater: Some(Inflater::new(FlateWrapper::Raw)),
            failed: None,
            output: LimitedVec::new(max_size, "deflate stream decompress"),
        })
    }

    pub fn transform(&mut self, chunk: &[u8]) -> Result<Vec<u8>, ComprsError> {
        self.inflate(chunk, "deflate stream decompress")
    }

    pub fn flush(&mut self) -> Result<Vec<u8>, ComprsError> {
        self.inflate(&[], "deflate stream flush")
    }

    /// Finalize the decompression stream, returning any remaining output.
    ///
    /// Fails with [`ComprsError::Truncated`] unless the input contained the
    /// final block of the deflate stream, and with the error of an earlier
    /// call that failed. `finish` ends the stream whether it succeeds or
    /// not: every later call fails with [`ComprsError::StreamFinished`].
    pub fn finish(&mut self) -> Result<Vec<u8>, ComprsError> {
        if let Some(error) = self.failed.take() {
            return Err(error);
        }
        let output = self.inflate(&[], "deflate stream finish");
        let stream_end = self
            .inflater
            .take()
            .is_some_and(|inflater| inflater.stream_end());
        self.failed = None;
        let output = output?;
        if !stream_end {
            return Err(ComprsError::Truncated("deflate"));
        }
        Ok(output)
    }

    /// Inflate `input`, returning all the output of the input so far.
    ///
    /// An error leaves the context failed, as in a
    /// [`StrictDecompressContext`] (#712): the context drops its inflater
    /// and the output that the failed call decoded, and every later call
    /// fails with the same error. A `finish` after the error for data after
    /// the end of the stream would otherwise succeed, with the output
    /// decoded before that data.
    fn inflate(&mut self, input: &[u8], context: &'static str) -> Result<Vec<u8>, ComprsError> {
        if let Some(error) = &self.failed {
            return Err(error.duplicate());
        }
        let result = self.inflate_into_output(input, context);
        // A failed call drops its output and returns only the error.
        let output = self.output.take();
        match result {
            Ok(()) => Ok(output),
            Err(error) => {
                self.inflater = None;
                self.failed = Some(error.duplicate());
                Err(error)
            }
        }
    }

    fn inflate_into_output(
        &mut self,
        input: &[u8],
        context: &'static str,
    ) -> Result<(), ComprsError> {
        let inflater = self
            .inflater
            .as_mut()
            .ok_or(ComprsError::StreamFinished("deflate stream"))?;

        let consumed = inflater
            .inflate(input, &mut self.output)
            .map_err(|e| self.output.error(e, context))?;
        if consumed < input.len() {
            return Err(ComprsError::Corrupt {
                context,
                source: "unexpected data after the end of the stream".into(),
            });
        }
        Ok(())
    }
}

impl MemoryUsage for DeflateDecompressContext {
    fn memory_usage(&self) -> usize {
        self.inflater.as_ref().map_or(0, |_| INFLATE_STATE_SIZE) + self.output.capacity()
    }
}

/// Streaming zlib compression context: the format that the Compression
/// Streams standard calls `deflate`, as [`gzip::zlib_compress`] writes it.
pub struct ZlibCompressContext {
    inner: FlateEncoder<ZlibEncoder<Vec<u8>>>,
}

impl ZlibCompressContext {
    pub fn new(level: Option<u32>) -> Result<Self, ComprsError> {
        let level = DEFLATE_LEVEL.check(level.unwrap_or(DEFAULT_LEVEL))?;
        let encoder = ZlibEncoder::new(Vec::new(), Compression::new(level));
        Ok(Self {
            inner: FlateEncoder::new(encoder, labels!("deflate", "compress")),
        })
    }

    pub fn transform(&mut self, chunk: &[u8]) -> Result<Vec<u8>, ComprsError> {
        self.inner.transform(chunk)
    }

    pub fn flush(&mut self) -> Result<Vec<u8>, ComprsError> {
        self.inner.flush()
    }

    pub fn finish(&mut self) -> Result<Vec<u8>, ComprsError> {
        self.inner.finish()
    }
}

impl MemoryUsage for ZlibCompressContext {
    fn memory_usage(&self) -> usize {
        self.inner.memory_usage()
    }
}

/// Streaming decompression context for raw deflate, zlib or gzip, with the
/// rules of [`gzip::decompress_strict`]: data after the end of the stream
/// fails with [`ComprsError::Corrupt`], and [`StrictDecompressContext::finish`]
/// fails with [`ComprsError::Truncated`] unless the input ended at the end of
/// the stream. gzip input may hold several members.
///
/// Its errors name the format as [`FlateWrapper::format_name`] does.
///
/// An error leaves the context failed, as an error leaves a stream of the
/// Compression Streams standard errored: the context drops its decoder and
/// the output that the failed call decoded, and every later call fails with
/// the same error. A `finish` after the error for junk after the stream
/// would otherwise succeed, with the output decoded before the junk.
/// `finish` ends the stream, whether it succeeds or not: every later call
/// fails with [`ComprsError::StreamFinished`].
pub struct StrictDecompressContext {
    stream: StrictStream,
    output: LimitedVec,
    labels: Labels,
}

/// The state of a [`StrictDecompressContext`].
enum StrictStream {
    Decoding(StrictDecoder),
    /// A `transform` or `flush` call failed with this error, which the later
    /// calls report again.
    Failed(ComprsError),
    /// `finish` was called.
    Finished,
}

impl StrictDecompressContext {
    pub fn new(wrapper: FlateWrapper, max_output_size: Option<f64>) -> Result<Self, ComprsError> {
        let max_size = crate::validate_max_output_size(max_output_size)?;
        let labels = match wrapper {
            FlateWrapper::Raw => labels!("deflate-raw", "decompress"),
            FlateWrapper::Zlib => labels!("deflate", "decompress"),
            FlateWrapper::Gzip => labels!("gzip", "decompress"),
        };
        Ok(Self {
            stream: StrictStream::Decoding(StrictDecoder::new(wrapper)),
            output: LimitedVec::new(max_size, labels.transform),
            labels,
        })
    }

    pub fn transform(&mut self, chunk: &[u8]) -> Result<Vec<u8>, ComprsError> {
        self.inflate(chunk, self.labels.transform)
    }

    pub fn flush(&mut self) -> Result<Vec<u8>, ComprsError> {
        self.inflate(&[], self.labels.flush)
    }

    /// Finalize the decompression stream, returning any remaining output.
    ///
    /// Fails with [`ComprsError::Truncated`] unless the input ended at the
    /// end of the stream, or of a gzip member, and with the error of an
    /// earlier call that failed.
    pub fn finish(&mut self) -> Result<Vec<u8>, ComprsError> {
        // A finish that fails ends the stream as well.
        match std::mem::replace(&mut self.stream, StrictStream::Finished) {
            StrictStream::Decoding(mut decoder) => {
                let result = decoder
                    .inflate(&[], &mut self.output, self.labels.finish)
                    .and_then(|()| decoder.finish());
                // Taken whether or not the stream ended cleanly, so that a
                // failed finish drops the output.
                let output = self.output.take();
                result.map(|()| output)
            }
            StrictStream::Failed(error) => Err(error),
            StrictStream::Finished => Err(ComprsError::StreamFinished(self.labels.stream)),
        }
    }

    fn inflate(&mut self, input: &[u8], context: &'static str) -> Result<Vec<u8>, ComprsError> {
        let decoder = match &mut self.stream {
            StrictStream::Decoding(decoder) => decoder,
            StrictStream::Failed(error) => return Err(error.duplicate()),
            StrictStream::Finished => return Err(ComprsError::StreamFinished(self.labels.stream)),
        };
        let result = decoder.inflate(input, &mut self.output, context);
        // A failed call drops its output and returns only the error.
        let output = self.output.take();
        match result {
            Ok(()) => Ok(output),
            Err(error) => {
                self.stream = StrictStream::Failed(error.duplicate());
                Err(error)
            }
        }
    }
}

impl MemoryUsage for StrictDecompressContext {
    fn memory_usage(&self) -> usize {
        let state = match &self.stream {
            StrictStream::Decoding(decoder) if decoder.is_inflating() => INFLATE_STATE_SIZE,
            _ => 0,
        };
        state + self.output.capacity()
    }
}

/// A flate2 `write` encoder into a `Vec<u8>`. flate2 gives each encoder
/// these methods but no trait for them, so [`FlateEncoder`] calls them
/// through this one.
trait Encoder: Write {
    fn get_ref(&self) -> &Vec<u8>;
    fn get_mut(&mut self) -> &mut Vec<u8>;
    fn finish(self) -> io::Result<Vec<u8>>;
}

// `$encoder::method` names the inherent method, which takes precedence over
// the trait method of the same name.
macro_rules! impl_encoder {
    ($($encoder:ident),+ $(,)?) => {$(
        impl Encoder for $encoder<Vec<u8>> {
            fn get_ref(&self) -> &Vec<u8> {
                $encoder::get_ref(self)
            }

            fn get_mut(&mut self) -> &mut Vec<u8> {
                $encoder::get_mut(self)
            }

            fn finish(self) -> io::Result<Vec<u8>> {
                $encoder::finish(self)
            }
        }
    )+};
}

impl_encoder!(GzEncoder, DeflateEncoder, ZlibEncoder);

/// Encoder state shared by [`GzipCompressContext`],
/// [`DeflateCompressContext`] and [`ZlibCompressContext`].
struct FlateEncoder<E> {
    /// `None` once the stream is finished.
    encoder: Option<E>,
    labels: Labels,
}

impl<E: Encoder> FlateEncoder<E> {
    fn new(encoder: E, labels: Labels) -> Self {
        Self {
            encoder: Some(encoder),
            labels,
        }
    }

    /// Compress `chunk`, returning the output that the encoder has written
    /// so far.
    fn transform(&mut self, chunk: &[u8]) -> Result<Vec<u8>, ComprsError> {
        let encoder = self
            .encoder
            .as_mut()
            .ok_or(ComprsError::StreamFinished(self.labels.stream))?;

        encoder
            .write_all(chunk)
            .map_err(|e| ComprsError::Operation {
                context: self.labels.transform,
                source: e.into(),
            })?;

        Ok(std::mem::take(encoder.get_mut()))
    }

    /// Flush the input written so far, returning the output, from which a
    /// decoder can read all that input but in the rare case that
    /// [`sync_flush`] describes.
    fn flush(&mut self) -> Result<Vec<u8>, ComprsError> {
        let encoder = self
            .encoder
            .as_mut()
            .ok_or(ComprsError::StreamFinished(self.labels.stream))?;

        sync_flush(encoder).map_err(|e| ComprsError::Operation {
            context: self.labels.flush,
            source: e.into(),
        })?;

        Ok(std::mem::take(encoder.get_mut()))
    }

    /// End the stream, returning the rest of the output.
    fn finish(&mut self) -> Result<Vec<u8>, ComprsError> {
        let encoder = self
            .encoder
            .take()
            .ok_or(ComprsError::StreamFinished(self.labels.stream))?;

        encoder.finish().map_err(|e| ComprsError::Operation {
            context: self.labels.finish,
            source: e.into(),
        })
    }

    /// The deflate state and flate2's buffer, and the output that has not
    /// been returned yet.
    fn memory_usage(&self) -> usize {
        self.encoder.as_ref().map_or(0, |encoder| {
            DEFLATE_STATE_SIZE + WRITER_BUFFER_SIZE + encoder.get_ref().capacity()
        })
    }
}

/// The last 4 bytes of a complete sync flush: the lengths of the empty
/// stored block that ends it, 0 and its one's complement.
const SYNC_FLUSH_END: [u8; 4] = [0x00, 0x00, 0xff, 0xff];

/// The most sync flushes that [`sync_flush`] runs. Two suffice, as it
/// describes: the bound only keeps the loop finite.
const MAX_SYNC_FLUSHES: usize = 4;

/// Run a sync flush of `encoder` to its end, after which its output holds
/// all the input written so far.
///
/// flate2 1.1's `flush` alone does not always get there (#701). It runs
/// the sync flush in the room left in its 32 KiB output buffer, without
/// writing the buffer out first, and then only drains the output that the
/// deflate state has pending, without flushing again. A transform of
/// poorly compressible input can leave the buffer nearly full, or more
/// output pending than the buffer holds, and the sync flush then stops
/// where the room runs out: before the empty stored block that ends it,
/// and before the last block of input if it had not written that block.
fn sync_flush<E: Encoder>(encoder: &mut E) -> io::Result<()> {
    // An empty write writes the buffer out, then runs the deflate state
    // without a flush, which moves pending output into the buffer and, at
    // levels 1 to 9, compresses all but the last 261 bytes of the input
    // that the state holds. Once two writes in a row add nothing to the
    // output, two runs have moved nothing (one is not enough: level 1
    // compresses into the pending output, which only the next run moves).
    // The buffer and the pending output are then empty, and the sync flush
    // has the whole buffer for the rest: at most a block of symbols and
    // those 261 bytes, or at level 0 less than 32 KiB of input to store.
    let mut idle = 0;
    while idle < 2 {
        let len = encoder.get_ref().len();
        #[allow(clippy::unused_io_amount)] // It takes no input.
        encoder.write(&[])?;
        idle = if encoder.get_ref().len() == len {
            idle + 1
        } else {
            0
        };
    }

    // A block can still take more than 32 KiB, as can level 0's input with
    // the header of the block that stores it. flate2 then drains what the
    // sync flush wrote, and a second one completes it, with at most those
    // 261 bytes of input left to write. A sync flush after a complete one
    // would add another empty stored block (00 00 00 ff ff), so the flush
    // runs again only while its output does not end as zlib-rs ends every
    // complete sync flush, at any level and with any wrapper. A block that
    // fills the buffer and happens to end with the same bytes stops the
    // loop early, which leaves at most a few hundred bytes of input for the
    // next call, and none at level 0, where the block holds the input
    // itself.
    for _ in 0..MAX_SYNC_FLUSHES {
        let start = encoder.get_ref().len();
        encoder.flush()?;
        if encoder.get_ref()[start..].ends_with(&SYNC_FLUSH_END) {
            break;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::io::Write;

    use flate2::Compression;
    use flate2::write::{DeflateEncoder, GzEncoder};

    use super::{
        DEFLATE_STATE_SIZE, DeflateCompressContext, DeflateDecompressContext, GzipCompressContext,
        GzipDecompressContext, INFLATE_STATE_SIZE, StrictDecompressContext,
    };
    use crate::gzip::{DEFAULT_LEVEL, FlateWrapper};
    use crate::{ComprsError, MemoryUsage};

    /// Decompression limit used by the size-limit tests.
    const LIMIT: usize = 64 * 1024;

    fn gzip(data: &[u8]) -> Vec<u8> {
        let mut encoder = GzEncoder::new(Vec::new(), Compression::new(DEFAULT_LEVEL));
        encoder.write_all(data).unwrap();
        encoder.finish().unwrap()
    }

    fn deflate(data: &[u8]) -> Vec<u8> {
        let mut encoder = DeflateEncoder::new(Vec::new(), Compression::new(DEFAULT_LEVEL));
        encoder.write_all(data).unwrap();
        encoder.finish().unwrap()
    }

    #[test]
    fn gzip_decompress_context_stops_inflating_at_the_limit() {
        // 8 MiB of zeros compress to about 8 KB: one chunk that expands 1000x.
        let bomb = gzip(&vec![0u8; 8 * 1024 * 1024]);
        let mut ctx = GzipDecompressContext::new(Some(LIMIT as f64)).unwrap();

        let err = ctx.transform(&bomb).unwrap_err();
        assert_eq!(
            err.to_string(),
            "gzip stream decompress exceeded maximum size of 65536 bytes"
        );
        // The output never grew past the limit (flate2 adds one 32 KiB buffer).
        let sink = ctx.decoder.as_ref().unwrap().get_ref();
        assert!(sink.capacity() <= LIMIT);
    }

    #[test]
    fn gzip_decompress_context_counts_the_output_that_flate2_keeps() {
        // flate2 keeps the output of its last write, up to 32 KiB, which
        // transform() flushes.
        let compressed = gzip(&[b'a'; 30_000]);
        let mut ctx = GzipDecompressContext::new(Some(1000.0)).unwrap();
        let result = ctx.transform(&compressed).map(|output| output.len());
        assert!(
            matches!(result, Err(ComprsError::SizeLimit { limit: 1000, .. })),
            "{result:?}"
        );
    }

    /// One `transform` returns all the output of a chunk that ends
    /// mid-stream, which flate2 keeps the last 32 KiB of until the next
    /// write, and `flush` finds nothing left.
    #[test]
    fn gzip_decompress_context_returns_all_the_output_of_a_flushed_chunk() {
        let input: Vec<u8> = (0..100_000u32)
            .map(|i| b"gzip stream "[i as usize % 12])
            .collect();
        for len in [1000, 40_000, input.len()] {
            let mut compressor = GzipCompressContext::new(None).unwrap();
            let mut flushed = compressor.transform(&input[..len]).unwrap();
            flushed.extend(compressor.flush().unwrap());
            let mut ctx = GzipDecompressContext::new(None).unwrap();
            let output = ctx.transform(&flushed).unwrap();
            assert_eq!(output.len(), len);
            assert!(output == input[..len]);
            assert!(ctx.flush().unwrap().is_empty(), "{len} bytes");
        }
    }

    #[test]
    fn gzip_decompress_context_accepts_output_at_the_limit() {
        let data = vec![7u8; LIMIT];
        let mut ctx = GzipDecompressContext::new(Some(LIMIT as f64)).unwrap();
        let mut output = ctx.transform(&gzip(&data)).unwrap();
        output.extend(ctx.flush().unwrap());
        output.extend(ctx.finish().unwrap());
        assert_eq!(output, data);
    }

    #[test]
    fn gzip_decompress_context_rejects_input_without_a_complete_header() {
        let compressed = gzip(b"gzip header test");
        for len in [0, 1, 5] {
            let mut ctx = GzipDecompressContext::new(None).unwrap();
            ctx.transform(&compressed[..len]).unwrap();
            assert!(matches!(ctx.finish(), Err(ComprsError::Truncated("gzip"))));
        }
    }

    #[test]
    fn gzip_decompress_context_rejects_truncated_input() {
        let compressed = gzip(&b"truncated gzip ".repeat(500));
        for len in [compressed.len() / 2, compressed.len() - 1] {
            let mut ctx = GzipDecompressContext::new(None).unwrap();
            let result = ctx
                .transform(&compressed[..len])
                .and_then(|_| ctx.flush())
                .and_then(|_| ctx.finish());
            assert!(result.is_err(), "input of {len} bytes");
        }
    }

    /// Decompress raw deflate `input` in chunks of `chunk_size` bytes, then
    /// finish.
    fn inflate_all(input: &[u8], chunk_size: usize) -> Result<Vec<u8>, ComprsError> {
        let mut ctx = DeflateDecompressContext::new(None).unwrap();
        let mut output = Vec::new();
        for chunk in input.chunks(chunk_size) {
            output.extend(ctx.transform(chunk)?);
        }
        output.extend(ctx.flush()?);
        output.extend(ctx.finish()?);
        Ok(output)
    }

    #[test]
    fn deflate_decompress_context_finishes_complete_streams() {
        let original = b"complete deflate stream ".repeat(500);
        let compressed = deflate(&original);
        for chunk_size in [1, 7, compressed.len()] {
            let output = inflate_all(&compressed, chunk_size).unwrap();
            assert_eq!(output, original, "chunk size {chunk_size}");
        }
        assert_eq!(inflate_all(&deflate(b""), 1).unwrap(), b"");
    }

    #[test]
    fn deflate_decompress_context_rejects_truncated_input() {
        let compressed = deflate(&b"truncated deflate ".repeat(500));
        for len in [0, 1, compressed.len() / 2, compressed.len() - 1] {
            let err = inflate_all(&compressed[..len], 64).unwrap_err();
            assert_eq!(
                err.to_string(),
                "deflate stream is truncated: unexpected end of input",
                "input of {len} bytes"
            );
        }
    }

    #[test]
    fn deflate_decompress_context_reports_corrupt_input() {
        let err = inflate_all(&[0xff; 16], 16).unwrap_err();
        assert_eq!(
            err.to_string(),
            "deflate stream decompress failed: corrupt deflate stream"
        );
    }

    #[test]
    fn deflate_decompress_context_rejects_data_after_the_stream() {
        let mut input = deflate(b"complete");
        input.extend(b"trailing");
        let err = inflate_all(&input, input.len()).unwrap_err();
        assert_eq!(
            err.to_string(),
            "deflate stream decompress failed: unexpected data after the end of the stream"
        );
    }

    /// After a call fails, every later call fails with its error, `finish`
    /// included, which then ends the stream; the failed context holds no
    /// state (#712).
    #[test]
    fn deflate_decompress_context_keeps_failing_after_an_error() {
        let mut input = deflate(&b"complete ".repeat(1000));
        input.extend(b"trailing");
        let mut ctx = DeflateDecompressContext::new(None).unwrap();
        let message =
            "deflate stream decompress failed: unexpected data after the end of the stream";
        assert_eq!(ctx.transform(&input).unwrap_err().to_string(), message);
        assert_eq!(ctx.memory_usage(), 0);
        assert_eq!(ctx.transform(b"more").unwrap_err().to_string(), message);
        assert_eq!(ctx.flush().unwrap_err().to_string(), message);
        assert_eq!(ctx.finish().unwrap_err().to_string(), message);
        assert!(matches!(
            ctx.finish(),
            Err(ComprsError::StreamFinished("deflate stream"))
        ));
    }

    #[test]
    fn contexts_report_the_zlib_state_until_finish() {
        let data = b"gzip and deflate streams ".repeat(100);

        let mut gzip = GzipCompressContext::new(None).unwrap();
        let mut deflate = DeflateCompressContext::new(None).unwrap();
        for ctx in [&gzip as &dyn MemoryUsage, &deflate] {
            assert!(ctx.memory_usage() >= DEFLATE_STATE_SIZE);
        }
        let gzipped = [gzip.transform(&data).unwrap(), gzip.finish().unwrap()].concat();
        let deflated = [deflate.transform(&data).unwrap(), deflate.finish().unwrap()].concat();
        assert_eq!(gzip.memory_usage(), 0);
        assert_eq!(deflate.memory_usage(), 0);

        let mut gunzip = GzipDecompressContext::new(None).unwrap();
        let mut inflate = DeflateDecompressContext::new(None).unwrap();
        for ctx in [&gunzip as &dyn MemoryUsage, &inflate] {
            assert!(ctx.memory_usage() >= INFLATE_STATE_SIZE);
        }
        gunzip.transform(&gzipped).unwrap();
        gunzip.finish().unwrap();
        inflate.transform(&deflated).unwrap();
        inflate.finish().unwrap();
        assert_eq!(gunzip.memory_usage(), 0);
        assert_eq!(inflate.memory_usage(), inflate.output.capacity());
    }

    #[test]
    fn strict_decompress_context_reports_the_inflate_state_inside_a_member() {
        let member = gzip(b"member");
        let mut ctx = StrictDecompressContext::new(FlateWrapper::Gzip, None).unwrap();
        assert!(ctx.memory_usage() >= INFLATE_STATE_SIZE);
        assert_eq!(ctx.transform(&member).unwrap(), b"member");
        // The state of a member is freed when the member ends, and the next
        // one starts with its second byte.
        assert_eq!(ctx.memory_usage(), 0);
        ctx.transform(&member[..1]).unwrap();
        assert_eq!(ctx.memory_usage(), 0);
        ctx.transform(&member[1..2]).unwrap();
        assert!(ctx.memory_usage() >= INFLATE_STATE_SIZE);
        assert_eq!(ctx.transform(&member[2..]).unwrap(), b"member");
        assert_eq!(ctx.memory_usage(), 0);
        ctx.finish().unwrap();
        assert_eq!(ctx.memory_usage(), 0);
    }

    #[test]
    fn deflate_decompress_context_cannot_be_used_after_finish() {
        let mut ctx = DeflateDecompressContext::new(None).unwrap();
        ctx.transform(&deflate(b"finished")).unwrap();
        ctx.finish().unwrap();
        assert!(matches!(
            ctx.transform(b"more"),
            Err(ComprsError::StreamFinished("deflate stream"))
        ));
        assert!(matches!(ctx.finish(), Err(ComprsError::StreamFinished(_))));
    }

    #[test]
    fn compress_contexts_cannot_be_used_after_finish() {
        let mut gzip = GzipCompressContext::new(None).unwrap();
        gzip.transform(b"finished").unwrap();
        gzip.finish().unwrap();
        let gzip_results = [gzip.transform(b"more"), gzip.flush(), gzip.finish()];

        let mut deflate = DeflateCompressContext::new(None).unwrap();
        deflate.transform(b"finished").unwrap();
        deflate.finish().unwrap();
        let deflate_results = [
            deflate.transform(b"more"),
            deflate.flush(),
            deflate.finish(),
        ];

        for (results, stream) in [
            (gzip_results, "gzip stream"),
            (deflate_results, "deflate stream"),
        ] {
            for result in results {
                assert!(
                    matches!(result, Err(ComprsError::StreamFinished(name)) if name == stream),
                    "{stream}: {result:?}"
                );
            }
        }
    }

    #[test]
    fn deflate_decompress_context_stops_inflating_at_the_limit() {
        let bomb = deflate(&vec![0u8; 8 * 1024 * 1024]);
        let mut ctx = DeflateDecompressContext::new(Some(LIMIT as f64)).unwrap();

        let err = ctx.transform(&bomb).unwrap_err();
        assert_eq!(
            err.to_string(),
            "deflate stream decompress exceeded maximum size of 65536 bytes"
        );
        // The output never grew past the limit plus the one byte that detects
        // the overflow.
        assert!(ctx.output.capacity() <= LIMIT + 1);
    }

    #[test]
    fn deflate_decompress_context_counts_finish_output() {
        let compressed = deflate(&[b'a'; 30_000]);
        let mut ctx = DeflateDecompressContext::new(Some(1000.0)).unwrap();
        let result = ctx.transform(&compressed).and_then(|_| ctx.finish());
        assert!(matches!(
            result,
            Err(ComprsError::SizeLimit { limit: 1000, .. })
        ));
    }

    #[test]
    fn deflate_decompress_context_accepts_output_at_the_limit() {
        let data = vec![7u8; LIMIT];
        let mut ctx = DeflateDecompressContext::new(Some(LIMIT as f64)).unwrap();
        let mut output = ctx.transform(&deflate(&data)).unwrap();
        output.extend(ctx.flush().unwrap());
        output.extend(ctx.finish().unwrap());
        assert_eq!(output, data);
    }

    #[test]
    fn gzip_stream_rejects_level_above_9() {
        assert!(GzipCompressContext::new(Some(9)).is_ok());
        let err = GzipCompressContext::new(Some(10)).err().unwrap();
        assert_eq!(
            err.to_string(),
            "gzip compression level must be an integer between 0 and 9"
        );
    }

    #[test]
    fn deflate_stream_rejects_level_above_9() {
        assert!(DeflateCompressContext::new(Some(9)).is_ok());
        let err = DeflateCompressContext::new(Some(10)).err().unwrap();
        assert_eq!(
            err.to_string(),
            "deflate compression level must be an integer between 0 and 9"
        );
    }
}
