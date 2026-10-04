//! LZ4 frame streaming compression and decompression.

use std::io::Write;

use lz4_flex::frame::FrameEncoder;

use crate::{ComprsError, MemoryUsage};

/// Heap memory of a frame encoder with the default 64 KiB blocks: a 16 KiB
/// hash table, and an input block and an output block that it allocates
/// with the first data.
const ENCODER_STATE_SIZE: usize =
    16 * 1024 + 64 * 1024 + lz4_flex::block::get_maximum_output_size(64 * 1024);

/// Streaming LZ4 frame compression context.
///
/// Uses `FrameEncoder` internally to produce incremental compressed output
/// on each `transform()` call: each call takes the bytes that the encoder
/// has written to its output Vec so far. The frame carries a content
/// checksum, like the output of [`crate::lz4::compress`].
pub struct CompressContext {
    encoder: Option<FrameEncoder<Vec<u8>>>,
}

impl CompressContext {
    pub fn new() -> Result<Self, ComprsError> {
        let encoder = crate::lz4::frame_encoder(Vec::new());
        Ok(Self {
            encoder: Some(encoder),
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

        Ok(std::mem::take(encoder.get_mut()))
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

        Ok(std::mem::take(encoder.get_mut()))
    }

    pub fn finish(&mut self) -> Result<Vec<u8>, ComprsError> {
        let encoder = self
            .encoder
            .take()
            .ok_or(ComprsError::StreamFinished("lz4 stream"))?;

        // The encoder's Vec holds only what earlier calls have not returned.
        encoder.finish().map_err(|e| ComprsError::Operation {
            context: "lz4 stream finish",
            source: e.into(),
        })
    }
}

impl MemoryUsage for CompressContext {
    fn memory_usage(&self) -> usize {
        self.encoder.as_ref().map_or(0, |encoder| {
            ENCODER_STATE_SIZE + encoder.get_ref().capacity()
        })
    }
}

/// Streaming LZ4 frame decompression context.
///
/// Buffers compressed input and decompresses on `flush()`.
/// LZ4 frame decompression requires the full compressed input, so true
/// incremental streaming is not possible with the current lz4_flex API.
pub struct DecompressContext {
    /// Compressed input that has not been decoded yet; `None` once the
    /// stream is finished.
    buffer: Option<Vec<u8>>,
    max_output_size: usize,
    /// Whether any compressed input has been received.
    received_input: bool,
}

impl DecompressContext {
    pub fn new(max_output_size: Option<f64>) -> Result<Self, ComprsError> {
        let max_size = crate::validate_max_output_size(max_output_size)?;
        Ok(Self {
            buffer: Some(Vec::new()),
            max_output_size: max_size,
            received_input: false,
        })
    }

    /// Buffer a chunk of compressed data.
    /// Returns an empty Vec (decompressed output is produced in `flush()`).
    pub fn transform(&mut self, chunk: &[u8]) -> Result<Vec<u8>, ComprsError> {
        self.buffer
            .as_mut()
            .ok_or(ComprsError::StreamFinished("lz4 stream"))?
            .extend_from_slice(chunk);
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
        let buffer = self
            .buffer
            .as_mut()
            .ok_or(ComprsError::StreamFinished("lz4 stream"))?;
        if buffer.is_empty() {
            if !self.received_input {
                return Err(ComprsError::Truncated("lz4"));
            }
            return Ok(Vec::new());
        }

        let result =
            crate::lz4::decompress_frames(buffer, self.max_output_size, "lz4 stream decompress")?;
        buffer.clear();
        Ok(result)
    }

    /// Decompress the remaining buffered data, like [`Self::flush`], and end
    /// the stream: it releases the buffer, and later calls fail.
    pub fn finish(&mut self) -> Result<Vec<u8>, ComprsError> {
        let output = self.flush();
        self.buffer = None;
        output
    }
}

impl MemoryUsage for DecompressContext {
    fn memory_usage(&self) -> usize {
        self.buffer.as_ref().map_or(0, Vec::capacity)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decompress_context_rejects_empty_input() {
        let mut ctx = DecompressContext::new(None).unwrap();
        ctx.transform(&[]).unwrap();
        assert!(matches!(ctx.flush(), Err(ComprsError::Truncated("lz4"))));
    }

    #[test]
    fn decompress_context_finish_decodes_and_ends_the_stream() {
        let compressed = crate::lz4::compress(b"lz4 stream").unwrap();
        let mut ctx = DecompressContext::new(None).unwrap();
        ctx.transform(&compressed).unwrap();
        assert!(ctx.memory_usage() >= compressed.len());
        assert_eq!(ctx.finish().unwrap(), b"lz4 stream");
        assert_eq!(ctx.memory_usage(), 0);
        assert!(matches!(
            ctx.transform(&compressed),
            Err(ComprsError::StreamFinished("lz4 stream"))
        ));
        assert!(matches!(ctx.flush(), Err(ComprsError::StreamFinished(_))));
        assert!(matches!(ctx.finish(), Err(ComprsError::StreamFinished(_))));

        // After flush(), nothing is left to decode.
        let mut ctx = DecompressContext::new(None).unwrap();
        ctx.transform(&compressed).unwrap();
        assert_eq!(ctx.flush().unwrap(), b"lz4 stream");
        assert!(ctx.finish().unwrap().is_empty());

        let mut ctx = DecompressContext::new(None).unwrap();
        assert!(matches!(ctx.finish(), Err(ComprsError::Truncated("lz4"))));
        assert!(matches!(ctx.finish(), Err(ComprsError::StreamFinished(_))));
    }

    #[test]
    fn compress_context_reports_the_encoder_state() {
        let mut ctx = CompressContext::new().unwrap();
        ctx.transform(b"lz4 stream").unwrap();
        assert!(ctx.memory_usage() >= ENCODER_STATE_SIZE);
        ctx.finish().unwrap();
        assert_eq!(ctx.memory_usage(), 0);
    }

    #[test]
    fn compress_context_returns_everything_the_encoder_writes() {
        // Several 64 KiB blocks, some of them stored uncompressed.
        let mut state = 0x2545_f491_4f6c_dd1du64;
        let data: Vec<u8> = (0..200_000u32)
            .map(|i| {
                state ^= state << 13;
                state ^= state >> 7;
                state ^= state << 17;
                if i / 50_000 % 2 == 0 {
                    state as u8
                } else {
                    (i % 7) as u8
                }
            })
            .collect();
        for chunk_size in [1, 1000, 64 * 1024] {
            let mut ctx = CompressContext::new().unwrap();
            let mut encoder = crate::lz4::frame_encoder(Vec::new());
            let mut compressed = Vec::new();
            for chunk in data.chunks(chunk_size) {
                compressed.extend(ctx.transform(chunk).unwrap());
                encoder.write_all(chunk).unwrap();
                // The context keeps no output that it has returned.
                assert_eq!(ctx.memory_usage(), ENCODER_STATE_SIZE);
            }
            compressed.extend(ctx.flush().unwrap());
            compressed.extend(ctx.finish().unwrap());
            encoder.flush().unwrap();
            assert_eq!(
                compressed,
                encoder.finish().unwrap(),
                "chunk size {chunk_size}"
            );
            assert_eq!(crate::lz4::decompress(&compressed).unwrap(), data);
        }
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
    fn compress_context_writes_a_content_checksum() {
        let original = b"lz4 stream with a content checksum. ".repeat(100);
        let mut compressed = compress_in_chunks(&original);
        // FLG: version 01, independent blocks, content checksum.
        assert_eq!(compressed[4], 0x64);
        assert_eq!(decompress_in_chunks(&compressed, None).unwrap(), original);

        // The last 5 bytes of a block are literals.
        let last_literal = compressed.len() - 9;
        compressed[last_literal] ^= 0x01;
        let err = decompress_in_chunks(&compressed, None).unwrap_err();
        assert!(err.to_string().contains("ContentChecksumError"), "{err}");
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
}
