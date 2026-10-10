//! The task of the one-shot `*Async` functions.
//!
//! Each `*Async` function checks its arguments, copies its input and returns
//! a [`OneShot`] task, which runs one `comprs_core` call on the libuv thread
//! pool. A [`Settle`] type then turns the result into the value or the error
//! that settles the Promise, on the JavaScript thread.

use std::marker::PhantomData;

use comprs_core::ComprsError;
use napi::Task;
use napi::bindgen_prelude::*;

use crate::error::to_napi_error;

/// How a [`OneShot`] task settles its Promise. Both functions run on the
/// JavaScript thread, so they can create JavaScript values.
pub trait Settle: 'static {
    /// The value that the Promise resolves to.
    type JsValue: ToNapiValue + TypeName;

    /// The value that the Promise resolves to, made from the output of the
    /// operation.
    fn resolve(env: &Env, output: Vec<u8>) -> Result<Self::JsValue>;

    /// The error that the Promise rejects with, made from the error of the
    /// operation.
    fn reject(env: &Env, err: ComprsError) -> Error;
}

/// Settles as the `*Async` functions always have: resolves to a `Buffer`
/// that holds the output, and rejects with the error that the synchronous
/// variant throws.
pub struct LegacyBuffer;

impl Settle for LegacyBuffer {
    type JsValue = Buffer;

    fn resolve(_env: &Env, output: Vec<u8>) -> Result<Buffer> {
        // Unlike a synchronous result (see `crate::convert`), the output
        // stays in the memory of the addon. A copy into V8's memory would
        // run here, on the JavaScript thread, with the page faults of the new
        // memory, which the `*Async` functions exist to keep off it. Awaiting
        // the Promise also turns the event loop, which frees the memory of
        // earlier results.
        Ok(Buffer::from(output))
    }

    fn reject(_env: &Env, err: ComprsError) -> Error {
        to_napi_error(err)
    }
}

/// What the operation of a [`OneShot`] task returns.
type Outcome = std::result::Result<Vec<u8>, ComprsError>;

/// The operation of a [`OneShot`] task.
type Operation = Box<dyn FnOnce() -> Outcome + Send>;

/// A task that runs an operation on the thread pool and settles its Promise
/// with `S`.
///
/// The impl of [`Task`] has no `#[napi]` attribute. On an impl of `Task`, the
/// attribute adds a class to the native binding, which `require()` returns
/// whole, so the class would be exported although it is not declared and
/// cannot be constructed (#568). The `*Async` functions declare the type of
/// their Promise with `ts_return_type` instead.
pub struct OneShot<S: Settle> {
    op: Option<Operation>,
    _settle: PhantomData<fn() -> S>,
}

impl<S: Settle> OneShot<S> {
    /// A task that runs `op`, which owns its input.
    pub fn new(op: impl FnOnce() -> Outcome + Send + 'static) -> Self {
        Self {
            op: Some(Box::new(op)),
            _settle: PhantomData,
        }
    }
}

impl<S: Settle> Task for OneShot<S> {
    // The error of the operation is part of the output, so that it reaches
    // `resolve` on the JavaScript thread as a `ComprsError`, from which
    // `S::reject` can make any error. `compute` fails only if it runs twice,
    // which napi-rs never does.
    type Output = Outcome;
    type JsValue = S::JsValue;

    fn compute(&mut self) -> Result<Self::Output> {
        let op = self
            .op
            .take()
            .ok_or_else(|| Error::new(Status::GenericFailure, "the task already ran"))?;
        Ok(op())
    }

    fn resolve(&mut self, env: Env, output: Self::Output) -> Result<Self::JsValue> {
        match output {
            Ok(output) => S::resolve(&env, output),
            Err(err) => Err(S::reject(&env, err)),
        }
    }
}
