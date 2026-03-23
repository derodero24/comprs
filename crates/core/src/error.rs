//! Structured error types for comprs.

use napi::bindgen_prelude::*;
use thiserror::Error;

/// Errors produced by comprs compression and decompression operations.
#[derive(Error, Debug)]
pub enum ZflateError {
    /// Compression or decompression operation failure.
    #[error("{context} failed: {source}")]
    Operation {
        context: &'static str,
        #[source]
        source: Box<dyn std::error::Error + Send + Sync>,
    },

    /// Resource creation failure (e.g. encoder/decoder initialization).
    #[error("failed to create {context}: {source}")]
    Creation {
        context: &'static str,
        #[source]
        source: Box<dyn std::error::Error + Send + Sync>,
    },

    /// Invalid argument.
    #[error("{0}")]
    InvalidArg(String),

    /// Decompressed output exceeded maximum size.
    #[error("{context} exceeded maximum size of {limit} bytes")]
    SizeLimit { context: &'static str, limit: usize },

    /// Stream context has already been finalized.
    #[error("{0} already finished")]
    StreamFinished(&'static str),
}

impl From<ZflateError> for napi::Error {
    fn from(e: ZflateError) -> Self {
        match &e {
            ZflateError::InvalidArg(_) => Error::new(Status::InvalidArg, e.to_string()),
            _ => Error::new(Status::GenericFailure, e.to_string()),
        }
    }
}
