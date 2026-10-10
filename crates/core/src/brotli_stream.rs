//! Brotli streaming compression and decompression.

use napi::bindgen_prelude::*;
use napi_derive::napi;

use crate::context::{NativeState, stream_context_methods};
use crate::error::to_napi_error;
use crate::options::stream_context_options;

/// Streaming brotli compression context.
///
/// Maintains internal compression state across multiple `transform` calls,
/// enabling chunked compression without losing cross-chunk context.
#[napi(custom_finalize)]
pub struct BrotliCompressContext {
    inner: NativeState<comprs_core::brotli_stream::CompressContext>,
}

#[napi]
impl BrotliCompressContext {
    #[napi(constructor)]
    pub fn new(env: Env, quality: Option<f64>) -> Result<Self> {
        let quality = comprs_core::brotli::QUALITY
            .check_optional_f64(quality)
            .map_err(to_napi_error)?;
        Ok(Self {
            inner: NativeState::new(
                &env,
                comprs_core::brotli_stream::CompressContext::new(quality).map_err(to_napi_error)?,
                "brotli stream",
            ),
        })
    }

    /// Compress a chunk of data. Returns compressed output (may be empty if
    /// the compressor is buffering data internally).
    #[napi]
    pub fn transform(&mut self, env: Env, chunk: Either<Buffer, Uint8Array>) -> Result<Buffer> {
        self.inner
            .call(&env, |ctx| ctx.transform(crate::as_bytes(&chunk)))
    }

    /// Flush the compressor's internal buffer. Returns any buffered compressed data.
    #[napi]
    pub fn flush(&mut self, env: Env) -> Result<Buffer> {
        self.inner.call(&env, |ctx| ctx.flush())
    }

    /// Finalize the compression stream. Writes the brotli stream footer.
    /// Must be called once after all data has been transformed.
    #[napi]
    pub fn finish(&mut self, env: Env) -> Result<Buffer> {
        self.inner.call_finish(&env, |ctx| ctx.finish())
    }
}

stream_context_methods!(BrotliCompressContext);

/// Streaming brotli decompression context.
///
/// Maintains internal decompression state across multiple `transform` calls,
/// enabling chunked decompression of a brotli stream.
#[napi(custom_finalize)]
pub struct BrotliDecompressContext {
    inner: NativeState<comprs_core::brotli_stream::DecompressContext>,
}

#[napi]
impl BrotliDecompressContext {
    #[napi(constructor)]
    pub fn new(env: Env, max_output_size: Option<f64>) -> Result<Self> {
        Ok(Self {
            inner: NativeState::new(
                &env,
                comprs_core::brotli_stream::DecompressContext::new(max_output_size)
                    .map_err(to_napi_error)?,
                "brotli stream",
            ),
        })
    }

    /// Decompress a chunk of compressed data. Returns decompressed output
    /// (may be empty if the decompressor needs more data).
    #[napi]
    pub fn transform(&mut self, env: Env, chunk: Either<Buffer, Uint8Array>) -> Result<Buffer> {
        self.inner
            .call(&env, |ctx| ctx.transform(crate::as_bytes(&chunk)))
    }

    /// Flush the decompressor's internal buffer. Returns any buffered decompressed data.
    #[napi]
    pub fn flush(&mut self, env: Env) -> Result<Buffer> {
        self.inner.call(&env, |ctx| ctx.flush())
    }

    /// Finalize the decompression stream. Returns any remaining decompressed data.
    /// Throws if the input ended before the end of the brotli stream, including empty input.
    /// Must be called once after all compressed data has been transformed.
    #[napi]
    pub fn finish(&mut self, env: Env) -> Result<Buffer> {
        self.inner.call_finish(&env, |ctx| ctx.finish())
    }
}

stream_context_methods!(BrotliDecompressContext);

/// Streaming brotli compression context with custom dictionary, in one of
/// two modes:
///
/// - By default, it buffers its input: `transform()` and `flush()` return
///   an empty buffer, and `finish()` compresses all of the input with the
///   dictionary, into the output of `brotliCompressWithDict()`.
/// - With `{ incremental: true }`, it holds at most the first 4 MiB less
///   16 bytes of input (4,194,288 bytes, as far as brotli refers back to
///   the dictionary), which compress with the dictionary into the output of
///   `brotliCompressWithDict()` if the input ends there. A longer input is
///   compressed without the dictionary, which only helps the start of a
///   stream, into a stream that decodes with or without it: the
///   `transform()` that takes the input past those bytes returns their
///   output, and from then on, `transform()` returns the output that the
///   encoder has emitted, `flush()` all the output of the input so far, and
///   `finish()` the rest of the stream. The stream helpers use this mode.
#[napi(custom_finalize)]
pub struct BrotliCompressDictContext {
    inner: NativeState<comprs_core::brotli_stream::CompressDictContext>,
}

#[napi]
impl BrotliCompressDictContext {
    /// `quality` defaults to 6. `options.incremental` selects the
    /// incremental mode; `options` must be an object, `undefined` or `null`.
    #[napi(
        constructor,
        ts_args_type = "dict: Buffer | Uint8Array, quality?: number | undefined | null, options?: StreamContextOptions | undefined | null"
    )]
    pub fn new(
        env: Env,
        dict: Either<Buffer, Uint8Array>,
        quality: Option<f64>,
        options: Option<Unknown>,
    ) -> Result<Self> {
        let quality = comprs_core::brotli::QUALITY
            .check_optional_f64(quality)
            .map_err(to_napi_error)?;
        let dict = crate::as_bytes(&dict);
        let context = if stream_context_options(options)? {
            comprs_core::brotli_stream::CompressDictContext::incremental(dict, quality)
        } else {
            comprs_core::brotli_stream::CompressDictContext::new(dict, quality)
        };
        Ok(Self {
            inner: NativeState::new(&env, context.map_err(to_napi_error)?, "brotli dict stream"),
        })
    }

    /// Take a chunk of data. By default, keep it and return an empty
    /// buffer: the output comes from `finish()`. Incremental, return the
    /// output that is ready, which is empty while the context holds its
    /// input.
    #[napi]
    pub fn transform(&mut self, env: Env, chunk: Either<Buffer, Uint8Array>) -> Result<Buffer> {
        self.inner
            .call(&env, |ctx| ctx.transform(crate::as_bytes(&chunk)))
    }

    /// Return an empty buffer while the context holds its input, as it
    /// always does by default. Incremental, once the input has passed the
    /// first 4,194,288 bytes, flush the encoder and return all the output of
    /// the input so far.
    #[napi]
    pub fn flush(&mut self, env: Env) -> Result<Buffer> {
        self.inner.call(&env, |ctx| ctx.flush())
    }

    /// Finalize the compression and return the rest of the output: all of
    /// it, compressed from the input that the context holds, if it holds the
    /// input. Must be called once after all data has been transformed.
    #[napi]
    pub fn finish(&mut self, env: Env) -> Result<Buffer> {
        self.inner.call_finish(&env, |ctx| ctx.finish())
    }
}

stream_context_methods!(BrotliCompressDictContext);

/// Streaming brotli decompression context with custom dictionary.
///
/// Maintains internal decompression state across multiple `transform` calls,
/// using a custom dictionary that matches the one used for compression.
#[napi(custom_finalize)]
pub struct BrotliDecompressDictContext {
    inner: NativeState<comprs_core::brotli_stream::DecompressDictContext>,
}

#[napi]
impl BrotliDecompressDictContext {
    #[napi(constructor)]
    pub fn new(
        env: Env,
        dict: Either<Buffer, Uint8Array>,
        max_output_size: Option<f64>,
    ) -> Result<Self> {
        Ok(Self {
            inner: NativeState::new(
                &env,
                comprs_core::brotli_stream::DecompressDictContext::new(
                    crate::as_bytes(&dict),
                    max_output_size,
                )
                .map_err(to_napi_error)?,
                "brotli dict stream",
            ),
        })
    }

    /// Decompress a chunk of compressed data. Returns decompressed output
    /// (may be empty if the decompressor needs more data).
    #[napi]
    pub fn transform(&mut self, env: Env, chunk: Either<Buffer, Uint8Array>) -> Result<Buffer> {
        self.inner
            .call(&env, |ctx| ctx.transform(crate::as_bytes(&chunk)))
    }

    /// Flush the decompressor's internal buffer. Returns any buffered decompressed data.
    #[napi]
    pub fn flush(&mut self, env: Env) -> Result<Buffer> {
        self.inner.call(&env, |ctx| ctx.flush())
    }

    /// Finalize the decompression stream. Returns any remaining decompressed data.
    /// Throws if the input ended before the end of the brotli stream, including empty input.
    /// Must be called once after all compressed data has been transformed.
    #[napi]
    pub fn finish(&mut self, env: Env) -> Result<Buffer> {
        self.inner.call_finish(&env, |ctx| ctx.finish())
    }
}

stream_context_methods!(BrotliDecompressDictContext);
