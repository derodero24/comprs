//! LZ4 frame streaming compression and decompression.

use std::io::Write;

use lz4_flex::frame::{FrameDecoder, FrameEncoder};
use napi::bindgen_prelude::*;
use napi_derive::napi;

use crate::ZflateError;

/// Streaming LZ4 frame compression context.
///
/// Uses `FrameEncoder` internally to produce incremental compressed output
/// on each `transform()` call. A cursor tracks already-returned bytes, and
/// old bytes are drained periodically to bound memory usage.
#[napi]
pub struct Lz4CompressContext {
    encoder: Option<FrameEncoder<Vec<u8>>>,
    cursor: usize,
}

#[napi]
impl Lz4CompressContext {
    #[napi(constructor)]
    pub fn new() -> Result<Self> {
        let encoder = FrameEncoder::new(Vec::new());
        Ok(Self {
            encoder: Some(encoder),
            cursor: 0,
        })
    }

    /// Compress a chunk of data. Returns any compressed output produced so far.
    #[napi]
    pub fn transform(&mut self, chunk: Either<Buffer, Uint8Array>) -> Result<Buffer> {
        let encoder = self
            .encoder
            .as_mut()
            .ok_or_else(|| napi::Error::from(ZflateError::StreamFinished("lz4 stream")))?;

        let input = crate::as_bytes(&chunk);
        encoder.write_all(input).map_err(|e| {
            napi::Error::from(ZflateError::Operation {
                context: "lz4 stream compress",
                source: e.into(),
            })
        })?;

        let output = encoder.get_mut();
        let new_bytes = output[self.cursor..].to_vec();
        output.drain(..self.cursor);
        self.cursor = output.len();
        Ok(new_bytes.into())
    }

    /// Flush the encoder's internal buffer. Returns any buffered compressed data.
    #[napi]
    pub fn flush(&mut self) -> Result<Buffer> {
        let encoder = self
            .encoder
            .as_mut()
            .ok_or_else(|| napi::Error::from(ZflateError::StreamFinished("lz4 stream")))?;

        encoder.flush().map_err(|e| {
            napi::Error::from(ZflateError::Operation {
                context: "lz4 stream flush",
                source: e.into(),
            })
        })?;

        let output = encoder.get_mut();
        let new_bytes = output[self.cursor..].to_vec();
        output.drain(..self.cursor);
        self.cursor = output.len();
        Ok(new_bytes.into())
    }

    /// Finalize the compression stream. Writes the LZ4 frame footer.
    /// Must be called once after all data has been transformed.
    #[napi]
    pub fn finish(&mut self) -> Result<Buffer> {
        let encoder = self
            .encoder
            .take()
            .ok_or_else(|| napi::Error::from(ZflateError::StreamFinished("lz4 stream")))?;

        let output = encoder.finish().map_err(|e| {
            napi::Error::from(ZflateError::Operation {
                context: "lz4 stream finish",
                source: e.into(),
            })
        })?;

        Ok(output[self.cursor..].to_vec().into())
    }
}

/// Streaming LZ4 frame decompression context.
///
/// Buffers compressed input and decompresses on `flush()`.
/// LZ4 frame decompression requires the full compressed input, so true
/// incremental streaming is not possible with the current lz4_flex API.
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
    use std::io::Read;

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
