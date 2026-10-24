//! Conversion of the output of comprs-core into the `Buffer`s and the
//! `Uint8Array`s that the bindings return.

use std::cell::Cell;
use std::marker::PhantomData;
use std::ptr::{self, NonNull};

use comprs_core::ComprsError;
use comprs_core::output::{Decoded, Output};
use comprs_core::zstd::WriteBuf;
use napi::bindgen_prelude::{Buffer, BufferSlice, Env, FromNapiValue, Uint8Array};
use napi::{check_status, sys};

use crate::error::to_napi_error;

/// Largest result, in bytes, that the synchronous functions and the methods
/// of the stream contexts return in memory that V8 allocates.
///
/// `Buffer::from(Vec<u8>)`, like `Uint8Array::from(Vec<u8>)`, hands the
/// memory of the `Vec` to JavaScript as an external buffer. Node.js frees
/// that memory only on a later turn of the event loop, even once V8 has
/// collected the Buffer, so a synchronous loop gets none of it back and
/// page-faults fresh memory on every call (#560). Node.js also marks
/// external buffers as untransferable, so such a result cannot be
/// transferred to a worker there (`DataCloneError`). A copy into memory
/// that V8 allocates frees the `Vec` at once, and V8 frees the copy as soon
/// as it collects it.
///
/// The copy takes about 0.1 ms per MiB. A synchronous loop saves more than
/// that in page faults, measured with glibc for results of up to 16 MiB; at
/// 64 MiB, which glibc maps with mmap() every time, the copy doubles the
/// faults instead. A program that yields to the event loop between calls,
/// as a server does, gets the memory of external buffers back and reuses
/// it, though, so for it the copy is mostly extra work: it costs nothing
/// for results of up to 2 MiB, while calls that return 4 MiB take 30%
/// longer, 8 MiB 70% and 16 MiB 2.7 times as long.
///
/// These figures, and so the limit, come from Node.js 22 on x86-64 Linux
/// with glibc. musl's mallocng, which Node.js uses on musl, serves blocks
/// above 128 KiB from fresh mappings, so there the copy makes calls that
/// return 128 KiB to 2 MiB take 1.2–1.5 times as long, with mimalloc for the
/// addon's own memory (see lib.rs; 1.5–2 times without it), measured with
/// Node.js 24 on x86-64 Alpine Linux. It still keeps a synchronous loop
/// that gets results of 1 MiB at a quarter of the memory, and is kept for
/// that (#679). The Windows heap was not measured.
/// `scripts/bench-result-memory.mjs` repeats these measurements.
///
/// The zstd and LZ4 functions decode frames that declare their content
/// sizes into memory that V8 allocates instead, which needs no copy, up to
/// [`DIRECT_DECODE_LIMIT`] (see [`sync_decoded`]).
///
/// `src/streams.ts` mirrors this value: the Web streams enqueue the results
/// of the stream contexts up to this size without copying them again.
pub(crate) const SYNC_COPY_LIMIT: usize = 2 << 20;

/// Largest result, in bytes, that the asynchronous methods of the stream
/// contexts, such as `transformAsync()`, return in memory that V8
/// allocates, for the reasons that [`SYNC_COPY_LIMIT`] gives. The copy runs
/// on the JavaScript thread, when the Promise settles.
///
/// `src/streams.ts` mirrors the smaller of this value and
/// [`SYNC_COPY_LIMIT`].
pub(crate) const ASYNC_STREAM_COPY_LIMIT: usize = SYNC_COPY_LIMIT;

/// Return `data` as a `Buffer`: a copy in memory that V8 allocates if `data`
/// holds at most `limit` bytes, which frees `data` right away, and `data`
/// itself as an external buffer otherwise.
pub(crate) fn to_buffer(env: &Env, data: Vec<u8>, limit: usize) -> napi::Result<Buffer> {
    // napi-rs creates an empty Buffer in V8's memory for an empty `Vec`.
    if data.is_empty() || data.len() > limit {
        return Ok(Buffer::from(data));
    }
    BufferSlice::copy_from(env, &data)?.into_buffer(env)
}

/// Return the result of a synchronous call as a `Buffer`, copied into
/// memory that V8 allocates up to [`SYNC_COPY_LIMIT`], or its error as the
/// error to throw.
pub(crate) fn sync_result(env: &Env, result: Result<Vec<u8>, ComprsError>) -> napi::Result<Buffer> {
    to_buffer(env, result.map_err(to_napi_error)?, SYNC_COPY_LIMIT)
}

/// Largest output, in bytes, that the synchronous zstd and LZ4 functions
/// decode straight into memory that V8 allocates (see [`sync_decoded`]):
/// `None` for any size, which all builds but the musl builds take.
///
/// Decoding into V8's memory needs no copy, so up to [`SYNC_COPY_LIMIT`] it
/// is faster than the copy everywhere. Above it, V8 frees a result as soon
/// as it collects it, so a synchronous loop that gets results of 4 MiB
/// grows the resident set by 8 MiB instead of 800 MiB, and runs 3 times as
/// fast, on glibc and musl alike. Elsewhere V8 allocates from the same heap
/// as the addon, so a program that yields to the event loop between calls
/// loses nothing either (Node.js 22 on x86-64 glibc Linux: as fast at
/// 16 MiB and 64 MiB, faster below). In the musl builds, though, the addon
/// allocates with mimalloc (see lib.rs), which reuses the memory of the
/// results that the event loop frees, while musl's mallocng, which V8 uses,
/// maps fresh memory for every block: there, calls that return 4 to 16 MiB
/// took 3 times as long in a yielding loop, measured with Node.js 24 on
/// x86-64 Alpine Linux, so larger results stay in the addon's memory, as
/// [`SYNC_COPY_LIMIT`] chooses for the copy (#679).
#[cfg(not(target_env = "musl"))]
pub(crate) const DIRECT_DECODE_LIMIT: Option<usize> = None;
#[cfg(target_env = "musl")]
pub(crate) const DIRECT_DECODE_LIMIT: Option<usize> = Some(SYNC_COPY_LIMIT);

/// Return the result of a synchronous decompression as a `K::Value`, a
/// `Buffer` or a plain `Uint8Array`, or its error as the error to throw:
/// that of a failed allocation, or `map_err` of the error of comprs-core.
/// `decode` decodes with one of the `*_into` functions of comprs-core, such
/// as `comprs_core::zstd::decompress_into`, passing on the allocator that it
/// gets. `context` names the operation in the error of an allocation in the
/// addon's memory that fails.
///
/// The output of frames that declare their content sizes is decoded
/// straight into memory that V8 allocates, up to [`DIRECT_DECODE_LIMIT`]:
/// unlike [`sync_result`], this needs no copy, and results larger than
/// [`SYNC_COPY_LIMIT`] are freed as soon as V8 collects them too (#679).
/// Other output is returned as [`V8Kind::from_vec`] returns it.
pub(crate) fn sync_decoded<K: V8Kind>(
    env: &Env,
    decode: impl FnOnce(
        &dyn Fn(usize) -> Result<DirectOutput<K>, ComprsError>,
    ) -> Result<Decoded<DirectOutput<K>>, ComprsError>,
    map_err: impl FnOnce(ComprsError) -> napi::Error,
    context: &'static str,
) -> napi::Result<K::Value> {
    // A failed allocation leaves a pending JavaScript exception, such as
    // `ERR_BUFFER_TOO_LARGE`, which the error of napi-rs keeps rather than
    // the error of comprs-core that stands in for it.
    let allocation_error = Cell::new(None);
    let allocate = |size| {
        if DIRECT_DECODE_LIMIT.is_some_and(|limit| size > limit) {
            let mut output = Vec::new();
            output
                .try_reserve_exact(size)
                .map_err(|err| ComprsError::Operation {
                    context,
                    source: err.into(),
                })?;
            return Ok(DirectOutput::Addon(output));
        }
        V8Memory::new(env, size)
            .map(DirectOutput::V8)
            .map_err(|err| {
                allocation_error.set(Some(err));
                ComprsError::Operation {
                    context,
                    source: "failed to allocate the output".into(),
                }
            })
    };
    match decode(&allocate) {
        Ok(Decoded::Allocated(DirectOutput::V8(output))) => output.finish(env),
        Ok(Decoded::Allocated(DirectOutput::Addon(output)) | Decoded::Grown(output)) => {
            K::from_vec(env, output, SYNC_COPY_LIMIT)
        }
        Err(err) => Err(allocation_error.take().unwrap_or_else(|| map_err(err))),
    }
}

/// The memory that [`sync_decoded`] decodes the output of frames with
/// content sizes into.
pub(crate) enum DirectOutput<K> {
    /// Memory that V8 allocates, up to [`DIRECT_DECODE_LIMIT`].
    V8(V8Memory<K>),
    /// The addon's memory, reserved for the whole output, for larger output.
    Addon(Vec<u8>),
}

// SAFETY: each variant upholds the contract of `WriteBuf` itself, and every
// method passes the call on to the same variant.
unsafe impl<K> WriteBuf for DirectOutput<K> {
    fn as_slice(&self) -> &[u8] {
        match self {
            Self::V8(output) => output.as_slice(),
            Self::Addon(output) => output.as_slice(),
        }
    }

    fn capacity(&self) -> usize {
        match self {
            Self::V8(output) => output.capacity(),
            Self::Addon(output) => output.capacity(),
        }
    }

    fn as_mut_ptr(&mut self) -> *mut u8 {
        match self {
            Self::V8(output) => output.as_mut_ptr(),
            Self::Addon(output) => output.as_mut_ptr(),
        }
    }

    unsafe fn filled_until(&mut self, n: usize) {
        // SAFETY: the caller promises that the first `n` bytes are written.
        unsafe {
            match self {
                Self::V8(output) => output.filled_until(n),
                Self::Addon(output) => output.filled_until(n),
            }
        }
    }
}

impl<K> Output for DirectOutput<K> {
    fn filled(&self) -> &[u8] {
        match self {
            Self::V8(output) => output.filled(),
            Self::Addon(output) => output.filled(),
        }
    }

    fn try_reserve(
        &mut self,
        additional: usize,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        match self {
            Self::V8(output) => output.try_reserve(additional),
            Self::Addon(output) => Output::try_reserve(output, additional),
        }
    }

    fn extend_from_slice(&mut self, bytes: &[u8]) {
        match self {
            Self::V8(output) => output.extend_from_slice(bytes),
            Self::Addon(output) => output.extend_from_slice(bytes),
        }
    }
}

/// The kind of JavaScript value that bytes in memory that V8 allocates
/// become: [`BufferKind`] for the classic API, which returns `Buffer`s, and
/// [`Uint8ArrayKind`] for the unified API, which returns plain
/// `Uint8Array`s.
pub(crate) trait V8Kind {
    /// The value.
    type Value;

    /// Allocate `size` bytes, of which none is initialized yet: their
    /// memory, null only if `size` is 0, and a handle to what holds them.
    fn allocate(env: &Env, size: usize) -> napi::Result<(*mut u8, sys::napi_value)>;

    /// The value over all the bytes of `handle`, which [`V8Kind::allocate`]
    /// returned for `size` bytes, every one of which is written.
    fn finish(env: &Env, handle: sys::napi_value, size: usize) -> napi::Result<Self::Value>;

    /// `data` as the value: a copy in memory that V8 allocates if `data`
    /// holds at most `limit` bytes, which frees `data` right away, and
    /// `data` itself as an external buffer otherwise.
    fn from_vec(env: &Env, data: Vec<u8>, limit: usize) -> napi::Result<Self::Value>;
}

/// A `Buffer`, from `napi_create_buffer`, which does not zero-fill it.
pub(crate) enum BufferKind {}

impl V8Kind for BufferKind {
    type Value = Buffer;

    fn allocate(env: &Env, size: usize) -> napi::Result<(*mut u8, sys::napi_value)> {
        let mut memory = ptr::null_mut();
        let mut value = ptr::null_mut();
        // SAFETY: `env` is the environment of the current call, and the
        // pointers are to locals.
        check_status!(unsafe {
            sys::napi_create_buffer(env.raw(), size, &mut memory, &mut value)
        })?;
        Ok((memory.cast(), value))
    }

    fn finish(env: &Env, handle: sys::napi_value, _size: usize) -> napi::Result<Buffer> {
        // SAFETY: `handle` is a `Buffer` of the current call's environment,
        // which the handle scope of the call keeps alive.
        unsafe { Buffer::from_napi_value(env.raw(), handle) }
    }

    fn from_vec(env: &Env, data: Vec<u8>, limit: usize) -> napi::Result<Buffer> {
        to_buffer(env, data, limit)
    }
}

/// A plain `Uint8Array` over an `ArrayBuffer` of its own.
///
/// The `ArrayBuffer` is that of a `Buffer` from `napi_create_buffer`, which
/// does not zero-fill it, as `napi_create_arraybuffer` does: zero-filling
/// made `decompressSync()` of 4 MiB of zstd output take a third longer. Node.js
/// allocates such a `Buffer` an `ArrayBuffer` of exactly its size, outside
/// the pool of `Buffer.allocUnsafe()`, and the `Buffer` itself is left to
/// the garbage collector.
pub(crate) enum Uint8ArrayKind {}

impl V8Kind for Uint8ArrayKind {
    type Value = Uint8Array;

    fn allocate(env: &Env, size: usize) -> napi::Result<(*mut u8, sys::napi_value)> {
        let (memory, buffer) = BufferKind::allocate(env, size)?;
        let mut kind = sys::TypedarrayType::uint8_array;
        let mut length = 0;
        let mut data = ptr::null_mut();
        let mut array_buffer = ptr::null_mut();
        let mut offset = 0;
        // SAFETY: `env` is the environment of the current call, `buffer` a
        // `Buffer` of it, and the pointers are to locals.
        check_status!(unsafe {
            sys::napi_get_typedarray_info(
                env.raw(),
                buffer,
                &mut kind,
                &mut length,
                &mut data,
                &mut array_buffer,
                &mut offset,
            )
        })?;
        let mut whole = ptr::null_mut();
        let mut whole_length = 0;
        // SAFETY: as above, for the `ArrayBuffer` of `buffer`.
        check_status!(unsafe {
            sys::napi_get_arraybuffer_info(env.raw(), array_buffer, &mut whole, &mut whole_length)
        })?;
        if length != size || offset != 0 || whole_length != size {
            return Err(napi::Error::new(
                napi::Status::GenericFailure,
                "napi_create_buffer returned a Buffer that does not start its ArrayBuffer",
            ));
        }
        Ok((memory, array_buffer))
    }

    fn finish(env: &Env, handle: sys::napi_value, size: usize) -> napi::Result<Uint8Array> {
        let mut array = ptr::null_mut();
        // SAFETY: `env` is the environment of the current call, `handle` an
        // `ArrayBuffer` of `size` bytes of it, and `array` then a Uint8Array
        // over all of it, as `Uint8Array::from_napi_value` requires.
        unsafe {
            check_status!(sys::napi_create_typedarray(
                env.raw(),
                sys::TypedarrayType::uint8_array,
                size,
                handle,
                0,
                &mut array
            ))?;
            Uint8Array::from_napi_value(env.raw(), array)
        }
    }

    fn from_vec(env: &Env, data: Vec<u8>, limit: usize) -> napi::Result<Uint8Array> {
        to_uint8array(env, data, limit)
    }
}

/// New memory that V8 allocates for a value of kind `K`, which a decoder
/// writes into, through [`WriteBuf`] or [`Output`], before JavaScript code
/// can reach it.
pub(crate) struct V8Memory<K> {
    handle: sys::napi_value,
    memory: NonNull<u8>,
    capacity: usize,
    len: usize,
    kind: PhantomData<K>,
}

impl<K: V8Kind> V8Memory<K> {
    /// `size` bytes, of which none is written yet.
    fn new(env: &Env, size: usize) -> napi::Result<Self> {
        let (memory, handle) = K::allocate(env, size)?;
        // Node-API does not promise memory for no bytes.
        let memory = match NonNull::new(memory) {
            Some(memory) => memory,
            None if size == 0 => NonNull::dangling(),
            None => {
                return Err(napi::Error::new(
                    napi::Status::GenericFailure,
                    "Node-API returned no memory",
                ));
            }
        };
        Ok(Self {
            handle,
            memory,
            capacity: size,
            len: 0,
            kind: PhantomData,
        })
    }

    /// The value, whose bytes must be written in full: its unwritten memory
    /// would show JavaScript code what that memory held before.
    fn finish(self, env: &Env) -> napi::Result<K::Value> {
        if self.len != self.capacity {
            return Err(napi::Error::new(
                napi::Status::GenericFailure,
                format!(
                    "decompress wrote {} of the {} bytes that the frames declare",
                    self.len, self.capacity
                ),
            ));
        }
        K::finish(env, self.handle, self.capacity)
    }
}

// SAFETY: `memory` starts the `capacity` bytes that `handle` holds, which
// stay allocated while the call's handle scope holds `handle`, and no other
// code reads or writes them before `finish` hands them to JavaScript. `len`
// counts the bytes from the start that a decoder has written, as
// `filled_until` tells.
unsafe impl<K> WriteBuf for V8Memory<K> {
    fn as_slice(&self) -> &[u8] {
        // SAFETY: the first `len` bytes are written, as above.
        unsafe { std::slice::from_raw_parts(self.memory.as_ptr(), self.len) }
    }

    fn capacity(&self) -> usize {
        self.capacity
    }

    fn as_mut_ptr(&mut self) -> *mut u8 {
        self.memory.as_ptr()
    }

    unsafe fn filled_until(&mut self, n: usize) {
        self.len = n;
    }
}

impl<K> Output for V8Memory<K> {
    fn filled(&self) -> &[u8] {
        self.as_slice()
    }

    fn try_reserve(
        &mut self,
        additional: usize,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        if additional > self.capacity - self.len {
            return Err("the output has no room for the content".into());
        }
        Ok(())
    }

    fn extend_from_slice(&mut self, bytes: &[u8]) {
        assert!(
            bytes.len() <= self.capacity - self.len,
            "the output has no room for the content"
        );
        // SAFETY: the `bytes.len()` bytes from `len` on are within the
        // memory, as checked, and `bytes` cannot overlap them: it is borrowed
        // while `self` is borrowed mutably. They are written then, so `len`
        // may count them.
        unsafe {
            ptr::copy_nonoverlapping(
                bytes.as_ptr(),
                self.memory.as_ptr().add(self.len),
                bytes.len(),
            );
        }
        self.len += bytes.len();
    }
}

/// Return `data` as a plain `Uint8Array`: a copy in memory that V8
/// allocates if `data` holds at most `limit` bytes, which frees `data` right
/// away, and `data` itself as an external buffer otherwise.
pub(crate) fn to_uint8array(env: &Env, data: Vec<u8>, limit: usize) -> napi::Result<Uint8Array> {
    if data.len() > limit {
        return Ok(Uint8Array::from(data));
    }
    copy_to_v8(env, &data)
}

/// A new `Uint8Array` that holds a copy of `data` in an `ArrayBuffer` of its
/// own that V8 allocates.
///
/// napi-rs 3.14's `Uint8ArraySlice::copy_from` creates such an array without
/// copying the data into it, which leaves it zero-filled, so this function
/// calls Node-API itself. (`BufferSlice::copy_from`, which [`to_buffer`]
/// uses, calls `napi_create_buffer_copy` and does copy.)
fn copy_to_v8(env: &Env, data: &[u8]) -> napi::Result<Uint8Array> {
    // Node-API does not promise memory for an empty `ArrayBuffer`, and a
    // copy to a null pointer is undefined behavior even for no bytes. For
    // an empty `Vec`, napi-rs creates an empty array in V8's memory without
    // copying.
    if data.is_empty() {
        return Ok(Uint8Array::from(Vec::new()));
    }
    let mut output = V8Memory::<Uint8ArrayKind>::new(env, data.len())?;
    // SAFETY: the memory of `output` has room for `data.len()` bytes, which
    // no JavaScript code can reach yet and which cannot overlap `data`; the
    // copy writes all of them.
    unsafe {
        ptr::copy_nonoverlapping(data.as_ptr(), output.as_mut_ptr(), data.len());
        output.filled_until(data.len());
    }
    output.finish(env)
}
