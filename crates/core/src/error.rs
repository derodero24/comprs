//! Structured error types for comprs.

use napi::bindgen_prelude::*;
use napi::{JsError, JsTypeError};

pub use comprs_core::ComprsError;

/// Convert a ComprsError to a napi::Error.
///
/// The `code` of the JavaScript error is "InvalidArg" for invalid arguments
/// and, as it has always been, for data whose format auto-detection cannot
/// determine. It is "GenericFailure" for every other error.
pub(crate) fn to_napi_error(e: ComprsError) -> napi::Error {
    match &e {
        ComprsError::InvalidArg(_) | ComprsError::UnknownFormat(_) => {
            Error::new(Status::InvalidArg, e.to_string())
        }
        _ => Error::new(Status::GenericFailure, e.to_string()),
    }
}

/// The error of the unified API (`@derodero24/comprs/next`) for `err`: a
/// `TypeError` for `ERR_COMPRS_INVALID_ARG` and a plain `Error` for every
/// other code, with the message of `err` and its code
/// ([`ComprsError::code`]) as `code`.
///
/// The JavaScript error is created here, on the JavaScript thread, and the
/// returned `napi::Error` holds a reference to it. napi-rs throws that very
/// object when a function returns the error, and rejects a Promise with it
/// when a task's `resolve` returns it, so the class and the `code` survive
/// both ways. A `napi::Error` that napi-rs turns into a JavaScript error
/// itself would always be a plain `Error`.
pub(crate) fn coded_error(env: &Env, err: &ComprsError) -> napi::Error {
    let error = Error::new(err.code(), err.to_string());
    let value = match err {
        ComprsError::InvalidArg(_) => JsTypeError::from(error).into_unknown(*env),
        _ => JsError::from(error).into_unknown(*env),
    };
    napi::Error::from(value)
}
