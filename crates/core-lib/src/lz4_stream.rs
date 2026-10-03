//! LZ4 frame streaming compression and decompression.

use std::io::Write;

use lz4_flex::frame::FrameEncoder;

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
    /// Whether any compressed input has been received.
    received_input: bool,
}

impl DecompressContext {
    pub fn new(max_output_size: Option<f64>) -> Result<Self, ComprsError> {
        let max_size = crate::validate_max_output_size(max_output_size)?;
        Ok(Self {
            buffer: Vec::new(),
            max_output_size: max_size,
            received_input: false,
        })
    }

    /// Buffer a chunk of compressed data.
    /// Returns an empty Vec (decompressed output is produced in `flush()`).
    pub fn transform(&mut self, chunk: &[u8]) -> Result<Vec<u8>, ComprsError> {
        self.buffer.extend_from_slice(chunk);
        self.received_input |= !chunk.is_empty();
        Ok(Vec::new())
    }

    /// Decompress all buffered data and return the result.
    ///
    /// Like [`crate::lz4::decompress`], it decodes every frame, skipping
    /// skippable frames. Fails with [`ComprsError::Truncated`] when no input
    /// was received at all or the input ends inside a frame, and with
    /// [`ComprsError::Operation`] when data that is not a frame follows a
    /// frame. Calling it again after a successful call returns an empty Vec.
    pub fn flush(&mut self) -> Result<Vec<u8>, ComprsError> {
        if self.buffer.is_empty() {
            if !self.received_input {
                return Err(ComprsError::Truncated("lz4"));
            }
            return Ok(Vec::new());
        }

        let result = crate::lz4::decompress_frames(
            &self.buffer,
            self.max_output_size,
            "lz4 stream decompress",
        )?;
        self.buffer.clear();
        Ok(result)
    }
}

#[cfg(test)]
mod tests {
    use std::io::Read;

    use lz4_flex::frame::FrameDecoder;

    use super::*;

    #[test]
    fn decompress_context_rejects_empty_input() {
        let mut ctx = DecompressContext::new(None).unwrap();
        ctx.transform(&[]).unwrap();
        assert!(matches!(ctx.flush(), Err(ComprsError::Truncated("lz4"))));
    }

    #[test]
    fn decompress_context_flush_is_repeatable() {
        let compressed = crate::lz4::compress(b"lz4 stream").unwrap();
        let mut ctx = DecompressContext::new(None).unwrap();
        ctx.transform(&compressed).unwrap();
        assert_eq!(ctx.flush().unwrap(), b"lz4 stream");
        assert!(ctx.flush().unwrap().is_empty());
    }

    /// Compress `data` with a [`CompressContext`], in chunks of 1000 bytes.
    fn compress_in_chunks(data: &[u8]) -> Vec<u8> {
        let mut ctx = CompressContext::new().unwrap();
        let mut compressed = Vec::new();
        for chunk in data.chunks(1000) {
            compressed.extend(ctx.transform(chunk).unwrap());
        }
        compressed.extend(ctx.flush().unwrap());
        compressed.extend(ctx.finish().unwrap());
        compressed
    }

    /// Decompress `input` with a [`DecompressContext`], in chunks of 7 bytes.
    fn decompress_in_chunks(
        input: &[u8],
        max_output_size: Option<f64>,
    ) -> Result<Vec<u8>, ComprsError> {
        let mut ctx = DecompressContext::new(max_output_size).unwrap();
        for chunk in input.chunks(7) {
            assert!(ctx.transform(chunk).unwrap().is_empty());
        }
        ctx.flush()
    }

    #[test]
    fn decompress_context_reads_every_frame() {
        let a = compress_in_chunks(b"Hello ");
        let b = crate::lz4::compress(b"World").unwrap();
        let skippable = [&0x184D_2A50_u32.to_le_bytes()[..], &[3, 0, 0, 0, 1, 2, 3]].concat();
        let input = [
            &skippable[..],
            &a[..],
            &skippable[..],
            &b[..],
            &skippable[..],
        ]
        .concat();
        assert_eq!(decompress_in_chunks(&input, None).unwrap(), b"Hello World");
        assert_eq!(
            decompress_in_chunks(&input, Some(11.0)).unwrap(),
            b"Hello World"
        );
        assert!(matches!(
            decompress_in_chunks(&input, Some(10.0)),
            Err(ComprsError::SizeLimit { limit: 10, .. })
        ));
    }

    #[test]
    fn decompress_context_rejects_truncated_input() {
        let frame = compress_in_chunks(&b"truncated lz4 stream. ".repeat(100));
        let concatenated = [&frame[..], &frame[..]].concat();
        for len in [1, 4, 7, frame.len() / 2, frame.len() - 8, frame.len() - 1] {
            for input in [&frame[..len], &concatenated[..frame.len() + len]] {
                assert!(
                    matches!(
                        decompress_in_chunks(input, None),
                        Err(ComprsError::Truncated("lz4"))
                    ),
                    "input of {} bytes",
                    input.len()
                );
            }
        }
    }

    #[test]
    fn decompress_context_rejects_data_after_the_last_frame() {
        let mut input = compress_in_chunks(b"complete");
        input.extend(b"trailing");
        let err = decompress_in_chunks(&input, None).unwrap_err();
        assert_eq!(
            err.to_string(),
            "lz4 stream decompress failed: unexpected data after the end of a frame"
        );
    }

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
