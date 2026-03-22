//! LZ4 frame streaming compression and decompression.

use std::io::Write;

use lz4_flex::frame::{FrameDecoder, FrameEncoder};
use napi::bindgen_prelude::*;
use napi_derive::napi;

use crate::ZflateError;

/// Streaming LZ4 frame compression context.
///
/// Buffers input data and produces the compressed LZ4 frame on `finish()`.
/// LZ4 frame format requires finalization to write a valid frame footer.
#[napi]
pub struct Lz4CompressContext {
    buffer: Option<Vec<u8>>,
}

#[napi]
impl Lz4CompressContext {
    #[napi(constructor)]
    pub fn new() -> Result<Self> {
        Ok(Self {
            buffer: Some(Vec::new()),
        })
    }

    /// Buffer a chunk of data for compression.
    /// Returns an empty buffer (compressed output is produced in `finish()`).
    #[napi]
    pub fn transform(&mut self, chunk: Either<Buffer, Uint8Array>) -> Result<Buffer> {
        let buf = self
            .buffer
            .as_mut()
            .ok_or_else(|| napi::Error::from(ZflateError::StreamFinished("lz4 stream")))?;

        buf.extend_from_slice(crate::as_bytes(&chunk));
        Ok(Buffer::from(Vec::<u8>::new()))
    }

    /// Flush the encoder's internal buffer. Returns empty (all output in `finish()`).
    #[napi]
    pub fn flush(&mut self) -> Result<Buffer> {
        if self.buffer.is_none() {
            return Err(ZflateError::StreamFinished("lz4 stream").into());
        }
        Ok(Buffer::from(Vec::<u8>::new()))
    }

    /// Finalize the compression stream. Compresses all buffered data and
    /// returns the complete LZ4 frame.
    #[napi]
    pub fn finish(&mut self) -> Result<Buffer> {
        let data = self
            .buffer
            .take()
            .ok_or_else(|| napi::Error::from(ZflateError::StreamFinished("lz4 stream")))?;

        let mut output = Vec::with_capacity(data.len());
        let mut encoder = FrameEncoder::new(&mut output);
        encoder.write_all(&data).map_err(|e| {
            napi::Error::from(ZflateError::Operation {
                context: "lz4 stream compress",
                source: e.into(),
            })
        })?;
        encoder.finish().map_err(|e| {
            napi::Error::from(ZflateError::Operation {
                context: "lz4 stream finish",
                source: e.into(),
            })
        })?;

        Ok(output.into())
    }
}

/// Streaming LZ4 frame decompression context.
///
/// Buffers compressed input and decompresses on `flush()`.
#[napi]
pub struct Lz4DecompressContext {
    buffer: Vec<u8>,
    max_output_size: usize,
}

#[napi]
impl Lz4DecompressContext {
    #[napi(constructor)]
    pub fn new(max_output_size: Option<f64>) -> Result<Self> {
        let max_size = crate::validate_max_output_size(max_output_size)?;
        Ok(Self {
            buffer: Vec::new(),
            max_output_size: max_size,
        })
    }

    /// Buffer a chunk of compressed data.
    /// Returns an empty buffer (decompressed output is produced in `flush()`).
    #[napi]
    pub fn transform(&mut self, chunk: Either<Buffer, Uint8Array>) -> Result<Buffer> {
        self.buffer.extend_from_slice(crate::as_bytes(&chunk));
        Ok(Buffer::from(Vec::<u8>::new()))
    }

    /// Decompress all buffered data and return the result.
    #[napi]
    pub fn flush(&mut self) -> Result<Buffer> {
        if self.buffer.is_empty() {
            return Ok(Buffer::from(Vec::<u8>::new()));
        }

        let decoder = FrameDecoder::new(self.buffer.as_slice());
        let init_cap = self
            .buffer
            .len()
            .saturating_mul(4)
            .min(self.max_output_size);
        let result = crate::decompress_with_limit(
            decoder,
            self.max_output_size,
            init_cap,
            "lz4 stream decompress",
        )?;
        self.buffer.clear();
        Ok(result.into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stream_round_trip() {
        let original = b"Hello, LZ4 streaming! ".repeat(100);

        // Compress
        let mut compressed = Vec::new();
        let mut encoder = FrameEncoder::new(&mut compressed);
        for chunk in original.chunks(256) {
            encoder.write_all(chunk).unwrap();
        }
        encoder.finish().unwrap();

        // Decompress
        let mut decoder = FrameDecoder::new(compressed.as_slice());
        let mut decompressed = Vec::new();
        decoder.read_to_end(&mut decompressed).unwrap();

        assert_eq!(original.as_slice(), decompressed.as_slice());
    }

    #[test]
    fn stream_empty_input() {
        let mut compressed = Vec::new();
        let encoder = FrameEncoder::new(&mut compressed);
        encoder.finish().unwrap();

        assert!(!compressed.is_empty());

        let mut decoder = FrameDecoder::new(compressed.as_slice());
        let mut decompressed = Vec::new();
        decoder.read_to_end(&mut decompressed).unwrap();
        assert!(decompressed.is_empty());
    }
}
