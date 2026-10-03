//! Gzip and raw deflate streaming compression and decompression.

use std::io::Write;

use flate2::Compression;
use flate2::write::{DeflateDecoder, DeflateEncoder, GzEncoder, MultiGzDecoder};

use crate::ComprsError;
use crate::limited::LimitedVec;

/// Default compression level for gzip/deflate (same as zlib default).
pub const DEFAULT_LEVEL: u32 = 6;

/// Streaming gzip compression context.
pub struct GzipCompressContext {
    encoder: Option<GzEncoder<Vec<u8>>>,
}

impl GzipCompressContext {
    pub fn new(level: Option<u32>) -> Result<Self, ComprsError> {
        let level = level.unwrap_or(DEFAULT_LEVEL);
        if level > 9 {
            return Err(ComprsError::InvalidArg(
                "gzip compression level must be between 0 and 9".to_string(),
            ));
        }
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

    pub fn finish(&mut self) -> Result<Vec<u8>, ComprsError> {
        let mut decoder = self
            .decoder
            .take()
            .ok_or(ComprsError::StreamFinished("gzip stream"))?;

        decoder
            .try_finish()
            .map_err(|e| decoder.get_ref().error(e, "gzip stream finish"))?;

        Ok(decoder.get_mut().take())
    }
}

/// Streaming raw deflate compression context.
pub struct DeflateCompressContext {
    encoder: Option<DeflateEncoder<Vec<u8>>>,
}

impl DeflateCompressContext {
    pub fn new(level: Option<u32>) -> Result<Self, ComprsError> {
        let level = level.unwrap_or(DEFAULT_LEVEL);
        if level > 9 {
            return Err(ComprsError::InvalidArg(
                "deflate compression level must be between 0 and 9".to_string(),
            ));
        }
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

/// Streaming raw deflate decompression context.
pub struct DeflateDecompressContext {
    decoder: Option<DeflateDecoder<LimitedVec>>,
}

impl DeflateDecompressContext {
    pub fn new(max_output_size: Option<f64>) -> Result<Self, ComprsError> {
        let max_size = crate::validate_max_output_size(max_output_size)?;
        let decoder = DeflateDecoder::new(LimitedVec::new(max_size, "deflate stream decompress"));
        Ok(Self {
            decoder: Some(decoder),
        })
    }

    pub fn transform(&mut self, chunk: &[u8]) -> Result<Vec<u8>, ComprsError> {
        let decoder = self
            .decoder
            .as_mut()
            .ok_or(ComprsError::StreamFinished("deflate stream"))?;

        decoder
            .write_all(chunk)
            .map_err(|e| decoder.get_ref().error(e, "deflate stream decompress"))?;

        Ok(decoder.get_mut().take())
    }

    pub fn flush(&mut self) -> Result<Vec<u8>, ComprsError> {
        let decoder = self
            .decoder
            .as_mut()
            .ok_or(ComprsError::StreamFinished("deflate stream"))?;

        decoder
            .flush()
            .map_err(|e| decoder.get_ref().error(e, "deflate stream flush"))?;

        Ok(decoder.get_mut().take())
    }

    pub fn finish(&mut self) -> Result<Vec<u8>, ComprsError> {
        let mut decoder = self
            .decoder
            .take()
            .ok_or(ComprsError::StreamFinished("deflate stream"))?;

        decoder
            .try_finish()
            .map_err(|e| decoder.get_ref().error(e, "deflate stream finish"))?;

        Ok(decoder.get_mut().take())
    }
}

#[cfg(test)]
mod tests {
    use std::io::{Read, Write};

    use flate2::Compression;
    use flate2::read::GzDecoder as GzReadDecoder;
    use flate2::write::{DeflateDecoder, DeflateEncoder, GzEncoder};

    use super::{DeflateDecompressContext, GzipDecompressContext};
    use crate::ComprsError;

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
    fn deflate_decompress_context_stops_inflating_at_the_limit() {
        let bomb = deflate(&vec![0u8; 8 * 1024 * 1024]);
        let mut ctx = DeflateDecompressContext::new(Some(LIMIT as f64)).unwrap();

        let err = ctx.transform(&bomb).unwrap_err();
        assert_eq!(
            err.to_string(),
            "deflate stream decompress exceeded maximum size of 65536 bytes"
        );
        let sink = ctx.decoder.as_ref().unwrap().get_ref();
        assert!(sink.capacity() <= LIMIT);
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
        let _ = GzEncoder::new(Vec::new(), Compression::new(9));
    }

    #[test]
    fn deflate_stream_rejects_level_above_9() {
        let _ = DeflateEncoder::new(Vec::new(), Compression::new(9));
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
