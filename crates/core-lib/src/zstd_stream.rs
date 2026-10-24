//! Zstandard streaming compression and decompression.

use std::borrow::BorrowMut;

use zstd::stream::raw::{InBuffer, OutBuffer};
use zstd::zstd_safe::zstd_sys::ZSTD_ErrorCode;
use zstd::zstd_safe::{self, CCtx, CParameter, DCtx, DParameter};

use crate::dictionary::{Dictionary, DictionaryFormat};
use crate::zstd::{DEFAULT_LEVEL, LEVEL};
use crate::{ComprsError, MemoryUsage};

/// Initial output buffer size for streaming operations.
const INITIAL_BUF_SIZE: usize = 128 * 1024;

/// The error source for a zstd error code: its name, such as "Data
/// corruption detected".
pub(crate) fn zstd_error(code: zstd_safe::ErrorCode) -> Box<dyn std::error::Error + Send + Sync> {
    zstd_safe::get_error_name(code).into()
}

/// The code of `ZSTD_error_memory_allocation`: zstd returns its error `e` as
/// the code `(size_t)-e`, which `ZSTD_getErrorCode` turns back into `e`.
const MEMORY_ALLOCATION: zstd_safe::ErrorCode =
    0usize.wrapping_sub(ZSTD_ErrorCode::ZSTD_error_memory_allocation as usize);

/// The code of `ZSTD_error_frameParameter_windowTooLarge`, which a decoder
/// returns for a frame whose window exceeds the largest that it accepts.
const WINDOW_TOO_LARGE: zstd_safe::ErrorCode =
    0usize.wrapping_sub(ZSTD_ErrorCode::ZSTD_error_frameParameter_windowTooLarge as usize);

/// The context of the [`ComprsError::SizeLimit`] for a frame whose window
/// exceeds the bound that the output limit lowered: "zstd frame window
/// exceeded maximum size of `<limit>` bytes".
const WINDOW_LIMIT_CONTEXT: &str = "zstd frame window";

/// The error for a code that a zstd decoder returned:
/// [`ComprsError::Operation`] for `ZSTD_error_memory_allocation`, which
/// zstd returns when its malloc fails, as for any other failed allocation,
/// and [`ComprsError::Corrupt`] for any other code, which reports input that
/// the decoder rejects.
pub(crate) fn decode_error(code: zstd_safe::ErrorCode, context: &'static str) -> ComprsError {
    let source = zstd_error(code);
    if code == MEMORY_ALLOCATION {
        ComprsError::Operation { context, source }
    } else {
        ComprsError::Corrupt { context, source }
    }
}

/// Create a compression context for `level`, `workers` and `dict` (empty for
/// none), which the caller has checked: zstd clamps levels and numbers of
/// workers out of range instead of failing.
///
/// The contexts use `zstd_safe` directly rather than `zstd::stream::raw`,
/// whose encoder and decoder do not expose the context's memory usage.
pub(crate) fn encoder(
    level: i32,
    workers: u32,
    dict: &[u8],
) -> Result<CCtx<'static>, zstd_safe::ErrorCode> {
    let mut encoder = CCtx::create();
    encoder.set_parameter(CParameter::CompressionLevel(level))?;
    if workers > 0 {
        encoder.set_parameter(CParameter::NbWorkers(workers))?;
    }
    encoder.load_dictionary(dict)?;
    Ok(encoder)
}

/// Create a [`StreamEncoder`] for the arguments of
/// [`CompressContext::with_workers`] and [`CompressDictContext::with_workers`].
fn stream_encoder(
    level: Option<i32>,
    workers: u32,
    dict: &[u8],
    context: &'static str,
) -> Result<StreamEncoder, ComprsError> {
    // The workers first, as the one-shot functions check them.
    let workers = crate::zstd::check_workers(workers)?;
    let level = LEVEL.check(level.unwrap_or(DEFAULT_LEVEL))?;
    let encoder = encoder(level, workers, dict).map_err(|code| ComprsError::Creation {
        context,
        source: zstd_error(code),
    })?;
    Ok(StreamEncoder::new(encoder, workers))
}

/// The log2 of the window that a decoder accepts whatever its output limit
/// (8 MiB). RFC 8878 recommends that decoders support windows of up to
/// 8 MiB, the most that the `zstd` HTTP content coding allows (RFC 9659),
/// and zstd writes no larger window at levels up to 19, so the frames that
/// comprs compresses at those levels decode under any output limit.
const MIN_WINDOW_LOG: u32 = 23;

/// The log2 of the largest window that a decoder accepts (128 MiB): zstd's
/// default, `ZSTD_WINDOWLOG_LIMIT_DEFAULT`, which the `zstd` CLI and
/// Node.js's zlib apply as well. A frame with a larger window, which only an
/// encoder told to use one writes, such as `zstd --long=28`, fails to decode
/// under any output limit.
const MAX_WINDOW_LOG: u32 = 27;

/// The log2 of the largest window that a decoder with an output limit of
/// `max_output_size` bytes accepts: the limit rounded up to a power of two,
/// within [`MIN_WINDOW_LOG`] and [`MAX_WINDOW_LOG`].
///
/// The streaming decoder allocates the window that a frame declares as soon
/// as it has read the frame header, before it writes any output, so without
/// this bound the 6-byte header of a frame without a content size reserves
/// 128 MiB whatever the limit. A frame that declares its content size as its
/// window, as zstd writes a frame whose content fits in its window, decodes
/// under any limit that the content fits in.
pub(crate) fn window_log_max(max_output_size: usize) -> u32 {
    let log = usize::BITS - max_output_size.saturating_sub(1).leading_zeros();
    log.clamp(MIN_WINDOW_LOG, MAX_WINDOW_LOG)
}

/// Bound the window of `decoder`, which has zstd's default parameters, by
/// [`window_log_max`] for an output limit of `max_output_size` bytes.
/// Limits of more than 64 MiB, the default limit among them, keep zstd's
/// default bound rather than set [`MAX_WINDOW_LOG`]: zstd's default is one
/// byte larger, which a frame whose window is its content size of
/// 128 MiB + 1 byte needs.
pub(crate) fn limit_window(
    decoder: &mut DCtx<'_>,
    max_output_size: usize,
) -> Result<(), zstd_safe::ErrorCode> {
    let window_log = window_log_max(max_output_size);
    if window_log < MAX_WINDOW_LOG {
        decoder.set_parameter(DParameter::WindowLogMax(window_log))?;
    }
    Ok(())
}

/// Create a decompression context for `dict` (empty for none) and an output
/// limit of `max_output_size` bytes, which bounds its window: see
/// [`limit_window`].
pub(crate) fn decoder(
    dict: &[u8],
    max_output_size: usize,
) -> Result<DCtx<'static>, zstd_safe::ErrorCode> {
    let mut decoder = DCtx::create();
    decoder.init()?;
    limit_window(&mut decoder, max_output_size)?;
    decoder.load_dictionary(dict)?;
    Ok(decoder)
}

/// Streaming zstd compression context.
pub struct CompressContext {
    inner: StreamEncoder,
}

impl CompressContext {
    pub fn new(level: Option<i32>) -> Result<Self, ComprsError> {
        Self::with_workers(level, 0)
    }

    /// Create a context that compresses on `workers` threads, which
    /// [`crate::zstd::compress_with_workers`] describes. 0 workers is
    /// [`new`](Self::new).
    ///
    /// With workers, the first [`transform`](Self::transform) or
    /// [`flush`](Self::flush) starts the threads and allocates their
    /// buffers, however short the stream: unlike a one-shot call, zstd does
    /// not know the size of the input. The threads stop when the stream
    /// finishes or the context is dropped, which waits for the jobs in
    /// progress. `transform` returns once zstd has taken the chunk, while
    /// the workers may still be compressing it; `flush` and
    /// [`finish`](Self::finish) wait for them.
    ///
    /// With workers, [`memory_usage`](MemoryUsage::memory_usage) reports
    /// the memory that zstd held the last time it had no job in progress
    /// after a call: on creation, after a `flush`, and after a `transform`
    /// whose jobs had finished. zstd cannot measure the workers' contexts
    /// while they compress.
    pub fn with_workers(level: Option<i32>, workers: u32) -> Result<Self, ComprsError> {
        Ok(Self {
            inner: stream_encoder(level, workers, &[], "zstd encoder")?,
        })
    }

    pub fn transform(&mut self, chunk: &[u8]) -> Result<Vec<u8>, ComprsError> {
        self.inner.transform(chunk)
    }

    pub fn flush(&mut self) -> Result<Vec<u8>, ComprsError> {
        self.inner.flush()
    }

    pub fn finish(&mut self) -> Result<Vec<u8>, ComprsError> {
        self.inner.finish()
    }
}

impl MemoryUsage for CompressContext {
    fn memory_usage(&self) -> usize {
        self.inner.memory_usage()
    }
}

/// Streaming zstd decompression context.
pub struct DecompressContext {
    inner: StreamDecoder,
}

impl DecompressContext {
    /// Create a context whose output may not exceed `max_output_size`
    /// bytes, [`crate::MAX_DECOMPRESSED_SIZE`] by default.
    ///
    /// As soon as it has read a frame header, before it writes any output,
    /// the decoder allocates a buffer for the window that the header
    /// declares, or for the content size if that is smaller. The window of
    /// a single-segment frame is its content size, so the header of such a
    /// frame can make the decoder allocate up to 128 MiB, as the header of a
    /// frame without a content size can.
    ///
    /// The limit therefore also bounds the window: to the limit rounded up
    /// to a power of two, but at least 8 MiB, which the frames that comprs
    /// compresses at levels up to 19 fit in, and at most zstd's default of
    /// 128 MiB. A frame whose window exceeds the bound fails before the
    /// decoder allocates it:
    ///
    /// - under a limit of 64 MiB or less, which lowers the bound, with
    ///   [`ComprsError::SizeLimit`] and the context "zstd frame window",
    ///   whatever the window: a larger limit decodes a frame whose window is
    ///   at most 128 MiB, while one whose window is larger fails under any
    ///   limit;
    /// - under a larger limit, which keeps zstd's bound, only a window over
    ///   128 MiB exceeds it, and the frame fails with
    ///   [`ComprsError::Corrupt`]: "Frame requires too much memory for
    ///   decoding".
    ///
    /// The context checks the window of a frame that declares its content
    /// size too, but zstd skips the check when a call holds the whole frame
    /// and has room for its content, and decodes the frame in one pass.
    /// zstd itself never writes a frame whose window exceeds its content
    /// size; if such a frame's window also exceeds the bound, whether it
    /// decodes or fails therefore depends on how the input is chunked.
    pub fn new(max_output_size: Option<f64>) -> Result<Self, ComprsError> {
        let max_size = crate::validate_max_output_size(max_output_size)?;
        let decoder = decoder(&[], max_size).map_err(|code| ComprsError::Creation {
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
    inner: StreamEncoder,
}

impl CompressDictContext {
    pub fn new(dict: &[u8], level: Option<i32>) -> Result<Self, ComprsError> {
        Self::with_workers(dict, level, 0)
    }

    /// Create a context that compresses on `workers` threads, as
    /// [`CompressContext::with_workers`] does. 0 workers is
    /// [`new`](Self::new).
    pub fn with_workers(
        dict: &[u8],
        level: Option<i32>,
        workers: u32,
    ) -> Result<Self, ComprsError> {
        Ok(Self {
            inner: stream_encoder(level, workers, dict, "zstd dict encoder")?,
        })
    }

    /// Create a context for a prepared [`Dictionary`]. `level` selects the
    /// level as in [`crate::zstd::compress_prepared`]: `None` the level of
    /// `dict`, and `Some(0)` [`DEFAULT_LEVEL`], whatever the level of
    /// `dict`. `workers` works as in [`with_workers`](Self::with_workers).
    ///
    /// The context loads the bytes of `dict`, which zstd digests once for
    /// the stream at its level, rather than sharing a prepared compression
    /// dictionary: zstd-safe's `CCtx::ref_cdict` makes the context borrow
    /// the dictionary, which a context that outlives the call cannot do
    /// without unsafe code. No level makes `dict` prepare or drop one.
    ///
    /// Fails with [`ComprsError::InvalidArg`] for a brotli dictionary, then
    /// for invalid `workers`, then for an invalid `level`.
    pub fn with_prepared(
        dict: &Dictionary,
        level: Option<i32>,
        workers: u32,
    ) -> Result<Self, ComprsError> {
        let prepared_level = dict.zstd_level()?;
        Self::with_workers(dict.raw(), Some(level.unwrap_or(prepared_level)), workers)
    }

    pub fn transform(&mut self, chunk: &[u8]) -> Result<Vec<u8>, ComprsError> {
        self.inner.transform(chunk)
    }

    pub fn flush(&mut self) -> Result<Vec<u8>, ComprsError> {
        self.inner.flush()
    }

    pub fn finish(&mut self) -> Result<Vec<u8>, ComprsError> {
        self.inner.finish()
    }
}

impl MemoryUsage for CompressDictContext {
    fn memory_usage(&self) -> usize {
        self.inner.memory_usage()
    }
}

/// Streaming zstd decompression context with dictionary.
pub struct DecompressDictContext {
    inner: StreamDecoder,
}

impl DecompressDictContext {
    /// Create a context for `dict` whose output may not exceed
    /// `max_output_size` bytes, which bounds the window of a frame as in
    /// [`DecompressContext::new`].
    pub fn new(dict: &[u8], max_output_size: Option<f64>) -> Result<Self, ComprsError> {
        let max_size = crate::validate_max_output_size(max_output_size)?;
        let decoder = decoder(dict, max_size).map_err(|code| ComprsError::Creation {
            context: "zstd dict decoder",
            source: zstd_error(code),
        })?;
        Ok(Self {
            inner: StreamDecoder::new(decoder, max_size, "zstd stream decompress"),
        })
    }

    /// Create a context for a prepared [`Dictionary`]. Like
    /// [`CompressDictContext::with_prepared`], it loads the bytes of `dict`
    /// once for the stream rather than borrowing the prepared decompression
    /// dictionary.
    ///
    /// Fails with [`ComprsError::InvalidArg`] for a brotli dictionary, then
    /// for an invalid `max_output_size`.
    pub fn with_prepared(
        dict: &Dictionary,
        max_output_size: Option<f64>,
    ) -> Result<Self, ComprsError> {
        Self::new(dict.raw_for(DictionaryFormat::Zstd)?, max_output_size)
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

/// Encoder state shared by [`CompressContext`] and [`CompressDictContext`].
struct StreamEncoder {
    /// `None` once the stream is finished.
    encoder: Option<CCtx<'static>>,
    /// With workers, the size of `encoder` on creation or after the last
    /// call that left no job in progress; `None` without workers.
    ///
    /// With workers, `ZSTD_sizeof_CCtx` also reads the context of every
    /// worker, whose workspace a running job reallocates, and zstd documents
    /// the sizes of its pools as valid only at initialization, not during
    /// compression (zstd 1.5.7, `zstdmt_compress.c`). A job returns its
    /// context to the pool before it reports itself complete under its
    /// mutex, and `ZSTD_getFrameProgression` reads every job under that
    /// mutex and counts the unfinished ones in `nbActiveWorkers`: the encoder
    /// is measured only when that count is 0.
    encoder_size: Option<usize>,
    /// The output of the current call. zstd writes into its spare capacity,
    /// and the buffer keeps its capacity for the next call, so a call that
    /// produces little or nothing allocates nothing beyond its exact-size
    /// result.
    output_buf: Vec<u8>,
}

impl StreamEncoder {
    fn new(encoder: CCtx<'static>, workers: u32) -> Self {
        Self {
            // No job runs before the first call.
            encoder_size: (workers > 0).then(|| encoder.sizeof()),
            encoder: Some(encoder),
            output_buf: Vec::new(),
        }
    }

    /// Compress `chunk`, returning the output that zstd produced for it.
    /// zstd buffers input until it has a full block, so the output is often
    /// empty.
    fn transform(&mut self, chunk: &[u8]) -> Result<Vec<u8>, ComprsError> {
        let mut in_buf = InBuffer::around(chunk);
        self.run(
            zstd_safe::compress_bound(chunk.len()).max(INITIAL_BUF_SIZE),
            "zstd stream compress",
            |encoder, out_buf| {
                encoder.compress_stream(out_buf, &mut in_buf)?;
                Ok(chunk.len() - in_buf.pos())
            },
        )
    }

    /// Flush the input buffered so far, ending the current block.
    fn flush(&mut self) -> Result<Vec<u8>, ComprsError> {
        self.run(INITIAL_BUF_SIZE, "zstd stream flush", |encoder, out_buf| {
            encoder.flush_stream(out_buf)
        })
    }

    /// End the frame and the stream.
    fn finish(&mut self) -> Result<Vec<u8>, ComprsError> {
        let output = self.run(
            INITIAL_BUF_SIZE,
            "zstd stream finish",
            |encoder, out_buf| encoder.end_stream(out_buf),
        );
        self.encoder = None;
        output
    }

    /// Call `step` until it reports no work left, and return a copy of the
    /// output.
    ///
    /// `step` writes after the output of the previous steps and returns the
    /// work left: input bytes to consume, or bytes that zstd still has to
    /// flush. The output buffer gets room for `initial_capacity` bytes and
    /// doubles whenever a step fills it.
    ///
    /// With workers, zstd compresses in the background: `compress_stream`
    /// may return before it has taken the whole chunk, once it has taken or
    /// written something, and `flush_stream` and `end_stream` report work
    /// left until the workers have finished every job and zstd has written
    /// their output. Calling `step` until no work is left covers both.
    fn run(
        &mut self,
        initial_capacity: usize,
        context: &'static str,
        mut step: impl FnMut(&mut CCtx<'static>, &mut OutBuffer<'_, Vec<u8>>) -> zstd_safe::SafeResult,
    ) -> Result<Vec<u8>, ComprsError> {
        let encoder = self
            .encoder
            .as_mut()
            .ok_or(ComprsError::StreamFinished("zstd stream"))?;

        self.output_buf.clear();
        reserve(&mut self.output_buf, initial_capacity, context)?;
        loop {
            let written = self.output_buf.len();
            if written == self.output_buf.capacity() {
                reserve(&mut self.output_buf, written.saturating_mul(2), context)?;
            }
            // zstd writes into the vector's spare capacity and sets its length
            // to the number of bytes written so far.
            let mut out_buf = OutBuffer::around_pos(&mut self.output_buf, written);
            let remaining = step(encoder, &mut out_buf).map_err(|code| ComprsError::Operation {
                context,
                source: zstd_error(code),
            })?;
            if remaining == 0 {
                break;
            }
        }

        // With workers, measure the encoder while no job is in progress,
        // which `flush_stream` and `end_stream` have waited for; see
        // `encoder_size`.
        #[cfg(feature = "zstdmt")]
        if self.encoder_size.is_some() && encoder.get_frame_progression().nbActiveWorkers == 0 {
            self.encoder_size = Some(encoder.sizeof());
        }

        Ok(self.output_buf.to_vec())
    }

    /// The memory of the encoder, including the workspace that it allocates
    /// for the first data, and of the output buffer.
    ///
    /// With workers, the encoder also holds their buffers and contexts, and
    /// the figure is the one measured on creation or after the last call
    /// that left no job in progress: after a `transform` whose jobs are
    /// still running, it reports the previous measurement, which `flush`
    /// renews. Without workers, zstd measures the encoder on every call of
    /// this function.
    fn memory_usage(&self) -> usize {
        let encoder = self.encoder.as_ref().map_or(0, |encoder| {
            self.encoder_size.unwrap_or_else(|| encoder.sizeof())
        });
        encoder + self.output_buf.capacity()
    }
}

/// Decompress `input`, which must end with a complete frame, in one call.
///
/// `input` may hold several frames, including skippable ones. The output
/// buffer starts with room for `initial_capacity` bytes and grows with the
/// decompressed data, but never past `max_output_size` plus one byte.
/// Exceeding `max_output_size` fails with [`ComprsError::SizeLimit`] and
/// `context`, which also prefixes decoder errors. `decoder` must have the
/// window bound of `max_output_size` (see [`limit_window`]): a frame whose
/// window exceeds a bound that the limit lowered fails with
/// [`ComprsError::SizeLimit`] as well, with the context
/// [`WINDOW_LIMIT_CONTEXT`].
pub(crate) fn decompress_all(
    decoder: &mut DCtx<'_>,
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
/// and [`decompress_all`], which borrows its decoder. That decoder may
/// itself borrow a prepared dictionary.
struct StreamDecoder<D = DCtx<'static>> {
    /// `None` once the stream is finished.
    decoder: Option<D>,
    output_buf: Vec<u8>,
    total_output: usize,
    max_output_size: usize,
    /// Context reported in [`ComprsError::SizeLimit`] for output over the
    /// limit.
    limit_context: &'static str,
    /// Whether the input so far ends with a complete frame, i.e. the last
    /// decoder call that made progress returned 0.
    frame_complete: bool,
}

impl<'a, D: BorrowMut<DCtx<'a>>> StreamDecoder<D> {
    fn new(decoder: D, max_output_size: usize, limit_context: &'static str) -> Self {
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
            .ok_or(ComprsError::StreamFinished("zstd stream"))?
            .borrow_mut();

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
                .map_err(|code| {
                    // Under a bound that the limit lowered, a frame whose
                    // window exceeds it fails as exceeding the limit: if
                    // its window is at most zstd's default bound of 128 MiB,
                    // a larger limit decodes it. The code does not give the
                    // window, so a window over 128 MiB, which no limit
                    // decodes, fails the same way. Under a limit that keeps
                    // zstd's bound, only such windows exceed it, and they
                    // fail as corrupt data.
                    if code == WINDOW_TOO_LARGE
                        && window_log_max(self.max_output_size) < MAX_WINDOW_LOG
                    {
                        ComprsError::SizeLimit {
                            context: WINDOW_LIMIT_CONTEXT,
                            limit: self.max_output_size,
                        }
                    } else {
                        decode_error(code, context)
                    }
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
}

impl StreamDecoder {
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
    use super::*;

    /// Decompression limit used by the size-limit tests.
    const LIMIT: usize = 64 * 1024;

    /// The code that zstd returns for its error `e`.
    fn error_code(e: ZSTD_ErrorCode) -> zstd_safe::ErrorCode {
        0usize.wrapping_sub(e as usize)
    }

    #[test]
    fn decode_error_tells_failed_allocations_from_corrupt_data() {
        // get_error_name decodes the code as ZSTD_getErrorCode does, so the
        // names check how the codes are encoded.
        let allocation = error_code(ZSTD_ErrorCode::ZSTD_error_memory_allocation);
        assert_eq!(
            zstd_safe::get_error_name(allocation),
            "Allocation error : not enough memory"
        );
        let err = decode_error(allocation, "zstd decompress");
        assert!(matches!(err, ComprsError::Operation { .. }), "{err:?}");
        assert_eq!(
            err.to_string(),
            "zstd decompress failed: Allocation error : not enough memory"
        );

        let corruption = error_code(ZSTD_ErrorCode::ZSTD_error_corruption_detected);
        assert_eq!(
            zstd_safe::get_error_name(corruption),
            "Data corruption detected"
        );
        let err = decode_error(corruption, "zstd decompress");
        assert!(matches!(err, ComprsError::Corrupt { .. }), "{err:?}");
        assert_eq!(
            err.to_string(),
            "zstd decompress failed: Data corruption detected"
        );
    }

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

    const DICT: &[u8] = b"zstd dictionary content, zstd dictionary content, zstd";

    /// Pseudo-random bytes, which zstd cannot compress.
    fn random(len: usize) -> Vec<u8> {
        let mut state = 0x9E37_79B9_7F4A_7C15u64;
        (0..len)
            .map(|_| {
                state ^= state << 13;
                state ^= state >> 7;
                state ^= state << 17;
                (state >> 32) as u8
            })
            .collect()
    }

    /// Words in a pseudo-random order: compressible, and different levels
    /// find different matches in it.
    fn words(len: usize) -> Vec<u8> {
        const WORDS: [&[u8]; 8] = [
            b"zstd ", b"stream ", b"chunk ", b"buffer ", b"frame ", b"block ", b"level ", b"\n",
        ];
        let mut output = Vec::with_capacity(len + 8);
        for byte in random(len) {
            if output.len() >= len {
                break;
            }
            output.extend_from_slice(WORDS[usize::from(byte % 8)]);
        }
        output.truncate(len);
        output
    }

    /// Compress `data` in chunks of `chunk_size` bytes, then finish.
    fn compress_chunks(encoder: &mut StreamEncoder, data: &[u8], chunk_size: usize) -> Vec<u8> {
        let mut output = Vec::new();
        for chunk in data.chunks(chunk_size) {
            output.extend(encoder.transform(chunk).unwrap());
        }
        output.extend(encoder.finish().unwrap());
        output
    }

    /// The frame that the `zstd` crate's stream encoder produces for `data`,
    /// written in chunks of `chunk_size` bytes.
    fn reference_frame(data: &[u8], chunk_size: usize, level: i32, dict: &[u8]) -> Vec<u8> {
        use std::io::Write;

        let mut encoder = zstd::stream::Encoder::with_dictionary(Vec::new(), level, dict).unwrap();
        for chunk in data.chunks(chunk_size) {
            encoder.write_all(chunk).unwrap();
        }
        encoder.finish().unwrap()
    }

    #[test]
    fn compress_contexts_match_the_reference_encoder() {
        let large = words(1280 * 1024);
        for level in [1, 3, 19] {
            // Level 19 is slow in unoptimized test builds.
            let data = if level == 19 {
                &large[..200 * 1024]
            } else {
                &large[..]
            };
            for chunk_size in [1, 1024, 64 * 1024, 1024 * 1024] {
                let data = if chunk_size == 1 {
                    &data[..16 * 1024]
                } else {
                    data
                };
                for dict in [&[][..], DICT] {
                    let mut ctx = if dict.is_empty() {
                        CompressContext::new(Some(level)).unwrap().inner
                    } else {
                        CompressDictContext::new(dict, Some(level)).unwrap().inner
                    };
                    let frame = compress_chunks(&mut ctx, data, chunk_size);
                    let case = format!(
                        "level {level}, {chunk_size}-byte chunks, {}-byte dictionary",
                        dict.len()
                    );
                    assert!(
                        frame == reference_frame(data, chunk_size, level, dict),
                        "{case}"
                    );
                    let decompressed = if dict.is_empty() {
                        crate::zstd::decompress(&frame)
                    } else {
                        crate::zstd::decompress_with_dict(&frame, dict)
                    };
                    assert!(decompressed.unwrap() == data, "{case}");
                }
            }
        }
    }

    /// A compression context with `workers` threads, with `dict` if it is
    /// not empty.
    fn encoder_with_workers(level: i32, workers: u32, dict: &[u8]) -> StreamEncoder {
        if dict.is_empty() {
            CompressContext::with_workers(Some(level), workers)
                .unwrap()
                .inner
        } else {
            CompressDictContext::with_workers(dict, Some(level), workers)
                .unwrap()
                .inner
        }
    }

    #[cfg(feature = "zstdmt")]
    #[test]
    fn compress_contexts_with_workers_round_trip() {
        // Four jobs at level 1, whose jobs hold 2 MiB.
        let data = words(8 * 1024 * 1024);
        for dict in [&[][..], DICT] {
            let frames = [1, 4].map(|workers| {
                let mut ctx = encoder_with_workers(1, workers, dict);
                let frame = compress_chunks(&mut ctx, &data, 64 * 1024);
                let decompressed = if dict.is_empty() {
                    crate::zstd::decompress(&frame)
                } else {
                    crate::zstd::decompress_with_dict(&frame, dict)
                };
                let case = format!("{workers} workers, {}-byte dictionary", dict.len());
                assert!(decompressed.unwrap() == data, "{case}");
                frame
            });
            // zstd's output does not depend on the number of workers from 1
            // up.
            assert!(frames[0] == frames[1], "{}-byte dictionary", dict.len());
            // The workers compress the jobs independently, so the frame
            // differs from the one that the calling thread compresses alone.
            let single = compress_chunks(&mut encoder_with_workers(1, 0, dict), &data, 64 * 1024);
            assert!(frames[0] != single, "{}-byte dictionary", dict.len());
        }
    }

    #[cfg(feature = "zstdmt")]
    #[test]
    fn compress_context_with_workers_flushes_every_job() {
        let data = words(6 * 1024 * 1024);
        // More than two jobs: the workers may still be compressing the
        // input when transform returns, and flush waits for them.
        let (head, tail) = data.split_at(5 * 1024 * 1024 + 1);
        let mut ctx = CompressContext::with_workers(Some(1), 2).unwrap();
        let mut frame = ctx.transform(head).unwrap();
        frame.extend(ctx.flush().unwrap());
        let mut decoder = DecompressContext::new(None).unwrap();
        assert!(decoder.transform(&frame).unwrap() == head);

        let rest = [ctx.transform(tail).unwrap(), ctx.finish().unwrap()].concat();
        assert!(decoder.transform(&rest).unwrap() == tail);
        decoder.finish().unwrap();
    }

    #[cfg(feature = "zstdmt")]
    #[test]
    fn compress_contexts_with_workers_drop_with_jobs_in_progress() {
        // The bindings drop a context whose stream JavaScript abandoned:
        // freeing the encoder waits for the jobs and stops the threads.
        let data = words(4 * 1024 * 1024 + 1);
        for dict in [&[][..], DICT] {
            let mut ctx = encoder_with_workers(1, 2, dict);
            ctx.transform(&data).unwrap();
            // Two jobs of 2 MiB have started.
            let progression = ctx.encoder.as_ref().unwrap().get_frame_progression();
            assert_eq!(
                progression.currentJobID,
                2,
                "{}-byte dictionary",
                dict.len()
            );
            drop(ctx);
        }
    }

    /// The memory of `encoder`, measured now. With workers, only while no
    /// job is in progress: see [`StreamEncoder::encoder_size`].
    fn measured_now(encoder: &StreamEncoder) -> usize {
        encoder.encoder.as_ref().map_or(0, CCtx::sizeof) + encoder.output_buf.capacity()
    }

    #[cfg(feature = "zstdmt")]
    #[test]
    fn compress_context_reports_the_workers_memory() {
        let data = words(2 * 1024 * 1024);
        let mut single = CompressContext::new(Some(1)).unwrap();
        let mut multi = CompressContext::with_workers(Some(1), 2).unwrap();
        for ctx in [&mut single, &mut multi] {
            ctx.transform(&data).unwrap();
            // flush waits for every job, so the figure is measured after it.
            ctx.flush().unwrap();
        }
        // The workers have buffers for their jobs and contexts of their own.
        assert!(
            multi.memory_usage() > 2 * single.memory_usage(),
            "{} bytes with 2 workers, {} without",
            multi.memory_usage(),
            single.memory_usage()
        );
        assert_eq!(multi.memory_usage(), measured_now(&multi.inner));
        multi.finish().unwrap();
        assert_eq!(multi.memory_usage(), multi.inner.output_buf.capacity());
    }

    #[cfg(feature = "zstdmt")]
    #[test]
    fn compress_context_with_workers_measures_no_job_in_progress() {
        use std::time::{Duration, Instant};

        let mut ctx = CompressContext::with_workers(Some(1), 2).unwrap();
        let created = ctx.memory_usage();
        assert_eq!(created, measured_now(&ctx.inner));

        // Two jobs of 2 MiB, which the workers are likely still compressing
        // when transform returns.
        ctx.transform(&words(4 * 1024 * 1024 + 1)).unwrap();
        let reported = ctx.memory_usage();
        let encoder = ctx.inner.encoder.as_ref().unwrap();
        let start = Instant::now();
        while encoder.get_frame_progression().nbActiveWorkers > 0 {
            assert!(
                start.elapsed() < Duration::from_secs(60),
                "jobs in progress"
            );
            std::thread::sleep(Duration::from_millis(1));
        }
        // The finished jobs have handed their contexts back to the pool, but
        // the figure changes only when the context calls zstd, never while
        // the workers may be compressing.
        assert_eq!(ctx.memory_usage(), reported);

        ctx.flush().unwrap();
        assert_eq!(ctx.memory_usage(), measured_now(&ctx.inner));
        assert!(ctx.memory_usage() > created);
    }

    #[test]
    fn compress_contexts_with_no_workers_measure_the_encoder_when_asked() {
        let data = words(256 * 1024);
        for dict in [&[][..], DICT] {
            // Without workers, the figure is zstd's measurement at the time
            // of the call, as before workers existed.
            let mut ctx = encoder_with_workers(5, 0, dict);
            assert_eq!(ctx.encoder_size, None, "{}-byte dictionary", dict.len());
            assert_eq!(ctx.memory_usage(), measured_now(&ctx));
            for chunk in data.chunks(64 * 1024) {
                ctx.transform(chunk).unwrap();
                assert_eq!(ctx.memory_usage(), measured_now(&ctx));
            }
            ctx.flush().unwrap();
            assert_eq!(ctx.memory_usage(), measured_now(&ctx));
            ctx.finish().unwrap();
            assert_eq!(ctx.memory_usage(), ctx.output_buf.capacity());
        }
    }

    /// The error of creating a context with `workers`, with `dict` if it is
    /// not empty.
    fn with_workers_error(level: Option<i32>, workers: u32, dict: &[u8]) -> ComprsError {
        let result = if dict.is_empty() {
            CompressContext::with_workers(level, workers).map(drop)
        } else {
            CompressDictContext::with_workers(dict, level, workers).map(drop)
        };
        result.unwrap_err()
    }

    #[test]
    fn compress_contexts_validate_workers() {
        for dict in [&[][..], DICT] {
            // The workers are checked before the level, as in the one-shot
            // functions.
            let err = with_workers_error(Some(23), 257, dict);
            assert!(matches!(err, ComprsError::InvalidArg(_)), "{err:?}");
            assert_eq!(
                err.to_string(),
                "zstd workers must be an integer between 0 and 256"
            );
            let err = with_workers_error(Some(23), 0, dict);
            assert!(matches!(err, ComprsError::InvalidArg(_)), "{err:?}");
        }
    }

    #[cfg(not(feature = "zstdmt"))]
    #[test]
    fn compress_contexts_with_workers_need_the_zstdmt_feature() {
        for dict in [&[][..], DICT] {
            let err = with_workers_error(None, 1, dict);
            assert!(matches!(err, ComprsError::InvalidArg(_)), "{err:?}");
            assert_eq!(
                err.to_string(),
                "zstd workers are not supported in this build"
            );
        }
    }

    #[test]
    fn compress_context_grows_the_output_buffer() {
        use std::io::Write;

        // Incompressible data that ends one byte short of a full block: zstd
        // holds back the last 128 KiB - 1 byte, which take more than the
        // initial buffer to flush as a raw block.
        let data = random(2 * 1024 * 1024);
        let (head, tail) = data.split_at(data.len() - 1);
        let mut ctx = CompressContext::new(Some(1)).unwrap();
        let mut frame = ctx.transform(head).unwrap();
        let flushed = ctx.flush().unwrap();
        assert!(flushed.len() > INITIAL_BUF_SIZE, "{} bytes", flushed.len());
        frame.extend(flushed);
        frame.extend(ctx.transform(tail).unwrap());
        frame.extend(ctx.finish().unwrap());
        let mut reference = zstd::stream::Encoder::new(Vec::new(), 1).unwrap();
        reference.write_all(head).unwrap();
        reference.flush().unwrap();
        reference.write_all(tail).unwrap();
        assert!(frame == reference.finish().unwrap());
        assert!(crate::zstd::decompress(&frame).unwrap() == data);

        let mut ctx = CompressDictContext::new(DICT, Some(1)).unwrap();
        let (head, tail) = data.split_at(1024 * 1024 - 1);
        let mut frame = ctx.transform(head).unwrap();
        let flushed = ctx.flush().unwrap();
        assert!(flushed.len() > INITIAL_BUF_SIZE, "{} bytes", flushed.len());
        frame.extend(flushed);
        frame.extend(ctx.transform(tail).unwrap());
        frame.extend(ctx.finish().unwrap());
        assert!(crate::zstd::decompress_with_dict(&frame, DICT).unwrap() == data);
    }

    #[test]
    fn compress_context_returns_exact_output_and_keeps_its_buffer() {
        let mut ctx = CompressContext::new(None).unwrap();
        // zstd buffers small input without producing output.
        let output = ctx.transform(b"small chunk").unwrap();
        assert!(output.is_empty());
        assert_eq!(output.capacity(), 0);
        let capacity = ctx.inner.output_buf.capacity();
        assert!(capacity >= INITIAL_BUF_SIZE, "{capacity} bytes");

        let flushed = ctx.flush().unwrap();
        assert!(!flushed.is_empty());
        assert_eq!(flushed.capacity(), flushed.len());
        // The buffer is reused rather than reallocated, and counted.
        assert_eq!(ctx.inner.output_buf.capacity(), capacity);
        assert!(ctx.memory_usage() >= capacity);
    }

    #[test]
    fn compress_contexts_cannot_be_used_after_finish() {
        let mut contexts = [
            CompressContext::new(None).unwrap().inner,
            CompressDictContext::new(DICT, None).unwrap().inner,
        ];
        for ctx in &mut contexts {
            ctx.transform(b"finished").unwrap();
            ctx.finish().unwrap();
            assert!(matches!(
                ctx.transform(b"more"),
                Err(ComprsError::StreamFinished(_))
            ));
            assert!(matches!(ctx.flush(), Err(ComprsError::StreamFinished(_))));
            assert!(matches!(ctx.finish(), Err(ComprsError::StreamFinished(_))));
        }
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
        assert_eq!(strong.memory_usage(), strong.inner.output_buf.capacity());
    }

    #[test]
    fn decompress_context_reports_the_window() {
        let original = vec![7u8; 1024 * 1024];
        let compressed = crate::zstd::compress(&original, None).unwrap();
        let mut ctx = DecompressContext::new(None).unwrap();
        let empty = ctx.memory_usage();

        let output = ctx.transform(&compressed).unwrap();
        // The frame declares its content size, so the decoder keeps a window
        // of up to that size rather than the window that the frame's level
        // uses; the output buffer holds the whole output of the call.
        assert!(ctx.memory_usage() > empty + 2 * original.len());
        assert_eq!(output, original);

        ctx.finish().unwrap();
        assert_eq!(ctx.memory_usage(), ctx.inner.output_buf.capacity());
    }

    /// A frame without a content size whose window descriptor, 0x88,
    /// declares a window of 128 MiB, then a raw block that holds "A". Its
    /// first 6 bytes are the frame header.
    const LARGE_WINDOW: [u8; 10] = [0x28, 0xB5, 0x2F, 0xFD, 0x00, 0x88, 0x09, 0x00, 0x00, 0x41];

    const MIB: usize = 1024 * 1024;

    /// The window that `frame` declares in its window descriptor (RFC 8878,
    /// section 3.1.1.1.2), which a frame without the single segment flag
    /// has: the frames that stream encoders write without a content size.
    fn declared_window(frame: &[u8]) -> usize {
        assert_eq!(frame[4] & 0x20, 0, "single-segment frame");
        let descriptor = frame[5];
        let base = 1 << (10 + (descriptor >> 3));
        base + base / 8 * usize::from(descriptor & 7)
    }

    #[test]
    fn window_log_max_rounds_the_limit_up_within_8_and_128_mib() {
        assert_eq!(declared_window(&LARGE_WINDOW), 128 * MIB);
        for (limit, log) in [
            (0, 23),
            (1, 23),
            (1024, 23),
            (8 * MIB, 23),
            (8 * MIB + 1, 24),
            (64 * MIB, 26),
            (64 * MIB + 1, 27),
            (128 * MIB, 27),
            (crate::MAX_DECOMPRESSED_SIZE, 27),
            (usize::MAX, 27),
        ] {
            assert_eq!(window_log_max(limit), log, "limit {limit}");
        }
    }

    #[test]
    fn decompress_context_keeps_the_default_window_bound_of_zstd() {
        // The header of a single-segment frame, whose window is its content
        // size: 128 MiB + 1 byte, which zstd's default bound accepts.
        const SIZE: usize = 128 * MIB + 1;
        let mut header = vec![0x28, 0xB5, 0x2F, 0xFD, 0xA0];
        header.extend((SIZE as u32).to_le_bytes());
        let mut ctx = DecompressContext::new(Some(SIZE as f64)).unwrap();
        assert!(ctx.transform(&header).unwrap().is_empty());
        assert!(ctx.memory_usage() > SIZE);
    }

    /// The decoders of every zstd decompression context, with
    /// `max_output_size`.
    fn decompress_contexts(max_output_size: Option<f64>) -> [(&'static str, StreamDecoder); 3] {
        let dict = Dictionary::new(DICT, DictionaryFormat::Zstd, None).unwrap();
        [
            (
                "DecompressContext",
                DecompressContext::new(max_output_size).unwrap().inner,
            ),
            (
                "DecompressDictContext",
                DecompressDictContext::new(DICT, max_output_size)
                    .unwrap()
                    .inner,
            ),
            (
                "DecompressDictContext::with_prepared",
                DecompressDictContext::with_prepared(&dict, max_output_size)
                    .unwrap()
                    .inner,
            ),
        ]
    }

    /// The header of a single-segment frame that declares a content size of
    /// 128 MiB, which is also its window. A streaming decoder sizes its
    /// buffer as the smaller of the content size and the window plus two
    /// blocks, so this header reserves 128 MiB as that of [`LARGE_WINDOW`]
    /// does.
    const LARGE_CONTENT_SIZE_HEADER: [u8; 9] = [0x28, 0xB5, 0x2F, 0xFD, 0xA0, 0, 0, 0, 0x08];

    #[test]
    fn decompress_contexts_bound_the_window_by_the_limit() {
        const CONTEXT: &str = "zstd stream decompress";
        let header = &LARGE_WINDOW[..6];
        for (name, mut ctx) in decompress_contexts(None) {
            // The default limit accepts the window, which the decoder
            // reserves as soon as it has read the header.
            assert!(ctx.decompress(header, CONTEXT).unwrap().is_empty());
            assert!(ctx.memory_usage() > 128 * MIB, "{name}");
            assert_eq!(ctx.decompress(&LARGE_WINDOW[6..], CONTEXT).unwrap(), b"A");
            assert_eq!(ctx.finish().unwrap(), b"", "{name}");
        }
        for (name, mut ctx) in decompress_contexts(None) {
            let header = &LARGE_CONTENT_SIZE_HEADER;
            assert!(ctx.decompress(header, CONTEXT).unwrap().is_empty());
            assert!(ctx.memory_usage() > 128 * MIB, "{name}");
        }
        for header in [header, &LARGE_CONTENT_SIZE_HEADER] {
            for (name, mut ctx) in decompress_contexts(Some(1024.0)) {
                let err = ctx.decompress(header, CONTEXT).unwrap_err();
                assert!(
                    matches!(err, ComprsError::SizeLimit { limit: 1024, .. }),
                    "{name}: {err:?}"
                );
                assert_eq!(
                    err.to_string(),
                    "zstd frame window exceeded maximum size of 1024 bytes"
                );
                assert!(
                    ctx.memory_usage() < MIB,
                    "{name}: {} bytes",
                    ctx.memory_usage()
                );
            }
        }
        for (name, mut ctx) in decompress_contexts(Some(1024.0)) {
            let err = ctx.decompress(&LARGE_WINDOW, CONTEXT).unwrap_err();
            assert!(
                matches!(
                    err,
                    ComprsError::SizeLimit {
                        context: "zstd frame window",
                        limit: 1024
                    }
                ),
                "{name}: {err:?}"
            );
        }
    }

    /// `data` compressed by a [`CompressContext`] at `level`, without a
    /// content size.
    fn stream_frame(data: &[u8], level: i32) -> Vec<u8> {
        let mut ctx = CompressContext::new(Some(level)).unwrap();
        let mut frame = ctx.transform(data).unwrap();
        frame.extend(ctx.finish().unwrap());
        frame
    }

    #[test]
    fn decompress_contexts_bound_the_window_of_comprs_frames() {
        // Without a content size, a frame declares the window of its level.
        let data = words(1000);
        let decompress = |frame: &[u8], limit: usize| {
            let mut ctx = DecompressContext::new(Some(limit as f64)).unwrap();
            [
                decompress_all(&mut ctx, frame, 64),
                crate::zstd::decompress_with_capacity(frame, limit),
            ]
        };

        // Level 19 declares 8 MiB, which every limit accepts.
        let frame = stream_frame(&data, 19);
        assert_eq!(declared_window(&frame), 8 * MIB);
        for output in decompress(&frame, data.len() + 1) {
            assert!(output.unwrap() == data);
        }

        // Level 20 declares 32 MiB, which needs a limit of more than 16 MiB,
        // such as the default. Level 22 declares 128 MiB, as LARGE_WINDOW
        // does, but its encoder takes about 700 MiB.
        let frame = stream_frame(&data, 20);
        assert_eq!(declared_window(&frame), 32 * MIB);
        for limit in [data.len() + 1, 16 * MIB] {
            for result in decompress(&frame, limit) {
                let err = result.unwrap_err();
                assert!(
                    matches!(
                        err,
                        ComprsError::SizeLimit {
                            context: "zstd frame window",
                            ..
                        }
                    ),
                    "{err:?}"
                );
            }
        }
        for output in decompress(&frame, 16 * MIB + 1) {
            assert!(output.unwrap() == data);
        }
        let mut ctx = DecompressContext::new(None).unwrap();
        assert!(decompress_all(&mut ctx, &frame, 64).unwrap() == data);
        assert!(crate::zstd::decompress(&frame).unwrap() == data);
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
