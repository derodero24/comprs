//! Brotli streaming compression and decompression.

use std::io::Write;

use napi::bindgen_prelude::*;
use napi_derive::napi;

use crate::ZflateError;

/// Default compression quality for brotli.
const DEFAULT_QUALITY: u32 = 6;

/// Default buffer size for brotli operations.
const BUFFER_SIZE: usize = 4096;

/// Default log2 of the sliding window size for brotli.
const LG_WINDOW_SIZE: u32 = 22;

/// Streaming brotli compression context.
///
/// Maintains internal compression state across multiple `transform` calls,
/// enabling chunked compression without losing cross-chunk context.
#[napi]
pub struct BrotliCompressContext {
    compressor: Option<brotli::CompressorWriter<Vec<u8>>>,
}

#[napi]
impl BrotliCompressContext {
    #[napi(constructor)]
    pub fn new(quality: Option<u32>) -> Result<Self> {
        let quality = quality.unwrap_or(DEFAULT_QUALITY);
        if quality > 11 {
            return Err(ZflateError::InvalidArg(
                "brotli quality must be between 0 and 11".to_string(),
            )
            .into());
        }
        let compressor =
            brotli::CompressorWriter::new(Vec::new(), BUFFER_SIZE, quality, LG_WINDOW_SIZE);
        Ok(Self {
            compressor: Some(compressor),
        })
    }

    /// Compress a chunk of data. Returns compressed output (may be empty if
    /// the compressor is buffering data internally).
    #[napi]
    pub fn transform(&mut self, chunk: Either<Buffer, Uint8Array>) -> Result<Buffer> {
        let compressor = self
            .compressor
            .as_mut()
            .ok_or_else(|| napi::Error::from(ZflateError::StreamFinished("brotli stream")))?;

        compressor.write_all(crate::as_bytes(&chunk)).map_err(|e| {
            napi::Error::from(ZflateError::Operation {
                context: "brotli stream compress",
                source: e.into(),
            })
        })?;

        // Drain whatever the compressor has flushed to the inner Vec
        let data = std::mem::take(compressor.get_mut());
        Ok(data.into())
    }

    /// Flush the compressor's internal buffer. Returns any buffered compressed data.
    #[napi]
    pub fn flush(&mut self) -> Result<Buffer> {
        let compressor = self
            .compressor
            .as_mut()
            .ok_or_else(|| napi::Error::from(ZflateError::StreamFinished("brotli stream")))?;

        compressor.flush().map_err(|e| {
            napi::Error::from(ZflateError::Operation {
                context: "brotli stream flush",
                source: e.into(),
            })
        })?;

        let data = std::mem::take(compressor.get_mut());
        Ok(data.into())
    }

    /// Finalize the compression stream. Writes the brotli stream footer.
    /// Must be called once after all data has been transformed.
    #[napi]
    pub fn finish(&mut self) -> Result<Buffer> {
        let compressor = self
            .compressor
            .take()
            .ok_or_else(|| napi::Error::from(ZflateError::StreamFinished("brotli stream")))?;

        // into_inner drops the CompressorWriter, which flushes remaining data
        // and writes the brotli stream end marker
        let output = compressor.into_inner();
        Ok(output.into())
    }
}

/// Streaming brotli decompression context.
///
/// Maintains internal decompression state across multiple `transform` calls,
/// enabling chunked decompression of a brotli stream.
#[napi]
pub struct BrotliDecompressContext {
    decompressor: brotli::DecompressorWriter<Vec<u8>>,
    total_output: usize,
    max_output_size: usize,
}

#[napi]
impl BrotliDecompressContext {
    #[napi(constructor)]
    pub fn new(max_output_size: Option<f64>) -> Result<Self> {
        let max_size = crate::validate_max_output_size(max_output_size)?;
        let decompressor = brotli::DecompressorWriter::new(Vec::new(), BUFFER_SIZE);
        Ok(Self {
            decompressor,
            total_output: 0,
            max_output_size: max_size,
        })
    }

    /// Decompress a chunk of compressed data. Returns decompressed output
    /// (may be empty if the decompressor needs more data).
    #[napi]
    pub fn transform(&mut self, chunk: Either<Buffer, Uint8Array>) -> Result<Buffer> {
        self.decompressor
            .write_all(crate::as_bytes(&chunk))
            .map_err(|e| {
                napi::Error::from(ZflateError::Operation {
                    context: "brotli stream decompress",
                    source: e.into(),
                })
            })?;

        // Drain whatever the decompressor has written to the inner Vec
        let data = std::mem::take(self.decompressor.get_mut());
        self.total_output += data.len();
        if self.total_output > self.max_output_size {
            return Err(ZflateError::SizeLimit {
                context: "brotli stream decompress",
                limit: self.max_output_size,
            }
            .into());
        }
        Ok(data.into())
    }

    /// Flush the decompressor's internal buffer. Returns any buffered decompressed data.
    #[napi]
    pub fn flush(&mut self) -> Result<Buffer> {
        self.decompressor.flush().map_err(|e| {
            napi::Error::from(ZflateError::Operation {
                context: "brotli stream flush",
                source: e.into(),
            })
        })?;

        let data = std::mem::take(self.decompressor.get_mut());
        self.total_output += data.len();
        if self.total_output > self.max_output_size {
            return Err(ZflateError::SizeLimit {
                context: "brotli stream decompress",
                limit: self.max_output_size,
            }
            .into());
        }
        Ok(data.into())
    }
}

#[cfg(test)]
mod tests {
    use std::io::{Read, Write};

    /// Default compression quality for brotli.
    const DEFAULT_QUALITY: u32 = 6;

    /// Default buffer size for brotli operations.
    const BUFFER_SIZE: usize = 4096;

    /// Default log2 of the sliding window size for brotli.
    const LG_WINDOW_SIZE: u32 = 22;

    #[test]
    fn stream_round_trip() {
        let original = b"Hello, zflate streaming! ".repeat(100);

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
