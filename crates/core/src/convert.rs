//! Conversion of the output of comprs-core into the `Buffer`s and the
//! `Uint8Array`s that the bindings return.

use std::cell::Cell;
use std::ptr::{self, NonNull};

use comprs_core::ComprsError;
use comprs_core::zstd::{Decoded, WriteBuf};
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
/// The zstd functions decode frames that declare their content sizes into
/// memory that V8 allocates instead, which needs no copy, up to
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

/// Largest output, in bytes, that the synchronous zstd functions decode
/// straight into memory that V8 allocates (see [`sync_decoded`]): `None`
/// for any size, which all builds but the musl builds take.
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

/// Return the result of a synchronous zstd decompression as a `Buffer`, or
/// its error as the error to throw. `decode` decodes with one of the
/// `*_into` functions of `comprs_core::zstd`, passing on the allocator that
/// it gets.
///
/// The output of frames that declare their content sizes is decoded
/// straight into a `Buffer` that V8 allocates, up to
/// [`DIRECT_DECODE_LIMIT`]: unlike [`sync_result`], this needs no copy, and
/// results larger than [`SYNC_COPY_LIMIT`] are freed as soon as V8 collects
/// them too (#679). Other output is returned as [`sync_result`] returns it.
pub(crate) fn sync_decoded(
    env: &Env,
    decode: impl FnOnce(
        &dyn Fn(usize) -> Result<ZstdOutput, ComprsError>,
    ) -> Result<Decoded<ZstdOutput>, ComprsError>,
) -> napi::Result<Buffer> {
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
                    context: "zstd decompress",
                    source: err.into(),
                })?;
            return Ok(ZstdOutput::Addon(output));
        }
        V8Buffer::new(env, size).map(ZstdOutput::V8).map_err(|err| {
            allocation_error.set(Some(err));
            ComprsError::Operation {
                context: "zstd decompress",
                source: "failed to allocate the output".into(),
            }
        })
    };
    match decode(&allocate) {
        Ok(Decoded::Allocated(ZstdOutput::V8(output))) => output.into_buffer(env),
        Ok(Decoded::Allocated(ZstdOutput::Addon(output)) | Decoded::Grown(output)) => {
            to_buffer(env, output, SYNC_COPY_LIMIT)
        }
        Err(err) => Err(allocation_error
            .take()
            .unwrap_or_else(|| to_napi_error(err))),
    }
}

/// The memory that [`sync_decoded`] decodes the output of frames with
/// content sizes into.
pub(crate) enum ZstdOutput {
    /// Memory that V8 allocates, up to [`DIRECT_DECODE_LIMIT`].
    V8(V8Buffer),
    /// The addon's memory, reserved for the whole output, for larger output.
    Addon(Vec<u8>),
}

// SAFETY: each variant upholds the contract of `WriteBuf` itself, and every
// method passes the call on to the same variant.
unsafe impl WriteBuf for ZstdOutput {
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

/// A new `Buffer` that V8 allocates, which a zstd decoder writes into
/// through [`WriteBuf`] before JavaScript code can reach it.
pub(crate) struct V8Buffer {
    value: sys::napi_value,
    memory: NonNull<u8>,
    capacity: usize,
    len: usize,
}

impl V8Buffer {
    /// A `Buffer` of `size` bytes, of which none is written yet.
    fn new(env: &Env, size: usize) -> napi::Result<Self> {
        let mut memory = ptr::null_mut();
        let mut value = ptr::null_mut();
        // SAFETY: `env` is the environment of the current call, and the
        // pointers are to locals.
        check_status!(unsafe {
            sys::napi_create_buffer(env.raw(), size, &mut memory, &mut value)
        })?;
        // Node-API does not promise memory for an empty `Buffer`.
        let memory = match NonNull::new(memory.cast::<u8>()) {
            Some(memory) => memory,
            None if size == 0 => NonNull::dangling(),
            None => {
                return Err(napi::Error::new(
                    napi::Status::GenericFailure,
                    "napi_create_buffer returned no memory",
                ));
            }
        };
        Ok(Self {
            value,
            memory,
            capacity: size,
            len: 0,
        })
    }

    /// The `Buffer`, which must be written in full: its unwritten memory
    /// would show JavaScript code what that memory held before.
    fn into_buffer(self, env: &Env) -> napi::Result<Buffer> {
        if self.len != self.capacity {
            return Err(napi::Error::new(
                napi::Status::GenericFailure,
                format!(
                    "zstd decompress wrote {} of the {} bytes that the frames declare",
                    self.len, self.capacity
                ),
            ));
        }
        // SAFETY: `value` is a `Buffer` of the current call's environment,
        // which the handle scope of the call keeps alive.
        unsafe { Buffer::from_napi_value(env.raw(), self.value) }
    }
}

// SAFETY: `memory` starts the `capacity` bytes of the `Buffer`, which stay
// allocated while the call's handle scope holds `value`, and no other code
// reads or writes them before `into_buffer` hands the `Buffer` to
// JavaScript. `len` counts the bytes from the start that a decoder has
// written, as `filled_until` tells.
unsafe impl WriteBuf for V8Buffer {
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
    let env = env.raw();
    let mut memory = ptr::null_mut();
    let mut buffer = ptr::null_mut();
    let mut array = ptr::null_mut();
    // SAFETY: `env` is the environment of the current call, and the
    // pointers are to locals.
    check_status!(unsafe {
        sys::napi_create_arraybuffer(env, data.len(), &mut memory, &mut buffer)
    })?;
    if memory.is_null() {
        return Err(napi::Error::new(
            napi::Status::GenericFailure,
            "napi_create_arraybuffer returned no memory",
        ));
    }
    // SAFETY: `memory` is not null and starts the `data.len()` bytes of the
    // new `buffer`, which no JavaScript code can reach yet and which cannot
    // overlap `data`. `env` is the environment of the current call, and
    // `array` is then a Uint8Array over all of `buffer`, as
    // `Uint8Array::from_napi_value` requires.
    unsafe {
        ptr::copy_nonoverlapping(data.as_ptr(), memory.cast::<u8>(), data.len());
        check_status!(sys::napi_create_typedarray(
            env,
            sys::TypedarrayType::uint8_array,
            data.len(),
            buffer,
            0,
            &mut array
        ))?;
        Uint8Array::from_napi_value(env, array)
    }
}
