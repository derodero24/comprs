//! The options argument of the stream context constructors.

use comprs_core::ComprsError;
use napi::JsValue;
use napi::bindgen_prelude::{JsObjectValue, Result, Unknown, ValueType};
use napi_derive::napi;

use crate::error::to_napi_error;

/// Options of a stream context.
///
/// `Lz4DecompressContext` and `BrotliCompressDictContext` take them.
#[napi(object)]
pub struct StreamContextOptions {
    /// Process the input as it arrives rather than hold it.
    ///
    /// With `incremental: true`, `Lz4DecompressContext.transform()` returns
    /// each LZ4 block once all of it has arrived, `flush()` returns nothing
    /// more, and `maxOutputSize` limits the output of the whole stream;
    /// `BrotliCompressDictContext` holds at most the first 4 MiB of input,
    /// then compresses each chunk as it arrives, without the dictionary.
    /// Without it, the context keeps the behaviour that it has always had.
    /// The stream helpers of `@derodero24/comprs/streams` and
    /// `@derodero24/comprs/node` set it.
    #[napi(ts_type = "boolean | undefined")]
    pub incremental: Option<bool>,
}

/// Read the `options` argument of a stream context constructor: whether it
/// sets `incremental`.
///
/// The argument is read by hand rather than as a [`StreamContextOptions`],
/// whose conversion errors name Rust types, so that the native addon and
/// the WebAssembly build reject the same values with the same messages:
/// `undefined` and `null` stand for no options, and for no `incremental`.
pub(crate) fn stream_context_options(options: Option<Unknown>) -> Result<bool> {
    let Some(options) = options else {
        return Ok(false);
    };
    match options.get_type()? {
        ValueType::Undefined | ValueType::Null => return Ok(false),
        ValueType::Object => {}
        _ => return Err(invalid_arg("options must be an object")),
    }
    let incremental: Unknown = options
        .coerce_to_object()?
        .get_named_property("incremental")?;
    match incremental.get_type()? {
        ValueType::Undefined | ValueType::Null => Ok(false),
        ValueType::Boolean => incremental.coerce_to_bool(),
        _ => Err(invalid_arg("incremental must be a boolean")),
    }
}

fn invalid_arg(message: &str) -> napi::Error {
    to_napi_error(ComprsError::InvalidArg(message.to_string()))
}
