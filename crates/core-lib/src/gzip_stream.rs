//! Gzip and raw deflate streaming compression and decompression.

use std::io::Write;

use flate2::Compression;
use flate2::write::{DeflateDecoder, DeflateEncoder, GzEncoder, MultiGzDecoder};

use crate::ComprsError;

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
    decoder: Option<MultiGzDecoder<Vec<u8>>>,
    total_output: usize,
    max_output_size: usize,
}

impl GzipDecompressContext {
    pub fn new(max_output_size: Option<f64>) -> Result<Self, ComprsError> {
        let max_size = crate::validate_max_output_size(max_output_size)?;
        let decoder = MultiGzDecoder::new(Vec::new());
        Ok(Self {
            decoder: Some(decoder),
            total_output: 0,
            max_output_size: max_size,
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
                .map_err(|e| ComprsError::Operation {
                    context: "gzip stream decompress",
                    source: e.into(),
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
            return Err(ComprsError::SizeLimit {
                context: "gzip stream decompress",
                limit: self.max_output_size,
            });
        }
        Ok(data)
    }

    pub fn flush(&mut self) -> Result<Vec<u8>, ComprsError> {
        let decoder = self
            .decoder
            .as_mut()
            .ok_or(ComprsError::StreamFinished("gzip stream"))?;

        decoder.flush().map_err(|e| ComprsError::Operation {
            context: "gzip stream flush",
            source: e.into(),
        })?;

        let output = decoder.get_mut();
        let data = std::mem::take(output);
        self.total_output += data.len();
        if self.total_output > self.max_output_size {
            return Err(ComprsError::SizeLimit {
                context: "gzip stream decompress",
                limit: self.max_output_size,
            });
        }
        Ok(data)
    }

    pub fn finish(&mut self) -> Result<Vec<u8>, ComprsError> {
        let decoder = self
            .decoder
            .take()
            .ok_or(ComprsError::StreamFinished("gzip stream"))?;

        decoder.finish().map_err(|e| ComprsError::Operation {
            context: "gzip stream finish",
            source: e.into(),
        })
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
    decoder: Option<DeflateDecoder<Vec<u8>>>,
    total_output: usize,
    max_output_size: usize,
}

impl DeflateDecompressContext {
    pub fn new(max_output_size: Option<f64>) -> Result<Self, ComprsError> {
        let max_size = crate::validate_max_output_size(max_output_size)?;
        let decoder = DeflateDecoder::new(Vec::new());
        Ok(Self {
            decoder: Some(decoder),
            total_output: 0,
            max_output_size: max_size,
        })
    }

    pub fn transform(&mut self, chunk: &[u8]) -> Result<Vec<u8>, ComprsError> {
        let decoder = self
            .decoder
            .as_mut()
            .ok_or(ComprsError::StreamFinished("deflate stream"))?;

        decoder
            .write_all(chunk)
            .map_err(|e| ComprsError::Operation {
                context: "deflate stream decompress",
                source: e.into(),
            })?;

        let output = decoder.get_mut();
        let data = std::mem::take(output);
        self.total_output += data.len();
        if self.total_output > self.max_output_size {
            return Err(ComprsError::SizeLimit {
                context: "deflate stream decompress",
                limit: self.max_output_size,
            });
        }
        Ok(data)
    }

    pub fn flush(&mut self) -> Result<Vec<u8>, ComprsError> {
        let decoder = self
            .decoder
            .as_mut()
            .ok_or(ComprsError::StreamFinished("deflate stream"))?;

        decoder.flush().map_err(|e| ComprsError::Operation {
            context: "deflate stream flush",
            source: e.into(),
        })?;

        let output = decoder.get_mut();
        let data = std::mem::take(output);
        self.total_output += data.len();
        if self.total_output > self.max_output_size {
            return Err(ComprsError::SizeLimit {
                context: "deflate stream decompress",
                limit: self.max_output_size,
            });
        }
        Ok(data)
    }

    pub fn finish(&mut self) -> Result<Vec<u8>, ComprsError> {
        let decoder = self
            .decoder
            .take()
            .ok_or(ComprsError::StreamFinished("deflate stream"))?;

        decoder.finish().map_err(|e| ComprsError::Operation {
            context: "deflate stream finish",
            source: e.into(),
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
