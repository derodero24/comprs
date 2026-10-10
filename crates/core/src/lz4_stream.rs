//! LZ4 frame streaming compression and decompression.

use napi::bindgen_prelude::*;
use napi_derive::napi;

use crate::context::NativeState;
use crate::error::to_napi_error;

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
            .run(&env, |ctx| ctx.transform(crate::as_bytes(&chunk)))
            .map(|v| v.into())
            .map_err(to_napi_error)
    }

    /// Flush the encoder's internal buffer. Returns any buffered compressed data.
    #[napi]
    pub fn flush(&mut self, env: Env) -> Result<Buffer> {
        self.inner
            .run(&env, |ctx| ctx.flush())
            .map(|v| v.into())
            .map_err(to_napi_error)
    }

    /// Finalize the compression stream. Writes the LZ4 frame footer.
    /// Must be called once after all data has been transformed.
    #[napi]
    pub fn finish(&mut self, env: Env) -> Result<Buffer> {
        self.inner
            .finish(&env, |ctx| ctx.finish())
            .map(|v| v.into())
            .map_err(to_napi_error)
    }

    /// Release the native state of the context now rather than when the
    /// context is garbage-collected. Later calls throw, and `finish()`
    /// releases the state too. Closing a finished or closed context does
    /// nothing. `[Symbol.dispose]()` is the same method, for `using`
    /// declarations.
    #[napi]
    pub fn close(&mut self, env: Env) {
        self.inner.close(&env);
    }
}

impl ObjectFinalize for Lz4CompressContext {
    fn finalize(mut self, env: Env) -> Result<()> {
        self.inner.close(&env);
        Ok(())
    }
}

/// Streaming LZ4 frame decompression context.
///
/// Buffers compressed input and decompresses on `flush()`.
/// LZ4 frame decompression requires the full compressed input, so true
/// incremental streaming is not possible with the current lz4_flex API.
/// The input may hold several concatenated frames, including skippable and
/// legacy frames.
#[napi(custom_finalize)]
pub struct Lz4DecompressContext {
    inner: NativeState<comprs_core::lz4_stream::DecompressContext>,
}

#[napi]
impl Lz4DecompressContext {
    #[napi(constructor)]
    pub fn new(env: Env, max_output_size: Option<f64>) -> Result<Self> {
        Ok(Self {
            inner: NativeState::new(
                &env,
                comprs_core::lz4_stream::DecompressContext::new(max_output_size)
                    .map_err(to_napi_error)?,
                "lz4 stream",
            ),
        })
    }

    /// Buffer a chunk of compressed data.
    /// Returns an empty buffer (decompressed output is produced in `flush()`).
    #[napi]
    pub fn transform(&mut self, env: Env, chunk: Either<Buffer, Uint8Array>) -> Result<Buffer> {
        self.inner
            .run(&env, |ctx| ctx.transform(crate::as_bytes(&chunk)))
            .map(|v| v.into())
            .map_err(to_napi_error)
    }

    /// Decompress all buffered data and return the result.
    /// Throws if no compressed data was transformed at all, if the input ends
    /// inside a frame, or if data that is not a frame follows a frame.
    #[napi]
    pub fn flush(&mut self, env: Env) -> Result<Buffer> {
        self.inner
            .run(&env, |ctx| ctx.flush())
            .map(|v| v.into())
            .map_err(to_napi_error)
    }

    /// Finalize the decompression stream. Decompresses the data buffered
    /// since the last `flush()`, like `flush()`, then releases the buffer.
    /// Throws like `flush()`, and if the stream is already finished.
    #[napi]
    pub fn finish(&mut self, env: Env) -> Result<Buffer> {
        self.inner
            .finish(&env, |ctx| ctx.finish())
            .map(|v| v.into())
            .map_err(to_napi_error)
    }

    /// Release the native state of the context now rather than when the
    /// context is garbage-collected. Later calls throw, and `finish()`
    /// releases the state too. Closing a finished or closed context does
    /// nothing. `[Symbol.dispose]()` is the same method, for `using`
    /// declarations.
    #[napi]
    pub fn close(&mut self, env: Env) {
        self.inner.close(&env);
    }
}

impl ObjectFinalize for Lz4DecompressContext {
    fn finalize(mut self, env: Env) -> Result<()> {
        self.inner.close(&env);
        Ok(())
    }
}
