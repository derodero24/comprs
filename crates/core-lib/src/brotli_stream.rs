//! Brotli streaming compression and decompression, with libbrotli through
//! comprs-brotli (#563).

use std::sync::Arc;

use comprs_brotli::{Decoder, Encoder, Operation, PreparedDictionary, Status};

use crate::brotli::{DEFAULT_QUALITY, QUALITY, decoder_error, invalid_data, operation_error};
use crate::dictionary::Dictionary;
use crate::limited::LimitedVec;
use crate::{ComprsError, MemoryUsage};

/// Room, in bytes, that the decompression contexts give the decoder in an
/// empty output buffer, which then doubles as it fills.
const OUTPUT_ROOM: usize = crate::brotli::BUFFER_SIZE;

/// Streaming brotli compression context.
///
/// The encoder gets the input `FEED` bytes at a time, whatever the chunks
/// (see `StreamEncoder`): `transform` holds the input that does not make
/// that much yet, and `flush` and `finish` pass it on first. At qualities 0
/// and 1, the encoder compresses the input of each call on its own, with
/// nothing that refers back to earlier calls: in chunks of 100 bytes, text
/// that compresses to 120 bytes in one call took 204,335 at quality 1
/// (#731).
pub struct CompressContext {
    /// `None` once the stream is finished.
    encoder: Option<StreamEncoder>,
}

impl CompressContext {
    pub fn new(quality: Option<u32>) -> Result<Self, ComprsError> {
        let quality = QUALITY.check(quality.unwrap_or(DEFAULT_QUALITY))?;
        let encoder = StreamEncoder::new(quality, None, 0)
            .map_err(|e| operation_error("brotli stream compress", e))?;
        Ok(Self {
            encoder: Some(encoder),
        })
    }

    pub fn transform(&mut self, chunk: &[u8]) -> Result<Vec<u8>, ComprsError> {
        self.encoder
            .as_mut()
            .ok_or(ComprsError::StreamFinished("brotli stream"))?
            .run(Operation::Process, chunk)
            .map_err(|e| operation_error("brotli stream compress", e))
    }

    pub fn flush(&mut self) -> Result<Vec<u8>, ComprsError> {
        self.encoder
            .as_mut()
            .ok_or(ComprsError::StreamFinished("brotli stream"))?
            .run(Operation::Flush, &[])
            .map_err(|e| operation_error("brotli stream flush", e))
    }

    pub fn finish(&mut self) -> Result<Vec<u8>, ComprsError> {
        self.encoder
            .take()
            .ok_or(ComprsError::StreamFinished("brotli stream"))?
            .run(Operation::Finish, &[])
            .map_err(|e| operation_error("brotli stream compress", e))
    }
}

impl MemoryUsage for CompressContext {
    fn memory_usage(&self) -> usize {
        self.encoder.as_ref().map_or(0, StreamEncoder::memory_usage)
    }
}

/// Streaming brotli decompression context.
pub struct DecompressContext {
    inner: StreamDecoder,
}

impl DecompressContext {
    pub fn new(max_output_size: Option<f64>) -> Result<Self, ComprsError> {
        let max_size = crate::validate_max_output_size(max_output_size)?;
        Ok(Self {
            inner: StreamDecoder::new(
                None,
                LimitedVec::new(max_size, "brotli stream decompress"),
                "brotli stream",
            )?,
        })
    }

    pub fn transform(&mut self, chunk: &[u8]) -> Result<Vec<u8>, ComprsError> {
        self.inner.decompress(chunk, "brotli stream decompress")
    }

    pub fn flush(&mut self) -> Result<Vec<u8>, ComprsError> {
        self.inner.decompress(&[], "brotli stream flush")
    }

    /// Finalize the decompression stream, returning any remaining output.
    ///
    /// Fails with [`ComprsError::Truncated`] unless the input contained the
    /// complete brotli stream.
    pub fn finish(&mut self) -> Result<Vec<u8>, ComprsError> {
        self.inner.finish("brotli stream finish")
    }
}

impl MemoryUsage for DecompressContext {
    fn memory_usage(&self) -> usize {
        self.inner.memory_usage()
    }
}

/// Most input that an incremental [`CompressDictContext`] holds before it
/// starts to compress: 4 MiB less 16 bytes (4,194,288), the longest
/// distance that brotli's encoder refers back with a window of
/// 2^[`crate::brotli::LG_WINDOW_SIZE`] bytes.
///
/// The encoder takes a custom dictionary as data that precedes the input,
/// so from input position p, the last byte of the dictionary is p + 1 bytes
/// back: only the first `DICT_REACH` bytes of input can refer to the
/// dictionary. A stream that ends within them gets the output of
/// [`crate::brotli::compress_with_dict`].
pub const DICT_REACH: usize = (1 << crate::brotli::LG_WINDOW_SIZE) - 16;

/// The name that [`ComprsError::StreamFinished`] reports for a
/// [`CompressDictContext`].
const DICT_STREAM: &str = "brotli dict stream";

/// The context of the errors of a [`CompressDictContext`].
const DICT_COMPRESS: &str = "brotli dict stream compress";

/// Streaming brotli compression context with custom dictionary, in one of
/// two modes:
///
/// - Buffered, as [`CompressDictContext::new`] creates it: `transform` keeps
///   the input and returns an empty Vec, as `flush` does, and `finish`
///   compresses all of it, into the output of
///   [`crate::brotli::compress_with_dict`].
/// - Incremental, as [`CompressDictContext::incremental`] creates it: it
///   holds the first [`DICT_REACH`] bytes of input in the same way, and a
///   stream of at most that many bytes gets the same output on `finish`.
///   The `transform` that takes the input past [`DICT_REACH`] bytes
///   compresses the input held so far with the dictionary, flushes it and
///   drops it, then passes the rest of its chunk on. From then on, the
///   encoder takes the input as it arrives, `FEED` bytes at a time:
///   `transform` returns the output that the encoder has emitted, `flush`
///   all the output of the input so far, and `finish` ends the stream.
///
/// An error of the encoder, such as a failed allocation, ends the stream:
/// the later calls fail with it too.
pub struct CompressDictContext {
    quality: u32,
    /// Most input that the context holds: [`DICT_REACH`] bytes in
    /// incremental mode, no limit in buffered mode.
    max_held: usize,
    state: DictState,
}

enum DictState {
    /// The dictionary and the input so far, which the context holds until
    /// `finish` or, in incremental mode, until the input grows past
    /// [`DICT_REACH`] bytes.
    Holding { dict: HeldDict, input: Vec<u8> },
    /// The encoder, which has taken the input so far.
    Streaming(Box<StreamEncoder>),
    /// A call failed with this error, which the later calls report again.
    Failed(ComprsError),
    /// `finish` was called.
    Finished,
}

/// The dictionary of a [`CompressDictContext`] that has not started to
/// compress.
enum HeldDict {
    /// Its bytes, empty for none, which the context prepares when it starts
    /// to compress.
    Bytes(Vec<u8>),
    /// Prepared by a [`Dictionary`], which reports its memory.
    Prepared(Arc<PreparedDictionary<'static>>),
}

impl HeldDict {
    /// The prepared dictionary, if any, and the memory of it that the
    /// context reports.
    fn prepare(self) -> Result<(Option<Arc<PreparedDictionary<'static>>>, usize), ComprsError> {
        match self {
            HeldDict::Bytes(bytes) if bytes.is_empty() => Ok((None, 0)),
            HeldDict::Bytes(bytes) => {
                let prepared = crate::brotli::prepared_dictionary(&bytes)
                    .map_err(|e| operation_error(DICT_COMPRESS, e))?;
                let memory = prepared.bytes().len() + prepared.memory_usage();
                Ok((Some(prepared), memory))
            }
            HeldDict::Prepared(prepared) => Ok((Some(prepared), 0)),
        }
    }
}

impl CompressDictContext {
    /// A buffered context, which compresses all its input on `finish`.
    pub fn new(dict: &[u8], quality: Option<u32>) -> Result<Self, ComprsError> {
        Self::with_max_held(HeldDict::Bytes(dict.to_vec()), quality, usize::MAX)
    }

    /// An incremental context, which holds at most [`DICT_REACH`] bytes of
    /// input and then streams.
    pub fn incremental(dict: &[u8], quality: Option<u32>) -> Result<Self, ComprsError> {
        Self::with_max_held(HeldDict::Bytes(dict.to_vec()), quality, DICT_REACH)
    }

    /// An incremental context with a prepared [`Dictionary`], which it
    /// shares rather than copies or prepares again: its output is that of
    /// [`incremental`](Self::incremental) with the bytes of the dictionary.
    ///
    /// Fails with [`ComprsError::InvalidArg`] for a zstd dictionary, then
    /// for an invalid `quality`.
    pub fn incremental_prepared(
        dict: &Dictionary,
        quality: Option<u32>,
    ) -> Result<Self, ComprsError> {
        let prepared = Arc::clone(dict.brotli_prepared()?);
        Self::with_max_held(HeldDict::Prepared(prepared), quality, DICT_REACH)
    }

    fn with_max_held(
        dict: HeldDict,
        quality: Option<u32>,
        max_held: usize,
    ) -> Result<Self, ComprsError> {
        let quality = QUALITY.check(quality.unwrap_or(DEFAULT_QUALITY))?;
        Ok(Self {
            quality,
            max_held,
            state: DictState::Holding {
                dict,
                input: Vec::new(),
            },
        })
    }

    /// Take a chunk of data. While the context holds its input, keep the
    /// chunk and return an empty Vec; otherwise compress it and return the
    /// output that the encoder has emitted.
    pub fn transform(&mut self, chunk: &[u8]) -> Result<Vec<u8>, ComprsError> {
        let (dict, input) = match &mut self.state {
            DictState::Holding { dict, input } => (dict, input),
            DictState::Streaming(encoder) => {
                let output = encoder.run(Operation::Process, chunk);
                return self.settle(output);
            }
            DictState::Failed(error) => return Err(error.duplicate()),
            DictState::Finished => return Err(ComprsError::StreamFinished(DICT_STREAM)),
        };
        let room = self.max_held - input.len();
        let (held, rest) = chunk.split_at(chunk.len().min(room));
        hold(input, held, self.max_held);
        if rest.is_empty() {
            return Ok(Vec::new());
        }

        // The input has grown past what the context holds: compress what it
        // holds with the dictionary, then the rest of the chunk. An empty
        // dictionary is none, as for `compress_with_dict`.
        let input = std::mem::take(input);
        let dict = std::mem::replace(dict, HeldDict::Bytes(Vec::new()));
        let output = dict.prepare().and_then(|(dict, dict_memory)| {
            let mut encoder = StreamEncoder::new(self.quality, dict, dict_memory)
                .map_err(|e| operation_error(DICT_COMPRESS, e))?;
            let mut output = encoder
                .run(Operation::Flush, &input)
                .map_err(|e| operation_error(DICT_COMPRESS, e))?;
            drop(input);
            output.extend(
                encoder
                    .run(Operation::Process, rest)
                    .map_err(|e| operation_error(DICT_COMPRESS, e))?,
            );
            self.state = DictState::Streaming(Box::new(encoder));
            Ok(output)
        });
        self.settle_checked(output)
    }

    /// While the context holds its input, return an empty Vec. Otherwise
    /// flush the encoder, and return all the output of the input so far.
    pub fn flush(&mut self) -> Result<Vec<u8>, ComprsError> {
        match &mut self.state {
            DictState::Holding { .. } => Ok(Vec::new()),
            DictState::Streaming(encoder) => {
                let output = encoder.run(Operation::Flush, &[]);
                self.settle(output)
            }
            DictState::Failed(error) => Err(error.duplicate()),
            DictState::Finished => Err(ComprsError::StreamFinished(DICT_STREAM)),
        }
    }

    /// End the stream and return the rest of the output: all of it, from
    /// the input that the context holds, if it holds the input. Later calls
    /// fail.
    pub fn finish(&mut self) -> Result<Vec<u8>, ComprsError> {
        match std::mem::replace(&mut self.state, DictState::Finished) {
            DictState::Holding { dict, input } => {
                let (dict, _) = dict.prepare()?;
                crate::brotli::compress_with_prepared_inner(
                    &input,
                    dict,
                    self.quality,
                    DICT_COMPRESS,
                )
            }
            DictState::Streaming(mut encoder) => encoder
                .run(Operation::Finish, &[])
                .map_err(|e| operation_error(DICT_COMPRESS, e)),
            DictState::Failed(error) => Err(error),
            DictState::Finished => Err(ComprsError::StreamFinished(DICT_STREAM)),
        }
    }

    /// Pass on the `output` of a call that ran the encoder, and end the
    /// stream if it is an error: an encoder that failed cannot go on.
    fn settle(
        &mut self,
        output: Result<Vec<u8>, comprs_brotli::Error>,
    ) -> Result<Vec<u8>, ComprsError> {
        self.settle_checked(output.map_err(|e| operation_error(DICT_COMPRESS, e)))
    }

    /// [`settle`](Self::settle) for an error that is already a
    /// [`ComprsError`].
    fn settle_checked(
        &mut self,
        output: Result<Vec<u8>, ComprsError>,
    ) -> Result<Vec<u8>, ComprsError> {
        output.inspect_err(|error| self.state = DictState::Failed(error.duplicate()))
    }
}

impl MemoryUsage for CompressDictContext {
    /// The dictionary and the input that the context holds, or the encoder
    /// state, with its window, its hash tables and the prepared dictionary.
    fn memory_usage(&self) -> usize {
        match &self.state {
            DictState::Holding { dict, input } => {
                let dict = match dict {
                    HeldDict::Bytes(bytes) => bytes.capacity(),
                    HeldDict::Prepared(_) => 0,
                };
                dict + input.capacity()
            }
            DictState::Streaming(encoder) => encoder.memory_usage(),
            DictState::Failed(_) | DictState::Finished => 0,
        }
    }
}

/// Append `chunk` to `input`, which never holds more than `max_held` bytes:
/// its capacity doubles as it fills, as a Vec's does, but stops at
/// `max_held`.
fn hold(input: &mut Vec<u8>, chunk: &[u8], max_held: usize) {
    let len = input.len() + chunk.len();
    if len > input.capacity() {
        let capacity = len.max(input.capacity().saturating_mul(2)).min(max_held);
        input.reserve_exact(capacity - input.len());
    }
    input.extend_from_slice(chunk);
}

/// Input that [`StreamEncoder`] passes to each call of the encoder: it holds
/// smaller chunks until they make this much, and passes what is left to the
/// call that flushes or ends the stream.
///
/// The encoder takes the input of its first call, with what it holds past
/// it, as a hint of the size of the stream, and tries a more complex model
/// of the literals above 1 MiB: given the 4 MiB that the start of a stream
/// holds at once, it made a stream of JSON lines 2% larger at qualities 6
/// and 9 than [`crate::brotli::compress_with_dict`]. At qualities 0 and 1,
/// the encoder compresses the input of each call on its own: 4 KiB calls
/// made the stream half again as large, and 4 MiB calls held 8 MiB. Calls
/// of 64 KiB gave about the size of the one-shot function's output at
/// qualities 6 and 9, and a smaller one at 0 and 1. Fed in calls of this
/// size, the encoder gives the same output however the stream's input is
/// split into chunks.
const FEED: usize = 64 * 1024;

/// libbrotli's encoder, driven one operation at a time for the streaming
/// compression contexts.
struct StreamEncoder {
    /// Holds the prepared dictionary that it is attached to, if any.
    encoder: Encoder<'static>,
    /// The memory of the prepared dictionary, its bytes included, unless a
    /// [`Dictionary`] reports it.
    dict_memory: usize,
    /// Input that the encoder has not taken yet: less than [`FEED`] bytes,
    /// which [`Self::run`] passes on once they make [`FEED`] bytes, or to
    /// flush or end the stream.
    pending: Vec<u8>,
}

#[cfg(test)]
thread_local! {
    /// The operation on which [`StreamEncoder::run`] fails in this thread,
    /// for the tests of an encoder that fails.
    static FAULT: std::cell::Cell<Option<Operation>> = const { std::cell::Cell::new(None) };
}

impl StreamEncoder {
    /// An encoder at `quality`, with the prepared raw dictionary `dict`, if
    /// any, which holds `dict_memory` bytes that the encoder reports.
    fn new(
        quality: u32,
        dict: Option<Arc<PreparedDictionary<'static>>>,
        dict_memory: usize,
    ) -> Result<Self, comprs_brotli::Error> {
        let mut encoder = crate::brotli::encoder(quality)?;
        if let Some(dict) = dict {
            encoder.attach_shared(dict)?;
        }
        Ok(Self {
            encoder,
            dict_memory,
            pending: Vec::new(),
        })
    }

    /// Run `op` on all of `input` and return the output: what the encoder
    /// has emitted so far for [`Operation::Process`], all the output of the
    /// input so far for [`Operation::Flush`], and the rest of the stream for
    /// [`Operation::Finish`].
    ///
    /// The encoder takes the input [`FEED`] bytes at a time, whatever the
    /// chunks it arrives in: the input short of that waits in
    /// [`Self::pending`] for more, a flush or the end of the stream.
    fn run(&mut self, op: Operation, mut input: &[u8]) -> Result<Vec<u8>, comprs_brotli::Error> {
        #[cfg(test)]
        if FAULT.get() == Some(op) {
            return Err(comprs_brotli::Error::Encoder);
        }
        let mut output = Vec::new();
        if !self.pending.is_empty() {
            let (head, rest) = input.split_at(input.len().min(FEED - self.pending.len()));
            self.pending.extend_from_slice(head);
            input = rest;
            if self.pending.len() == FEED {
                self.encoder
                    .compress_all(Operation::Process, &self.pending, &mut output)?;
                self.pending.clear();
            }
        }
        // Either `pending` is empty now, or so is `input`.
        let (pieces, rest) = input.as_chunks::<FEED>();
        for piece in pieces {
            self.encoder
                .compress_all(Operation::Process, piece, &mut output)?;
        }
        if !rest.is_empty() {
            self.pending.reserve_exact(FEED);
            self.pending.extend_from_slice(rest);
        }
        if op != Operation::Process {
            self.encoder.compress_all(op, &self.pending, &mut output)?;
            self.pending.clear();
        }
        Ok(output)
    }

    /// The memory of the encoder, including its window, its hash tables and
    /// its dictionary, and of the input that waits for it.
    fn memory_usage(&self) -> usize {
        self.encoder.memory_usage() + self.dict_memory + self.pending.capacity()
    }
}

/// Streaming brotli decompression context with custom dictionary.
pub struct DecompressDictContext {
    inner: StreamDecoder,
}

impl DecompressDictContext {
    pub fn new(dict: &[u8], max_output_size: Option<f64>) -> Result<Self, ComprsError> {
        let max_size = crate::validate_max_output_size(max_output_size)?;
        Ok(Self {
            inner: StreamDecoder::new(
                (!dict.is_empty()).then(|| Arc::from(dict)),
                LimitedVec::new(max_size, "brotli dict stream decompress"),
                "brotli dict stream",
            )?,
        })
    }

    /// Create a context for a prepared [`Dictionary`], whose bytes it shares
    /// rather than copies.
    ///
    /// Fails with [`ComprsError::InvalidArg`] for a zstd dictionary, then
    /// for an invalid `max_output_size`.
    pub fn with_prepared(
        dict: &Dictionary,
        max_output_size: Option<f64>,
    ) -> Result<Self, ComprsError> {
        let dict = dict.brotli_raw()?;
        let max_size = crate::validate_max_output_size(max_output_size)?;
        Ok(Self {
            inner: StreamDecoder::new(
                Some(dict),
                LimitedVec::new(max_size, "brotli dict stream decompress"),
                "brotli dict stream",
            )?,
        })
    }

    pub fn transform(&mut self, chunk: &[u8]) -> Result<Vec<u8>, ComprsError> {
        self.inner
            .decompress(chunk, "brotli dict stream decompress")
    }

    pub fn flush(&mut self) -> Result<Vec<u8>, ComprsError> {
        self.inner.decompress(&[], "brotli dict stream flush")
    }

    /// Finalize the decompression stream, returning any remaining output.
    ///
    /// Fails with [`ComprsError::Truncated`] unless the input contained the
    /// complete brotli stream.
    pub fn finish(&mut self) -> Result<Vec<u8>, ComprsError> {
        self.inner.finish("brotli dict stream finish")
    }
}

impl MemoryUsage for DecompressDictContext {
    fn memory_usage(&self) -> usize {
        self.inner.memory_usage()
    }
}

/// Decompress the brotli stream at the start of `input`, with the custom
/// dictionary `dict` (empty for none), in one call.
///
/// The decoder gets all of `input` at once, so it sees how much output a
/// stream shorter than its window holds and sizes its ring buffer for that
/// rather than for the whole window (4 MiB at the default window size). It
/// writes into the output buffer, which starts with room for four times the
/// input and grows geometrically, but never past `max_output_size` plus one
/// byte. A failure to allocate that first buffer is reported as an error, as
/// in [`crate::decompress_with_limit`].
///
/// Invalid input fails with "Invalid Data", prefixed by `context`, and
/// exceeding `max_output_size` with [`ComprsError::SizeLimit`]. `end` sets
/// how the end of the input is checked:
///
/// - [`End::Lenient`]: data after the end of the stream is ignored, and
///   truncated input fails with "Invalid Data" as well. Both are
///   [`ComprsError::Corrupt`]: the one-shot functions keep that message for
///   truncated input, so unlike the decompression contexts they do not
///   report it as [`ComprsError::Truncated`].
/// - [`End::Strict`]: like the decompression contexts, input that ends
///   before the end of the stream fails with [`ComprsError::Truncated`], and
///   data after the end of the stream with [`ComprsError::Corrupt`].
pub(crate) fn decompress_all(
    input: &[u8],
    dict: &[u8],
    max_output_size: usize,
    context: &'static str,
    end: End,
) -> Result<Vec<u8>, ComprsError> {
    let mut output = LimitedVec::new(max_output_size, context);
    output
        .try_reserve(input.len().saturating_mul(4))
        .map_err(|e| ComprsError::Operation {
            context,
            source: e.into(),
        })?;
    let mut decoder = Decoder::new().map_err(|e| operation_error(context, e))?;
    if !dict.is_empty() {
        decoder
            .attach(dict)
            .map_err(|e| operation_error(context, e))?;
    }
    let mut rest = input;
    loop {
        let result = output
            .append_with(input.len().saturating_mul(4), |buf| {
                Ok(decoder.decompress(&mut rest, buf))
            })
            .map_err(|e| output.error(e, context))?;
        match (result, end) {
            (Ok(Status::NeedsMoreOutput), _) => {}
            (Ok(Status::Finished), End::Strict) if !rest.is_empty() => {
                return Err(data_after_the_stream(context));
            }
            (Ok(Status::Finished), _) => return Ok(crate::finish_output(output.take())),
            (Ok(Status::NeedsMoreInput), End::Strict) => {
                return Err(ComprsError::Truncated("brotli"));
            }
            (Ok(Status::NeedsMoreInput), End::Lenient) => {
                return Err(invalid_data(context));
            }
            (Err(e), _) => return Err(decoder_error(context, e)),
        }
    }
}

/// How [`decompress_all`] checks the end of its input.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum End {
    /// Data after the end of the stream is ignored, and truncated input is
    /// invalid data, as the one-shot functions have always reported it.
    Lenient,
    /// Truncated input and data after the end of the stream are errors of
    /// their own, as in the decompression contexts.
    Strict,
}

/// The error for data after the end of a brotli stream.
fn data_after_the_stream(context: &'static str) -> ComprsError {
    ComprsError::Corrupt {
        context,
        source: "unexpected data after the end of the stream".into(),
    }
}

/// Decoder shared by [`DecompressContext`] and [`DecompressDictContext`].
struct StreamDecoder {
    /// `None` once the stream is finished, or a call failed. Holds the
    /// dictionary that it is attached to, if any.
    decoder: Option<Decoder<'static>>,
    /// The bytes of the dictionary.
    dict_len: usize,
    /// The error of a call that failed, which the later calls report again
    /// until `finish`.
    failed: Option<ComprsError>,
    output: LimitedVec,
    /// Whether the decoder has reached the end of the brotli stream.
    ended: bool,
    /// Name reported by [`ComprsError::StreamFinished`].
    name: &'static str,
}

impl StreamDecoder {
    fn new(
        dict: Option<Arc<[u8]>>,
        output: LimitedVec,
        name: &'static str,
    ) -> Result<Self, ComprsError> {
        let mut decoder = Decoder::new().map_err(|e| operation_error(name, e))?;
        let dict_len = dict.as_ref().map_or(0, |dict| dict.len());
        if let Some(dict) = dict {
            decoder
                .attach_shared(dict)
                .map_err(|e| operation_error(name, e))?;
        }
        Ok(Self {
            decoder: Some(decoder),
            dict_len,
            failed: None,
            output,
            ended: false,
            name,
        })
    }

    /// Decompress `input`, returning all the output of the input so far.
    /// An empty `input` only drains the decoder.
    ///
    /// An error leaves the decoder failed, as it leaves a stream of the
    /// Compression Streams standard errored (#712): the decoder drops its
    /// state and the output that the failed call decoded, and every later
    /// call fails with the same error. A `finish` after the error for data
    /// after the end of the stream would otherwise succeed, with the output
    /// decoded before that data.
    fn decompress(&mut self, input: &[u8], context: &'static str) -> Result<Vec<u8>, ComprsError> {
        if let Some(error) = &self.failed {
            return Err(error.duplicate());
        }
        let result = self.run(input, context);
        // A failed call drops its output and returns only the error.
        let output = self.output.take();
        match result {
            Ok(()) => Ok(output),
            Err(error) => {
                self.decoder = None;
                self.failed = Some(error.duplicate());
                Err(error)
            }
        }
    }

    /// Feed `input` to the decoder, which writes all the output of the input
    /// so far to `output`.
    fn run(&mut self, mut input: &[u8], context: &'static str) -> Result<(), ComprsError> {
        let decoder = self
            .decoder
            .as_mut()
            .ok_or(ComprsError::StreamFinished(self.name))?;
        if self.ended {
            if input.is_empty() {
                return Ok(());
            }
            return Err(data_after_the_stream(context));
        }
        loop {
            let (result, filled) = self
                .output
                .append_with(OUTPUT_ROOM, |buf| {
                    let result = decoder.decompress(&mut input, buf);
                    Ok((result, buf.len() == buf.capacity()))
                })
                .map_err(|e| self.output.error(e, context))?;
            match result.map_err(|e| decoder_error(context, e))? {
                Status::NeedsMoreOutput => {}
                // Out of input, the decoder writes the output that it holds
                // in its ring buffer, as much as fits into the buffer, and
                // asks for more input even if some is left: call it again
                // while it fills the buffer, until a call leaves room, which
                // it does once it has written all of it (#704). Each call
                // that goes on wrote a full buffer of the output of the
                // input so far, which is finite, so the loop ends; and the
                // output limit, checked on each call, stops it sooner.
                Status::NeedsMoreInput if filled => {}
                Status::NeedsMoreInput => return Ok(()),
                Status::Finished => {
                    self.ended = true;
                    if !input.is_empty() {
                        return Err(data_after_the_stream(context));
                    }
                    return Ok(());
                }
            }
        }
    }

    /// Drain the decoder and end the stream, failing unless the decoder
    /// reached the end of the brotli stream, and with the error of an
    /// earlier call that failed. `finish` ends the stream whether it
    /// succeeds or not: every later call fails with
    /// [`ComprsError::StreamFinished`].
    fn finish(&mut self, context: &'static str) -> Result<Vec<u8>, ComprsError> {
        if let Some(error) = self.failed.take() {
            return Err(error);
        }
        let output = self.decompress(&[], context);
        self.decoder = None;
        self.failed = None;
        let output = output?;
        if !self.ended {
            return Err(ComprsError::Truncated("brotli"));
        }
        Ok(output)
    }

    /// The memory of the decoder, including its ring buffer, of the
    /// dictionary and of the output buffer.
    fn memory_usage(&self) -> usize {
        self.decoder
            .as_ref()
            .map_or(0, |decoder| decoder.memory_usage() + self.dict_len)
            + self.output.capacity()
    }
}

#[cfg(test)]
mod tests {
    use comprs_brotli::Operation::{self, Finish as FINISH, Flush as FLUSH, Process as PROCESS};

    use super::{
        CompressContext, CompressDictContext, DICT_REACH, DecompressContext, DecompressDictContext,
    };
    use crate::brotli::{TEXT, compress_with_dict, decompress, decompress_with_dict};
    use crate::{ComprsError, MemoryUsage};

    /// Decompression limit used by the size-limit tests.
    const LIMIT: usize = 64 * 1024;

    /// `size` bytes of text that compresses about as well as prose.
    fn prose(size: usize) -> Vec<u8> {
        TEXT.iter().copied().cycle().take(size).collect()
    }

    /// 8 MiB of zeros compress to a few hundred bytes: one chunk that
    /// expands more than 10,000x.
    fn bomb(dict: &[u8]) -> Vec<u8> {
        crate::brotli::compress_with_dict(&vec![0u8; 8 * 1024 * 1024], dict, Some(1)).unwrap()
    }

    #[test]
    fn decompress_context_stops_inflating_at_the_limit() {
        let mut ctx = DecompressContext::new(Some(LIMIT as f64)).unwrap();

        let err = ctx.transform(&bomb(&[])).unwrap_err();
        assert_eq!(
            err.to_string(),
            "brotli stream decompress exceeded maximum size of 65536 bytes"
        );
        // The output never grew past the limit.
        assert!(ctx.inner.output.capacity() <= LIMIT);
    }

    #[test]
    fn decompress_dict_context_stops_inflating_at_the_limit() {
        let dict = b"a small custom dictionary";
        let mut ctx = DecompressDictContext::new(dict, Some(LIMIT as f64)).unwrap();

        let err = ctx.transform(&bomb(dict)).unwrap_err();
        assert_eq!(
            err.to_string(),
            "brotli dict stream decompress exceeded maximum size of 65536 bytes"
        );
        assert!(ctx.inner.output.capacity() <= LIMIT);
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

    /// 256 KiB of text-like data that brotli compresses well.
    fn text() -> Vec<u8> {
        (0..256 * 1024u32)
            .map(|i| b"lorem ipsum dolor sit amet "[(i * 7 % 27) as usize])
            .collect()
    }

    #[test]
    fn compress_context_reports_the_encoder_state() {
        let mut fast = CompressContext::new(Some(1)).unwrap();
        let mut strong = CompressContext::new(Some(9)).unwrap();
        let empty = strong.memory_usage();
        assert!(empty < 64 * 1024, "{empty} bytes");

        // The encoder allocates its ring buffer and hash tables as data
        // arrives, more of them at higher qualities.
        let data = text();
        fast.transform(&data).unwrap();
        strong.transform(&data).unwrap();
        assert!(
            fast.memory_usage() > data.len(),
            "{} bytes",
            fast.memory_usage()
        );
        assert!(
            strong.memory_usage() > 4 * fast.memory_usage(),
            "{} bytes at quality 9, {} at quality 1",
            strong.memory_usage(),
            fast.memory_usage()
        );

        strong.finish().unwrap();
        assert_eq!(strong.memory_usage(), 0);
    }

    /// The context passes the encoder [`super::FEED`] bytes at a time, so
    /// that the output does not depend on the chunks: at qualities 0 and 1,
    /// the encoder compresses the input of each call on its own (#731).
    #[test]
    fn compress_context_output_does_not_depend_on_the_chunks() {
        let mut input = prose(150 * 1024);
        input.extend(b"The quick brown fox jumps over the lazy dog. ".repeat(1000));
        let chunkings: [&[usize]; 6] = [
            &[1],
            &[100],
            &[1000],
            &[64 * 1024],
            &[100_000],
            &[7, 70_000],
        ];
        for quality in [0, 1, 2, 5] {
            let compress = |chunk_sizes: &[usize]| {
                let mut ctx = CompressContext::new(Some(quality)).unwrap();
                let mut output = Vec::new();
                let mut rest = input.as_slice();
                for &size in chunk_sizes.iter().cycle() {
                    if rest.is_empty() {
                        break;
                    }
                    let (chunk, tail) = rest.split_at(size.min(rest.len()));
                    output.extend(ctx.transform(chunk).unwrap());
                    rest = tail;
                }
                output.extend(ctx.finish().unwrap());
                output
            };
            let whole = compress(&[input.len()]);
            assert_eq!(decompress(&whole).unwrap(), input, "quality {quality}");
            for chunk_sizes in chunkings {
                assert!(
                    compress(chunk_sizes) == whole,
                    "quality {quality}, chunks of {chunk_sizes:?}"
                );
            }
        }
    }

    #[test]
    fn fast_compress_context_holds_the_input_that_does_not_complete_a_block() {
        let data = prose(super::FEED + 1000);
        let mut ctx = CompressContext::new(Some(1)).unwrap();
        let idle = ctx.memory_usage();
        // The first chunk is held, and counted, until a block is complete.
        assert!(ctx.transform(&data[..super::FEED - 1]).unwrap().is_empty());
        assert!(ctx.memory_usage() >= idle + super::FEED);
        let mut compressed = ctx.transform(&data[super::FEED - 1..]).unwrap();
        // flush() and finish() pass what is held on first.
        compressed.extend(ctx.flush().unwrap());
        let mut decoder = DecompressContext::new(None).unwrap();
        assert_eq!(decoder.transform(&compressed).unwrap(), data);
        compressed.extend(ctx.transform(b" and the rest").unwrap());
        compressed.extend(ctx.finish().unwrap());
        assert_eq!(ctx.memory_usage(), 0);
        let mut expected = data.clone();
        expected.extend(b" and the rest");
        assert_eq!(decompress(&compressed).unwrap(), expected);
    }

    #[test]
    fn compress_dict_context_reports_the_buffered_input() {
        let dict = b"brotli dictionary ".repeat(100);
        let mut ctx = CompressDictContext::new(&dict, None).unwrap();
        ctx.transform(&text()).unwrap();
        assert!(ctx.memory_usage() >= dict.len() + text().len());
        ctx.finish().unwrap();
        assert_eq!(ctx.memory_usage(), 0);
    }

    #[test]
    fn decompress_context_reports_the_ring_buffer() {
        let data = text();
        let compressed = crate::brotli::compress(&data, None).unwrap();
        let mut ctx = DecompressContext::new(None).unwrap();
        let empty = ctx.memory_usage();

        assert_eq!(ctx.transform(&compressed).unwrap(), data);
        // The ring buffer holds up to a window of output.
        assert!(ctx.memory_usage() > empty + data.len());

        ctx.finish().unwrap();
        assert_eq!(ctx.memory_usage(), 0);
    }

    #[test]
    fn decompress_dict_context_reports_the_dictionary() {
        let dict = b"brotli dictionary ".repeat(1000);
        let compressed = crate::brotli::compress_with_dict(&dict, &dict, None).unwrap();
        let mut ctx = DecompressDictContext::new(&dict, None).unwrap();
        assert!(ctx.memory_usage() >= dict.len());

        assert_eq!(ctx.transform(&compressed).unwrap(), dict);
        ctx.finish().unwrap();
        assert_eq!(ctx.memory_usage(), 0);
    }

    #[test]
    fn decompress_context_finishes_complete_streams() {
        let original = b"complete brotli stream ".repeat(500);
        let compressed = crate::brotli::compress(&original, None).unwrap();
        for chunk_size in [1, 7, compressed.len()] {
            let mut ctx = DecompressContext::new(None).unwrap();
            let output = decompress_all(&mut ctx, &compressed, chunk_size).unwrap();
            assert_eq!(output, original, "chunk size {chunk_size}");
        }
    }

    /// After a call fails, every later call fails with its error, `finish`
    /// included, which then ends the stream; the failed context drops its
    /// decoder state (#712).
    #[test]
    fn decompress_contexts_keep_failing_after_an_error() {
        let original = b"complete brotli stream ".repeat(500);
        let dict = english_dict();
        let cases = [
            (
                Decoder::Plain(DecompressContext::new(None).unwrap()),
                crate::brotli::compress(&original, None).unwrap(),
                "brotli stream",
            ),
            (
                Decoder::Dict(DecompressDictContext::new(&dict, None).unwrap()),
                compress_with_dict(&original, &dict, None).unwrap(),
                "brotli dict stream",
            ),
        ];
        for (mut ctx, mut input, name) in cases {
            input.extend(b"trailing");
            let message =
                format!("{name} decompress failed: unexpected data after the end of the stream");
            assert_eq!(ctx.transform(&input).unwrap_err().to_string(), message);
            assert_eq!(ctx.memory_usage(), 0, "{name}");
            assert_eq!(ctx.transform(b"more").unwrap_err().to_string(), message);
            assert_eq!(ctx.flush().unwrap_err().to_string(), message);
            assert_eq!(ctx.finish().unwrap_err().to_string(), message);
            assert_eq!(
                ctx.finish().unwrap_err().to_string(),
                format!("{name} already finished")
            );
        }
    }

    /// A brotli decompression context of either kind, for the tests that
    /// cover both.
    enum Decoder {
        Plain(DecompressContext),
        Dict(DecompressDictContext),
    }

    impl Decoder {
        fn transform(&mut self, chunk: &[u8]) -> Result<Vec<u8>, ComprsError> {
            match self {
                Decoder::Plain(ctx) => ctx.transform(chunk),
                Decoder::Dict(ctx) => ctx.transform(chunk),
            }
        }

        fn flush(&mut self) -> Result<Vec<u8>, ComprsError> {
            match self {
                Decoder::Plain(ctx) => ctx.flush(),
                Decoder::Dict(ctx) => ctx.flush(),
            }
        }

        fn finish(&mut self) -> Result<Vec<u8>, ComprsError> {
            match self {
                Decoder::Plain(ctx) => ctx.finish(),
                Decoder::Dict(ctx) => ctx.finish(),
            }
        }

        fn memory_usage(&self) -> usize {
            match self {
                Decoder::Plain(ctx) => ctx.memory_usage(),
                Decoder::Dict(ctx) => ctx.memory_usage(),
            }
        }
    }

    #[test]
    fn decompress_context_rejects_truncated_input() {
        let compressed = crate::brotli::compress(&b"truncated brotli ".repeat(500), None).unwrap();
        for len in [0, 1, compressed.len() / 2, compressed.len() - 1] {
            let mut ctx = DecompressContext::new(None).unwrap();
            let err = decompress_all(&mut ctx, &compressed[..len], 64).unwrap_err();
            assert_eq!(
                err.to_string(),
                "brotli stream is truncated: unexpected end of input",
                "input of {len} bytes"
            );
        }
    }

    #[test]
    fn decompress_dict_context_rejects_truncated_input() {
        let dict = b"brotli dictionary content ".repeat(20);
        let original = b"brotli dictionary content, compressed ".repeat(20);
        let compressed = crate::brotli::compress_with_dict(&original, &dict, None).unwrap();

        let mut ctx = DecompressDictContext::new(&dict, None).unwrap();
        let mut output = ctx.transform(&compressed).unwrap();
        output.extend(ctx.finish().unwrap());
        assert_eq!(output, original);

        let mut ctx = DecompressDictContext::new(&dict, None).unwrap();
        ctx.transform(&compressed[..compressed.len() - 1]).unwrap();
        assert!(matches!(
            ctx.finish(),
            Err(ComprsError::Truncated("brotli"))
        ));
    }

    #[test]
    fn decompress_contexts_reject_large_window_streams() {
        let compressed =
            crate::brotli::compress_large_window(&b"large window brotli ".repeat(50), 30);
        let dict = b"brotli dictionary";
        for chunk_size in [1, compressed.len()] {
            let mut ctx = DecompressContext::new(None).unwrap();
            let err = compressed
                .chunks(chunk_size)
                .find_map(|chunk| ctx.transform(chunk).err())
                .expect("a large-window stream decoded");
            assert_eq!(
                err.to_string(),
                "brotli stream decompress failed: Invalid Data",
                "chunk size {chunk_size}"
            );

            let mut ctx = DecompressDictContext::new(dict, None).unwrap();
            let err = compressed
                .chunks(chunk_size)
                .find_map(|chunk| ctx.transform(chunk).err())
                .expect("a large-window stream decoded");
            assert_eq!(
                err.to_string(),
                "brotli dict stream decompress failed: Invalid Data",
                "chunk size {chunk_size}"
            );
        }
    }

    #[test]
    fn decompress_context_rejects_data_after_the_stream() {
        let mut input = crate::brotli::compress(b"complete", None).unwrap();
        input.extend(b"trailing");
        let mut ctx = DecompressContext::new(None).unwrap();
        let err = ctx.transform(&input).unwrap_err();
        assert_eq!(
            err.to_string(),
            "brotli stream decompress failed: unexpected data after the end of the stream"
        );
    }

    #[test]
    fn decompress_context_does_not_finish_after_invalid_data() {
        let mut ctx = DecompressContext::new(None).unwrap();
        assert!(ctx.transform(&[0xff; 16]).is_err());
        assert!(ctx.finish().is_err());
    }

    #[test]
    fn decompress_context_cannot_be_used_after_finish() {
        let compressed = crate::brotli::compress(b"finished", None).unwrap();
        let mut ctx = DecompressContext::new(None).unwrap();
        ctx.transform(&compressed).unwrap();
        ctx.finish().unwrap();
        assert!(matches!(
            ctx.transform(&compressed),
            Err(ComprsError::StreamFinished("brotli stream"))
        ));
        assert!(matches!(ctx.finish(), Err(ComprsError::StreamFinished(_))));
    }

    #[test]
    fn decompress_context_accepts_output_at_the_limit() {
        let data = vec![7u8; LIMIT];
        let compressed = crate::brotli::compress(&data, None).unwrap();
        let mut ctx = DecompressContext::new(Some(LIMIT as f64)).unwrap();
        let mut output = ctx.transform(&compressed).unwrap();
        output.extend(ctx.flush().unwrap());
        assert_eq!(output, data);
    }

    /// `len` bytes of [`english`] text, and the start of a stream that goes
    /// on: the text compressed at quality 5 with `transform` and `flush`,
    /// not `finish`.
    fn flushed_text(len: usize) -> (Vec<u8>, Vec<u8>) {
        let input = english(len);
        let mut ctx = CompressContext::new(Some(5)).unwrap();
        let mut compressed = ctx.transform(&input).unwrap();
        compressed.extend(ctx.flush().unwrap());
        (input, compressed)
    }

    /// The decoder holds the output of a chunk that ends mid-stream until
    /// it runs out of input, then writes it a buffer at a time: one
    /// `transform` returns all of it, many buffers, and `flush` finds
    /// nothing left (#704).
    #[test]
    fn decompress_context_returns_all_the_output_of_a_flushed_chunk() {
        let (input, compressed) = flushed_text(100_000);
        let mut ctx = DecompressContext::new(None).unwrap();
        let output = ctx.transform(&compressed).unwrap();
        assert_eq!(output.len(), input.len());
        assert!(output == input);
        assert!(ctx.flush().unwrap().is_empty());
        assert!(!ctx.inner.ended);
    }

    // A context with a prepared Dictionary writes the stream of one with its
    // bytes, whether it holds the input until `finish` or streams it, and a
    // decompression context with the Dictionary reads it.
    #[test]
    fn dict_contexts_with_a_prepared_dictionary_match_those_with_its_bytes() {
        use crate::dictionary::{Dictionary, DictionaryFormat};

        let bytes = english_dict();
        let dict = Dictionary::new(&bytes, DictionaryFormat::Brotli, None).unwrap();
        for len in [1000, DICT_REACH + 100_000] {
            let input = english(len);
            let mut with_bytes = CompressDictContext::incremental(&bytes, Some(5)).unwrap();
            let mut prepared = CompressDictContext::incremental_prepared(&dict, Some(5)).unwrap();
            let mut expected = Vec::new();
            let mut output = Vec::new();
            for chunk in input.chunks(300_000) {
                expected.extend(with_bytes.transform(chunk).unwrap());
                output.extend(prepared.transform(chunk).unwrap());
            }
            expected.extend(with_bytes.finish().unwrap());
            output.extend(prepared.finish().unwrap());
            assert!(output == expected, "{len} bytes");

            let mut ctx = DecompressDictContext::with_prepared(&dict, None).unwrap();
            let mut restored = ctx.transform(&output).unwrap();
            restored.extend(ctx.finish().unwrap());
            assert!(restored == input, "{len} bytes");
        }
    }

    // The Dictionary reports the memory of what it prepared, so a context
    // that shares it reports only its own.
    #[test]
    fn dict_contexts_leave_the_memory_of_a_prepared_dictionary_to_it() {
        use crate::dictionary::{Dictionary, DictionaryFormat};

        let bytes = english_dict();
        let dict = Dictionary::new(&bytes, DictionaryFormat::Brotli, None).unwrap();
        let mut with_bytes = CompressDictContext::incremental(&bytes, Some(5)).unwrap();
        let mut prepared = CompressDictContext::incremental_prepared(&dict, Some(5)).unwrap();
        assert_eq!(
            with_bytes.memory_usage() - prepared.memory_usage(),
            bytes.capacity().max(bytes.len())
        );
        let input = english(DICT_REACH + 1);
        with_bytes.transform(&input).unwrap();
        prepared.transform(&input).unwrap();
        let tables = dict.brotli_prepared().unwrap().memory_usage();
        assert_eq!(
            with_bytes.memory_usage() - prepared.memory_usage(),
            bytes.len() + tables
        );
    }

    #[test]
    fn dict_contexts_reject_a_zstd_dictionary() {
        use crate::dictionary::{Dictionary, DictionaryFormat};

        let dict = Dictionary::new(&english_dict(), DictionaryFormat::Zstd, None).unwrap();
        let errors = [
            CompressDictContext::incremental_prepared(&dict, None).map(drop),
            DecompressDictContext::with_prepared(&dict, None).map(drop),
        ];
        for error in errors {
            assert!(
                matches!(&error, Err(ComprsError::InvalidArg(message)) if message == "this Dictionary is for zstd"),
                "{error:?}"
            );
        }
    }

    #[test]
    fn decompress_dict_context_returns_all_the_output_of_a_flushed_chunk() {
        let dict = english_dict();
        let input = english(100_000);
        // `CompressDictContext` holds input of this size until `finish`, so
        // drive the encoder with the dictionary directly.
        let prepared = crate::brotli::prepared_dictionary(&dict).unwrap();
        let mut encoder = super::StreamEncoder::new(5, Some(prepared), 0).unwrap();
        let compressed = encoder.run(FLUSH, &input).unwrap();
        let mut ctx = DecompressDictContext::new(&dict, None).unwrap();
        let output = ctx.transform(&compressed).unwrap();
        assert_eq!(output.len(), input.len());
        assert!(output == input);
        assert!(ctx.flush().unwrap().is_empty());
        assert!(!ctx.inner.ended);
        // The stream refers to the dictionary.
        let mut plain = DecompressContext::new(None).unwrap();
        assert!(plain.transform(&compressed).ok() != Some(input));
    }

    /// The output limit stops a chunk that ends mid-stream too: the
    /// `transform` that takes it fails once the output that the decoder
    /// writes passes the limit, and the output never grows past it.
    #[test]
    fn decompress_context_stops_inflating_a_flushed_chunk_at_the_limit() {
        let (_, compressed) = flushed_text(4 * LIMIT);
        let mut ctx = DecompressContext::new(Some(LIMIT as f64)).unwrap();
        let transformed = ctx.transform(&compressed).map(|output| output.len());
        assert_eq!(
            transformed.unwrap_err().to_string(),
            "brotli stream decompress exceeded maximum size of 65536 bytes"
        );
        assert!(ctx.inner.output.capacity() <= LIMIT);
    }

    /// The dictionary stream compresses on `finish` as `compress_with_dict`
    /// does, which the input on which brotli 9.0.0, the Rust port that
    /// comprs used before libbrotli, panicked (#623) round-trips through.
    #[test]
    fn compress_dict_context_survives_encoder_panic() {
        let data = [
            255, 164, 251, 255, 255, 240, 7, 0, 0, 0, 0, 0, 0, 0, 0, 41, 103, 0, 14,
        ];
        let dict = [254, 255];
        let mut ctx = super::CompressDictContext::new(&dict, None).unwrap();
        assert!(ctx.transform(&data).unwrap().is_empty());
        let compressed = ctx.finish().unwrap();
        let decompressed = crate::brotli::decompress_with_dict(&compressed, &dict).unwrap();
        assert_eq!(decompressed, data);
    }

    /// The input on which the Rust port failed with a dictionary (#642)
    /// decodes with the dictionary at every quality.
    #[test]
    fn compress_dict_context_fallback_decodes_with_the_dictionary() {
        let data = crate::brotli::dict_fallback_input();
        let dict = crate::brotli::FALLBACK_DICT;
        for quality in 5..=11 {
            let mut ctx = CompressDictContext::new(&dict, Some(quality)).unwrap();
            for chunk in data.chunks(1000) {
                assert!(ctx.transform(chunk).unwrap().is_empty());
            }
            let compressed = ctx.finish().unwrap();
            let decompressed = crate::brotli::decompress_with_dict(&compressed, &dict).unwrap();
            assert!(decompressed == data, "quality {quality}");
        }
    }

    const KIB: usize = 1024;
    const MIB: usize = 1024 * KIB;

    /// `len` bytes of xorshift noise from `seed`, which brotli stores
    /// uncompressed.
    fn noise_from(seed: u64, len: usize) -> Vec<u8> {
        let mut state = seed;
        (0..len)
            .map(|_| {
                state ^= state << 13;
                state ^= state >> 7;
                state ^= state << 17;
                (state >> 32) as u8
            })
            .collect()
    }

    /// `len` bytes of xorshift noise.
    fn noise(len: usize) -> Vec<u8> {
        noise_from(0x2545_f491_4f6c_dd1d, len)
    }

    /// `len` bytes of English text, [`TEXT`] repeated, which brotli encodes
    /// with references to the dictionary of [`english_dict`], and to the
    /// built-in dictionary without one.
    fn english(len: usize) -> Vec<u8> {
        TEXT.iter().copied().cycle().take(len).collect()
    }

    /// A dictionary for [`english`] and [`mixed`].
    fn english_dict() -> Vec<u8> {
        [b"Words of the quick brown fox and the lazy dog: ", TEXT].concat()
    }

    /// `len` bytes of [`TEXT`] and noise in turn, which brotli compresses to
    /// about a third, quickly even at high qualities.
    fn mixed(len: usize) -> Vec<u8> {
        let noise = noise(len);
        TEXT.chunks(64)
            .cycle()
            .zip(noise.chunks(64))
            .flat_map(|(text, noise)| [text, noise])
            .flatten()
            .copied()
            .take(len)
            .collect()
    }

    /// What an incremental context made of `input` in chunks of
    /// `chunk_size` bytes: the output of every call before `finish`, and
    /// the whole stream.
    fn compress_incremental(
        dict: &[u8],
        quality: u32,
        input: &[u8],
        chunk_size: usize,
    ) -> (Vec<u8>, Vec<u8>) {
        let mut ctx = CompressDictContext::incremental(dict, Some(quality)).unwrap();
        let mut output = Vec::new();
        for chunk in input.chunks(chunk_size) {
            output.extend(ctx.transform(chunk).unwrap());
        }
        output.extend(ctx.flush().unwrap());
        let before_finish = output.clone();
        output.extend(ctx.finish().unwrap());
        (before_finish, output)
    }

    /// Check that an incremental context compresses `input`, in chunks of
    /// each of `chunk_sizes`, into a stream that decodes with `dict`: into
    /// the output of [`compress_with_dict`] if the context holds all of the
    /// input, and otherwise with output before `finish`.
    fn check_incremental(dict: &[u8], quality: u32, input: &[u8], chunk_sizes: &[usize]) {
        let one_shot = (input.len() <= DICT_REACH)
            .then(|| compress_with_dict(input, dict, Some(quality)).unwrap());
        for &chunk_size in chunk_sizes {
            let context = format!(
                "quality {quality}, {} bytes in chunks of {chunk_size}",
                input.len()
            );
            let (before_finish, output) = compress_incremental(dict, quality, input, chunk_size);
            if let Some(one_shot) = &one_shot {
                assert!(&output == one_shot, "{context}");
                assert!(before_finish.is_empty(), "{context}");
            } else {
                assert!(!before_finish.is_empty(), "{context}");
            }
            let decompressed = decompress_with_dict(&output, dict).unwrap();
            assert!(decompressed == input, "{context}");
        }
    }

    fn check_low_quality(quality: u32) {
        let dict = english_dict();
        let input = mixed(12 * MIB);
        for len in [
            0,
            1,
            DICT_REACH - 1,
            DICT_REACH,
            DICT_REACH + 1,
            input.len(),
        ] {
            // Chunks of DICT_REACH / 16 bytes end exactly at the reach.
            check_incremental(
                &dict,
                quality,
                &input[..len],
                &[64 * KIB, MIB, DICT_REACH / 16],
            );
        }
    }

    #[test]
    fn incremental_dict_context_round_trips_at_quality_0() {
        check_low_quality(0);
    }

    #[test]
    fn incremental_dict_context_round_trips_at_quality_1() {
        check_low_quality(1);
    }

    fn check_mid_quality(quality: u32) {
        let dict = english_dict();
        let input = mixed(DICT_REACH + 64 * KIB);
        check_incremental(&dict, quality, &input[..DICT_REACH], &[MIB]);
        check_incremental(&dict, quality, &input[..DICT_REACH + 1], &[64 * KIB]);
        check_incremental(&dict, quality, &input, &[64 * KIB, MIB, DICT_REACH / 16]);
    }

    #[test]
    fn incremental_dict_context_round_trips_at_quality_6() {
        check_mid_quality(6);
    }

    #[test]
    fn incremental_dict_context_round_trips_at_quality_9() {
        check_mid_quality(9);
    }

    /// English text at qualities 10 and 11, which use brotli's built-in
    /// dictionary the most.
    #[test]
    fn incremental_dict_context_round_trips_at_qualities_10_and_11() {
        let dict = english_dict();
        for quality in [10, 11] {
            check_incremental(&dict, quality, &english(DICT_REACH + 64 * KIB), &[MIB]);
        }
    }

    /// The release builds of the tests above with 12 MiB, too slow for a
    /// debug build: `cargo test --release -p comprs-core -- --ignored`.
    #[test]
    #[ignore = "slow without optimizations"]
    fn incremental_dict_context_round_trips_12_mib_at_qualities_6_and_9() {
        let dict = english_dict();
        let input = mixed(12 * MIB);
        for quality in [6, 9] {
            check_incremental(&dict, quality, &input, &[64 * KIB, MIB]);
        }
    }

    /// `len` bytes of JSON lines, like the records of a log.
    fn records(len: usize) -> Vec<u8> {
        let mut output = Vec::with_capacity(len + 128);
        for i in 0u64.. {
            if output.len() >= len {
                break;
            }
            let line = format!(
                "{{\"id\":{i},\"name\":\"user{}\",\"email\":\"user{i}@example.com\",\"score\":{}}}\n",
                i * 7919 % 10007,
                i * 2_654_435_761 % 1000
            );
            output.extend_from_slice(line.as_bytes());
        }
        output.truncate(len);
        output
    }

    /// Most of the output comes before `finish`: the output of the first
    /// [`DICT_REACH`] bytes when the input passes them, then what the
    /// encoder emits as the rest arrives. The buffered context emits nothing
    /// before `finish`. The stream is about as large as the output of
    /// [`compress_with_dict`].
    #[test]
    #[ignore = "slow without optimizations"]
    fn incremental_dict_context_emits_most_of_its_output_before_finish() {
        let input = records(16 * MIB);
        let dict = records(2 * KIB);
        let (before_finish, output) = compress_incremental(&dict, 6, &input, 64 * KIB);
        let one_shot = compress_with_dict(&input, &dict, Some(6)).unwrap();
        let sizes = format!(
            "{} of {} bytes before finish(), {} in one call",
            before_finish.len(),
            output.len(),
            one_shot.len()
        );
        assert!(before_finish.len() * 10 >= output.len() * 4, "{sizes}");
        assert!(output.len() * 100 <= one_shot.len() * 101, "{sizes}");
        assert!(decompress_with_dict(&output, &dict).unwrap() == input);
    }

    /// The encoder takes the input [`super::FEED`] bytes at a time, whatever
    /// the chunks that it arrives in, so small chunks give the stream of
    /// large ones. At qualities 0 and 1, brotli compresses the input of each
    /// call of the encoder on its own: chunks of 4 KiB, passed on one by
    /// one, made a stream half again as large.
    #[test]
    fn incremental_dict_context_streams_small_chunks_like_large_ones() {
        let dict = records(2 * KIB);
        let input = records(DICT_REACH + MIB);
        for quality in [0, 1] {
            let one_shot = compress_with_dict(&input, &dict, Some(quality)).unwrap();
            let (_, large) = compress_incremental(&dict, quality, &input, 64 * KIB);
            for chunk_size in [4 * KIB, 1000] {
                let (_, small) = compress_incremental(&dict, quality, &input, chunk_size);
                let sizes = format!(
                    "quality {quality}, chunks of {chunk_size}: {} bytes, {} in chunks of \
                     64 KiB, {} in one call",
                    small.len(),
                    large.len(),
                    one_shot.len()
                );
                assert!(small == large, "{sizes}");
                assert!(small.len() * 100 <= one_shot.len() * 103, "{sizes}");
                assert!(
                    decompress_with_dict(&small, &dict).unwrap() == input,
                    "{sizes}"
                );
            }
        }
    }

    /// A chunk that ends exactly at [`DICT_REACH`] bytes, and an empty one
    /// after it, leave the context holding its input: the next chunk starts
    /// the stream, which is the one of other chunks.
    #[test]
    fn incremental_dict_context_holds_a_chunk_that_ends_at_the_reach() {
        let dict = english_dict();
        let input = mixed(DICT_REACH + 64 * KIB);
        let split: [&[u8]; 3] = [&input[..DICT_REACH], &[], &input[DICT_REACH..]];
        for quality in [1, 5] {
            let mut ctx = CompressDictContext::incremental(&dict, Some(quality)).unwrap();
            let mut output = Vec::new();
            for (i, chunk) in split.iter().enumerate() {
                let transformed = ctx.transform(chunk).unwrap();
                let flushed = ctx.flush().unwrap();
                assert_eq!(
                    transformed.is_empty() && flushed.is_empty(),
                    i < 2,
                    "quality {quality}, chunk {i}"
                );
                output.extend(transformed);
                output.extend(flushed);
            }
            output.extend(ctx.finish().unwrap());
            let (_, chunked) = compress_incremental(&dict, quality, &input, 64 * KIB);
            assert!(output == chunked, "quality {quality}");
            assert!(decompress_with_dict(&output, &dict).unwrap() == input);
        }
    }

    /// Streams of at most [`DICT_REACH`] bytes compress into the output of
    /// [`compress_with_dict`] at every quality, also for the input on which
    /// the Rust port failed with a dictionary (#642).
    #[test]
    fn incremental_dict_context_gives_the_one_shot_output_up_to_the_reach() {
        let fallback = crate::brotli::dict_fallback_input();
        let inputs = [
            (&crate::brotli::FALLBACK_DICT[..], &fallback[..]),
            (&english_dict(), &english(20_000)),
        ];
        for quality in 0..=11 {
            for (dict, input) in inputs {
                let expected = compress_with_dict(input, dict, Some(quality)).unwrap();
                for chunk_size in [1000, input.len()] {
                    let (before_finish, output) =
                        compress_incremental(dict, quality, input, chunk_size);
                    assert!(before_finish.is_empty(), "quality {quality}");
                    assert!(output == expected, "quality {quality}");
                }
            }
        }
    }

    /// A stream that starts with [`crate::brotli::dict_fallback_input`], on
    /// which the Rust port failed with the dictionary, and goes past
    /// [`DICT_REACH`] bytes.
    #[test]
    fn incremental_dict_context_compresses_the_dict_fallback_input_past_the_reach() {
        let dict = crate::brotli::FALLBACK_DICT;
        let mut input = crate::brotli::dict_fallback_input();
        input.extend(english(DICT_REACH + 64 * KIB - input.len()));
        let (_, output) = compress_incremental(&dict, 5, &input, MIB);
        assert!(decompress_with_dict(&output, &dict).unwrap() == input);
    }

    /// An empty dictionary stands for none, as for [`compress_with_dict`]:
    /// past [`DICT_REACH`] bytes, the stream is that of an encoder without
    /// a dictionary, which decodes with an empty one too.
    #[test]
    fn incremental_dict_context_takes_an_empty_dictionary_for_none() {
        let quality = 5;
        let mut input = vec![0; DICT_REACH];
        input.extend(english(64 * KIB));
        let mut encoder = super::StreamEncoder::new(quality, None, 0).unwrap();
        let mut expected = encoder.run(FLUSH, &input[..DICT_REACH]).unwrap();
        expected.extend(encoder.run(PROCESS, &input[DICT_REACH..]).unwrap());
        expected.extend(encoder.run(FINISH, &[]).unwrap());
        let mut ctx = CompressDictContext::incremental(&[], Some(quality)).unwrap();
        let mut output = ctx.transform(&input[..DICT_REACH]).unwrap();
        output.extend(ctx.transform(&input[DICT_REACH..]).unwrap());
        output.extend(ctx.finish().unwrap());
        assert!(output == expected);
        assert!(decompress(&output).unwrap() == input);
        let mut decoder = DecompressDictContext::new(&[], None).unwrap();
        let mut decoded = decoder.transform(&output).unwrap();
        decoded.extend(decoder.finish().unwrap());
        assert!(decoded == input);
    }

    /// 8 MiB and 64 KiB of a period of 1000 bytes of noise, with two bytes
    /// changed, the second `changed` bytes past the match below, on which
    /// brotli 9.0.0, the Rust port that comprs used before libbrotli,
    /// panicked with a dictionary at quality 2 if `changed` is 4, and at
    /// quality 5 if it is 3. Its ring buffer held 8 MiB, and once the input
    /// wrapped around it, the encoder still took the position that marked
    /// the end of the dictionary for one, and cut a match that started on
    /// the byte before it to one byte, which it could not encode (#623,
    /// #703).
    fn ring_buffer_input(changed: usize) -> Vec<u8> {
        let period = noise_from(0x1234_5679, 1000);
        let mut input: Vec<_> = period
            .iter()
            .copied()
            .cycle()
            .take(8 * MIB + 64 * KIB)
            .collect();
        // At `start`, the input repeats the 4 bytes from the last byte of
        // the first 8 MiB on, where the end of the dictionary lies in the
        // ring buffer, after a byte that breaks the match before them.
        let start = 8 * MIB - 1 + 1000;
        input[start - 1] ^= 0x55;
        input[start + changed] ^= 0x33;
        input
    }

    /// Past [`DICT_REACH`] bytes, the context keeps the dictionary, on the
    /// input on which the Rust port panicked with one.
    #[test]
    fn incremental_dict_context_streams_past_the_ring_buffer() {
        let dict = b"a dictionary of a few words";
        for (changed, quality) in [(4, 2), (3, 5)] {
            let input = ring_buffer_input(changed);
            let (_, output) = compress_incremental(dict, quality, &input, 64 * KIB);
            let decompressed = decompress_with_dict(&output, dict).unwrap();
            assert!(decompressed == input, "quality {quality}");
        }
    }

    /// One-shot dictionary compression keeps the dictionary on an input of
    /// more than 8 MiB, such as [`ring_buffer_input`], on which the Rust
    /// port panicked with one, so that comprs compressed it without (#703).
    #[test]
    fn dict_compress_keeps_the_dictionary_on_long_inputs() {
        let dict = b"a dictionary of a few words";
        for (changed, quality) in [(4, 2), (3, 5)] {
            let input = ring_buffer_input(changed);
            let output = compress_with_dict(&input, dict, Some(quality)).unwrap();
            assert!(decompress_with_dict(&output, dict).unwrap() == input);
        }
    }

    /// After the encoder fails, every call fails with its error, until
    /// `finish` ends the stream.
    #[test]
    fn incremental_dict_context_reports_an_encoder_error_again() {
        let mut ctx = CompressDictContext::incremental(b"dictionary", Some(1)).unwrap();
        assert!(!ctx.transform(&vec![0; DICT_REACH + 1]).unwrap().is_empty());
        let message = "brotli dict stream compress failed: brotli encoder failed";
        assert_eq!(
            ctx.settle(Err(comprs_brotli::Error::Encoder))
                .unwrap_err()
                .to_string(),
            message
        );
        assert_eq!(ctx.memory_usage(), 0);
        assert_eq!(ctx.transform(b"more").unwrap_err().to_string(), message);
        assert_eq!(ctx.flush().unwrap_err().to_string(), message);
        assert_eq!(ctx.finish().unwrap_err().to_string(), message);
        assert!(matches!(
            ctx.finish(),
            Err(ComprsError::StreamFinished("brotli dict stream"))
        ));
    }

    /// Makes the encoders of this thread fail on an operation, until it is
    /// dropped.
    struct Fault;

    impl Fault {
        fn on(op: Operation) -> Self {
            super::FAULT.set(Some(op));
            Self
        }
    }

    impl Drop for Fault {
        fn drop(&mut self) {
            super::FAULT.set(None);
        }
    }

    /// An error of the encoder, in any call that runs it, ends the stream:
    /// the context drops the encoder, and every later call fails with the
    /// error until `finish`, which ends the stream.
    #[test]
    fn incremental_dict_context_reports_an_encoder_failure() {
        type Call = fn(&mut CompressDictContext, &[u8]) -> Result<Vec<u8>, ComprsError>;
        // The name of a case, the input that the context takes first, then
        // the operation on which the encoder fails, in the call that runs it
        // on the last bytes.
        type Case<'a> = (&'a str, &'a [u8], Operation, Call, &'a [u8]);
        let transform: Call = |ctx, chunk| ctx.transform(chunk);
        let flush: Call = |ctx, _| ctx.flush();
        let finish: Call = |ctx, _| ctx.finish();
        let message = "brotli dict stream compress failed: brotli encoder failed";
        let input = mixed(DICT_REACH + 64 * KIB);
        let (start, rest) = input.split_at(DICT_REACH + 1);
        let cases: [Case; 4] = [
            // The flush of the input that the context held.
            ("the transform past the reach", &[], FLUSH, transform, start),
            ("a later transform", start, PROCESS, transform, rest),
            ("flush", start, FLUSH, flush, &[]),
            ("finish", start, FINISH, finish, &[]),
        ];
        for (call_name, first, op, call, chunk) in cases {
            let mut ctx = CompressDictContext::incremental(b"dictionary", Some(1)).unwrap();
            ctx.transform(first).unwrap();
            assert!(ctx.memory_usage() > 0, "{call_name}");
            let failed = {
                let _fault = Fault::on(op);
                call(&mut ctx, chunk)
            };
            assert_eq!(failed.unwrap_err().to_string(), message, "{call_name}");
            assert_eq!(ctx.memory_usage(), 0, "{call_name}");
            if op != FINISH {
                for result in [ctx.transform(b"more"), ctx.flush(), ctx.finish()] {
                    assert_eq!(result.unwrap_err().to_string(), message, "{call_name}");
                }
            }
            for result in [ctx.transform(b"more"), ctx.flush(), ctx.finish()] {
                assert!(
                    matches!(
                        result,
                        Err(ComprsError::StreamFinished("brotli dict stream"))
                    ),
                    "{call_name}"
                );
            }
        }
    }

    /// An incremental context holds at most the dictionary and
    /// [`DICT_REACH`] bytes of input, then the encoder state, which stops
    /// growing. A buffered context holds all of its input.
    #[test]
    fn incremental_dict_context_holds_at_most_the_reach() {
        let dict = english_dict();
        let input = mixed(16 * MIB);
        for quality in [0, 1, 2] {
            let mut ctx = CompressDictContext::incremental(&dict, Some(quality)).unwrap();
            let mut output = Vec::new();
            let mut holding = 0;
            let mut streaming = Vec::new();
            // Chunks that do not divide the reach.
            for chunk in input.chunks(MIB - 1000) {
                let emitted = ctx.transform(chunk).unwrap();
                if output.is_empty() && emitted.is_empty() {
                    holding = holding.max(ctx.memory_usage());
                } else {
                    streaming.push(ctx.memory_usage());
                }
                output.extend(emitted);
            }
            let context = format!("quality {quality}: {holding} bytes, then {streaming:?}");
            assert!(holding <= dict.len() + DICT_REACH, "{context}");
            // The encoder state, with the window and its hash tables, takes
            // about 9 MB at quality 2, less below.
            let most = streaming.iter().max().unwrap();
            assert!(*most <= 3 * DICT_REACH, "{context}");
            assert!(most - streaming[0] <= MIB, "{context}");
            output.extend(ctx.finish().unwrap());
            assert_eq!(ctx.memory_usage(), 0);
            assert!(decompress_with_dict(&output, &dict).unwrap() == input);
        }

        let mut buffered = CompressDictContext::new(&dict, Some(0)).unwrap();
        for chunk in input.chunks(MIB) {
            assert!(buffered.transform(chunk).unwrap().is_empty());
            assert!(buffered.flush().unwrap().is_empty());
        }
        assert!(buffered.memory_usage() >= input.len());
    }

    #[test]
    fn incremental_dict_context_cannot_be_used_after_finish() {
        for len in [0, DICT_REACH + 1] {
            let mut ctx = CompressDictContext::incremental(b"dictionary", Some(0)).unwrap();
            ctx.transform(&vec![0; len]).unwrap();
            ctx.finish().unwrap();
            for result in [ctx.transform(b"more"), ctx.flush(), ctx.finish()] {
                assert!(
                    matches!(
                        result,
                        Err(ComprsError::StreamFinished("brotli dict stream"))
                    ),
                    "{len} bytes"
                );
            }
        }
    }

    /// Whether `compressed`, the start of a brotli stream that goes on,
    /// decodes with `dict` to exactly `expected`, and then needs more input.
    fn decodes_so_far(compressed: &[u8], dict: &[u8], expected: &[u8]) -> bool {
        let mut ctx = DecompressDictContext::new(dict, None).unwrap();
        ctx.transform(compressed)
            .is_ok_and(|output| output == expected)
            && !ctx.inner.ended
    }

    /// Once it streams, `flush` returns all the output of the input so far.
    #[test]
    fn incremental_dict_context_flushes_once_it_streams() {
        let dict = english_dict();
        let input = mixed(DICT_REACH + 3 * MIB);
        let mut ctx = CompressDictContext::incremental(&dict, Some(5)).unwrap();
        let mut taken = DICT_REACH + MIB;
        let mut output = ctx.transform(&input[..taken]).unwrap();
        // Flushing again, with or without input since, adds what the input
        // needs.
        output.extend(ctx.flush().unwrap());
        for chunk in input[taken..].chunks(MIB) {
            output.extend(ctx.transform(chunk).unwrap());
            output.extend(ctx.flush().unwrap());
            output.extend(ctx.flush().unwrap());
            taken += chunk.len();
            assert!(
                decodes_so_far(&output, &dict, &input[..taken]),
                "{taken} bytes"
            );
        }
        output.extend(ctx.finish().unwrap());
        assert!(decompress_with_dict(&output, &dict).unwrap() == input);
    }
}
