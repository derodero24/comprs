//! Structured error types for comprs.

use napi::bindgen_prelude::*;

pub use comprs_core::ComprsError;

/// Convert a ComprsError to a napi::Error.
pub(crate) fn to_napi_error(e: ComprsError) -> napi::Error {
    match &e {
        ComprsError::InvalidArg(_) => Error::new(Status::InvalidArg, e.to_string()),
        _ => Error::new(Status::GenericFailure, e.to_string()),
    }
}
