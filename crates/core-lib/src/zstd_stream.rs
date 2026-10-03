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
    output_buf: Vec<u8>,
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
            output_buf: Vec::with_capacity(INITIAL_BUF_SIZE),
        })
    }

    pub fn transform(&mut self, chunk: &[u8]) -> Result<Vec<u8>, ComprsError> {
        let encoder = self
            .encoder
            .as_mut()
            .ok_or(ComprsError::StreamFinished("zstd stream"))?;

        let bound = zstd::zstd_safe::compress_bound(chunk.len());
        self.output_buf.clear();
        self.output_buf.resize(bound.max(INITIAL_BUF_SIZE), 0);

        let mut in_buf = InBuffer::around(chunk);
        let mut total_written = 0;

        while in_buf.pos() < in_buf.src.len() {
            let mut out_buf = OutBuffer::around_pos(&mut self.output_buf, total_written);
            encoder
                .run(&mut in_buf, &mut out_buf)
                .map_err(|e| ComprsError::Operation {
                    context: "zstd stream compress",
                    source: e.into(),
                })?;
            total_written = out_buf.pos();
            if total_written >= self.output_buf.len() {
                self.output_buf.resize(self.output_buf.len() * 2, 0);
            }
        }

        Ok(self.output_buf[..total_written].to_vec())
    }

    pub fn flush(&mut self) -> Result<Vec<u8>, ComprsError> {
        let encoder = self
            .encoder
            .as_mut()
            .ok_or(ComprsError::StreamFinished("zstd stream"))?;

        self.output_buf.clear();
        self.output_buf.resize(INITIAL_BUF_SIZE, 0);
        let mut total_written = 0;

        loop {
            let mut out_buf = OutBuffer::around_pos(&mut self.output_buf, total_written);
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
            if total_written >= self.output_buf.len() {
                self.output_buf.resize(self.output_buf.len() * 2, 0);
            }
        }

        Ok(self.output_buf[..total_written].to_vec())
    }

    pub fn finish(&mut self) -> Result<Vec<u8>, ComprsError> {
        let mut encoder = self
            .encoder
            .take()
            .ok_or(ComprsError::StreamFinished("zstd stream"))?;

        self.output_buf.clear();
        self.output_buf.resize(INITIAL_BUF_SIZE, 0);
        let mut total_written = 0;

        loop {
            let mut out_buf = OutBuffer::around_pos(&mut self.output_buf, total_written);
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
            if total_written >= self.output_buf.len() {
                self.output_buf.resize(self.output_buf.len() * 2, 0);
            }
        }

        Ok(self.output_buf[..total_written].to_vec())
    }
}

/// Streaming zstd decompression context.
pub struct DecompressContext {
    inner: StreamDecoder,
}

impl DecompressContext {
    pub fn new(max_output_size: Option<f64>) -> Result<Self, ComprsError> {
        let max_size = crate::validate_max_output_size(max_output_size)?;
        let decoder = Decoder::new().map_err(|e| ComprsError::Creation {
            context: "zstd decoder",
            source: e.into(),
        })?;
        Ok(Self {
            inner: StreamDecoder::new(decoder, max_size),
        })
    }

    pub fn transform(&mut self, chunk: &[u8]) -> Result<Vec<u8>, ComprsError> {
        self.inner.decompress(chunk, "zstd stream decompress")
    }

    pub fn flush(&mut self) -> Result<Vec<u8>, ComprsError> {
        self.inner.decompress(&[], "zstd stream flush")
    }
}

/// Streaming zstd compression context with dictionary.
pub struct CompressDictContext {
    encoder: Option<Encoder<'static>>,
    output_buf: Vec<u8>,
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
            output_buf: Vec::with_capacity(INITIAL_BUF_SIZE),
        })
    }

    pub fn transform(&mut self, chunk: &[u8]) -> Result<Vec<u8>, ComprsError> {
        let encoder = self
            .encoder
            .as_mut()
            .ok_or(ComprsError::StreamFinished("zstd stream"))?;

        let bound = zstd::zstd_safe::compress_bound(chunk.len());
        self.output_buf.clear();
        self.output_buf.resize(bound.max(INITIAL_BUF_SIZE), 0);

        let mut in_buf = InBuffer::around(chunk);
        let mut total_written = 0;

        while in_buf.pos() < in_buf.src.len() {
            let mut out_buf = OutBuffer::around_pos(&mut self.output_buf, total_written);
            encoder
                .run(&mut in_buf, &mut out_buf)
                .map_err(|e| ComprsError::Operation {
                    context: "zstd stream compress",
                    source: e.into(),
                })?;
            total_written = out_buf.pos();
            if total_written >= self.output_buf.len() {
                self.output_buf.resize(self.output_buf.len() * 2, 0);
            }
        }

        Ok(self.output_buf[..total_written].to_vec())
    }

    pub fn flush(&mut self) -> Result<Vec<u8>, ComprsError> {
        let encoder = self
            .encoder
            .as_mut()
            .ok_or(ComprsError::StreamFinished("zstd stream"))?;

        self.output_buf.clear();
        self.output_buf.resize(INITIAL_BUF_SIZE, 0);
        let mut total_written = 0;

        loop {
            let mut out_buf = OutBuffer::around_pos(&mut self.output_buf, total_written);
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
            if total_written >= self.output_buf.len() {
                self.output_buf.resize(self.output_buf.len() * 2, 0);
            }
        }

        Ok(self.output_buf[..total_written].to_vec())
    }

    pub fn finish(&mut self) -> Result<Vec<u8>, ComprsError> {
        let mut encoder = self
            .encoder
            .take()
            .ok_or(ComprsError::StreamFinished("zstd stream"))?;

        self.output_buf.clear();
        self.output_buf.resize(INITIAL_BUF_SIZE, 0);
        let mut total_written = 0;

        loop {
            let mut out_buf = OutBuffer::around_pos(&mut self.output_buf, total_written);
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
            if total_written >= self.output_buf.len() {
                self.output_buf.resize(self.output_buf.len() * 2, 0);
            }
        }

        Ok(self.output_buf[..total_written].to_vec())
    }
}

/// Streaming zstd decompression context with dictionary.
pub struct DecompressDictContext {
    inner: StreamDecoder,
}

impl DecompressDictContext {
    pub fn new(dict: &[u8], max_output_size: Option<f64>) -> Result<Self, ComprsError> {
        let max_size = crate::validate_max_output_size(max_output_size)?;
        let decoder = Decoder::with_dictionary(dict).map_err(|e| ComprsError::Creation {
            context: "zstd dict decoder",
            source: e.into(),
        })?;
        Ok(Self {
            inner: StreamDecoder::new(decoder, max_size),
        })
    }

    pub fn transform(&mut self, chunk: &[u8]) -> Result<Vec<u8>, ComprsError> {
        self.inner.decompress(chunk, "zstd stream decompress")
    }

    pub fn flush(&mut self) -> Result<Vec<u8>, ComprsError> {
        self.inner.decompress(&[], "zstd stream flush")
    }
}

/// Decoder state shared by [`DecompressContext`] and [`DecompressDictContext`].
struct StreamDecoder {
    decoder: Decoder<'static>,
    output_buf: Vec<u8>,
    total_output: usize,
    max_output_size: usize,
}

impl StreamDecoder {
    fn new(decoder: Decoder<'static>, max_output_size: usize) -> Self {
        Self {
            decoder,
            output_buf: Vec::new(),
            total_output: 0,
            max_output_size,
        }
    }

    /// Decompress `input` and drain the decoder, returning all output that is
    /// available so far. An empty `input` only drains the decoder.
    ///
    /// The output buffer grows geometrically but never past the remaining
    /// output budget plus one byte, so a stream that exceeds `max_output_size`
    /// fails without allocating beyond it.
    fn decompress(&mut self, input: &[u8], context: &'static str) -> Result<Vec<u8>, ComprsError> {
        let remaining = self.max_output_size - self.total_output;
        let max_capacity = remaining.saturating_add(1);
        self.output_buf.clear();
        self.output_buf
            .reserve_exact(input.len().max(INITIAL_BUF_SIZE).min(max_capacity));

        let mut in_buf = InBuffer::around(input);
        let mut total_written = 0;

        loop {
            // zstd writes into the vector's spare capacity and sets its length
            // to the number of bytes written so far.
            let capacity = self.output_buf.capacity();
            let mut out_buf = OutBuffer::around_pos(&mut self.output_buf, total_written);
            self.decoder
                .run(&mut in_buf, &mut out_buf)
                .map_err(|e| ComprsError::Operation {
                    context,
                    source: e.into(),
                })?;
            total_written = out_buf.pos();
            if total_written > remaining {
                return Err(ComprsError::SizeLimit {
                    context: "zstd stream decompress",
                    limit: self.max_output_size,
                });
            }
            if total_written < capacity {
                // The decoder has flushed everything it could; stop once the
                // input is used up as well.
                if in_buf.pos() == input.len() {
                    break;
                }
            } else {
                let new_capacity = capacity.saturating_mul(2).min(max_capacity);
                self.output_buf.reserve_exact(new_capacity - total_written);
            }
        }

        self.total_output += total_written;
        Ok(self.output_buf.to_vec())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Decompression limit used by the size-limit tests.
    const LIMIT: usize = 64 * 1024;

    #[test]
    fn decompress_context_stops_decoding_at_the_limit() {
        let bomb = crate::zstd::compress(&vec![0u8; 8 * 1024 * 1024], None).unwrap();
        let mut ctx = DecompressContext::new(Some(LIMIT as f64)).unwrap();

        let err = ctx.transform(&bomb).unwrap_err();
        assert_eq!(
            err.to_string(),
            "zstd stream decompress exceeded maximum size of 65536 bytes"
        );
        // The output buffer never grew past the limit plus the one byte that
        // detects the overflow.
        assert!(ctx.inner.output_buf.capacity() <= LIMIT + 1);
    }

    #[test]
    fn decompress_context_accepts_output_at_the_limit() {
        let data = vec![7u8; LIMIT];
        let compressed = crate::zstd::compress(&data, None).unwrap();
        let mut ctx = DecompressContext::new(Some(LIMIT as f64)).unwrap();
        let mut output = ctx.transform(&compressed).unwrap();
        output.extend(ctx.flush().unwrap());
        assert_eq!(output, data);
    }

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
