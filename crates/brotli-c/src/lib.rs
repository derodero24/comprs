//! libbrotli, Google's C brotli library, vendored in `brotli/` and built
//! by `build.rs`, with a safe interface to the part that comprs uses: the
//! streaming encoder and decoder, and raw (LZ77 prefix) dictionaries,
//! which are what comprs calls custom dictionaries (#563).
//!
//! comprs-core forbids unsafe code; every call into libbrotli is in this
//! crate. Every instance allocates through Rust's global allocator and
//! counts what it holds (see `alloc`).
//!
//! The encoder and the decoder write into the spare capacity of a `Vec`,
//! which the caller reserves, so that the caller decides how much output
//! a call may produce: the decoder's output limits of comprs-core work
//! that way.

#![deny(
    clippy::all,
    clippy::undocumented_unsafe_blocks,
    missing_docs,
    unsafe_op_in_unsafe_fn
)]

mod alloc;
mod ffi;

use std::ffi::CStr;
use std::fmt;
use std::ptr::NonNull;
use std::sync::Arc;

use alloc::Counter;

/// The lowest quality: 0.
pub const MIN_QUALITY: u32 = 0;
/// The highest quality: 11.
pub const MAX_QUALITY: u32 = 11;
/// The smallest window, as the log2 of its size: 10.
pub const MIN_WINDOW_BITS: u32 = 10;
/// The largest window that RFC 7932 allows, as the log2 of its size: 24.
pub const MAX_WINDOW_BITS: u32 = 24;

/// The version of the vendored libbrotli, as `BrotliEncoderVersion` gives
/// it: the major version in the bits from 24 up, the minor in 12 to 23 and
/// the patch in 0 to 11.
pub fn version() -> u32 {
    // SAFETY: the function has no preconditions.
    unsafe { ffi::BrotliEncoderVersion() }
}

/// An error of libbrotli or of this interface.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Error {
    /// Memory could not be allocated: libbrotli's, or the output's.
    OutOfMemory,
    /// The encoder rejected a parameter value, or a parameter or a
    /// dictionary given after it started.
    InvalidParameter(&'static str),
    /// libbrotli rejected a dictionary.
    InvalidDictionary,
    /// The encoder failed, which libbrotli documents for no valid input.
    Encoder,
    /// The data does not decode: libbrotli's error code, negative, and its
    /// name, such as `_ERROR_FORMAT_PADDING_1`.
    Decoder {
        /// libbrotli's `BrotliDecoderErrorCode`.
        code: i32,
        /// libbrotli's `BrotliDecoderErrorString` of the code.
        message: &'static str,
    },
}

impl Error {
    /// The decoder's error for `code`.
    fn decoder(code: i32) -> Self {
        // SAFETY: BrotliDecoderErrorString takes any code and returns a
        // static NUL-terminated string.
        let message = unsafe { CStr::from_ptr(ffi::BrotliDecoderErrorString(code)) };
        Self::Decoder {
            code,
            message: message.to_str().unwrap_or("_ERROR_UNKNOWN"),
        }
    }

    /// Whether this is a decoder error that tells that memory ran out:
    /// libbrotli's codes from -30 to -21 (`_ERROR_ALLOC_*`).
    pub fn is_out_of_memory(&self) -> bool {
        match self {
            Self::OutOfMemory => true,
            Self::Decoder { code, .. } => (-30..=-21).contains(code),
            _ => false,
        }
    }
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::OutOfMemory => f.write_str("out of memory"),
            Self::InvalidParameter(name) => write!(f, "invalid brotli encoder parameter: {name}"),
            Self::InvalidDictionary => f.write_str("invalid brotli dictionary"),
            Self::Encoder => f.write_str("brotli encoder failed"),
            Self::Decoder { message, .. } => {
                // libbrotli's names start with an underscore, as in
                // `_ERROR_FORMAT_PADDING_1`.
                f.write_str(message.trim_start_matches('_'))
            }
        }
    }
}

impl std::error::Error for Error {}

/// The bytes of a dictionary: borrowed for `'d`, or shared.
#[derive(Clone, Debug)]
enum Bytes<'d> {
    Borrowed(&'d [u8]),
    Shared(Arc<[u8]>),
}

impl Bytes<'_> {
    fn as_slice(&self) -> &[u8] {
        match self {
            Self::Borrowed(bytes) => bytes,
            Self::Shared(bytes) => bytes,
        }
    }
}

/// Reserve room in `output` for at least one more byte, growing it
/// geometrically: by its length, and at least by `min` bytes.
fn reserve(output: &mut Vec<u8>, min: usize) -> Result<(), Error> {
    if output.capacity() > output.len() {
        return Ok(());
    }
    output
        .try_reserve(output.len().max(min))
        .map_err(|_| Error::OutOfMemory)
}

/// A raw (LZ77 prefix) dictionary prepared for the encoder: libbrotli has
/// hashed it once for qualities up to the one it was prepared for, and
/// encoders that [`Encoder::attach`] it reuse that.
///
/// It holds its bytes, borrowed for `'d` or shared, since libbrotli keeps
/// only a pointer to them. libbrotli only reads it once it is prepared, so
/// encoders on several threads can share it.
pub struct PreparedDictionary<'d> {
    raw: NonNull<ffi::BrotliEncoderPreparedDictionary>,
    bytes: Bytes<'d>,
    counter: Box<Counter>,
}

// SAFETY: libbrotli only reads a prepared dictionary after
// BrotliEncoderPrepareDictionary has returned it, and frees it only in
// `drop`, which takes it by value: it has no thread affinity, and shared
// references to it only read.
unsafe impl Send for PreparedDictionary<'_> {}
// SAFETY: as above.
unsafe impl Sync for PreparedDictionary<'_> {}

impl<'d> PreparedDictionary<'d> {
    /// Prepare `bytes`, borrowed, as a raw dictionary for encoders of
    /// qualities up to `max_quality`.
    pub fn new(bytes: &'d [u8], max_quality: u32) -> Result<Self, Error> {
        Self::prepare(Bytes::Borrowed(bytes), max_quality)
    }

    fn prepare(bytes: Bytes<'d>, max_quality: u32) -> Result<Self, Error> {
        if max_quality > MAX_QUALITY {
            return Err(Error::InvalidParameter("dictionary quality"));
        }
        let counter = Box::<Counter>::default();
        let data = bytes.as_slice();
        let (alloc, free) = alloc::FUNCTIONS;
        // SAFETY: `data` is valid for `data.len()` bytes, and stays where it
        // is for as long as `self` holds `bytes`: libbrotli keeps a pointer
        // to it. The memory functions get the opaque of `counter`, which
        // `self` keeps in its box.
        let raw = unsafe {
            ffi::BrotliEncoderPrepareDictionary(
                ffi::BROTLI_SHARED_DICTIONARY_RAW,
                data.len(),
                data.as_ptr(),
                max_quality as i32,
                alloc,
                free,
                counter.opaque(),
            )
        };
        let raw = NonNull::new(raw).ok_or(Error::OutOfMemory)?;
        Ok(Self {
            raw,
            bytes,
            counter,
        })
    }

    /// The bytes of the dictionary.
    pub fn bytes(&self) -> &[u8] {
        self.bytes.as_slice()
    }

    /// The bytes that libbrotli holds for the prepared dictionary, without
    /// the dictionary's own bytes.
    pub fn memory_usage(&self) -> usize {
        self.counter.get()
    }
}

impl PreparedDictionary<'static> {
    /// Prepare `bytes`, shared, as a raw dictionary for encoders of
    /// qualities up to `max_quality`.
    pub fn shared(bytes: Arc<[u8]>, max_quality: u32) -> Result<Self, Error> {
        Self::prepare(Bytes::Shared(bytes), max_quality)
    }
}

impl Drop for PreparedDictionary<'_> {
    fn drop(&mut self) {
        // SAFETY: `raw` came from BrotliEncoderPrepareDictionary and is
        // freed once, here; the encoders that it is attached to borrow or
        // share `self`, so none outlives it.
        unsafe { ffi::BrotliEncoderDestroyPreparedDictionary(self.raw.as_ptr()) }
    }
}

impl fmt::Debug for PreparedDictionary<'_> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("PreparedDictionary")
            .field("len", &self.bytes().len())
            .finish_non_exhaustive()
    }
}

/// A dictionary attached to an encoder: borrowed for `'d`, or shared.
enum Attached<'d> {
    Borrowed(#[allow(dead_code, reason = "held only to keep it alive")] &'d PreparedDictionary<'d>),
    Shared(
        #[allow(dead_code, reason = "held only to keep it alive")] Arc<PreparedDictionary<'static>>,
    ),
}

/// What [`Encoder::compress`] does with its input.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Operation {
    /// Compress the input; output may lag behind it.
    Process,
    /// Compress the input and emit all of its output, so that a decoder can
    /// decode all of the input so far.
    Flush,
    /// Compress the input, which is the last, and end the stream.
    Finish,
}

impl Operation {
    fn raw(self) -> i32 {
        match self {
            Self::Process => ffi::BROTLI_OPERATION_PROCESS,
            Self::Flush => ffi::BROTLI_OPERATION_FLUSH,
            Self::Finish => ffi::BROTLI_OPERATION_FINISH,
        }
    }
}

/// The kind of input that the encoder tunes for (`BROTLI_PARAM_MODE`).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Mode {
    /// Any data: libbrotli's default.
    #[default]
    Generic,
    /// UTF-8 text.
    Text,
    /// WOFF 2.0 fonts.
    Font,
}

/// A brotli encoder: libbrotli's streaming `BrotliEncoderState`.
///
/// Its parameters are set before it compresses: [`Encoder::set_quality`],
/// [`Encoder::set_window`], [`Encoder::set_mode`],
/// [`Encoder::set_size_hint`] and [`Encoder::attach`]. It may hold
/// dictionaries borrowed for `'d`.
pub struct Encoder<'d> {
    state: NonNull<ffi::BrotliEncoderState>,
    dictionaries: Vec<Attached<'d>>,
    counter: Box<Counter>,
    /// Whether [`Encoder::compress`] has run: libbrotli rejects parameters
    /// from then on, but would attach a dictionary to a stream under way,
    /// which a decoder, given it from the start, would not decode.
    started: bool,
}

// SAFETY: a BrotliEncoderState has no thread affinity, and every method
// that calls libbrotli on it takes `&mut self`. The dictionaries that it
// holds are Sync.
unsafe impl Send for Encoder<'_> {}

impl<'d> Encoder<'d> {
    /// A new encoder with libbrotli's default parameters: quality 11, a
    /// window of 2^22 bytes, generic mode.
    pub fn new() -> Result<Self, Error> {
        Self::with_counter(Box::default())
    }

    fn with_counter(counter: Box<Counter>) -> Result<Self, Error> {
        let (alloc, free) = alloc::FUNCTIONS;
        // SAFETY: the memory functions get the opaque of `counter`, which
        // `self` keeps in its box for as long as the state lives.
        let state = unsafe { ffi::BrotliEncoderCreateInstance(alloc, free, counter.opaque()) };
        Ok(Self {
            state: NonNull::new(state).ok_or(Error::OutOfMemory)?,
            dictionaries: Vec::new(),
            counter,
            started: false,
        })
    }

    fn set_parameter(&mut self, param: i32, value: u32, name: &'static str) -> Result<(), Error> {
        // SAFETY: `state` is a live encoder, and libbrotli checks the
        // parameter and its value.
        let set = unsafe { ffi::BrotliEncoderSetParameter(self.state.as_ptr(), param, value) };
        if set == ffi::BROTLI_TRUE {
            Ok(())
        } else {
            Err(Error::InvalidParameter(name))
        }
    }

    /// Set the quality, from [`MIN_QUALITY`] to [`MAX_QUALITY`].
    pub fn set_quality(&mut self, quality: u32) -> Result<(), Error> {
        if quality > MAX_QUALITY {
            return Err(Error::InvalidParameter("quality"));
        }
        self.set_parameter(ffi::BROTLI_PARAM_QUALITY, quality, "quality")
    }

    /// Set the window, as the log2 of its size, from [`MIN_WINDOW_BITS`] to
    /// [`MAX_WINDOW_BITS`].
    pub fn set_window(&mut self, bits: u32) -> Result<(), Error> {
        if !(MIN_WINDOW_BITS..=MAX_WINDOW_BITS).contains(&bits) {
            return Err(Error::InvalidParameter("window"));
        }
        self.set_parameter(ffi::BROTLI_PARAM_LGWIN, bits, "window")
    }

    /// Set the kind of input to tune for.
    pub fn set_mode(&mut self, mode: Mode) -> Result<(), Error> {
        let value = match mode {
            Mode::Generic => 0,
            Mode::Text => 1,
            Mode::Font => 2,
        };
        self.set_parameter(ffi::BROTLI_PARAM_MODE, value, "mode")
    }

    /// Tell the encoder how many bytes of input to expect, which it sizes
    /// its buffers by. libbrotli reads at most 2^30.
    pub fn set_size_hint(&mut self, size: usize) -> Result<(), Error> {
        let size = u32::try_from(size.min(1 << 30)).unwrap_or(1 << 30);
        self.set_parameter(ffi::BROTLI_PARAM_SIZE_HINT, size, "size hint")
    }

    fn attach_raw(
        &mut self,
        dictionary: &PreparedDictionary<'_>,
        attached: Attached<'d>,
    ) -> Result<(), Error> {
        if self.started {
            return Err(Error::InvalidParameter("dictionary"));
        }
        // SAFETY: `state` is a live encoder and `dictionary` a live prepared
        // dictionary, which `attached`, kept in `self`, keeps alive for as
        // long as the encoder.
        let ok = unsafe {
            ffi::BrotliEncoderAttachPreparedDictionary(self.state.as_ptr(), dictionary.raw.as_ptr())
        };
        if ok != ffi::BROTLI_TRUE {
            return Err(Error::InvalidParameter("dictionary"));
        }
        self.dictionaries.push(attached);
        Ok(())
    }

    /// Attach a prepared dictionary, borrowed: the stream may then refer to
    /// it, and a decoder must have the same raw dictionary attached.
    pub fn attach(&mut self, dictionary: &'d PreparedDictionary<'d>) -> Result<(), Error> {
        self.attach_raw(dictionary, Attached::Borrowed(dictionary))
    }

    /// Attach a prepared dictionary, shared, as [`Encoder::attach`] does.
    pub fn attach_shared(
        &mut self,
        dictionary: Arc<PreparedDictionary<'static>>,
    ) -> Result<(), Error> {
        let raw = Arc::clone(&dictionary);
        self.attach_raw(&raw, Attached::Shared(dictionary))
    }

    /// Run the encoder once on `input`, which it advances past the bytes
    /// that it takes, writing into the spare capacity of `output` only.
    ///
    /// The encoder may take only part of `input`, and may have more output
    /// than fits ([`Encoder::has_more_output`]): call it again, with more
    /// room in `output`, until it has taken all the input and, for
    /// [`Operation::Flush`] and [`Operation::Finish`], emitted all the
    /// output. [`Encoder::compress_all`] does that.
    ///
    /// Once memory has run out, the encoder fails with
    /// [`Error::OutOfMemory`] for good: libbrotli does not report every
    /// failed allocation, and may have dropped input when one failed.
    pub fn compress(
        &mut self,
        operation: Operation,
        input: &mut &[u8],
        output: &mut Vec<u8>,
    ) -> Result<(), Error> {
        if self.counter.has_failed() {
            return Err(Error::OutOfMemory);
        }
        self.started = true;
        let mut available_in = input.len();
        let mut next_in = input.as_ptr();
        let spare = output.spare_capacity_mut();
        let mut available_out = spare.len();
        let mut next_out = spare.as_mut_ptr().cast::<u8>();
        // SAFETY: `state` is a live encoder. libbrotli reads at most
        // `available_in` bytes from `next_in` and writes at most
        // `available_out` bytes from `next_out`, the spare capacity of
        // `output`, and advances the pointers and decreases the counts by
        // what it read and wrote.
        let ok = unsafe {
            ffi::BrotliEncoderCompressStream(
                self.state.as_ptr(),
                operation.raw(),
                &mut available_in,
                &mut next_in,
                &mut available_out,
                &mut next_out,
                std::ptr::null_mut(),
            )
        };
        let written = spare.len() - available_out;
        // SAFETY: libbrotli wrote the first `written` bytes of the spare
        // capacity.
        unsafe { output.set_len(output.len() + written) };
        *input = &input[input.len() - available_in..];
        // libbrotli 1.2.1 takes the input even when it fails to allocate the
        // ring buffer for it, and reports success, so the failure is checked
        // here rather than trusted to `ok`.
        if self.counter.has_failed() {
            Err(Error::OutOfMemory)
        } else if ok == ffi::BROTLI_TRUE {
            Ok(())
        } else {
            Err(Error::Encoder)
        }
    }

    /// Compress all of `input` with `operation`, growing `output` as
    /// needed: for [`Operation::Process`], until the encoder has taken the
    /// input, and for the others, until it has emitted all of the output too.
    pub fn compress_all(
        &mut self,
        operation: Operation,
        mut input: &[u8],
        output: &mut Vec<u8>,
    ) -> Result<(), Error> {
        loop {
            reserve(output, 4096)?;
            self.compress(operation, &mut input, output)?;
            let done = match operation {
                Operation::Process => input.is_empty(),
                Operation::Flush => input.is_empty() && !self.has_more_output(),
                Operation::Finish => self.is_finished(),
            };
            if done {
                return Ok(());
            }
        }
    }

    /// Whether the stream has ended and all of its output been emitted.
    pub fn is_finished(&mut self) -> bool {
        // SAFETY: `state` is a live encoder.
        unsafe { ffi::BrotliEncoderIsFinished(self.state.as_ptr()) == ffi::BROTLI_TRUE }
    }

    /// Whether the encoder holds output that it has not emitted yet.
    pub fn has_more_output(&mut self) -> bool {
        // SAFETY: `state` is a live encoder.
        unsafe { ffi::BrotliEncoderHasMoreOutput(self.state.as_ptr()) == ffi::BROTLI_TRUE }
    }

    /// The bytes that libbrotli holds for the encoder, without the
    /// dictionaries attached to it.
    pub fn memory_usage(&self) -> usize {
        self.counter.get()
    }
}

impl Drop for Encoder<'_> {
    fn drop(&mut self) {
        // SAFETY: `state` came from BrotliEncoderCreateInstance and is freed
        // once, here, before the dictionaries that it refers to.
        unsafe { ffi::BrotliEncoderDestroyInstance(self.state.as_ptr()) }
    }
}

impl fmt::Debug for Encoder<'_> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Encoder")
            .field("dictionaries", &self.dictionaries.len())
            .finish_non_exhaustive()
    }
}

/// The worst-case size of the stream of `input_size` bytes compressed in one
/// [`Operation::Finish`] call, or `None` if it overflows.
pub fn max_compressed_size(input_size: usize) -> Option<usize> {
    // SAFETY: the function has no preconditions.
    let size = unsafe { ffi::BrotliEncoderMaxCompressedSize(input_size) };
    (size != 0).then_some(size)
}

/// What a call of [`Decoder::decompress`] ended with.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Status {
    /// The stream ended; the input that it has not taken follows it.
    Finished,
    /// The decoder took all the input and needs more.
    NeedsMoreInput,
    /// The decoder filled the room in the output and has more.
    NeedsMoreOutput,
}

/// A brotli decoder: libbrotli's streaming `BrotliDecoderState`, which
/// rejects the Large Window Brotli extension, as RFC 7932 does. It may hold
/// dictionaries borrowed for `'d`.
pub struct Decoder<'d> {
    state: NonNull<ffi::BrotliDecoderState>,
    dictionaries: Vec<Bytes<'d>>,
    counter: Box<Counter>,
}

// SAFETY: a BrotliDecoderState has no thread affinity, and every method
// that calls libbrotli on it takes `&mut self`, or `&self` for those that
// only read it.
unsafe impl Send for Decoder<'_> {}

impl<'d> Decoder<'d> {
    /// A new decoder.
    pub fn new() -> Result<Self, Error> {
        Self::with_counter(Box::default())
    }

    fn with_counter(counter: Box<Counter>) -> Result<Self, Error> {
        let (alloc, free) = alloc::FUNCTIONS;
        // SAFETY: the memory functions get the opaque of `counter`, which
        // `self` keeps in its box for as long as the state lives.
        let state = unsafe { ffi::BrotliDecoderCreateInstance(alloc, free, counter.opaque()) };
        let decoder = Self {
            state: NonNull::new(state).ok_or(Error::OutOfMemory)?,
            dictionaries: Vec::new(),
            counter,
        };
        // libbrotli's default, made explicit: a large-window stream fails.
        // SAFETY: `state` is a live decoder that has not started.
        unsafe {
            ffi::BrotliDecoderSetParameter(
                decoder.state.as_ptr(),
                ffi::BROTLI_DECODER_PARAM_LARGE_WINDOW,
                0,
            );
        }
        Ok(decoder)
    }

    fn attach_bytes(&mut self, bytes: Bytes<'d>) -> Result<(), Error> {
        let data = bytes.as_slice();
        // SAFETY: `state` is a live decoder, and `data` stays valid and in
        // place for as long as `self` holds `bytes`: libbrotli keeps a
        // pointer to it.
        let ok = unsafe {
            ffi::BrotliDecoderAttachDictionary(
                self.state.as_ptr(),
                ffi::BROTLI_SHARED_DICTIONARY_RAW,
                data.len(),
                data.as_ptr(),
            )
        };
        if ok != ffi::BROTLI_TRUE {
            return Err(Error::InvalidDictionary);
        }
        self.dictionaries.push(bytes);
        Ok(())
    }

    /// Attach a raw dictionary, borrowed, before the decoder starts.
    pub fn attach(&mut self, dictionary: &'d [u8]) -> Result<(), Error> {
        self.attach_bytes(Bytes::Borrowed(dictionary))
    }

    /// Attach a raw dictionary, shared, before the decoder starts.
    pub fn attach_shared(&mut self, dictionary: Arc<[u8]>) -> Result<(), Error> {
        self.attach_bytes(Bytes::Shared(dictionary))
    }

    /// Run the decoder once on `input`, which it advances past the bytes
    /// that it takes, writing into the spare capacity of `output` only.
    ///
    /// On an error, the decoder is done: later calls fail with it too.
    pub fn decompress(&mut self, input: &mut &[u8], output: &mut Vec<u8>) -> Result<Status, Error> {
        let mut available_in = input.len();
        let mut next_in = input.as_ptr();
        let spare = output.spare_capacity_mut();
        let mut available_out = spare.len();
        let mut next_out = spare.as_mut_ptr().cast::<u8>();
        // SAFETY: as in `Encoder::compress`, for a live decoder.
        let result = unsafe {
            ffi::BrotliDecoderDecompressStream(
                self.state.as_ptr(),
                &mut available_in,
                &mut next_in,
                &mut available_out,
                &mut next_out,
                std::ptr::null_mut(),
            )
        };
        let written = spare.len() - available_out;
        // SAFETY: libbrotli wrote the first `written` bytes of the spare
        // capacity.
        unsafe { output.set_len(output.len() + written) };
        *input = &input[input.len() - available_in..];
        match result {
            ffi::BROTLI_DECODER_RESULT_SUCCESS => Ok(Status::Finished),
            ffi::BROTLI_DECODER_RESULT_NEEDS_MORE_INPUT => Ok(Status::NeedsMoreInput),
            ffi::BROTLI_DECODER_RESULT_NEEDS_MORE_OUTPUT => Ok(Status::NeedsMoreOutput),
            ffi::BROTLI_DECODER_RESULT_ERROR => Err(self.error()),
            _ => Err(Error::decoder(0)),
        }
    }

    /// The error that the decoder failed with.
    fn error(&self) -> Error {
        // SAFETY: `state` is a live decoder.
        Error::decoder(unsafe { ffi::BrotliDecoderGetErrorCode(self.state.as_ptr()) })
    }

    /// Whether the stream has ended and all of its output been emitted.
    pub fn is_finished(&self) -> bool {
        // SAFETY: `state` is a live decoder.
        unsafe { ffi::BrotliDecoderIsFinished(self.state.as_ptr()) == ffi::BROTLI_TRUE }
    }

    /// The bytes that libbrotli holds for the decoder, without the
    /// dictionaries attached to it.
    pub fn memory_usage(&self) -> usize {
        self.counter.get()
    }
}

impl Drop for Decoder<'_> {
    fn drop(&mut self) {
        // SAFETY: `state` came from BrotliDecoderCreateInstance and is freed
        // once, here, before the dictionaries that it refers to.
        unsafe { ffi::BrotliDecoderDestroyInstance(self.state.as_ptr()) }
    }
}

impl fmt::Debug for Decoder<'_> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Decoder")
            .field("dictionaries", &self.dictionaries.len())
            .finish_non_exhaustive()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Text of `len` bytes that compresses, but not trivially.
    fn text(len: usize) -> Vec<u8> {
        (0..len)
            .map(|i| b"comprs compresses brotli with libbrotli "[i % 40] ^ (i / 997) as u8)
            .collect()
    }

    // The build defines BROTLI_ENCODER_CLEANUP_ON_OOM: without it, the
    // encoder would end the process here.
    #[test]
    fn an_encoder_that_runs_out_of_memory_fails() {
        let mut encoder = Encoder::with_counter(Box::new(Counter::limited(256 * 1024))).unwrap();
        encoder.set_quality(11).unwrap();
        let mut output = Vec::new();
        let result = encoder.compress_all(Operation::Finish, &text(1 << 20), &mut output);
        assert_eq!(result, Err(Error::OutOfMemory));
        let result = encoder.compress(Operation::Finish, &mut &b""[..], &mut output);
        assert_eq!(result, Err(Error::OutOfMemory));
    }

    #[test]
    fn a_decoder_that_runs_out_of_memory_fails() {
        let input = text(1 << 20);
        let mut encoder = Encoder::new().unwrap();
        encoder.set_quality(1).unwrap();
        let mut compressed = Vec::new();
        encoder
            .compress_all(Operation::Finish, &input, &mut compressed)
            .unwrap();
        let mut decoder = Decoder::with_counter(Box::new(Counter::limited(64 * 1024))).unwrap();
        let mut output = Vec::with_capacity(input.len());
        let err = decoder
            .decompress(&mut &compressed[..], &mut output)
            .unwrap_err();
        assert!(err.is_out_of_memory(), "{err:?}");
    }
}
