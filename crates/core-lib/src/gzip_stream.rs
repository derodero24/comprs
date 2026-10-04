//! Gzip and raw deflate streaming compression and decompression.

use std::io::Write;

use flate2::Compression;
use flate2::write::{DeflateEncoder, GzEncoder, MultiGzDecoder};

use crate::gzip::{DEFLATE_LEVEL, Inflater, LEVEL};
use crate::limited::LimitedVec;
use crate::{ComprsError, MemoryUsage};

/// Default compression level for gzip/deflate (same as zlib default).
pub const DEFAULT_LEVEL: u32 = 6;

// flate2 does not report the memory of its streams, but zlib-rs allocates a
// fixed amount for each, whatever the level and the data. The sizes below
// were measured with flate2 1.1.9 and zlib-rs 0.6.

/// Heap memory of a deflate stream: its 64 KiB window, hash chains and
/// pending output (371 KiB).
const DEFLATE_STATE_SIZE: usize = 380_032;

/// Heap memory of an inflate stream: its 32 KiB window and decoding tables.
const INFLATE_STATE_SIZE: usize = 47_552;

/// Buffer that flate2's `write` encoders and decoders keep.
const WRITER_BUFFER_SIZE: usize = 32 * 1024;

/// Streaming gzip compression context.
pub struct GzipCompressContext {
    encoder: Option<GzEncoder<Vec<u8>>>,
}

impl GzipCompressContext {
    pub fn new(level: Option<u32>) -> Result<Self, ComprsError> {
        let level = LEVEL.check(level.unwrap_or(DEFAULT_LEVEL))?;
        let encoder = GzEncoder::new(Vec::new(), Compression::new(level));
        Ok(Self {
            encoder: Some(encoder),
        })
    }

    pub fn transform(&mut self, chunk: &[u8]) -> Result<Vec<u8>, ComprsError> {
        let encoder = self
            .encoder
            .as_mut()
            .ok_or(ComprsError::StreamFinished("gzip stream"))?;

        encoder
            .write_all(chunk)
            .map_err(|e| ComprsError::Operation {
                context: "gzip stream compress",
                source: e.into(),
            })?;

        let output = encoder.get_mut();
        let data = std::mem::take(output);
        Ok(data)
    }

    pub fn flush(&mut self) -> Result<Vec<u8>, ComprsError> {
        let encoder = self
            .encoder
            .as_mut()
            .ok_or(ComprsError::StreamFinished("gzip stream"))?;

        encoder.flush().map_err(|e| ComprsError::Operation {
            context: "gzip stream flush",
            source: e.into(),
        })?;

        let output = encoder.get_mut();
        let data = std::mem::take(output);
        Ok(data)
    }

    pub fn finish(&mut self) -> Result<Vec<u8>, ComprsError> {
        let encoder = self
            .encoder
            .take()
            .ok_or(ComprsError::StreamFinished("gzip stream"))?;

        encoder.finish().map_err(|e| ComprsError::Operation {
            context: "gzip stream finish",
            source: e.into(),
        })
    }
}

impl MemoryUsage for GzipCompressContext {
    fn memory_usage(&self) -> usize {
        self.encoder.as_ref().map_or(0, |encoder| {
            DEFLATE_STATE_SIZE + WRITER_BUFFER_SIZE + encoder.get_ref().capacity()
        })
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
    /// header of a member was complete, including empty input.
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
    encoder: Option<DeflateEncoder<Vec<u8>>>,
}

impl DeflateCompressContext {
    pub fn new(level: Option<u32>) -> Result<Self, ComprsError> {
        let level = DEFLATE_LEVEL.check(level.unwrap_or(DEFAULT_LEVEL))?;
        let encoder = DeflateEncoder::new(Vec::new(), Compression::new(level));
        Ok(Self {
            encoder: Some(encoder),
        })
    }

    pub fn transform(&mut self, chunk: &[u8]) -> Result<Vec<u8>, ComprsError> {
        let encoder = self
            .encoder
            .as_mut()
            .ok_or(ComprsError::StreamFinished("deflate stream"))?;

        encoder
            .write_all(chunk)
            .map_err(|e| ComprsError::Operation {
                context: "deflate stream compress",
                source: e.into(),
            })?;

        let output = encoder.get_mut();
        let data = std::mem::take(output);
        Ok(data)
    }

    pub fn flush(&mut self) -> Result<Vec<u8>, ComprsError> {
        let encoder = self
            .encoder
            .as_mut()
            .ok_or(ComprsError::StreamFinished("deflate stream"))?;

        encoder.flush().map_err(|e| ComprsError::Operation {
            context: "deflate stream flush",
            source: e.into(),
        })?;

        let output = encoder.get_mut();
        let data = std::mem::take(output);
        Ok(data)
    }

    pub fn finish(&mut self) -> Result<Vec<u8>, ComprsError> {
        let encoder = self
            .encoder
            .take()
            .ok_or(ComprsError::StreamFinished("deflate stream"))?;

        encoder.finish().map_err(|e| ComprsError::Operation {
            context: "deflate stream finish",
            source: e.into(),
        })
    }
}

impl MemoryUsage for DeflateCompressContext {
    fn memory_usage(&self) -> usize {
        self.encoder.as_ref().map_or(0, |encoder| {
            DEFLATE_STATE_SIZE + WRITER_BUFFER_SIZE + encoder.get_ref().capacity()
        })
    }
}

/// Streaming raw deflate decompression context.
pub struct DeflateDecompressContext {
    /// `None` once the stream is finished.
    inflater: Option<Inflater>,
    output: LimitedVec,
}

impl DeflateDecompressContext {
    pub fn new(max_output_size: Option<f64>) -> Result<Self, ComprsError> {
        let max_size = crate::validate_max_output_size(max_output_size)?;
        Ok(Self {
            inflater: Some(Inflater::new()),
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
    /// final block of the deflate stream.
    pub fn finish(&mut self) -> Result<Vec<u8>, ComprsError> {
        let output = self.inflate(&[], "deflate stream finish");
        let stream_end = self
            .inflater
            .take()
            .is_some_and(|inflater| inflater.stream_end());
        let output = output?;
        if !stream_end {
            return Err(ComprsError::Truncated("deflate"));
        }
        Ok(output)
    }

    fn inflate(&mut self, input: &[u8], context: &'static str) -> Result<Vec<u8>, ComprsError> {
        let inflater = self
            .inflater
            .as_mut()
            .ok_or(ComprsError::StreamFinished("deflate stream"))?;

        let consumed = inflater
            .inflate(input, &mut self.output)
            .map_err(|e| self.output.error(e, context))?;
        if consumed < input.len() {
            return Err(ComprsError::Operation {
                context,
                source: "unexpected data after the end of the stream".into(),
            });
        }

        Ok(self.output.take())
    }
}

impl MemoryUsage for DeflateDecompressContext {
    fn memory_usage(&self) -> usize {
        self.inflater.as_ref().map_or(0, |_| INFLATE_STATE_SIZE) + self.output.capacity()
    }
}

#[cfg(test)]
mod tests {
    use std::io::{Read, Write};

    use flate2::Compression;
    use flate2::read::GzDecoder as GzReadDecoder;
    use flate2::write::{DeflateDecoder, DeflateEncoder, GzEncoder};

    use super::{
        DEFLATE_STATE_SIZE, DeflateCompressContext, DeflateDecompressContext, GzipCompressContext,
        GzipDecompressContext, INFLATE_STATE_SIZE,
    };
    use crate::{ComprsError, MemoryUsage};

    const DEFAULT_LEVEL: u32 = 6;

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
    fn gzip_decompress_context_counts_finish_output() {
        // flate2 holds up to 32 KiB of output, which only finish() returns.
        let compressed = gzip(&[b'a'; 30_000]);
        let mut ctx = GzipDecompressContext::new(Some(1000.0)).unwrap();
        let result = ctx.transform(&compressed).and_then(|_| ctx.finish());
        assert!(matches!(
            result,
            Err(ComprsError::SizeLimit { limit: 1000, .. })
        ));
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
    fn gzip_stream_round_trip() {
        let original = b"Hello, comprs gzip streaming! ".repeat(100);

        // Compress in chunks using GzEncoder
        let mut encoder = GzEncoder::new(Vec::new(), Compression::new(DEFAULT_LEVEL));
        for chunk in original.chunks(256) {
            encoder.write_all(chunk).unwrap();
        }
        let compressed = encoder.finish().unwrap();

        // Verify with standard read decoder
        let mut decoder = GzReadDecoder::new(compressed.as_slice());
        let mut decompressed = Vec::new();
        decoder.read_to_end(&mut decompressed).unwrap();
        assert_eq!(original.as_slice(), decompressed.as_slice());
    }

    #[test]
    fn gzip_stream_empty_input() {
        let mut encoder = GzEncoder::new(Vec::new(), Compression::new(DEFAULT_LEVEL));
        encoder.write_all(b"").unwrap();
        let compressed = encoder.finish().unwrap();

        // Should produce a valid (empty) gzip frame
        assert!(!compressed.is_empty());

        let mut decoder = GzReadDecoder::new(compressed.as_slice());
        let mut decompressed = Vec::new();
        decoder.read_to_end(&mut decompressed).unwrap();
        assert!(decompressed.is_empty());
    }

    #[test]
    fn deflate_stream_round_trip() {
        let original = b"Hello, comprs deflate streaming! ".repeat(100);

        // Compress in chunks
        let mut encoder = DeflateEncoder::new(Vec::new(), Compression::new(DEFAULT_LEVEL));
        for chunk in original.chunks(256) {
            encoder.write_all(chunk).unwrap();
        }
        let compressed = encoder.finish().unwrap();

        // Decompress
        let mut decoder = DeflateDecoder::new(Vec::new());
        decoder.write_all(&compressed).unwrap();
        let decompressed = decoder.finish().unwrap();
        assert_eq!(original.as_slice(), decompressed.as_slice());
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

    #[test]
    fn deflate_stream_empty_input() {
        let mut encoder = DeflateEncoder::new(Vec::new(), Compression::new(DEFAULT_LEVEL));
        encoder.write_all(b"").unwrap();
        let compressed = encoder.finish().unwrap();

        assert!(!compressed.is_empty());

        let mut decoder = DeflateDecoder::new(Vec::new());
        decoder.write_all(&compressed).unwrap();
        let decompressed = decoder.finish().unwrap();
        assert!(decompressed.is_empty());
    }
}
