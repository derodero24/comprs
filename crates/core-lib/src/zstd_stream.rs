//! Zstandard streaming compression and decompression.

use zstd::stream::raw::{InBuffer, OutBuffer};
use zstd::zstd_safe::{self, CCtx, CParameter, DCtx};

use crate::zstd::LEVEL;
use crate::{ComprsError, MemoryUsage};

/// Default compression level for zstd (same as the C library default).
pub const DEFAULT_LEVEL: i32 = 3;

/// Initial output buffer size for streaming operations.
const INITIAL_BUF_SIZE: usize = 128 * 1024;

/// The error source for a zstd error code: its name, such as "Data
/// corruption detected".
pub(crate) fn zstd_error(code: zstd_safe::ErrorCode) -> Box<dyn std::error::Error + Send + Sync> {
    zstd_safe::get_error_name(code).into()
}

/// Create a compression context for `level` and `dict` (empty for none).
///
/// The contexts use `zstd_safe` directly rather than `zstd::stream::raw`,
/// whose encoder and decoder do not expose the context's memory usage.
fn encoder(level: i32, dict: &[u8], context: &'static str) -> Result<CCtx<'static>, ComprsError> {
    let mut encoder = CCtx::create();
    encoder
        .set_parameter(CParameter::CompressionLevel(level))
        .and_then(|_| encoder.load_dictionary(dict))
        .map_err(|code| ComprsError::Creation {
            context,
            source: zstd_error(code),
        })?;
    Ok(encoder)
}

/// Create a decompression context for `dict` (empty for none).
pub(crate) fn decoder(dict: &[u8]) -> Result<DCtx<'static>, zstd_safe::ErrorCode> {
    let mut decoder = DCtx::create();
    decoder.init()?;
    decoder.load_dictionary(dict)?;
    Ok(decoder)
}

/// Streaming zstd compression context.
pub struct CompressContext {
    encoder: Option<CCtx<'static>>,
    output_buf: Vec<u8>,
}

impl CompressContext {
    pub fn new(level: Option<i32>) -> Result<Self, ComprsError> {
        let level = LEVEL.check(level.unwrap_or(DEFAULT_LEVEL))?;
        let encoder = encoder(level, &[], "zstd encoder")?;
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
                .compress_stream(&mut out_buf, &mut in_buf)
                .map_err(|code| ComprsError::Operation {
                    context: "zstd stream compress",
                    source: zstd_error(code),
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
            let remaining =
                encoder
                    .flush_stream(&mut out_buf)
                    .map_err(|code| ComprsError::Operation {
                        context: "zstd stream flush",
                        source: zstd_error(code),
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
                    .end_stream(&mut out_buf)
                    .map_err(|code| ComprsError::Operation {
                        context: "zstd stream finish",
                        source: zstd_error(code),
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

impl MemoryUsage for CompressContext {
    fn memory_usage(&self) -> usize {
        self.encoder.as_ref().map_or(0, CCtx::sizeof) + self.output_buf.capacity()
    }
}

/// Streaming zstd decompression context.
pub struct DecompressContext {
    inner: StreamDecoder,
}

impl DecompressContext {
    pub fn new(max_output_size: Option<f64>) -> Result<Self, ComprsError> {
        let max_size = crate::validate_max_output_size(max_output_size)?;
        let decoder = decoder(&[]).map_err(|code| ComprsError::Creation {
            context: "zstd decoder",
            source: zstd_error(code),
        })?;
        Ok(Self {
            inner: StreamDecoder::new(decoder, max_size, "zstd stream decompress"),
        })
    }

    pub fn transform(&mut self, chunk: &[u8]) -> Result<Vec<u8>, ComprsError> {
        self.inner.decompress(chunk, "zstd stream decompress")
    }

    pub fn flush(&mut self) -> Result<Vec<u8>, ComprsError> {
        self.inner.decompress(&[], "zstd stream flush")
    }

    /// Finalize the decompression stream, returning any remaining output.
    ///
    /// Fails with [`ComprsError::Truncated`] unless the input ended with a
    /// complete frame.
    pub fn finish(&mut self) -> Result<Vec<u8>, ComprsError> {
        self.inner.finish()
    }
}

impl MemoryUsage for DecompressContext {
    fn memory_usage(&self) -> usize {
        self.inner.memory_usage()
    }
}

/// Streaming zstd compression context with dictionary.
pub struct CompressDictContext {
    encoder: Option<CCtx<'static>>,
    output_buf: Vec<u8>,
}

impl CompressDictContext {
    pub fn new(dict: &[u8], level: Option<i32>) -> Result<Self, ComprsError> {
        let level = LEVEL.check(level.unwrap_or(DEFAULT_LEVEL))?;
        let encoder = encoder(level, dict, "zstd dict encoder")?;
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
                .compress_stream(&mut out_buf, &mut in_buf)
                .map_err(|code| ComprsError::Operation {
                    context: "zstd stream compress",
                    source: zstd_error(code),
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
            let remaining =
                encoder
                    .flush_stream(&mut out_buf)
                    .map_err(|code| ComprsError::Operation {
                        context: "zstd stream flush",
                        source: zstd_error(code),
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
                    .end_stream(&mut out_buf)
                    .map_err(|code| ComprsError::Operation {
                        context: "zstd stream finish",
                        source: zstd_error(code),
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

impl MemoryUsage for CompressDictContext {
    fn memory_usage(&self) -> usize {
        self.encoder.as_ref().map_or(0, CCtx::sizeof) + self.output_buf.capacity()
    }
}

/// Streaming zstd decompression context with dictionary.
pub struct DecompressDictContext {
    inner: StreamDecoder,
}

impl DecompressDictContext {
    pub fn new(dict: &[u8], max_output_size: Option<f64>) -> Result<Self, ComprsError> {
        let max_size = crate::validate_max_output_size(max_output_size)?;
        let decoder = decoder(dict).map_err(|code| ComprsError::Creation {
            context: "zstd dict decoder",
            source: zstd_error(code),
        })?;
        Ok(Self {
            inner: StreamDecoder::new(decoder, max_size, "zstd stream decompress"),
        })
    }

    pub fn transform(&mut self, chunk: &[u8]) -> Result<Vec<u8>, ComprsError> {
        self.inner.decompress(chunk, "zstd stream decompress")
    }

    pub fn flush(&mut self) -> Result<Vec<u8>, ComprsError> {
        self.inner.decompress(&[], "zstd stream flush")
    }

    /// Finalize the decompression stream, returning any remaining output.
    ///
    /// Fails with [`ComprsError::Truncated`] unless the input ended with a
    /// complete frame.
    pub fn finish(&mut self) -> Result<Vec<u8>, ComprsError> {
        self.inner.finish()
    }
}

impl MemoryUsage for DecompressDictContext {
    fn memory_usage(&self) -> usize {
        self.inner.memory_usage()
    }
}

/// Decompress `input`, which must end with a complete frame, in one call.
///
/// `input` may hold several frames, including skippable ones. The output
/// buffer starts with room for `initial_capacity` bytes and grows with the
/// decompressed data, but never past `max_output_size` plus one byte.
/// Exceeding `max_output_size` fails with [`ComprsError::SizeLimit`] and
/// `context`, which also prefixes decoder errors.
pub(crate) fn decompress_all(
    decoder: DCtx<'static>,
    input: &[u8],
    max_output_size: usize,
    initial_capacity: usize,
    context: &'static str,
) -> Result<Vec<u8>, ComprsError> {
    let mut stream = StreamDecoder::new(decoder, max_output_size, context);
    stream.decode(input, initial_capacity, context)?;
    if !stream.frame_complete {
        return Err(ComprsError::Truncated("zstd"));
    }
    Ok(stream.output_buf)
}

/// Decoder state shared by [`DecompressContext`], [`DecompressDictContext`]
/// and [`decompress_all`].
struct StreamDecoder {
    /// `None` once the stream is finished.
    decoder: Option<DCtx<'static>>,
    output_buf: Vec<u8>,
    total_output: usize,
    max_output_size: usize,
    /// Context reported in [`ComprsError::SizeLimit`].
    limit_context: &'static str,
    /// Whether the input so far ends with a complete frame, i.e. the last
    /// decoder call that made progress returned 0.
    frame_complete: bool,
}

impl StreamDecoder {
    fn new(decoder: DCtx<'static>, max_output_size: usize, limit_context: &'static str) -> Self {
        Self {
            decoder: Some(decoder),
            output_buf: Vec::new(),
            total_output: 0,
            max_output_size,
            limit_context,
            frame_complete: false,
        }
    }

    /// Decompress `input` and drain the decoder, returning all output that is
    /// available so far. An empty `input` only drains the decoder.
    fn decompress(&mut self, input: &[u8], context: &'static str) -> Result<Vec<u8>, ComprsError> {
        self.decode(input, input.len().max(INITIAL_BUF_SIZE), context)?;
        Ok(self.output_buf.to_vec())
    }

    /// Decompress `input` into `output_buf`, replacing its contents, and
    /// drain the decoder.
    ///
    /// The output buffer gets room for `initial_capacity` bytes, then grows
    /// geometrically but never past the remaining output budget plus one
    /// byte, so a stream that exceeds `max_output_size` fails without
    /// allocating beyond it.
    fn decode(
        &mut self,
        input: &[u8],
        initial_capacity: usize,
        context: &'static str,
    ) -> Result<(), ComprsError> {
        let decoder = self
            .decoder
            .as_mut()
            .ok_or(ComprsError::StreamFinished("zstd stream"))?;

        let remaining = self.max_output_size - self.total_output;
        let max_capacity = remaining.saturating_add(1);
        self.output_buf.clear();
        reserve(
            &mut self.output_buf,
            initial_capacity.min(max_capacity),
            context,
        )?;

        let mut in_buf = InBuffer::around(input);
        let mut total_written = 0;

        loop {
            // zstd writes into the vector's spare capacity and sets its length
            // to the number of bytes written so far.
            let capacity = self.output_buf.capacity();
            let in_pos = in_buf.pos();
            let mut out_buf = OutBuffer::around_pos(&mut self.output_buf, total_written);
            let hint = decoder
                .decompress_stream(&mut out_buf, &mut in_buf)
                .map_err(|code| ComprsError::Operation {
                    context,
                    source: zstd_error(code),
                })?;
            // A call without input or output, such as a drain at a frame
            // boundary, reports the header size of the next frame instead.
            if in_buf.pos() > in_pos || out_buf.pos() > total_written {
                self.frame_complete = hint == 0;
            }
            total_written = out_buf.pos();
            if total_written > remaining {
                return Err(ComprsError::SizeLimit {
                    context: self.limit_context,
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
                reserve(&mut self.output_buf, new_capacity, context)?;
            }
        }

        self.total_output += total_written;
        Ok(())
    }

    /// Drain the decoder and end the stream, failing unless the input ended
    /// with a complete frame.
    fn finish(&mut self) -> Result<Vec<u8>, ComprsError> {
        let output = self.decompress(&[], "zstd stream finish");
        self.decoder = None;
        let output = output?;
        if !self.frame_complete {
            return Err(ComprsError::Truncated("zstd"));
        }
        Ok(output)
    }

    /// The memory of the decoder, including the window and the input buffer
    /// that it allocates for the first frame, and of the output buffer.
    fn memory_usage(&self) -> usize {
        self.decoder.as_ref().map_or(0, DCtx::sizeof) + self.output_buf.capacity()
    }
}

/// Grow `buf` to a capacity of at least `capacity` bytes, reporting a failed
/// allocation as an error instead of aborting.
fn reserve(buf: &mut Vec<u8>, capacity: usize, context: &'static str) -> Result<(), ComprsError> {
    buf.try_reserve_exact(capacity.saturating_sub(buf.len()))
        .map_err(|e| ComprsError::Operation {
            context,
            source: e.into(),
        })
}

#[cfg(test)]
mod tests {
    use zstd::stream::raw::Operation;

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

    /// Decompress `input` in chunks of `chunk_size` bytes, then finish.
    fn decompress_all(
        ctx: &mut DecompressContext,
        input: &[u8],
        chunk_size: usize,
    ) -> Result<Vec<u8>, ComprsError> {
        let mut output = Vec::new();
        for chunk in input.chunks(chunk_size) {
            output.extend(ctx.transform(chunk)?);
        }
        output.extend(ctx.flush()?);
        output.extend(ctx.finish()?);
        Ok(output)
    }

    #[test]
    fn decompress_context_finishes_complete_frames() {
        let original = b"complete zstd frame ".repeat(500);
        let compressed = crate::zstd::compress(&original, None).unwrap();
        for chunk_size in [1, 7, compressed.len()] {
            let mut ctx = DecompressContext::new(None).unwrap();
            let output = decompress_all(&mut ctx, &compressed, chunk_size).unwrap();
            assert_eq!(output, original, "chunk size {chunk_size}");
        }
    }

    #[test]
    fn decompress_context_finishes_concatenated_frames() {
        let mut compressed = crate::zstd::compress(b"first frame, ", None).unwrap();
        compressed.extend(crate::zstd::compress(b"second frame", None).unwrap());
        let mut ctx = DecompressContext::new(None).unwrap();
        let output = decompress_all(&mut ctx, &compressed, 5).unwrap();
        assert_eq!(output, b"first frame, second frame");
    }

    #[test]
    fn decompress_context_rejects_truncated_input() {
        let compressed = crate::zstd::compress(&b"truncated zstd ".repeat(500), None).unwrap();
        let mut concatenated = compressed.clone();
        concatenated.extend(&compressed[..compressed.len() / 2]);
        let truncated = [
            &compressed[..0],
            &compressed[..1],
            &compressed[..compressed.len() / 2],
            &compressed[..compressed.len() - 1],
            &concatenated[..],
        ];
        for input in truncated {
            let mut ctx = DecompressContext::new(None).unwrap();
            let err = decompress_all(&mut ctx, input, 64).unwrap_err();
            assert_eq!(
                err.to_string(),
                "zstd stream is truncated: unexpected end of input",
                "input of {} bytes",
                input.len()
            );
        }
    }

    #[test]
    fn decompress_dict_context_rejects_truncated_input() {
        let dict = b"zstd dictionary content ".repeat(20);
        let original = b"zstd dictionary content, compressed ".repeat(20);
        let compressed = crate::zstd::compress_with_dict(&original, &dict, None).unwrap();

        let mut ctx = DecompressDictContext::new(&dict, None).unwrap();
        let mut output = ctx.transform(&compressed).unwrap();
        output.extend(ctx.finish().unwrap());
        assert_eq!(output, original);

        let mut ctx = DecompressDictContext::new(&dict, None).unwrap();
        ctx.transform(&compressed[..compressed.len() - 1]).unwrap();
        assert!(matches!(ctx.finish(), Err(ComprsError::Truncated("zstd"))));
    }

    #[test]
    fn decompress_context_cannot_be_used_after_finish() {
        let compressed = crate::zstd::compress(b"finished", None).unwrap();
        let mut ctx = DecompressContext::new(None).unwrap();
        ctx.transform(&compressed).unwrap();
        ctx.finish().unwrap();
        assert!(matches!(
            ctx.transform(&compressed),
            Err(ComprsError::StreamFinished(_))
        ));
        assert!(matches!(ctx.flush(), Err(ComprsError::StreamFinished(_))));
        assert!(matches!(ctx.finish(), Err(ComprsError::StreamFinished(_))));
    }

    #[test]
    fn compress_context_reports_the_encoder_workspace() {
        let mut fast = CompressContext::new(Some(1)).unwrap();
        let mut strong = CompressContext::new(Some(9)).unwrap();
        // zstd allocates the workspace for the level with the first data.
        let empty = strong.memory_usage();
        assert!(empty < 256 * 1024, "{empty} bytes");

        fast.transform(b"first data").unwrap();
        strong.transform(b"first data").unwrap();
        assert!(
            fast.memory_usage() > 1024 * 1024,
            "{} bytes",
            fast.memory_usage()
        );
        assert!(
            strong.memory_usage() > 4 * fast.memory_usage(),
            "{} bytes at level 9, {} at level 1",
            strong.memory_usage(),
            fast.memory_usage()
        );

        strong.finish().unwrap();
        assert_eq!(strong.memory_usage(), strong.output_buf.capacity());
    }

    #[test]
    fn decompress_context_reports_the_window() {
        let original = vec![7u8; 1024 * 1024];
        let compressed = crate::zstd::compress(&original, None).unwrap();
        let mut ctx = DecompressContext::new(None).unwrap();
        let empty = ctx.memory_usage();

        let output = ctx.transform(&compressed).unwrap();
        // The decoder keeps a window of up to the frame's content size, and
        // the output buffer the whole output of the call.
        assert!(ctx.memory_usage() > empty + 2 * original.len());
        assert_eq!(output, original);

        ctx.finish().unwrap();
        assert_eq!(ctx.memory_usage(), ctx.inner.output_buf.capacity());
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
