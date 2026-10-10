//! The task of the one-shot `*Async` functions.
//!
//! Each `*Async` function checks its arguments, copies its input and returns
//! a [`OneShot`] task, which runs one `comprs_core` call on the libuv thread
//! pool. A [`Settle`] type then turns the result into the value or the error
//! that settles the Promise, on the JavaScript thread. A [`Withdrawable`]
//! task can be withdrawn until a thread of the pool reaches it.

use std::marker::PhantomData;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use comprs_core::ComprsError;
use napi::Task;
use napi::bindgen_prelude::*;

use crate::error::{coded_error, to_napi_error};

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

/// Settles as the functions of the unified API (`@derodero24/comprs/next`)
/// do: resolves to a plain `Uint8Array` that holds the output, and rejects
/// with the error of [`coded_error`], which carries the code of the error's
/// category.
pub struct NextBytes;

impl Settle for NextBytes {
    type JsValue = Uint8Array;

    fn resolve(_env: &Env, output: Vec<u8>) -> Result<Uint8Array> {
        // As with `LegacyBuffer`, the output stays in the memory of the
        // addon: a copy into memory that V8 allocates would run here, on the
        // JavaScript thread, which the `*Async` functions keep the work off.
        Ok(Uint8Array::from(output))
    }

    fn reject(env: &Env, err: ComprsError) -> Error {
        coded_error(env, &err)
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

/// The claim on the start of the task of a [`Withdrawable`], shared by the
/// task and the caller: the thread of the pool that reaches the task and
/// [`Withdrawal::withdraw`] both take it, and whichever comes first wins.
#[derive(Clone, Default)]
pub struct Withdrawal(Arc<AtomicBool>);

impl Withdrawal {
    /// Withdraw the task: whether no thread had started it, which then none
    /// will. The task fails with [`Status::Cancelled`] when a thread reaches
    /// it instead.
    pub fn withdraw(&self) -> bool {
        self.take()
    }

    /// Take the claim: whether nobody had taken it. `Relaxed` is enough: the
    /// flag guards no other memory, and each swap reads the value that the
    /// one before it wrote.
    fn take(&self) -> bool {
        !self.0.swap(true, Ordering::Relaxed)
    }
}

/// A task that runs `T` unless the caller withdrew it through its
/// [`Withdrawal`] before a thread of the pool reached it.
///
/// A withdrawn task stays in the queue of the pool, but the thread that
/// reaches it fails it at once, without running `T`, so it holds the thread
/// for no more than that check. The `AbortSignal` of napi-rs would remove
/// the task from the queue instead, but napi-rs 3.14 leaks the reference
/// that `napi_wrap` returns for each signal that it converts, about 100
/// bytes of native memory per call.
pub struct Withdrawable<T> {
    task: T,
    withdrawal: Option<Withdrawal>,
}

impl<T> Withdrawable<T> {
    /// `task`, which `withdrawal` can withdraw, if there is one.
    pub fn new(task: T, withdrawal: Option<Withdrawal>) -> Self {
        Self { task, withdrawal }
    }

    /// Whether the thread that reached the task may run it: whether it took
    /// the claim before the caller withdrew the task, if the caller can.
    fn may_run(&self) -> bool {
        self.withdrawal.as_ref().is_none_or(Withdrawal::take)
    }
}

impl<T: Task> Task for Withdrawable<T> {
    type Output = T::Output;
    type JsValue = T::JsValue;

    fn compute(&mut self) -> Result<Self::Output> {
        if !self.may_run() {
            return Err(Error::new(Status::Cancelled, "the call was withdrawn"));
        }
        self.task.compute()
    }

    fn resolve(&mut self, env: Env, output: Self::Output) -> Result<Self::JsValue> {
        self.task.resolve(env, output)
    }

    fn reject(&mut self, env: Env, err: Error) -> Result<Self::JsValue> {
        self.task.reject(env, err)
    }

    fn finally(self, env: Env) -> Result<()> {
        self.task.finally(env)
    }
}

#[cfg(test)]
mod tests {
    // The tests call no function that creates a `napi::Error`: its `Drop`
    // calls Node-API, which a test binary does not link.
    use super::*;

    #[test]
    fn a_withdrawn_task_does_not_run() {
        let withdrawal = Withdrawal::default();
        let task = Withdrawable::new((), Some(withdrawal.clone()));
        assert!(withdrawal.withdraw());
        assert!(!task.may_run());
    }

    #[test]
    fn a_task_that_a_thread_reached_cannot_be_withdrawn() {
        let withdrawal = Withdrawal::default();
        let task = Withdrawable::new((), Some(withdrawal.clone()));
        assert!(task.may_run());
        assert!(!withdrawal.withdraw());
    }

    #[test]
    fn a_task_is_withdrawn_once() {
        let withdrawal = Withdrawal::default();
        assert!(withdrawal.withdraw());
        assert!(!withdrawal.withdraw());
    }

    #[test]
    fn a_task_without_a_withdrawal_runs() {
        assert!(Withdrawable::new((), None).may_run());
    }
}
