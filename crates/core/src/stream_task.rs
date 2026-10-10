//! The task of the asynchronous methods of the stream contexts.
//!
//! `transformAsync(chunk)`, `flushAsync()` and `finishAsync()` run the codec
//! of a stream context on the libuv thread pool, as the streams of
//! `node:zlib` do, so that an expensive chunk does not block the event loop
//! (#554). The context shares its state with a [`StreamTask`] (see
//! [`NativeState`]): creating the task marks the context as busy, and the
//! task clears the mark when it settles, on the JavaScript thread, once it
//! has dropped the state if the stream ended or was closed meanwhile and has
//! reported the memory of the state. A [`Settle`] type then turns the result
//! into the value or the error that settles the Promise.

use std::marker::PhantomData;
use std::mem;
use std::sync::Arc;

use comprs_core::{ComprsError, MemoryUsage};
use napi::Task;
use napi::bindgen_prelude::*;

use crate::context::{NativeState, Shared};
use crate::convert::{ASYNC_STREAM_COPY_LIMIT, to_buffer, to_uint8array};
use crate::error::{coded_error, to_napi_error};
use crate::task::Settle;

/// What a method of a codec state returns.
type Outcome = std::result::Result<Vec<u8>, ComprsError>;

/// The methods of a codec state of comprs-core that the stream contexts
/// call. The codecs implement them as inherent methods, which these
/// delegate to.
pub trait StreamCodec: MemoryUsage + Send + 'static {
    /// Take a chunk of input, and return the output that is ready.
    fn transform(&mut self, chunk: &[u8]) -> Outcome;
    /// Return the output of the input so far.
    fn flush(&mut self) -> Outcome;
    /// End the stream, and return the rest of the output.
    fn finish(&mut self) -> Outcome;
}

macro_rules! stream_codecs {
    ($($codec:ty),+ $(,)?) => {
        $(
            impl StreamCodec for $codec {
                fn transform(&mut self, chunk: &[u8]) -> Outcome {
                    <$codec>::transform(self, chunk)
                }

                fn flush(&mut self) -> Outcome {
                    <$codec>::flush(self)
                }

                fn finish(&mut self) -> Outcome {
                    <$codec>::finish(self)
                }
            }
        )+
    };
}

stream_codecs!(
    comprs_core::brotli_stream::CompressContext,
    comprs_core::brotli_stream::CompressDictContext,
    comprs_core::brotli_stream::DecompressContext,
    comprs_core::brotli_stream::DecompressDictContext,
    comprs_core::gzip_stream::DeflateCompressContext,
    comprs_core::gzip_stream::DeflateDecompressContext,
    comprs_core::gzip_stream::GzipCompressContext,
    comprs_core::gzip_stream::GzipDecompressContext,
    comprs_core::lz4_stream::CompressContext,
    comprs_core::lz4_stream::DecompressContext,
    comprs_core::zstd_stream::CompressContext,
    comprs_core::zstd_stream::CompressDictContext,
    comprs_core::zstd_stream::DecompressContext,
    comprs_core::zstd_stream::DecompressDictContext,
);

/// The method that a [`StreamTask`] calls.
pub enum Op {
    /// `transform(chunk)`, with a copy of the chunk.
    Transform(Vec<u8>),
    /// `flush()`.
    Flush,
    /// `finish()`, which ends the stream.
    Finish,
}

impl Op {
    fn call<T: StreamCodec>(self, codec: &mut T) -> Outcome {
        match self {
            Op::Transform(chunk) => codec.transform(&chunk),
            Op::Flush => codec.flush(),
            Op::Finish => codec.finish(),
        }
    }
}

/// Settles as the methods of the stream contexts return: resolves to a
/// `Buffer` that holds the output, and rejects with the error that the
/// synchronous method throws.
///
/// Unlike the result of a one-shot `*Async` function, the output is copied
/// into memory that V8 allocates, up to [`ASYNC_STREAM_COPY_LIMIT`], as the
/// synchronous methods return it (see `crate::convert`): a stream returns
/// many results in a row, whose memory Node.js would otherwise free only on
/// a later turn of the event loop, and the stream helpers enqueue such
/// results without copying them again, as transferable chunks.
pub struct StreamBuffer;

impl Settle for StreamBuffer {
    type JsValue = Buffer;

    fn resolve(env: &Env, output: Vec<u8>) -> Result<Buffer> {
        to_buffer(env, output, ASYNC_STREAM_COPY_LIMIT)
    }

    fn reject(_env: &Env, err: ComprsError) -> Error {
        to_napi_error(err)
    }
}

/// Settles as the asynchronous calls of the streams of the unified API
/// (`@derodero24/comprs/next`) return: resolves to a plain `Uint8Array` that
/// holds the output, copied into memory that V8 allocates up to
/// [`ASYNC_STREAM_COPY_LIMIT`], for the reason that [`StreamBuffer`] gives,
/// and rejects with the error of [`coded_error`], which carries the code of
/// the error's category.
pub struct NextStreamBytes;

impl Settle for NextStreamBytes {
    type JsValue = Uint8Array;

    fn resolve(env: &Env, output: Vec<u8>) -> Result<Uint8Array> {
        to_uint8array(env, output, ASYNC_STREAM_COPY_LIMIT)
    }

    fn reject(env: &Env, err: ComprsError) -> Error {
        coded_error(env, &err)
    }
}

/// A task that calls a method of a stream context on the thread pool, and
/// settles its Promise with `S`.
///
/// The impl of [`Task`] has no `#[napi]` attribute, for the reason that
/// [`crate::task::OneShot`] gives. The methods declare the type of their
/// Promise with `ts_return_type` instead.
pub struct StreamTask<T: StreamCodec, S: Settle> {
    call: Call<T>,
    _settle: PhantomData<fn() -> S>,
}

enum Call<T: StreamCodec> {
    /// The task marked the context as busy: `compute` takes `op` and calls
    /// it on the state, and the task clears the mark when it settles.
    Run {
        shared: Arc<Shared<T>>,
        op: Option<Op>,
    },
    /// The context refused the call with this error, which `compute` takes,
    /// and was not marked.
    Refused(Option<ComprsError>),
    /// The task settled.
    Settled,
}

impl<T: StreamCodec, S: Settle> StreamTask<T, S> {
    /// A task that calls `op` on the state of `state`, or rejects with
    /// `<name> already closed` or `<name> is busy: an asynchronous call has
    /// not finished` (see [`NativeState::begin_async`]).
    pub(crate) fn new(state: &NativeState<T>, op: Op) -> Self {
        let call = match state.begin_async() {
            Ok(shared) => Call::Run {
                shared,
                op: Some(op),
            },
            Err(err) => Call::Refused(Some(err)),
        };
        Self {
            call,
            _settle: PhantomData,
        }
    }

    /// Settle the state of the context, once: drop it if the stream was
    /// closed meanwhile, report its memory, and clear the busy mark.
    fn settle_state(&mut self, env: &Env) {
        if let Call::Run { shared, .. } = mem::replace(&mut self.call, Call::Settled) {
            shared.settle(env);
        }
    }
}

impl<T: StreamCodec, S: Settle> Task for StreamTask<T, S> {
    // The error of the method is part of the output, so that it reaches
    // `resolve` on the JavaScript thread as a `ComprsError`, from which
    // `S::reject` can make any error, as in `OneShot`. `compute` fails only
    // if it runs twice, which napi-rs never does.
    type Output = Outcome;
    type JsValue = S::JsValue;

    fn compute(&mut self) -> Result<Self::Output> {
        let already_ran = || Error::new(Status::GenericFailure, "the task already ran");
        match &mut self.call {
            Call::Run { shared, op } => {
                let op = op.take().ok_or_else(already_ran)?;
                let ends = matches!(op, Op::Finish);
                Ok(shared.run_async(ends, |codec| op.call(codec)))
            }
            Call::Refused(err) => Ok(Err(err.take().ok_or_else(already_ran)?)),
            Call::Settled => Err(already_ran()),
        }
    }

    fn resolve(&mut self, env: Env, output: Self::Output) -> Result<Self::JsValue> {
        self.settle_state(&env);
        match output {
            Ok(output) => S::resolve(&env, output),
            Err(err) => Err(S::reject(&env, err)),
        }
    }

    fn reject(&mut self, env: Env, err: Error) -> Result<Self::JsValue> {
        self.settle_state(&env);
        Err(err)
    }
}

impl<T: StreamCodec, S: Settle> Drop for StreamTask<T, S> {
    /// Clear the busy mark if the task never settled, as when Node.js
    /// cancels it while the environment shuts down, so that the context does
    /// not stay busy.
    fn drop(&mut self) {
        if let Call::Run { shared, .. } = &self.call {
            shared.abandon();
        }
    }
}
