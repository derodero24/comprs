//! Conversion of the output of comprs-core into the `Buffer`s that the
//! bindings return.

use comprs_core::ComprsError;
use napi::bindgen_prelude::{Buffer, BufferSlice, Env};

use crate::error::to_napi_error;

/// Largest result, in bytes, that the synchronous functions and the methods
/// of the stream contexts return in memory that V8 allocates.
///
/// `Buffer::from(Vec<u8>)` hands the memory of the `Vec` to JavaScript as an
/// external buffer. Node.js frees that memory only on a later turn of the
/// event loop, even once V8 has collected the Buffer, so a synchronous loop
/// gets none of it back and page-faults fresh memory on every call (#560).
/// V8 cannot detach external memory either, so such a result cannot be
/// transferred to a worker. A copy into memory that V8 allocates frees the
/// `Vec` at once, and V8 frees the copy as soon as it collects it.
///
/// The copy takes about 0.1 ms per MiB. A synchronous loop saves more than
/// that in page faults, measured with glibc for results of up to 16 MiB; at
/// 64 MiB, which glibc maps with mmap() every time, the copy doubles the
/// faults instead. A program that yields to the event loop between calls,
/// as a server does, gets the memory of external buffers back and reuses
/// it, though, so for it the copy is mostly extra work: it costs nothing
/// for results of up to 2 MiB, while calls that return 4 MiB take 30%
/// longer, 8 MiB 70% and 16 MiB 2.7 times as long.
pub(crate) const SYNC_COPY_LIMIT: usize = 2 << 20;

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
