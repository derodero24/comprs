//! Zstandard streaming compression and decompression.

use zstd::stream::raw::{Decoder, Encoder, InBuffer, Operation, OutBuffer};

use crate::ComprsError;

/// Default compression level for zstd (same as the C library default).
pub const DEFAULT_LEVEL: i32 = 3;

/// Initial output buffer size for streaming operations.
const INITIAL_BUF_SIZE: usize = 128 * 1024;

/// Streaming zstd compression context.
pub struct CompressContext {
    encoder: Option<Encoder<'static>>,
}

impl CompressContext {
    pub fn new(level: Option<i32>) -> Result<Self, ComprsError> {
        let level = level.unwrap_or(DEFAULT_LEVEL);
        if !(-131072..=22).contains(&level) {
            return Err(ComprsError::InvalidArg(
                "zstd compression level must be between -131072 and 22".to_string(),
            ));
        }
        let encoder = Encoder::new(level).map_err(|e| ComprsError::Creation {
            context: "zstd encoder",
            source: e.into(),
        })?;
        Ok(Self {
            encoder: Some(encoder),
        })
    }

    pub fn transform(&mut self, chunk: &[u8]) -> Result<Vec<u8>, ComprsError> {
        let encoder = self
            .encoder
            .as_mut()
            .ok_or(ComprsError::StreamFinished("zstd stream"))?;

        let bound = zstd::zstd_safe::compress_bound(chunk.len());
        let mut output = vec![0u8; bound.max(INITIAL_BUF_SIZE)];

        let mut in_buf = InBuffer::around(chunk);
        let mut total_written = 0;

        while in_buf.pos() < in_buf.src.len() {
            let mut out_buf = OutBuffer::around_pos(&mut output, total_written);
            encoder
                .run(&mut in_buf, &mut out_buf)
                .map_err(|e| ComprsError::Operation {
                    context: "zstd stream compress",
                    source: e.into(),
                })?;
            total_written = out_buf.pos();
            if total_written >= output.len() {
                output.resize(output.len() * 2, 0);
            }
        }

        output.truncate(total_written);
        Ok(output)
    }

    pub fn flush(&mut self) -> Result<Vec<u8>, ComprsError> {
        let encoder = self
            .encoder
            .as_mut()
            .ok_or(ComprsError::StreamFinished("zstd stream"))?;

        let mut output = vec![0u8; INITIAL_BUF_SIZE];
        let mut total_written = 0;

        loop {
            let mut out_buf = OutBuffer::around_pos(&mut output, total_written);
            let remaining = encoder
                .flush(&mut out_buf)
                .map_err(|e| ComprsError::Operation {
                    context: "zstd stream flush",
                    source: e.into(),
                })?;
            total_written = out_buf.pos();
            if remaining == 0 {
                break;
            }
            if total_written >= output.len() {
                output.resize(output.len() * 2, 0);
            }
        }

        output.truncate(total_written);
        Ok(output)
    }

    pub fn finish(&mut self) -> Result<Vec<u8>, ComprsError> {
        let mut encoder = self
            .encoder
            .take()
            .ok_or(ComprsError::StreamFinished("zstd stream"))?;

        let mut output = vec![0u8; INITIAL_BUF_SIZE];
        let mut total_written = 0;

        loop {
            let mut out_buf = OutBuffer::around_pos(&mut output, total_written);
            let remaining =
                encoder
                    .finish(&mut out_buf, true)
                    .map_err(|e| ComprsError::Operation {
                        context: "zstd stream finish",
                        source: e.into(),
                    })?;
            total_written = out_buf.pos();
            if remaining == 0 {
                break;
            }
            if total_written >= output.len() {
                output.resize(output.len() * 2, 0);
            }
        }

        output.truncate(total_written);
        Ok(output)
    }
}

/// Streaming zstd decompression context.
pub struct DecompressContext {
    decoder: Decoder<'static>,
    total_output: usize,
    max_output_size: usize,
}

impl DecompressContext {
    pub fn new(max_output_size: Option<f64>) -> Result<Self, ComprsError> {
        let max_size = crate::validate_max_output_size(max_output_size)?;
        let decoder = Decoder::new().map_err(|e| ComprsError::Creation {
            context: "zstd decoder",
            source: e.into(),
        })?;
        Ok(Self {
            decoder,
            total_output: 0,
            max_output_size: max_size,
        })
    }

    pub fn transform(&mut self, chunk: &[u8]) -> Result<Vec<u8>, ComprsError> {
        let mut output = vec![0u8; chunk.len().max(INITIAL_BUF_SIZE)];

        let mut in_buf = InBuffer::around(chunk);
        let mut total_written = 0;

        while in_buf.pos() < in_buf.src.len() {
            let mut out_buf = OutBuffer::around_pos(&mut output, total_written);
            self.decoder
                .run(&mut in_buf, &mut out_buf)
                .map_err(|e| ComprsError::Operation {
                    context: "zstd stream decompress",
                    source: e.into(),
                })?;
            total_written = out_buf.pos();
            if self.total_output + total_written > self.max_output_size {
                return Err(ComprsError::SizeLimit {
                    context: "zstd stream decompress",
                    limit: self.max_output_size,
                });
            }
            if total_written >= output.len() {
                output.resize(output.len() * 2, 0);
            }
        }

        self.total_output += total_written;
        output.truncate(total_written);
        Ok(output)
    }

    pub fn flush(&mut self) -> Result<Vec<u8>, ComprsError> {
        let mut output = vec![0u8; INITIAL_BUF_SIZE];
        let mut total_written = 0;

        loop {
            let mut out_buf = OutBuffer::around_pos(&mut output, total_written);
            let remaining =
                self.decoder
                    .flush(&mut out_buf)
                    .map_err(|e| ComprsError::Operation {
                        context: "zstd stream flush",
                        source: e.into(),
                    })?;
            total_written = out_buf.pos();
            if remaining == 0 {
                break;
            }
            if total_written >= output.len() {
                output.resize(output.len() * 2, 0);
            }
        }

        output.truncate(total_written);
        Ok(output)
    }
}

/// Streaming zstd compression context with dictionary.
pub struct CompressDictContext {
    encoder: Option<Encoder<'static>>,
}

impl CompressDictContext {
    pub fn new(dict: &[u8], level: Option<i32>) -> Result<Self, ComprsError> {
        let level = level.unwrap_or(DEFAULT_LEVEL);
        if !(-131072..=22).contains(&level) {
            return Err(ComprsError::InvalidArg(
                "zstd compression level must be between -131072 and 22".to_string(),
            ));
        }
        let encoder = Encoder::with_dictionary(level, dict).map_err(|e| ComprsError::Creation {
            context: "zstd dict encoder",
            source: e.into(),
        })?;
        Ok(Self {
            encoder: Some(encoder),
        })
    }

    pub fn transform(&mut self, chunk: &[u8]) -> Result<Vec<u8>, ComprsError> {
        let encoder = self
            .encoder
            .as_mut()
            .ok_or(ComprsError::StreamFinished("zstd stream"))?;

        let bound = zstd::zstd_safe::compress_bound(chunk.len());
        let mut output = vec![0u8; bound.max(INITIAL_BUF_SIZE)];

        let mut in_buf = InBuffer::around(chunk);
        let mut total_written = 0;

        while in_buf.pos() < in_buf.src.len() {
            let mut out_buf = OutBuffer::around_pos(&mut output, total_written);
            encoder
                .run(&mut in_buf, &mut out_buf)
                .map_err(|e| ComprsError::Operation {
                    context: "zstd stream compress",
                    source: e.into(),
                })?;
            total_written = out_buf.pos();
            if total_written >= output.len() {
                output.resize(output.len() * 2, 0);
            }
        }

        output.truncate(total_written);
        Ok(output)
    }

    pub fn flush(&mut self) -> Result<Vec<u8>, ComprsError> {
        let encoder = self
            .encoder
            .as_mut()
            .ok_or(ComprsError::StreamFinished("zstd stream"))?;

        let mut output = vec![0u8; INITIAL_BUF_SIZE];
        let mut total_written = 0;

        loop {
            let mut out_buf = OutBuffer::around_pos(&mut output, total_written);
            let remaining = encoder
                .flush(&mut out_buf)
                .map_err(|e| ComprsError::Operation {
                    context: "zstd stream flush",
                    source: e.into(),
                })?;
            total_written = out_buf.pos();
            if remaining == 0 {
                break;
            }
            if total_written >= output.len() {
                output.resize(output.len() * 2, 0);
            }
        }

        output.truncate(total_written);
        Ok(output)
    }

    pub fn finish(&mut self) -> Result<Vec<u8>, ComprsError> {
        let mut encoder = self
            .encoder
            .take()
            .ok_or(ComprsError::StreamFinished("zstd stream"))?;

        let mut output = vec![0u8; INITIAL_BUF_SIZE];
        let mut total_written = 0;

        loop {
            let mut out_buf = OutBuffer::around_pos(&mut output, total_written);
            let remaining =
                encoder
                    .finish(&mut out_buf, true)
                    .map_err(|e| ComprsError::Operation {
                        context: "zstd stream finish",
                        source: e.into(),
                    })?;
            total_written = out_buf.pos();
            if remaining == 0 {
                break;
            }
            if total_written >= output.len() {
                output.resize(output.len() * 2, 0);
            }
        }

        output.truncate(total_written);
        Ok(output)
    }
}

/// Streaming zstd decompression context with dictionary.
pub struct DecompressDictContext {
    decoder: Decoder<'static>,
    total_output: usize,
    max_output_size: usize,
}

impl DecompressDictContext {
    pub fn new(dict: &[u8], max_output_size: Option<f64>) -> Result<Self, ComprsError> {
        let max_size = crate::validate_max_output_size(max_output_size)?;
        let decoder = Decoder::with_dictionary(dict).map_err(|e| ComprsError::Creation {
            context: "zstd dict decoder",
            source: e.into(),
        })?;
        Ok(Self {
            decoder,
            total_output: 0,
            max_output_size: max_size,
        })
    }

    pub fn transform(&mut self, chunk: &[u8]) -> Result<Vec<u8>, ComprsError> {
        let mut output = vec![0u8; chunk.len().max(INITIAL_BUF_SIZE)];

        let mut in_buf = InBuffer::around(chunk);
        let mut total_written = 0;

        while in_buf.pos() < in_buf.src.len() {
            let mut out_buf = OutBuffer::around_pos(&mut output, total_written);
            self.decoder
                .run(&mut in_buf, &mut out_buf)
                .map_err(|e| ComprsError::Operation {
                    context: "zstd stream decompress",
                    source: e.into(),
                })?;
            total_written = out_buf.pos();
            if self.total_output + total_written > self.max_output_size {
                return Err(ComprsError::SizeLimit {
                    context: "zstd stream decompress",
                    limit: self.max_output_size,
                });
            }
            if total_written >= output.len() {
                output.resize(output.len() * 2, 0);
            }
        }

        self.total_output += total_written;
        output.truncate(total_written);
        Ok(output)
    }

    pub fn flush(&mut self) -> Result<Vec<u8>, ComprsError> {
        let mut output = vec![0u8; INITIAL_BUF_SIZE];
        let mut total_written = 0;

        loop {
            let mut out_buf = OutBuffer::around_pos(&mut output, total_written);
            let remaining =
                self.decoder
                    .flush(&mut out_buf)
                    .map_err(|e| ComprsError::Operation {
                        context: "zstd stream flush",
                        source: e.into(),
                    })?;
            total_written = out_buf.pos();
            if remaining == 0 {
                break;
            }
            if total_written >= output.len() {
                output.resize(output.len() * 2, 0);
            }
        }

        output.truncate(total_written);
        Ok(output)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stream_round_trip() {
        let original = b"Hello, comprs streaming! ".repeat(100);

        // Compress in chunks
        let mut encoder = zstd::stream::raw::Encoder::new(DEFAULT_LEVEL).unwrap();
        let mut compressed = Vec::new();

        for chunk in original.chunks(256) {
            let mut in_buf = InBuffer::around(chunk);
            while in_buf.pos() < in_buf.src.len() {
                let mut out = vec![0u8; 1024];
                let mut out_buf = OutBuffer::around(&mut out);
                encoder.run(&mut in_buf, &mut out_buf).unwrap();
                let written = out_buf.pos();
                compressed.extend_from_slice(&out[..written]);
            }
        }

        // Finish the frame
        loop {
            let mut out = vec![0u8; 1024];
            let mut out_buf = OutBuffer::around(&mut out);
            let remaining = encoder.finish(&mut out_buf, true).unwrap();
            let written = out_buf.pos();
            compressed.extend_from_slice(&out[..written]);
            if remaining == 0 {
                break;
            }
        }

        // Decompress in chunks
        let mut decoder = zstd::stream::raw::Decoder::new().unwrap();
        let mut decompressed = Vec::new();

        for chunk in compressed.chunks(64) {
            let mut in_buf = InBuffer::around(chunk);
            while in_buf.pos() < in_buf.src.len() {
                let mut out = vec![0u8; 1024];
                let mut out_buf = OutBuffer::around(&mut out);
                decoder.run(&mut in_buf, &mut out_buf).unwrap();
                let written = out_buf.pos();
                decompressed.extend_from_slice(&out[..written]);
            }
        }

        assert_eq!(original.as_slice(), decompressed.as_slice());
    }

    #[test]
    fn stream_empty_input() {
        let mut encoder = zstd::stream::raw::Encoder::new(DEFAULT_LEVEL).unwrap();

        // Finish immediately (empty frame)
        let mut compressed = Vec::new();
        loop {
            let mut out = vec![0u8; 1024];
            let mut out_buf = OutBuffer::around(&mut out);
            let remaining = encoder.finish(&mut out_buf, true).unwrap();
            let written = out_buf.pos();
            compressed.extend_from_slice(&out[..written]);
            if remaining == 0 {
                break;
            }
        }

        // Should produce a valid (empty) zstd frame
        assert!(!compressed.is_empty());

        let decompressed = zstd::bulk::decompress(&compressed, 1024).unwrap();
        assert!(decompressed.is_empty());
    }

    #[test]
    fn context_round_trip() {
        let original = b"Hello from context API! ".repeat(50);

        let mut ctx = CompressContext::new(Some(3)).unwrap();
        let mut compressed = Vec::new();
        for chunk in original.chunks(100) {
            compressed.extend_from_slice(&ctx.transform(chunk).unwrap());
        }
        compressed.extend_from_slice(&ctx.finish().unwrap());

        let mut dctx = DecompressContext::new(None).unwrap();
        let mut decompressed = Vec::new();
        for chunk in compressed.chunks(64) {
            decompressed.extend_from_slice(&dctx.transform(chunk).unwrap());
        }

        assert_eq!(original.as_slice(), decompressed.as_slice());
    }
}
