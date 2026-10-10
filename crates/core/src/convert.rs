//! Conversion of the output of comprs-core into the `Buffer`s and the
//! `Uint8Array`s that the bindings return.

use std::ptr;

use comprs_core::ComprsError;
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
/// with glibc. Other allocators, such as musl's mallocng and the Windows
/// heap, serve large blocks from fresh mappings, and were not measured.
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
