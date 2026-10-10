//! Brotli streaming compression and decompression.

use std::any::{Any, TypeId};
use std::cell::RefCell;
use std::io::Write;
use std::panic::{AssertUnwindSafe, UnwindSafe};
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use brotli::enc::encode::{BrotliEncoderOperation, BrotliEncoderStateStruct};
use brotli::enc::interface::{PredictionModeContextMap, StaticCommand};
use brotli::enc::writer::CompressorWriterCustomAlloc;
use brotli::enc::{Allocator, BrotliAlloc, BrotliEncoderParams, SliceWrapper, StandardAlloc};
use brotli::{BrotliDecompressStream, BrotliResult, BrotliState, InputPair, InputReferenceMut};

use crate::brotli::{BUFFER_SIZE, DEFAULT_QUALITY, LG_WINDOW_SIZE, QUALITY};
use crate::limited::LimitedVec;
use crate::{ComprsError, MemoryUsage};

/// Allocator for the brotli encoder and decoder states that counts the bytes
/// they hold, which the brotli crate does not report otherwise. Clones share
/// the count.
///
/// The states take all their memory from the allocator and return it with
/// `free_cell`, so the count follows them as they grow: the encoder holds a
/// few kilobytes before the first block and tens of megabytes at high
/// qualities, the decoder sizes its ring buffer from the stream's window.
///
/// The allocator of an encoder of a small input, [`CountingAlloc::for_input`],
/// also recycles the ring buffer of the encoder, as [`RING_BUFFER`]
/// describes.
#[derive(Clone, Default)]
pub(crate) struct CountingAlloc {
    allocated: Arc<AtomicUsize>,
    /// Whether the allocator is the encoder's of a small input, which takes
    /// its ring buffer from [`RING_BUFFER`] and gives it back there.
    recycles: bool,
}

impl CountingAlloc {
    /// The allocator of an encoder that compresses `len` bytes, its custom
    /// dictionary included, in one go: it recycles the ring buffer of the
    /// encoder through [`RING_BUFFER`] if they are at most
    /// [`RECYCLED_INPUT`] bytes. The encoders of streams, whose input is not
    /// known when they start, take [`CountingAlloc::default`], which does
    /// not.
    pub(crate) fn for_input(len: usize) -> Self {
        Self {
            recycles: len <= RECYCLED_INPUT,
            ..Self::default()
        }
    }

    /// Bytes allocated and not freed yet.
    fn allocated(&self) -> usize {
        self.allocated.load(Ordering::Relaxed)
    }

    fn add(&self, bytes: usize) {
        self.allocated.fetch_add(bytes, Ordering::Relaxed);
    }

    /// Whether this allocator recycles `len` elements of `T`: the ring
    /// buffer of an encoder of a small input, the only array of bytes of at
    /// least [`RECYCLED_BYTES`] that an encoder allocates.
    fn recycles<T: 'static>(&self, len: usize) -> bool {
        self.recycles && len >= RECYCLED_BYTES && TypeId::of::<T>() == TypeId::of::<u8>()
    }
}

/// Size from which an encoder's array of bytes is its ring buffer, which
/// [`RING_BUFFER`] recycles.
///
/// The encoder keeps 2^(1 + max(lgwin, lgblock)) bytes of input in its ring
/// buffer, and a tail of one block and 9 bytes of slack: 8 MiB and up to
/// 256 KiB with the window of [`LG_WINDOW_SIZE`] and its blocks of at most
/// 2^18 bytes. Its other arrays of bytes hold the output of one block and
/// are far smaller.
const RECYCLED_BYTES: usize = 1 << (LG_WINDOW_SIZE + 1);

/// The most input, in bytes, of an encoder that recycles its ring buffer,
/// its custom dictionary included (#727).
///
/// Recycling saves the 0.33 ms of zero-filling a fresh ring buffer (see
/// [`RING_BUFFER`]), most of the time of compressing a small input. On a
/// large one, it saves a small part of the time, and with glibc it costs
/// more: an encoder that does not free its ring buffer changes when glibc
/// grows and trims its heap, and the other arrays of the encoder then
/// page-fault on every call. That made compressing 1 to 10 MB 8% to 71%
/// slower at quality 6, while inputs of up to 256 KiB were all faster or
/// within 4%.
const RECYCLED_INPUT: usize = 256 * 1024;

thread_local! {
    /// The ring buffer that an encoder of a small input last freed on this
    /// thread, which the next such encoder of this thread takes if it is of
    /// the size that it needs (#707): see [`CountingAlloc::for_input`]. It
    /// holds the memory of a `CountingAlloc` array of bytes, as a
    /// `Box<dyn Any>` because the allocator is generic over the type of its
    /// elements.
    ///
    /// The encoder allocates its ring buffer once the input, a custom
    /// dictionary included, outgrows one block: on every call that
    /// compresses with a dictionary. With glibc, a fresh allocation of
    /// those 8 MiB comes from the heap once one has been freed, which raises
    /// its threshold for `mmap`, and zeroing it then took 330 us: 90% of the
    /// time of compressing a 100-byte message with a dictionary at
    /// quality 5.
    ///
    /// A recycled ring buffer holds the bytes of an earlier stream, not
    /// zeros. The encoder does not read them: brotli's C encoder allocates
    /// its ring buffer without initializing it and writes every byte that
    /// it reads, the input, two bytes before it and the slack after it, as
    /// the Rust port does in `RingBufferInitBuffer` and `RingBufferWrite`.
    /// The tests compress with a ring buffer full of other bytes and get the
    /// same output. The ring buffer stays with the thread, at most 8.3 MiB of
    /// memory that the bindings do not report.
    static RING_BUFFER: RefCell<Option<Box<dyn Any>>> = const { RefCell::new(None) };
}

/// The ring buffer of [`RING_BUFFER`], if it holds `len` elements of `T`,
/// which it then no longer holds.
fn take_ring_buffer<T: 'static>(
    len: usize,
) -> Option<<StandardAlloc as Allocator<T>>::AllocatedMemory>
where
    StandardAlloc: Allocator<T>,
{
    RING_BUFFER.with(|kept| {
        let mut kept = kept.borrow_mut();
        let memory = kept
            .take()?
            .downcast::<<StandardAlloc as Allocator<T>>::AllocatedMemory>()
            .ok()?;
        if memory.slice().len() == len {
            return Some(*memory);
        }
        *kept = Some(memory);
        None
    })
}

impl<T: Clone + Default + 'static> Allocator<T> for CountingAlloc {
    type AllocatedMemory = <StandardAlloc as Allocator<T>>::AllocatedMemory;

    fn alloc_cell(&mut self, len: usize) -> Self::AllocatedMemory {
        self.add(len.saturating_mul(size_of::<T>()));
        if self.recycles::<T>(len)
            && let Some(memory) = take_ring_buffer::<T>(len)
        {
            return memory;
        }
        StandardAlloc::default().alloc_cell(len)
    }

    fn free_cell(&mut self, data: Self::AllocatedMemory) {
        let bytes = size_of_val(data.slice());
        // Saturate rather than wrap should a state ever free memory that it
        // did not allocate here. This is the loop that `fetch_update` runs,
        // written out: Rust 1.99 deprecates `fetch_update` for `try_update`,
        // which needs Rust 1.95, newer than the rust-version in Cargo.toml.
        let mut allocated = self.allocated.load(Ordering::Relaxed);
        while let Err(current) = self.allocated.compare_exchange_weak(
            allocated,
            allocated.saturating_sub(bytes),
            Ordering::Relaxed,
            Ordering::Relaxed,
        ) {
            allocated = current;
        }
        if self.recycles::<T>(data.slice().len()) {
            RING_BUFFER.with(|kept| *kept.borrow_mut() = Some(Box::new(data)));
        }
    }
}

impl BrotliAlloc for CountingAlloc {}

/// The writer of the compressing contexts and of
/// [`crate::brotli::compress`], whose allocator counts the memory of its
/// encoder.
pub(crate) type Compressor = CompressorWriterCustomAlloc<
    Vec<u8>,
    <CountingAlloc as Allocator<u8>>::AllocatedMemory,
    CountingAlloc,
>;

/// A [`Compressor`] at `quality`, which writes to `output` and allocates
/// with `alloc`.
pub(crate) fn compressor(output: Vec<u8>, mut alloc: CountingAlloc, quality: u32) -> Compressor {
    let buffer = <CountingAlloc as Allocator<u8>>::alloc_cell(&mut alloc, BUFFER_SIZE);
    Compressor::new(output, buffer, alloc, quality, LG_WINDOW_SIZE)
}

/// Streaming brotli compression context.
pub struct CompressContext {
    compressor: Option<Compressor>,
    /// Shares its count with the compressor's allocator.
    alloc: CountingAlloc,
}

impl CompressContext {
    pub fn new(quality: Option<u32>) -> Result<Self, ComprsError> {
        let quality = QUALITY.check(quality.unwrap_or(DEFAULT_QUALITY))?;
        let alloc = CountingAlloc::default();
        let compressor = compressor(Vec::new(), alloc.clone(), quality);
        Ok(Self {
            compressor: Some(compressor),
            alloc,
        })
    }

    pub fn transform(&mut self, chunk: &[u8]) -> Result<Vec<u8>, ComprsError> {
        let compressor = self
            .compressor
            .as_mut()
            .ok_or(ComprsError::StreamFinished("brotli stream"))?;

        compressor
            .write_all(chunk)
            .map_err(|e| ComprsError::Operation {
                context: "brotli stream compress",
                source: e.into(),
            })?;

        // Drain whatever the compressor has flushed to the inner Vec
        let data = std::mem::take(compressor.get_mut());
        Ok(data)
    }

    pub fn flush(&mut self) -> Result<Vec<u8>, ComprsError> {
        let compressor = self
            .compressor
            .as_mut()
            .ok_or(ComprsError::StreamFinished("brotli stream"))?;

        compressor.flush().map_err(|e| ComprsError::Operation {
            context: "brotli stream flush",
            source: e.into(),
        })?;

        let data = std::mem::take(compressor.get_mut());
        Ok(data)
    }

    pub fn finish(&mut self) -> Result<Vec<u8>, ComprsError> {
        let compressor = self
            .compressor
            .take()
            .ok_or(ComprsError::StreamFinished("brotli stream"))?;

        // into_inner drops the CompressorWriter, which flushes remaining data
        // and writes the brotli stream end marker
        Ok(compressor.into_inner())
    }
}

impl MemoryUsage for CompressContext {
    fn memory_usage(&self) -> usize {
        self.compressor.as_ref().map_or(0, |compressor| {
            self.alloc.allocated() + compressor.get_ref().capacity()
        })
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
                Vec::new(),
                LimitedVec::new(max_size, "brotli stream decompress"),
                "brotli stream",
            ),
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
/// 2^[`LG_WINDOW_SIZE`] bytes.
///
/// The encoder takes a custom dictionary as data that precedes the input,
/// so from input position p, the last byte of the dictionary is p + 1 bytes
/// back: only the first `DICT_REACH` bytes of input can refer to the
/// dictionary. A stream that ends within them gets all that the dictionary
/// can give.
pub const DICT_REACH: usize = (1 << LG_WINDOW_SIZE) - 16;

/// The name that [`ComprsError::StreamFinished`] reports for a
/// [`CompressDictContext`].
const DICT_STREAM: &str = "brotli dict stream";

/// The context of the errors of a [`CompressDictContext`].
const DICT_COMPRESS: &str = "brotli dict stream compress";

/// Streaming brotli compression context with custom dictionary.
///
/// brotli's `CompressorWriter`, which [`CompressContext`] uses, takes no
/// dictionary, so this context uses the low-level encoder of
/// [`crate::brotli::compress_with_dict`]. It works in one of two modes:
///
/// - Buffered, as [`CompressDictContext::new`] creates it: `transform` keeps
///   the input and returns an empty Vec, as `flush` does, and `finish`
///   compresses all of it, into the output of
///   [`crate::brotli::compress_with_dict`], which compresses an input of
///   more than [`crate::brotli::DICT_INPUT_LIMIT`] bytes without
///   dictionaries, for the reason below.
/// - Incremental, as [`CompressDictContext::incremental`] creates it: it
///   holds the first [`DICT_REACH`] bytes of input in the same way, and a
///   stream of at most that many bytes gets the same output on `finish`.
///   The `transform` that takes the input past [`DICT_REACH`] bytes
///   compresses the input held so far, flushes it and drops it, then passes
///   the rest of its chunk on. From then on, the encoder takes the input as
///   it arrives, 64 KiB at a time: `transform` returns the output that the
///   encoder has emitted, `flush` all the output of the input so far, and
///   `finish` ends the stream.
///
/// The stream of a longer input is compressed with neither the custom
/// dictionary nor brotli's built-in one, as the fallback of
/// [`crate::brotli::compress_with_dict`] is, and decodes the same with or
/// without the dictionary (an empty dictionary stands for none, and keeps
/// the built-in one): brotli 9.0.0's encoder is not safe with a custom
/// dictionary on a long stream. It marks the end of the dictionary in its
/// ring buffer of 2^([`LG_WINDOW_SIZE`] + 1) bytes, and once the input has
/// wrapped around the ring buffer, every 8 MiB, it still cuts the matches
/// that cross the mark, and panics when that leaves one byte, as it does at
/// the end of the dictionary itself (#623). The dictionary only helps the
/// start of a stream, before the stream's own data has the strings that it
/// holds, so its loss past [`DICT_REACH`] bytes costs little: on 4.06 to
/// 16 MiB of JSON lines with a 2 KiB dictionary, in chunks of 4 KiB or of
/// 64 KiB, the stream came out from 5.5% smaller to 2.2% larger than the
/// output of [`crate::brotli::compress_with_dict`] with the dictionary, and
/// at most 0.8% larger at qualities 1 to 11.
///
/// An error of the encoder, which no input is known to cause, ends the
/// stream: the later calls fail with it too.
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
    Holding { dict: Vec<u8>, input: Vec<u8> },
    /// The encoder, which has taken the input so far.
    Streaming(Box<StreamEncoder>),
    /// A call failed with this error, which the later calls report again.
    Failed(ComprsError),
    /// `finish` was called.
    Finished,
}

impl CompressDictContext {
    /// A buffered context, which compresses all its input on `finish`.
    pub fn new(dict: &[u8], quality: Option<u32>) -> Result<Self, ComprsError> {
        Self::with_max_held(dict, quality, usize::MAX)
    }

    /// An incremental context, which holds at most [`DICT_REACH`] bytes of
    /// input and then streams.
    pub fn incremental(dict: &[u8], quality: Option<u32>) -> Result<Self, ComprsError> {
        Self::with_max_held(dict, quality, DICT_REACH)
    }

    fn with_max_held(
        dict: &[u8],
        quality: Option<u32>,
        max_held: usize,
    ) -> Result<Self, ComprsError> {
        let quality = QUALITY.check(quality.unwrap_or(DEFAULT_QUALITY))?;
        Ok(Self {
            quality,
            max_held,
            state: DictState::Holding {
                dict: dict.to_vec(),
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
                let output =
                    encoder.stream(BrotliEncoderOperation::BROTLI_OPERATION_PROCESS, chunk);
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
        // holds, then the rest of the chunk, without the dictionary. An empty
        // dictionary is none, as for `compress_with_dict`, so the encoder
        // keeps brotli's built-in dictionary then.
        let params = crate::brotli::encoder_params(self.quality, dict.is_empty());
        let mut encoder = StreamEncoder::new(&params);
        let output = encoder
            .stream(BrotliEncoderOperation::BROTLI_OPERATION_FLUSH, input)
            .and_then(|mut output| {
                output.extend(
                    encoder.stream(BrotliEncoderOperation::BROTLI_OPERATION_PROCESS, rest)?,
                );
                Ok(output)
            });
        if output.is_ok() {
            self.state = DictState::Streaming(encoder);
        }
        self.settle(output)
    }

    /// While the context holds its input, return an empty Vec. Otherwise
    /// flush the encoder, and return all the output of the input so far.
    pub fn flush(&mut self) -> Result<Vec<u8>, ComprsError> {
        match &mut self.state {
            DictState::Holding { .. } => Ok(Vec::new()),
            DictState::Streaming(encoder) => {
                let output = encoder.stream(BrotliEncoderOperation::BROTLI_OPERATION_FLUSH, &[]);
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
                crate::brotli::compress_with_dict_inner(&input, &dict, self.quality, DICT_COMPRESS)
            }
            DictState::Streaming(mut encoder) => {
                encoder.stream(BrotliEncoderOperation::BROTLI_OPERATION_FINISH, &[])
            }
            DictState::Failed(error) => Err(error),
            DictState::Finished => Err(ComprsError::StreamFinished(DICT_STREAM)),
        }
    }

    /// Pass on the `output` of a call that ran the encoder, and end the
    /// stream if it is an error: an encoder that failed cannot go on.
    fn settle(&mut self, output: Result<Vec<u8>, ComprsError>) -> Result<Vec<u8>, ComprsError> {
        if let Err(error) = &output {
            self.state = DictState::Failed(error.duplicate());
        }
        output
    }
}

impl MemoryUsage for CompressDictContext {
    /// The dictionary and the input that the context holds, or the encoder
    /// state, with its window and hash tables.
    fn memory_usage(&self) -> usize {
        match &self.state {
            DictState::Holding { dict, input } => dict.capacity() + input.capacity(),
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

/// Run `f`, which runs the encoder of a streaming [`CompressDictContext`],
/// under [`std::panic::catch_unwind`], and report its error or its panic as
/// an error of the context.
///
/// The encoder has no custom dictionary, so no input is known to make it
/// panic: unlike the panics that [`crate::brotli::compress_with_dict`]
/// recovers from, these do not run under [`crate::panic_guard::catch`], and
/// the panic hook reports them.
fn catch_encoder_panic<T>(
    f: impl FnOnce() -> std::io::Result<T> + UnwindSafe,
) -> Result<T, ComprsError> {
    match std::panic::catch_unwind(f) {
        Ok(result) => result.map_err(|e| ComprsError::Operation {
            context: DICT_COMPRESS,
            source: e.into(),
        }),
        Err(_) => Err(ComprsError::Operation {
            context: DICT_COMPRESS,
            source: "the encoder panicked".into(),
        }),
    }
}

type EncoderState = BrotliEncoderStateStruct<CountingAlloc>;

/// Input that [`StreamEncoder`] passes to each call of the encoder: it
/// holds smaller chunks until they make this much, and passes what is left
/// to the call that flushes or ends the stream.
///
/// The encoder takes the input of its first block, with what the call
/// holds past it, as a hint of the size of the stream, and tries a more
/// complex model of the literals above 1 MiB: given the 4 MiB that the
/// start of a stream holds at once, it made a stream of JSON lines 2% larger
/// at qualities 6 and 9 than [`crate::brotli::compress_with_dict`], which
/// passes 4 KiB at a time. At qualities 0 and 1, the encoder compresses the
/// input of each call on its own, in an output buffer twice its size: 4 KiB
/// calls made the stream half again as large, and 4 MiB calls held 8 MiB.
/// Calls of 64 KiB gave about the size of the one-shot function's output at
/// qualities 6 and 9, and a smaller one at 0 and 1.
const FEED: usize = 64 * 1024;

/// brotli's low-level encoder, driven one operation at a time for a
/// streaming [`CompressDictContext`].
struct StreamEncoder {
    state: EncoderState,
    /// Input that the encoder has not taken yet: less than [`FEED`] bytes,
    /// which [`Self::run`] passes on once they make [`FEED`] bytes, or to
    /// flush or end the stream.
    pending: Vec<u8>,
}

#[cfg(test)]
thread_local! {
    /// The operation on which [`StreamEncoder::run`] panics in this thread,
    /// for the tests of an encoder that fails.
    static FAULT: std::cell::Cell<Option<BrotliEncoderOperation>> =
        const { std::cell::Cell::new(None) };
}

impl StreamEncoder {
    /// An encoder with `params` and no custom dictionary. The state is
    /// boxed, as it holds several kilobytes of tables itself.
    fn new(params: &BrotliEncoderParams) -> Box<Self> {
        let mut encoder = Box::new(Self {
            state: EncoderState::new(CountingAlloc::default()),
            pending: Vec::new(),
        });
        encoder.state.params = params.clone();
        encoder
    }

    /// [`Self::run`], with a panic turned into an error by
    /// [`catch_encoder_panic`].
    fn stream(&mut self, op: BrotliEncoderOperation, input: &[u8]) -> Result<Vec<u8>, ComprsError> {
        // The context drops the encoder after an error, so nothing sees the
        // state that a panic left it in.
        catch_encoder_panic(AssertUnwindSafe(|| self.run(op, input)))
    }

    /// Run `op` on all of `input` and return the output: what the encoder
    /// has emitted so far for `BROTLI_OPERATION_PROCESS`, all the output of
    /// the input so far for `BROTLI_OPERATION_FLUSH`, and the rest of the
    /// stream for `BROTLI_OPERATION_FINISH`.
    ///
    /// The encoder takes the input [`FEED`] bytes at a time, whatever the
    /// chunks it arrives in: the input short of that waits in
    /// [`Self::pending`] for more, a flush or the end of the stream.
    fn run(&mut self, op: BrotliEncoderOperation, mut input: &[u8]) -> std::io::Result<Vec<u8>> {
        #[cfg(test)]
        if FAULT.get() == Some(op) {
            // Unlike `panic!`, `resume_unwind` does not run the panic hook,
            // which would print the panic.
            std::panic::resume_unwind(Box::new("an injected encoder panic"));
        }
        let process = BrotliEncoderOperation::BROTLI_OPERATION_PROCESS;
        let mut output = Vec::new();
        if !self.pending.is_empty() {
            let (head, rest) = input.split_at(input.len().min(FEED - self.pending.len()));
            self.pending.extend_from_slice(head);
            input = rest;
            if self.pending.len() == FEED {
                Self::call(&mut self.state, process, &self.pending, &mut output)?;
                self.pending.clear();
            }
        }
        // Either `pending` is empty now, or so is `input`.
        let (pieces, rest) = input.as_chunks::<FEED>();
        for piece in pieces {
            Self::call(&mut self.state, process, piece, &mut output)?;
        }
        if !rest.is_empty() {
            self.pending.reserve_exact(FEED);
            self.pending.extend_from_slice(rest);
        }
        if op != process {
            Self::call(&mut self.state, op, &self.pending, &mut output)?;
            self.pending.clear();
        }
        Ok(output)
    }

    /// Run `op` on `input`, which is at most [`FEED`] bytes, in one call of
    /// the encoder `state`, and append its output to `output`.
    fn call(
        state: &mut EncoderState,
        op: BrotliEncoderOperation,
        input: &[u8],
        output: &mut Vec<u8>,
    ) -> std::io::Result<()> {
        let mut buffer = [0u8; BUFFER_SIZE];
        let mut available_in = input.len();
        let mut input_offset = 0;
        let mut nop = |_: &mut PredictionModeContextMap<InputReferenceMut>,
                       _: &mut [StaticCommand],
                       _: InputPair,
                       _: &mut CountingAlloc| {};
        loop {
            let mut available_out = buffer.len();
            let mut output_offset = 0;
            let ok = state.compress_stream(
                op,
                &mut available_in,
                input,
                &mut input_offset,
                &mut available_out,
                &mut buffer,
                &mut output_offset,
                &mut None,
                &mut nop,
            );
            output.extend_from_slice(&buffer[..output_offset]);
            if !ok {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    "Invalid Data",
                ));
            }
            if available_in == 0
                && !state.has_more_output()
                && (op != BrotliEncoderOperation::BROTLI_OPERATION_FINISH || state.is_finished())
            {
                return Ok(());
            }
        }
    }

    /// The memory of the encoder state, including its window and its hash
    /// tables, and of the input that waits for it.
    fn memory_usage(&self) -> usize {
        self.state.m8.allocated() + self.pending.capacity()
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
                dict.to_vec(),
                LimitedVec::new(max_size, "brotli dict stream decompress"),
                "brotli dict stream",
            ),
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

type DecoderState = BrotliState<CountingAlloc, CountingAlloc, CountingAlloc>;

/// A decoder state with the custom dictionary `dict` (empty for none), whose
/// allocations `alloc` counts.
fn decoder_state(dict: Vec<u8>, alloc: &CountingAlloc) -> DecoderState {
    // The state owns the dictionary and frees it with the allocator.
    alloc.add(dict.len());
    let mut state = DecoderState::new_with_custom_dictionary(
        alloc.clone(),
        alloc.clone(),
        alloc.clone(),
        dict.into(),
    );
    // Decode RFC 7932 streams only: see `crate::brotli::reject_large_window`.
    state.large_window = false;
    state
}

/// Most output that one decoder call of [`decompress_all`] writes. The
/// output buffer is zeroed just before the decoder writes to it, a part of
/// this size at a time, so the zeroed part is still in the cache when the
/// decoder overwrites it.
const DECOMPRESS_ALL_CHUNK: usize = 64 * 1024;

/// Decompress the brotli stream at the start of `input`, with the custom
/// dictionary `dict` (empty for none), in one call.
///
/// The decoder gets all of `input` at once, so it sees how much output a
/// stream shorter than its window holds and sizes its ring buffer for that
/// rather than for the whole window (4 MiB at the default window size). It
/// writes straight into the output buffer, which starts with room for four
/// times the input and grows geometrically, but never past
/// `max_output_size` plus one byte. A failure to allocate that first
/// buffer is reported as an error, as in [`crate::decompress_with_limit`].
///
/// Invalid input fails with "Invalid Data", prefixed by `context`, and
/// exceeding `max_output_size` with [`ComprsError::SizeLimit`]. `end` sets
/// how the end of the input is checked:
///
/// - [`End::Lenient`]: like `brotli::Decompressor`, data after the end of
///   the stream is ignored, and truncated input fails with "Invalid Data" as
///   well. Both are [`ComprsError::Corrupt`]: the one-shot functions keep
///   that message for truncated input, so unlike the decompression contexts
///   they do not report it as [`ComprsError::Truncated`].
/// - [`End::Strict`]: like the decompression contexts, input that ends
///   before the end of the stream fails with [`ComprsError::Truncated`], and
///   data after the end of the stream with [`ComprsError::Corrupt`].
pub(crate) fn decompress_all(
    input: &[u8],
    dict: Vec<u8>,
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
    let mut state = decoder_state(dict, &CountingAlloc::default());
    let mut available_in = input.len();
    let mut input_offset = 0;
    let mut total_out = 0;
    loop {
        let result = output
            .append_with(input.len().saturating_mul(4), |buf| {
                let start = buf.len();
                let mut available_out = (buf.capacity() - start).min(DECOMPRESS_ALL_CHUNK);
                buf.resize(start + available_out, 0);
                let mut output_offset = start;
                let result = BrotliDecompressStream(
                    &mut available_in,
                    &mut input_offset,
                    input,
                    &mut available_out,
                    &mut output_offset,
                    buf,
                    &mut total_out,
                    &mut state,
                );
                buf.truncate(output_offset);
                Ok(result)
            })
            .map_err(|e| output.error(e, context))?;
        match (result, end) {
            (BrotliResult::NeedsMoreOutput, _) => {}
            (BrotliResult::ResultSuccess, End::Strict) if input_offset < input.len() => {
                return Err(data_after_the_stream(context));
            }
            (BrotliResult::ResultSuccess, _) => return Ok(crate::finish_output(output.take())),
            (BrotliResult::NeedsMoreInput, End::Strict) => {
                return Err(ComprsError::Truncated("brotli"));
            }
            (BrotliResult::NeedsMoreInput | BrotliResult::ResultFailure, _) => {
                return Err(ComprsError::Corrupt {
                    context,
                    source: std::io::Error::new(std::io::ErrorKind::InvalidData, "Invalid Data")
                        .into(),
                });
            }
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

/// Decoder state shared by [`DecompressContext`] and [`DecompressDictContext`].
///
/// Drives `BrotliDecompressStream` directly rather than through
/// `brotli::DecompressorWriter`, whose `close()` cannot tell a complete stream
/// from one whose error it has already reported.
struct StreamDecoder {
    /// `None` once the stream is finished, or a call failed.
    state: Option<DecoderState>,
    /// The error of a call that failed, which the later calls report again
    /// until `finish`.
    failed: Option<ComprsError>,
    /// Shares its count with the allocators of `state`.
    alloc: CountingAlloc,
    /// Buffer each decoder call fills before its output moves to `output`.
    buffer: Vec<u8>,
    total_out: usize,
    output: LimitedVec,
    /// Whether the decoder has reached the end of the brotli stream.
    ended: bool,
    /// Name reported by [`ComprsError::StreamFinished`].
    name: &'static str,
}

impl StreamDecoder {
    fn new(dict: Vec<u8>, output: LimitedVec, name: &'static str) -> Self {
        let alloc = CountingAlloc::default();
        Self {
            state: Some(decoder_state(dict, &alloc)),
            failed: None,
            alloc,
            buffer: vec![0; BUFFER_SIZE],
            total_out: 0,
            output,
            ended: false,
            name,
        }
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
                self.state = None;
                self.failed = Some(error.duplicate());
                Err(error)
            }
        }
    }

    /// Feed `input` to the decoder, which writes all the output of the input
    /// so far to `output`.
    fn run(&mut self, input: &[u8], context: &'static str) -> Result<(), ComprsError> {
        let state = self
            .state
            .as_mut()
            .ok_or(ComprsError::StreamFinished(self.name))?;

        let mut available_in = input.len();
        let mut input_offset = 0;
        loop {
            let mut available_out = self.buffer.len();
            let mut output_offset = 0;
            let result = BrotliDecompressStream(
                &mut available_in,
                &mut input_offset,
                input,
                &mut available_out,
                &mut output_offset,
                &mut self.buffer,
                &mut self.total_out,
                state,
            );
            self.output
                .write_all(&self.buffer[..output_offset])
                .map_err(|e| self.output.error(e, context))?;
            match result {
                BrotliResult::NeedsMoreOutput => {}
                // Out of input, the decoder writes the output that it holds
                // in its ring buffer, as much as fits into the buffer, and
                // asks for more input even if some is left: call it again
                // while it fills the buffer, until a call leaves room, which
                // it does once it has written all of it (#704). Each call
                // that goes on wrote a full buffer of the output of the
                // input so far, which is finite, so the loop ends; and the
                // output limit, checked on each call, stops it sooner.
                BrotliResult::NeedsMoreInput if available_out == 0 => {}
                BrotliResult::NeedsMoreInput => break,
                BrotliResult::ResultSuccess => {
                    self.ended = true;
                    if input_offset < input.len() {
                        return Err(data_after_the_stream(context));
                    }
                    break;
                }
                BrotliResult::ResultFailure => {
                    return Err(ComprsError::Corrupt {
                        context,
                        source: "Invalid Data".into(),
                    });
                }
            }
        }

        Ok(())
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
        self.state = None;
        self.failed = None;
        let output = output?;
        if !self.ended {
            return Err(ComprsError::Truncated("brotli"));
        }
        Ok(output)
    }

    /// The memory of the decoder state, including its ring buffer and the
    /// dictionary, and of the output buffers.
    fn memory_usage(&self) -> usize {
        self.alloc.allocated() + self.buffer.capacity() + self.output.capacity()
    }
}

#[cfg(test)]
mod tests {
    use brotli::enc::encode::BrotliEncoderOperation::{
        self, BROTLI_OPERATION_FINISH as FINISH, BROTLI_OPERATION_FLUSH as FLUSH,
        BROTLI_OPERATION_PROCESS as PROCESS,
    };
    use brotli::enc::{Allocator, SliceWrapper, SliceWrapperMut, StandardAlloc};

    use super::{
        CompressContext, CompressDictContext, CountingAlloc, DICT_REACH, DecompressContext,
        DecompressDictContext,
    };
    use crate::brotli::{BUFFER_SIZE, TEXT, compress_with_dict, decompress, decompress_with_dict};
    use crate::{ComprsError, MemoryUsage};

    /// Decompression limit used by the size-limit tests.
    const LIMIT: usize = 64 * 1024;

    /// The length and the address of the ring buffer that [`super::RING_BUFFER`]
    /// keeps, if any.
    fn kept_ring_buffer() -> Option<(usize, usize)> {
        super::RING_BUFFER.with(|kept| {
            let kept = kept.borrow();
            let memory = kept
                .as_ref()?
                .downcast_ref::<<StandardAlloc as Allocator<u8>>::AllocatedMemory>()?;
            Some((memory.slice().len(), memory.slice().as_ptr() as usize))
        })
    }

    /// Fill the ring buffer that [`super::RING_BUFFER`] keeps with bytes
    /// that no stream holds, which the encoder must not read.
    fn scramble_kept_ring_buffer() {
        super::RING_BUFFER.with(|kept| {
            let mut kept = kept.borrow_mut();
            let memory = kept
                .as_mut()
                .and_then(|memory| {
                    memory.downcast_mut::<<StandardAlloc as Allocator<u8>>::AllocatedMemory>()
                })
                .expect("a ring buffer is kept");
            let mut state = 0x9e37_79b9_u32;
            for byte in memory.slice_mut() {
                state ^= state << 13;
                state ^= state >> 17;
                state ^= state << 5;
                *byte = state as u8;
            }
        });
    }

    /// Drop the ring buffer that [`super::RING_BUFFER`] keeps.
    fn drop_kept_ring_buffer() {
        super::RING_BUFFER.with(|kept| kept.borrow_mut().take());
    }

    /// What `compress` returns with a fresh ring buffer, and with a
    /// recycled one full of other bytes: the same output, or the test fails.
    ///
    /// An encoder that allocates no ring buffer, as at qualities 0 and 1,
    /// which ignore a custom dictionary, leaves nothing to recycle, so
    /// `compress` then runs once; `recycles` says whether it must allocate
    /// one.
    fn compress_with_recycled_ring_buffer(
        label: &str,
        recycles: bool,
        compress: impl Fn() -> Vec<u8>,
    ) -> Vec<u8> {
        drop_kept_ring_buffer();
        let fresh = compress();
        if kept_ring_buffer().is_none() {
            assert!(!recycles, "the encoder kept no ring buffer: {label}");
            return fresh;
        }
        scramble_kept_ring_buffer();
        assert!(
            compress() == fresh,
            "a recycled ring buffer changed the output: {label}"
        );
        fresh
    }

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
        // The output never grew past the limit (brotli adds one 4 KiB buffer).
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
        // The encoder returned all its memory to the allocator, except the
        // buffer of the writer, which drops it.
        assert_eq!(strong.alloc.allocated(), BUFFER_SIZE);
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
        // Dropping the state returned all its memory to the allocator.
        assert_eq!(ctx.inner.alloc.allocated(), 0);
    }

    #[test]
    fn decompress_dict_context_reports_the_dictionary() {
        let dict = b"brotli dictionary ".repeat(1000);
        let compressed = crate::brotli::compress_with_dict(&dict, &dict, None).unwrap();
        let mut ctx = DecompressDictContext::new(&dict, None).unwrap();
        assert!(ctx.memory_usage() >= dict.len());

        assert_eq!(ctx.transform(&compressed).unwrap(), dict);
        ctx.finish().unwrap();
        assert_eq!(ctx.inner.alloc.allocated(), 0);
    }

    #[test]
    fn counting_alloc_clamps_the_count_at_zero() {
        let mut alloc = CountingAlloc::default();
        let small = <CountingAlloc as Allocator<u32>>::alloc_cell(&mut alloc, 2);
        let large = <CountingAlloc as Allocator<u32>>::alloc_cell(&mut alloc, 8);
        assert_eq!(alloc.allocated(), 40);

        <CountingAlloc as Allocator<u32>>::free_cell(&mut alloc, small);
        assert_eq!(alloc.allocated(), 32);
        // Freeing memory that another allocator handed out stops at zero
        // instead of wrapping around.
        let foreign =
            <StandardAlloc as Allocator<u32>>::alloc_cell(&mut StandardAlloc::default(), 16);
        <CountingAlloc as Allocator<u32>>::free_cell(&mut alloc, foreign);
        assert_eq!(alloc.allocated(), 0);
        <CountingAlloc as Allocator<u32>>::free_cell(&mut alloc, large);
        assert_eq!(alloc.allocated(), 0);
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
            assert_eq!(ctx.memory_usage(), BUFFER_SIZE, "{name}");
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

    #[test]
    fn decompress_dict_context_returns_all_the_output_of_a_flushed_chunk() {
        let dict = english_dict();
        let input = english(100_000);
        // `CompressDictContext` holds input of this size until `finish`, so
        // drive brotli's encoder with the dictionary directly.
        let mut encoder = super::StreamEncoder::new(&crate::brotli::encoder_params(5, true));
        encoder.state.set_custom_dictionary(dict.len(), &dict);
        let compressed = encoder.stream(FLUSH, &input).unwrap();
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

    /// The dictionary stream compresses on `finish` through the same encoder
    /// path as `compress_with_dict`, so it hits the same brotli 9.0.0 panic.
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

    /// The fallback that `finish` takes when the encoder fails decodes with
    /// the dictionary (#642).
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
    /// with references to the dictionary of [`english_dict`] at first, and
    /// to the built-in dictionary without one.
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
    /// input, and otherwise with output before `finish`, into a stream that
    /// refers to no dictionary and decodes the same without `dict`.
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
                // Text that brotli's built-in dictionary covers decodes into
                // other bytes with a custom dictionary if the stream refers
                // to the built-in one (#642).
                assert!(decompress(&output).unwrap() == input, "{context}");
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
    /// before `finish`. The stream, which does not use the dictionary, is
    /// about as large as the output of [`compress_with_dict`].
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
        assert!(output.len() * 1000 <= one_shot.len() * 1005, "{sizes}");
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
    /// [`compress_with_dict`] at every quality, also when that takes the
    /// fallback for brotli 9.0.0's dictionary bugs.
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

    /// brotli 9.0.0's encoder fails on the start of this stream with the
    /// dictionary, as it does on [`crate::brotli::dict_fallback_input`]:
    /// past [`DICT_REACH`] bytes, the context compresses it without the
    /// dictionary.
    #[test]
    fn incremental_dict_context_compresses_the_dict_fallback_input_past_the_reach() {
        let dict = crate::brotli::FALLBACK_DICT;
        let mut input = crate::brotli::dict_fallback_input();
        input.extend(english(DICT_REACH + 64 * KIB - input.len()));
        let (_, output) = compress_incremental(&dict, 5, &input, MIB);
        assert!(decompress_with_dict(&output, &dict).unwrap() == input);
    }

    /// An empty dictionary stands for none, as for [`compress_with_dict`]:
    /// past [`DICT_REACH`] bytes, the stream keeps brotli's built-in
    /// dictionary, which makes English text smaller.
    #[test]
    fn incremental_dict_context_keeps_the_built_in_dictionary_for_an_empty_one() {
        let quality = 5;
        let mut input = vec![0; DICT_REACH];
        input.extend(english(64 * KIB));
        // What the context makes of `input` past the reach, with or without
        // brotli's built-in dictionary.
        let stream = |use_dictionary| {
            let params = crate::brotli::encoder_params(quality, use_dictionary);
            let mut encoder = super::StreamEncoder::new(&params);
            let mut output = encoder.stream(FLUSH, &input[..DICT_REACH]).unwrap();
            output.extend(encoder.stream(PROCESS, &input[DICT_REACH..]).unwrap());
            output.extend(encoder.stream(FINISH, &[]).unwrap());
            output
        };
        let mut ctx = CompressDictContext::incremental(&[], Some(quality)).unwrap();
        let mut output = ctx.transform(&input[..DICT_REACH]).unwrap();
        output.extend(ctx.transform(&input[DICT_REACH..]).unwrap());
        output.extend(ctx.finish().unwrap());
        assert!(output == stream(true));
        let without = stream(false);
        assert!(
            output.len() < without.len(),
            "{} bytes, {} without the built-in dictionary",
            output.len(),
            without.len()
        );
        assert!(decompress(&output).unwrap() == input);
        let mut decoder = DecompressDictContext::new(&[], None).unwrap();
        let mut decoded = decoder.transform(&output).unwrap();
        decoded.extend(decoder.finish().unwrap());
        assert!(decoded == input);
    }

    /// 8 MiB and 64 KiB of a period of 1000 bytes of noise, with two bytes
    /// changed, the second `changed` bytes past the match below, on which
    /// brotli 9.0.0's encoder with a dictionary panics at quality 2 if
    /// `changed` is 4, and at quality 5 if it is 3. Its ring buffer holds
    /// 8 MiB, and once the input wraps around it, the encoder still takes
    /// the position that marks the end of the dictionary for one, and cuts
    /// a match that starts on the byte before it to one byte, which it
    /// cannot encode, as at the end of the dictionary itself (#623).
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

    /// Past [`DICT_REACH`] bytes, the context compresses without the
    /// dictionary, so the bug of brotli 9.0.0's encoder that
    /// [`ring_buffer_input`] triggers cannot end the stream with an error.
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

    /// One-shot dictionary compression keeps an input of more than
    /// [`DICT_INPUT_LIMIT`] bytes, such as [`ring_buffer_input`], away from
    /// the encoder with the dictionary, which would panic on it (#703): it
    /// compresses the input with neither dictionary, so the output does not
    /// depend on the dictionary and decodes the same with or without it.
    ///
    /// [`DICT_INPUT_LIMIT`]: crate::brotli::DICT_INPUT_LIMIT
    #[test]
    fn dict_compress_takes_long_inputs_without_dictionaries() {
        let dict = b"a dictionary of a few words";
        for (changed, quality) in [(4, 2), (3, 5)] {
            let input = ring_buffer_input(changed);
            let before = crate::brotli::dict_encodes();
            let output = compress_with_dict(&input, dict, Some(quality)).unwrap();
            assert_eq!(crate::brotli::dict_encodes(), before, "quality {quality}");
            let other = compress_with_dict(&input, b"another dictionary", Some(quality)).unwrap();
            assert!(output == other, "quality {quality}");
            assert!(decompress_with_dict(&output, dict).unwrap() == input);
            assert!(decompress(&output).unwrap() == input);
        }
    }

    /// An input of up to [`DICT_INPUT_LIMIT`] bytes is compressed with the
    /// dictionary, as before, and one byte more without it.
    ///
    /// [`DICT_INPUT_LIMIT`]: crate::brotli::DICT_INPUT_LIMIT
    #[test]
    fn dict_compress_keeps_the_dictionary_up_to_the_limit() {
        let limit = crate::brotli::DICT_INPUT_LIMIT;
        let dict = english_dict();
        let input = english(limit + 1);
        for (len, encodes) in [(limit, 1), (limit + 1, 0)] {
            let before = crate::brotli::dict_encodes();
            let output = compress_with_dict(&input[..len], &dict, Some(2)).unwrap();
            assert_eq!(
                crate::brotli::dict_encodes() - before,
                encodes,
                "{len} bytes"
            );
            assert!(decompress_with_dict(&output, &dict).unwrap() == input[..len]);
        }
    }

    /// The canary of `incremental_dict_context_streams_past_the_ring_buffer`,
    /// which tests nothing unless brotli's encoder panics on
    /// [`ring_buffer_input`] with a dictionary: brotli 9.0.0's does, as the
    /// stream encoder would if it kept the dictionary past [`DICT_REACH`]
    /// bytes. Once a brotli release no longer panics here (#623), this test
    /// fails: if the release fixes the bug, delete this test and reconsider
    /// keeping the dictionary in the stream; otherwise, change
    /// [`ring_buffer_input`] to trigger the bug again.
    #[test]
    fn brotli_encoder_still_panics_past_the_ring_buffer_with_a_dictionary() {
        let dict = b"a dictionary of a few words";
        for (changed, quality) in [(4, 2), (3, 5)] {
            let input = ring_buffer_input(changed);
            let params = crate::brotli::encoder_params(quality, true);
            let mut encoder = super::StreamEncoder::new(&params);
            encoder.state.set_custom_dictionary(dict.len(), dict);
            let encoded = crate::panic_guard::catch(std::panic::AssertUnwindSafe(|| {
                encoder.run(FINISH, &input)
            }));
            assert!(encoded.is_err(), "quality {quality}");
        }
    }

    /// After the encoder fails, every call fails with its error, until
    /// `finish` ends the stream.
    #[test]
    fn incremental_dict_context_reports_an_encoder_error_again() {
        let mut ctx = CompressDictContext::incremental(b"dictionary", Some(1)).unwrap();
        assert!(!ctx.transform(&vec![0; DICT_REACH + 1]).unwrap().is_empty());
        let error = ComprsError::Operation {
            context: super::DICT_COMPRESS,
            source: "an injected encoder error".into(),
        };
        let message = "brotli dict stream compress failed: an injected encoder error";
        assert_eq!(ctx.settle(Err(error)).unwrap_err().to_string(), message);
        assert_eq!(ctx.memory_usage(), 0);
        assert_eq!(ctx.transform(b"more").unwrap_err().to_string(), message);
        assert_eq!(ctx.flush().unwrap_err().to_string(), message);
        assert_eq!(ctx.finish().unwrap_err().to_string(), message);
        assert!(matches!(
            ctx.finish(),
            Err(ComprsError::StreamFinished("brotli dict stream"))
        ));
    }

    /// Makes the encoders of this thread panic on an operation, until it is
    /// dropped.
    struct Fault;

    impl Fault {
        fn on(op: BrotliEncoderOperation) -> Self {
            super::FAULT.set(Some(op));
            Self
        }
    }

    impl Drop for Fault {
        fn drop(&mut self) {
            super::FAULT.set(None);
        }
    }

    /// A panic of the encoder, in any call that runs it, ends the stream
    /// with an error: the context drops the encoder, and every later call
    /// fails with the error until `finish`, which ends the stream.
    #[test]
    fn incremental_dict_context_reports_an_encoder_panic() {
        type Call = fn(&mut CompressDictContext, &[u8]) -> Result<Vec<u8>, ComprsError>;
        // The name of a case, the input that the context takes first, then
        // the operation on which the encoder panics, in the call that runs
        // it on the last bytes.
        type Case<'a> = (&'a str, &'a [u8], BrotliEncoderOperation, Call, &'a [u8]);
        let transform: Call = |ctx, chunk| ctx.transform(chunk);
        let flush: Call = |ctx, _| ctx.flush();
        let finish: Call = |ctx, _| ctx.finish();
        let message = "brotli dict stream compress failed: the encoder panicked";
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

    #[test]
    fn catch_encoder_panic_reports_a_panic_as_an_error() {
        let panicked = super::catch_encoder_panic(|| -> std::io::Result<()> {
            panic!("an injected encoder panic")
        });
        assert_eq!(
            panicked.unwrap_err().to_string(),
            "brotli dict stream compress failed: the encoder panicked"
        );
        let failed = super::catch_encoder_panic(|| -> std::io::Result<()> {
            Err(std::io::Error::other("e"))
        });
        assert_eq!(
            failed.unwrap_err().to_string(),
            "brotli dict stream compress failed: e"
        );
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

    #[test]
    fn recycled_ring_buffers_give_the_output_of_fresh_ones() {
        // The encoder allocates all of its ring buffer on every call with a
        // dictionary, and once the input outgrows one block without one.
        let dict = prose(4096);
        let message = prose(100);
        let text = prose(super::RECYCLED_INPUT);
        for quality in 0..=11 {
            // Qualities 0 and 1 ignore a custom dictionary, and compress
            // 256 KiB without the ring buffer.
            let with_dict = quality >= 2;
            compress_with_recycled_ring_buffer(
                &format!("a message with a dictionary at quality {quality}"),
                with_dict,
                || compress_with_dict(&message, &dict, Some(quality)).unwrap(),
            );
            compress_with_recycled_ring_buffer(
                &format!("20 KB with a dictionary at quality {quality}"),
                with_dict,
                || compress_with_dict(&text[..20_000], &dict, Some(quality)).unwrap(),
            );
            if quality < 10 {
                let output = compress_with_recycled_ring_buffer(
                    &format!("256 KiB at quality {quality}"),
                    quality >= 2,
                    || crate::brotli::compress(&text, Some(quality)).unwrap(),
                );
                assert_eq!(decompress(&output).unwrap(), text);
            }
        }
    }

    /// The encoders of large inputs and of streams allocate a fresh ring
    /// buffer and free it, and leave the one that the thread keeps (#727).
    #[test]
    fn only_encoders_of_small_inputs_recycle_the_ring_buffer() {
        let dict = prose(4096);
        let text = prose(super::RECYCLED_INPUT + 1);
        drop_kept_ring_buffer();
        crate::brotli::compress(&text, Some(5)).unwrap();
        compress_with_dict(&text[dict.len()..], &dict, Some(5)).unwrap();
        let mut ctx = CompressContext::new(Some(5)).unwrap();
        for chunk in text.chunks(64 * 1024) {
            ctx.transform(chunk).unwrap();
        }
        ctx.finish().unwrap();
        let mut encoder = super::StreamEncoder::new(&crate::brotli::encoder_params(5, true));
        encoder
            .stream(BrotliEncoderOperation::BROTLI_OPERATION_FINISH, &text)
            .unwrap();
        drop(encoder);
        assert_eq!(kept_ring_buffer(), None);

        // An encoder of a small input keeps its ring buffer, which the others
        // neither take nor replace.
        compress_with_dict(&text[..100], &dict, Some(5)).unwrap();
        let kept = kept_ring_buffer().expect("the encoder kept its ring buffer");
        crate::brotli::compress(&text, Some(5)).unwrap();
        compress_with_dict(&text[dict.len()..], &dict, Some(5)).unwrap();
        assert_eq!(kept_ring_buffer(), Some(kept));
        // Inputs of up to RECYCLED_INPUT bytes, the dictionary included,
        // recycle it.
        compress_with_dict(&text[dict.len() + 1..], &dict, Some(5)).unwrap();
        assert_eq!(kept_ring_buffer(), Some(kept));
        drop_kept_ring_buffer();
        compress_with_dict(&text[dict.len() + 1..], &dict, Some(5)).unwrap();
        assert!(kept_ring_buffer().is_some());
    }

    #[test]
    fn encoders_reuse_the_ring_buffer_of_their_thread() {
        let dict = prose(4096);
        let message = prose(100);
        drop_kept_ring_buffer();
        compress_with_dict(&message, &dict, Some(5)).unwrap();
        let kept = kept_ring_buffer().expect("the encoder kept its ring buffer");
        assert!(kept.0 > super::RECYCLED_BYTES);
        // The next encoder takes it, and gives it back.
        compress_with_dict(&message, &dict, Some(5)).unwrap();
        assert_eq!(kept_ring_buffer(), Some(kept));
        // Another thread keeps its own.
        std::thread::spawn(move || {
            assert_eq!(kept_ring_buffer(), None);
            compress_with_dict(&message, &dict, Some(5)).unwrap();
            assert!(kept_ring_buffer().is_some());
        })
        .join()
        .unwrap();
        assert_eq!(kept_ring_buffer(), Some(kept));
    }

    #[test]
    fn only_encoders_recycle_and_only_their_ring_buffer() {
        drop_kept_ring_buffer();
        // A decoder's allocator, and an encoder's array of other elements,
        // free their memory.
        let mut decoder = CountingAlloc::default();
        let bytes =
            <CountingAlloc as Allocator<u8>>::alloc_cell(&mut decoder, super::RECYCLED_BYTES);
        <CountingAlloc as Allocator<u8>>::free_cell(&mut decoder, bytes);
        assert_eq!(kept_ring_buffer(), None);
        let mut encoder = CountingAlloc::for_input(0);
        let words =
            <CountingAlloc as Allocator<u32>>::alloc_cell(&mut encoder, super::RECYCLED_BYTES);
        <CountingAlloc as Allocator<u32>>::free_cell(&mut encoder, words);
        assert_eq!(kept_ring_buffer(), None);
        // An encoder's smaller array of bytes too.
        let small = <CountingAlloc as Allocator<u8>>::alloc_cell(&mut encoder, 4096);
        <CountingAlloc as Allocator<u8>>::free_cell(&mut encoder, small);
        assert_eq!(kept_ring_buffer(), None);
        // An encoder's ring buffer is kept, and goes to a request of its size
        // only, counted as allocated as a fresh one is.
        let len = super::RECYCLED_BYTES + 9;
        let ring = <CountingAlloc as Allocator<u8>>::alloc_cell(&mut encoder, len);
        <CountingAlloc as Allocator<u8>>::free_cell(&mut encoder, ring);
        let kept = kept_ring_buffer().expect("the ring buffer is kept");
        let other = <CountingAlloc as Allocator<u8>>::alloc_cell(&mut encoder, len + 1);
        assert_eq!(kept_ring_buffer(), Some(kept));
        let same = <CountingAlloc as Allocator<u8>>::alloc_cell(&mut encoder, len);
        assert_eq!(kept_ring_buffer(), None);
        assert_eq!(same.slice().as_ptr() as usize, kept.1);
        assert_eq!(encoder.allocated(), 2 * len + 1);
        <CountingAlloc as Allocator<u8>>::free_cell(&mut encoder, other);
        <CountingAlloc as Allocator<u8>>::free_cell(&mut encoder, same);
        assert_eq!(encoder.allocated(), 0);
        assert_eq!(kept_ring_buffer().map(|(kept_len, _)| kept_len), Some(len));
        // The allocator of a larger input neither takes it nor keeps its own.
        let mut large = CountingAlloc::for_input(super::RECYCLED_INPUT + 1);
        let ring = <CountingAlloc as Allocator<u8>>::alloc_cell(&mut large, len);
        assert_ne!(ring.slice().as_ptr() as usize, kept.1);
        <CountingAlloc as Allocator<u8>>::free_cell(&mut large, ring);
        assert_eq!(kept_ring_buffer(), Some((len, kept.1)));
    }
}
