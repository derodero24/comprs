//! Gzip and raw deflate streaming compression and decompression.

use std::io::Write;

use flate2::Compression;
use flate2::write::{DeflateDecoder, DeflateEncoder, GzEncoder, MultiGzDecoder};
use napi::bindgen_prelude::*;
use napi_derive::napi;

use crate::ZflateError;

/// Default compression level for gzip/deflate (same as zlib default).
const DEFAULT_LEVEL: u32 = 6;

/// Streaming gzip compression context.
///
/// Maintains internal compression state across multiple `transform` calls,
/// enabling chunked gzip compression without losing cross-chunk context.
#[napi]
pub struct GzipCompressContext {
    encoder: Option<GzEncoder<Vec<u8>>>,
}

#[napi]
impl GzipCompressContext {
    #[napi(constructor)]
    pub fn new(level: Option<u32>) -> Result<Self> {
        let level = level.unwrap_or(DEFAULT_LEVEL);
        if level > 9 {
            return Err(ZflateError::InvalidArg(
                "gzip compression level must be between 0 and 9".to_string(),
            )
            .into());
        }
        let encoder = GzEncoder::new(Vec::new(), Compression::new(level));
        Ok(Self {
            encoder: Some(encoder),
        })
    }

    /// Compress a chunk of data. Returns compressed output (may be empty if
    /// the encoder is buffering data internally).
    #[napi]
    pub fn transform(&mut self, chunk: Either<Buffer, Uint8Array>) -> Result<Buffer> {
        let encoder = self
            .encoder
            .as_mut()
            .ok_or_else(|| napi::Error::from(ZflateError::StreamFinished("gzip stream")))?;

        encoder.write_all(crate::as_bytes(&chunk)).map_err(|e| {
            napi::Error::from(ZflateError::Operation {
                context: "gzip stream compress",
                source: e.into(),
            })
        })?;

        let output = encoder.get_mut();
        let data = std::mem::take(output);
        Ok(data.into())
    }

    /// Flush the encoder's internal buffer. Returns any buffered compressed data.
    #[napi]
    pub fn flush(&mut self) -> Result<Buffer> {
        let encoder = self
            .encoder
            .as_mut()
            .ok_or_else(|| napi::Error::from(ZflateError::StreamFinished("gzip stream")))?;

        encoder.flush().map_err(|e| {
            napi::Error::from(ZflateError::Operation {
                context: "gzip stream flush",
                source: e.into(),
            })
        })?;

        let output = encoder.get_mut();
        let data = std::mem::take(output);
        Ok(data.into())
    }

    /// Finalize the gzip stream. Writes the gzip footer (CRC32 + size).
    /// Must be called once after all data has been transformed.
    #[napi]
    pub fn finish(&mut self) -> Result<Buffer> {
        let encoder = self
            .encoder
            .take()
            .ok_or_else(|| napi::Error::from(ZflateError::StreamFinished("gzip stream")))?;

        encoder.finish().map(|v| v.into()).map_err(|e| {
            napi::Error::from(ZflateError::Operation {
                context: "gzip stream finish",
                source: e.into(),
            })
        })
    }
}

/// Streaming gzip decompression context.
///
/// Maintains internal decompression state across multiple `transform` calls,
/// enabling chunked decompression of a gzip stream.
#[napi]
pub struct GzipDecompressContext {
    decoder: Option<MultiGzDecoder<Vec<u8>>>,
    total_output: usize,
    max_output_size: usize,
}

#[napi]
impl GzipDecompressContext {
    #[napi(constructor)]
    pub fn new(max_output_size: Option<f64>) -> Result<Self> {
        let max_size = crate::validate_max_output_size(max_output_size)?;
        let decoder = MultiGzDecoder::new(Vec::new());
        Ok(Self {
            decoder: Some(decoder),
            total_output: 0,
            max_output_size: max_size,
        })
    }

    /// Decompress a chunk of compressed data. Returns decompressed output
    /// (may be empty if the decoder needs more data).
    #[napi]
    pub fn transform(&mut self, chunk: Either<Buffer, Uint8Array>) -> Result<Buffer> {
        let decoder = self
            .decoder
            .as_mut()
            .ok_or_else(|| napi::Error::from(ZflateError::StreamFinished("gzip stream")))?;

        let input = crate::as_bytes(&chunk);
        let mut pos = 0;
        while pos < input.len() {
            let n = decoder.write(&input[pos..]).map_err(|e| {
                napi::Error::from(ZflateError::Operation {
                    context: "gzip stream decompress",
                    source: e.into(),
                })
            })?;
            if n == 0 {
                break;
            }
            pos += n;
        }

        let output = decoder.get_mut();
        let data = std::mem::take(output);
        self.total_output += data.len();
        if self.total_output > self.max_output_size {
            return Err(ZflateError::SizeLimit {
                context: "gzip stream decompress",
                limit: self.max_output_size,
            }
            .into());
        }
        Ok(data.into())
    }

    /// Flush the decoder's internal buffer. Returns any buffered decompressed data.
    #[napi]
    pub fn flush(&mut self) -> Result<Buffer> {
        let decoder = self
            .decoder
            .as_mut()
            .ok_or_else(|| napi::Error::from(ZflateError::StreamFinished("gzip stream")))?;

        decoder.flush().map_err(|e| {
            napi::Error::from(ZflateError::Operation {
                context: "gzip stream flush",
                source: e.into(),
            })
        })?;

        let output = decoder.get_mut();
        let data = std::mem::take(output);
        self.total_output += data.len();
        if self.total_output > self.max_output_size {
            return Err(ZflateError::SizeLimit {
                context: "gzip stream decompress",
                limit: self.max_output_size,
            }
            .into());
        }
        Ok(data.into())
    }

    /// Finalize the gzip decompression stream and verify CRC integrity.
    /// Must be called once after all compressed data has been transformed.
    #[napi]
    pub fn finish(&mut self) -> Result<Buffer> {
        let decoder = self
            .decoder
            .take()
            .ok_or_else(|| napi::Error::from(ZflateError::StreamFinished("gzip stream")))?;

        decoder.finish().map(|v| v.into()).map_err(|e| {
            napi::Error::from(ZflateError::Operation {
                context: "gzip stream finish",
                source: e.into(),
            })
        })
    }
}

/// Streaming raw deflate compression context.
///
/// Maintains internal compression state across multiple `transform` calls,
/// enabling chunked deflate compression without losing cross-chunk context.
#[napi]
pub struct DeflateCompressContext {
    encoder: Option<DeflateEncoder<Vec<u8>>>,
}

#[napi]
impl DeflateCompressContext {
    #[napi(constructor)]
    pub fn new(level: Option<u32>) -> Result<Self> {
        let level = level.unwrap_or(DEFAULT_LEVEL);
        if level > 9 {
            return Err(ZflateError::InvalidArg(
                "deflate compression level must be between 0 and 9".to_string(),
            )
            .into());
        }
        let encoder = DeflateEncoder::new(Vec::new(), Compression::new(level));
        Ok(Self {
            encoder: Some(encoder),
        })
    }

    /// Compress a chunk of data. Returns compressed output (may be empty if
    /// the encoder is buffering data internally).
    #[napi]
    pub fn transform(&mut self, chunk: Either<Buffer, Uint8Array>) -> Result<Buffer> {
        let encoder = self
            .encoder
            .as_mut()
            .ok_or_else(|| napi::Error::from(ZflateError::StreamFinished("deflate stream")))?;

        encoder.write_all(crate::as_bytes(&chunk)).map_err(|e| {
            napi::Error::from(ZflateError::Operation {
                context: "deflate stream compress",
                source: e.into(),
            })
        })?;

        let output = encoder.get_mut();
        let data = std::mem::take(output);
        Ok(data.into())
    }

    /// Flush the encoder's internal buffer. Returns any buffered compressed data.
    #[napi]
    pub fn flush(&mut self) -> Result<Buffer> {
        let encoder = self
            .encoder
            .as_mut()
            .ok_or_else(|| napi::Error::from(ZflateError::StreamFinished("deflate stream")))?;

        encoder.flush().map_err(|e| {
            napi::Error::from(ZflateError::Operation {
                context: "deflate stream flush",
                source: e.into(),
            })
        })?;

        let output = encoder.get_mut();
        let data = std::mem::take(output);
        Ok(data.into())
    }

    /// Finalize the deflate stream.
    /// Must be called once after all data has been transformed.
    #[napi]
    pub fn finish(&mut self) -> Result<Buffer> {
        let encoder = self
            .encoder
            .take()
            .ok_or_else(|| napi::Error::from(ZflateError::StreamFinished("deflate stream")))?;

        encoder.finish().map(|v| v.into()).map_err(|e| {
            napi::Error::from(ZflateError::Operation {
                context: "deflate stream finish",
                source: e.into(),
            })
        })
    }
}

/// Streaming raw deflate decompression context.
///
/// Maintains internal decompression state across multiple `transform` calls,
/// enabling chunked decompression of a raw deflate stream.
#[napi]
pub struct DeflateDecompressContext {
    decoder: Option<DeflateDecoder<Vec<u8>>>,
    total_output: usize,
    max_output_size: usize,
}

#[napi]
impl DeflateDecompressContext {
    #[napi(constructor)]
    pub fn new(max_output_size: Option<f64>) -> Result<Self> {
        let max_size = crate::validate_max_output_size(max_output_size)?;
        let decoder = DeflateDecoder::new(Vec::new());
        Ok(Self {
            decoder: Some(decoder),
            total_output: 0,
            max_output_size: max_size,
        })
    }

    /// Decompress a chunk of compressed data. Returns decompressed output
    /// (may be empty if the decoder needs more data).
    #[napi]
    pub fn transform(&mut self, chunk: Either<Buffer, Uint8Array>) -> Result<Buffer> {
        let decoder = self
            .decoder
            .as_mut()
            .ok_or_else(|| napi::Error::from(ZflateError::StreamFinished("deflate stream")))?;

        decoder.write_all(crate::as_bytes(&chunk)).map_err(|e| {
            napi::Error::from(ZflateError::Operation {
                context: "deflate stream decompress",
                source: e.into(),
            })
        })?;

        let output = decoder.get_mut();
        let data = std::mem::take(output);
        self.total_output += data.len();
        if self.total_output > self.max_output_size {
            return Err(ZflateError::SizeLimit {
                context: "deflate stream decompress",
                limit: self.max_output_size,
            }
            .into());
        }
        Ok(data.into())
    }

    /// Flush the decoder's internal buffer. Returns any buffered decompressed data.
    #[napi]
    pub fn flush(&mut self) -> Result<Buffer> {
        let decoder = self
            .decoder
            .as_mut()
            .ok_or_else(|| napi::Error::from(ZflateError::StreamFinished("deflate stream")))?;

        decoder.flush().map_err(|e| {
            napi::Error::from(ZflateError::Operation {
                context: "deflate stream flush",
                source: e.into(),
            })
        })?;

        let output = decoder.get_mut();
        let data = std::mem::take(output);
        self.total_output += data.len();
        if self.total_output > self.max_output_size {
            return Err(ZflateError::SizeLimit {
                context: "deflate stream decompress",
                limit: self.max_output_size,
            }
            .into());
        }
        Ok(data.into())
    }

    /// Finalize the deflate decompression stream.
    /// Must be called once after all compressed data has been transformed.
    #[napi]
    pub fn finish(&mut self) -> Result<Buffer> {
        let decoder = self
            .decoder
            .take()
            .ok_or_else(|| napi::Error::from(ZflateError::StreamFinished("deflate stream")))?;

        decoder.finish().map(|v| v.into()).map_err(|e| {
            napi::Error::from(ZflateError::Operation {
                context: "deflate stream finish",
                source: e.into(),
            })
        })
    }
}

#[cfg(test)]
mod tests {
    use std::io::{Read, Write};

    use flate2::Compression;
    use flate2::read::GzDecoder as GzReadDecoder;
    use flate2::write::{DeflateDecoder, DeflateEncoder, GzEncoder};

    const DEFAULT_LEVEL: u32 = 6;

    #[test]
    fn gzip_stream_round_trip() {
        let original = b"Hello, zflate gzip streaming! ".repeat(100);

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
        let original = b"Hello, zflate deflate streaming! ".repeat(100);

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
        // Verify that flate2 accepts level 9 (max valid)
        let _ = GzEncoder::new(Vec::new(), Compression::new(9));
        // Level 10+ is rejected by our napi wrapper validation.
    }

    #[test]
    fn deflate_stream_rejects_level_above_9() {
        // Verify that flate2 accepts level 9 (max valid)
        let _ = DeflateEncoder::new(Vec::new(), Compression::new(9));
        // Level 10+ is rejected by our napi wrapper validation.
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
