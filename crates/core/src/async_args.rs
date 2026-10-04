//! Argument handling of the `*Async` functions.
//!
//! An `*Async` function reports every error through the Promise it returns,
//! invalid arguments included, and rejects with the error that its
//! synchronous variant throws for the same arguments: a synchronous throw
//! would escape `promise.catch()`. napi-rs converts the arguments of a
//! function before calling it and throws if one has the wrong type, so the
//! `*Async` functions take their arguments as [`AsyncArg`], whose conversion
//! keeps the error instead. They convert and validate them in [`checked`],
//! which returns a task that rejects with the first error.
//!
//! Their TypeScript signatures are written out with `ts_args_type`, since
//! napi-rs cannot derive them from [`AsyncArg`].

use napi::Task;
use napi::bindgen_prelude::*;

/// An argument of an `*Async` function: the value converted from
/// JavaScript, or the error that the conversion produced.
pub struct AsyncArg<T>(Result<T>);

impl<T> AsyncArg<T> {
    /// The converted value, or the error that the conversion produced.
    pub fn get(self) -> Result<T> {
        self.0
    }
}

impl<T: FromNapiValue> FromNapiValue for AsyncArg<T> {
    unsafe fn from_napi_value(env: sys::napi_env, napi_val: sys::napi_value) -> Result<Self> {
        // SAFETY (all unsafe blocks): the caller passes a valid `env` and a
        // value of it, which is what `T::from_napi_value` and the Node-API
        // calls require, and `exception` is a value that Node-API returns.
        let value = unsafe { T::from_napi_value(env, napi_val) };
        if value.is_ok() {
            return Ok(Self(value));
        }
        // A conversion that runs JavaScript, such as the getter of an array
        // element, fails with the exception of that code pending, and napi-rs
        // throws a pending exception when the function returns. Keep the
        // exception as the error instead: the synchronous variant throws it.
        let mut pending = false;
        check_status!(unsafe { sys::napi_is_exception_pending(env, &mut pending) })?;
        if !pending {
            return Ok(Self(value));
        }
        let mut exception = std::ptr::null_mut();
        check_status!(unsafe { sys::napi_get_and_clear_last_exception(env, &mut exception) })?;
        let exception = unsafe { Unknown::from_raw_unchecked(env, exception) };
        Ok(Self(Err(Error::from_unknown_without_coercion(exception))))
    }
}

/// The task of an `*Async` function, or the error in the function's
/// arguments, which `compute` returns to reject the Promise with it.
pub struct Checked<T>(Result<T>);

impl<T> Checked<T> {
    /// The task, or a copy of the error in the arguments. napi-rs calls
    /// `resolve` only after `compute` succeeds, so only `compute` returns it.
    fn task(&mut self) -> Result<&mut T> {
        match &mut self.0 {
            Ok(task) => Ok(task),
            Err(err) => Err(err.try_clone()?),
        }
    }
}

impl<T: Task> Task for Checked<T> {
    type Output = T::Output;
    type JsValue = T::JsValue;

    fn compute(&mut self) -> Result<Self::Output> {
        self.task()?.compute()
    }

    fn resolve(&mut self, env: Env, output: Self::Output) -> Result<Self::JsValue> {
        self.task()?.resolve(env, output)
    }

    fn reject(&mut self, env: Env, err: Error) -> Result<Self::JsValue> {
        match &mut self.0 {
            Ok(task) => task.reject(env, err),
            Err(_) => Err(err),
        }
    }

    fn finally(self, env: Env) -> Result<()> {
        match self.0 {
            Ok(task) => task.finally(env),
            Err(_) => Ok(()),
        }
    }
}

/// The task that `build` makes from the arguments of an `*Async` function,
/// or, if `build` fails, a task that rejects with its error.
pub fn checked<T: Task>(build: impl FnOnce() -> Result<T>) -> AsyncTask<Checked<T>> {
    AsyncTask::new(Checked(build()))
}
