//! Structured error types for comprs.

use napi::bindgen_prelude::*;

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
