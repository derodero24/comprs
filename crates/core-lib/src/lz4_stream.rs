//! LZ4 frame streaming compression and decompression.

use std::io::Write;

use lz4_flex::frame::{FrameDecoder, FrameEncoder};

use crate::ComprsError;

/// Streaming LZ4 frame compression context.
///
/// Uses `FrameEncoder` internally to produce incremental compressed output
/// on each `transform()` call. A cursor tracks already-returned bytes, and
/// old bytes are drained periodically to bound memory usage.
pub struct CompressContext {
    encoder: Option<FrameEncoder<Vec<u8>>>,
    cursor: usize,
}

impl CompressContext {
    pub fn new() -> Result<Self, ComprsError> {
        let encoder = FrameEncoder::new(Vec::new());
        Ok(Self {
            encoder: Some(encoder),
            cursor: 0,
        })
    }

    pub fn transform(&mut self, chunk: &[u8]) -> Result<Vec<u8>, ComprsError> {
        let encoder = self
            .encoder
            .as_mut()
            .ok_or(ComprsError::StreamFinished("lz4 stream"))?;

        encoder
            .write_all(chunk)
            .map_err(|e| ComprsError::Operation {
                context: "lz4 stream compress",
                source: e.into(),
            })?;

        let output = encoder.get_mut();
        let new_bytes = output[self.cursor..].to_vec();
        output.drain(..self.cursor);
        self.cursor = output.len();
        Ok(new_bytes)
    }

    pub fn flush(&mut self) -> Result<Vec<u8>, ComprsError> {
        let encoder = self
            .encoder
            .as_mut()
            .ok_or(ComprsError::StreamFinished("lz4 stream"))?;

        encoder.flush().map_err(|e| ComprsError::Operation {
            context: "lz4 stream flush",
            source: e.into(),
        })?;

        let output = encoder.get_mut();
        let new_bytes = output[self.cursor..].to_vec();
        output.drain(..self.cursor);
        self.cursor = output.len();
        Ok(new_bytes)
    }

    pub fn finish(&mut self) -> Result<Vec<u8>, ComprsError> {
        let encoder = self
            .encoder
            .take()
            .ok_or(ComprsError::StreamFinished("lz4 stream"))?;

        let cursor = self.cursor;
        let output = encoder.finish().map_err(|e| ComprsError::Operation {
            context: "lz4 stream finish",
            source: e.into(),
        })?;

        Ok(output[cursor..].to_vec())
    }
}

/// Streaming LZ4 frame decompression context.
///
/// Buffers compressed input and decompresses on `flush()`.
/// LZ4 frame decompression requires the full compressed input, so true
/// incremental streaming is not possible with the current lz4_flex API.
pub struct DecompressContext {
    buffer: Vec<u8>,
    max_output_size: usize,
}

impl DecompressContext {
    pub fn new(max_output_size: Option<f64>) -> Result<Self, ComprsError> {
        let max_size = crate::validate_max_output_size(max_output_size)?;
        Ok(Self {
            buffer: Vec::new(),
            max_output_size: max_size,
        })
    }

    /// Buffer a chunk of compressed data.
    /// Returns an empty Vec (decompressed output is produced in `flush()`).
    pub fn transform(&mut self, chunk: &[u8]) -> Result<Vec<u8>, ComprsError> {
        self.buffer.extend_from_slice(chunk);
        Ok(Vec::new())
    }

    /// Decompress all buffered data and return the result.
    pub fn flush(&mut self) -> Result<Vec<u8>, ComprsError> {
        if self.buffer.is_empty() {
            return Ok(Vec::new());
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
        Ok(result)
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
