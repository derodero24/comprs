//! LZ4 frame streaming compression and decompression.

use napi::bindgen_prelude::*;
use napi_derive::napi;

use crate::context::{NativeState, stream_context_methods};
use crate::error::to_napi_error;
use crate::options::stream_context_options;

/// Streaming LZ4 frame compression context.
///
/// Compresses into independent blocks of up to 64 KiB and returns the
/// output of each block once the block is complete; `flush()` completes the
/// current block early. The frame carries a content checksum, as the `lz4`
/// CLI writes by default.
#[napi(custom_finalize)]
pub struct Lz4CompressContext {
    inner: NativeState<comprs_core::lz4_stream::CompressContext>,
}

#[napi]
impl Lz4CompressContext {
    #[napi(constructor)]
    pub fn new(env: Env) -> Result<Self> {
        Ok(Self {
            inner: NativeState::new(
                &env,
                comprs_core::lz4_stream::CompressContext::new(),
                "lz4 stream",
            ),
        })
    }

    /// Compress a chunk of data. Returns any compressed output produced so far.
    #[napi]
    pub fn transform(&mut self, env: Env, chunk: Either<Buffer, Uint8Array>) -> Result<Buffer> {
        self.inner
            .call(&env, |ctx| ctx.transform(crate::as_bytes(&chunk)))
    }

    /// Flush the encoder's internal buffer. Returns any buffered compressed data.
    #[napi]
    pub fn flush(&mut self, env: Env) -> Result<Buffer> {
        self.inner.call(&env, |ctx| ctx.flush())
    }

    /// Finalize the compression stream. Writes the LZ4 frame footer.
    /// Must be called once after all data has been transformed.
    #[napi]
    pub fn finish(&mut self, env: Env) -> Result<Buffer> {
        self.inner.call_finish(&env, |ctx| ctx.finish())
    }
}

stream_context_methods!(Lz4CompressContext, comprs_core::lz4_stream::CompressContext);

/// Streaming LZ4 frame decompression context.
///
/// The input may hold several concatenated frames, including skippable and
/// legacy frames. The context works in one of two modes:
///
/// - By default, it buffers its input: `transform()` keeps each chunk and
///   returns an empty buffer, and `flush()` decodes what has been kept since
///   the last `flush()`, which must end between frames. `maxOutputSize`
///   limits the output of each `flush()` on its own, not of the whole stream.
/// - With `{ incremental: true }`, it decodes its input as it arrives:
///   `transform()` returns the content of each block once all of the block
///   has arrived, and throws as soon as the input is invalid; `flush()`
///   returns an empty buffer; `finish()` throws if the input did not end
///   between frames. `maxOutputSize` limits the output of the whole stream,
///   and the context keeps at most one block of input. The stream helpers
///   use this mode.
#[napi(custom_finalize)]
pub struct Lz4DecompressContext {
    inner: NativeState<comprs_core::lz4_stream::DecompressContext>,
}

#[napi]
impl Lz4DecompressContext {
    /// `maxOutputSize` defaults to 256 MB. `options.incremental` selects the
    /// incremental mode; `options` must be an object, `undefined` or `null`.
    #[napi(
        constructor,
        ts_args_type = "maxOutputSize?: number | undefined | null, options?: StreamContextOptions | undefined | null"
    )]
    pub fn new(env: Env, max_output_size: Option<f64>, options: Option<Unknown>) -> Result<Self> {
        let context = if stream_context_options(options)? {
            comprs_core::lz4_stream::DecompressContext::incremental(max_output_size)
        } else {
            comprs_core::lz4_stream::DecompressContext::new(max_output_size)
        };
        Ok(Self {
            inner: NativeState::new(&env, context.map_err(to_napi_error)?, "lz4 stream"),
        })
    }

    /// Take a chunk of compressed data. By default, keep it and return an
    /// empty buffer: the output comes from `flush()`. Incremental, return the
    /// content of the blocks that the chunk completes, and throw if the
    /// input is invalid or the output exceeds `maxOutputSize`.
    #[napi]
    pub fn transform(&mut self, env: Env, chunk: Either<Buffer, Uint8Array>) -> Result<Buffer> {
        self.inner
            .call(&env, |ctx| ctx.transform(crate::as_bytes(&chunk)))
    }

    /// By default, decompress all buffered data and return the result, with
    /// at most `maxOutputSize` bytes. Throws if no compressed data was
    /// transformed at all, if the input ends inside a frame, or if data that
    /// is not a frame follows a frame. Incremental, return an empty buffer.
    #[napi]
    pub fn flush(&mut self, env: Env) -> Result<Buffer> {
        self.inner.call(&env, |ctx| ctx.flush())
    }

    /// Finalize the decompression stream, then release the native state.
    /// By default, decompress the data buffered since the last `flush()`,
    /// like `flush()`. Incremental, return an empty buffer, or throw if the
    /// input did not end between frames, including empty input. Throws if
    /// the stream is already finished.
    #[napi]
    pub fn finish(&mut self, env: Env) -> Result<Buffer> {
        self.inner.call_finish(&env, |ctx| ctx.finish())
    }
}

stream_context_methods!(
    Lz4DecompressContext,
    comprs_core::lz4_stream::DecompressContext
);
