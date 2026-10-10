//! The functions of the unified API, `@derodero24/comprs/next`, in the
//! browser build: the counterparts of the hidden binding of the native addon
//! (crates/core/src/next.rs), over [`comprs_core::unified`], with its
//! positional parameters.
//!
//! The TypeScript layer of the unified API is their only caller, through
//! its browser backend (src/next/wasm.ts) and browser/wasm.js. It reads the
//! options objects, checks their shapes and types, and passes the values on
//! as positional arguments, so the glue's conversions, which check nothing,
//! only ever see values of the declared types. comprs-core checks the ranges
//! and the combinations of the values. The glue exports the functions as
//! `nextCompress`, `nextDecompress`, `nextDetectFormat`,
//! `nextTrainDictionary` and `nextErrorCodes`; the browser entry,
//! browser/index.js, does not.
//!
//! Every error carries the code of its category ([`ComprsError::code`]) as
//! `code`, as [`coded_error`] describes; a panic or a failed allocation
//! traps instead, as in the other functions of the crate. The glue copies
//! the inputs into WebAssembly memory for the call, and each result out of
//! it into a `Uint8Array` of its own. comprs-core is built without its
//! `zstdmt` feature here, so compression with workers fails with "zstd
//! workers are not supported in this build" (`ERR_COMPRS_INVALID_ARG`).
//! There are no `*Async` functions: the backend runs these on the calling
//! thread.

use comprs_core::ComprsError;
use comprs_core::unified;
use js_sys::{Reflect, Uint8Array};
use wasm_bindgen::prelude::*;

/// The error of the unified API for `err`, as the native binding creates
/// it: a `TypeError` for `ERR_COMPRS_INVALID_ARG` and a plain `Error` for
/// every other code, with the message of `err` and its code
/// ([`ComprsError::code`]) as `code`.
fn coded_error(err: &ComprsError) -> JsValue {
    let message = err.to_string();
    let error = match err {
        ComprsError::InvalidArg(_) => js_sys::TypeError::new(&message).into(),
        _ => js_sys::Error::new(&message),
    };
    // Setting a property of a new Error object cannot fail: Reflect.set()
    // defines it and returns true.
    let _ = Reflect::set(&error, &"code".into(), &err.code().into());
    error.into()
}

/// The result of a call, with its error as [`coded_error`] creates it.
fn coded<T>(result: Result<T, ComprsError>) -> Result<T, JsValue> {
    result.map_err(|err| coded_error(&err))
}

/// Compress `data` in `format`: `compressSync()` and `compress()` of the
/// unified API, with the fields of its options as positional arguments,
/// which [`unified::compress_fields`] checks in its order, as for the
/// native binding.
///
/// `dictionary` holds the bytes of a dictionary, for zstd and brotli.
/// `gzipHeader` tells whether the options have a gzip header, for gzip,
/// which may have no fields; `gzipFilename` and `gzipMtime` hold its fields
/// and imply it. `workers` is the number of zstd worker threads, which this
/// build accepts as 0 only.
#[wasm_bindgen(js_name = "nextCompress")]
#[allow(clippy::too_many_arguments)] // The fields of the options.
pub fn next_compress(
    data: &[u8],
    format: &str,
    level: Option<f64>,
    dictionary: Option<Vec<u8>>,
    gzip_header: Option<bool>,
    gzip_filename: Option<String>,
    gzip_mtime: Option<f64>,
    workers: Option<f64>,
) -> Result<Vec<u8>, JsValue> {
    coded(unified::compress_fields(
        data,
        format,
        level,
        dictionary.as_deref(),
        gzip_header,
        gzip_filename,
        gzip_mtime,
        workers,
    ))
}

/// Decompress `data` in `format`, or in the format that detection finds if
/// `format` is `null` or `undefined`: `decompressSync()` and `decompress()`
/// of the unified API, with the fields of its options as positional
/// arguments, which [`unified::decompress_fields`] checks in its order, as
/// for the native binding.
#[wasm_bindgen(js_name = "nextDecompress")]
pub fn next_decompress(
    data: &[u8],
    format: Option<String>,
    max_output_size: Option<f64>,
    dictionary: Option<Vec<u8>>,
) -> Result<Vec<u8>, JsValue> {
    coded(unified::decompress_fields(
        data,
        format.as_deref(),
        max_output_size,
        dictionary.as_deref(),
    ))
}

/// The name of the format of `data` that [`unified::detect`] finds, or
/// `null`, as the native binding returns them. It is never `deflate-raw`,
/// which has no header to recognize.
#[wasm_bindgen(js_name = "nextDetectFormat", unchecked_return_type = "string | null")]
pub fn next_detect_format(data: &[u8]) -> JsValue {
    unified::detect(data).map_or(JsValue::NULL, |format| format.name().into())
}

/// Train a zstd dictionary of at most `maxSize` bytes from `samples`, with
/// [`unified::train_dictionary`]: `trainDictionarySync()` and
/// `trainDictionary()` of the unified API.
#[wasm_bindgen(js_name = "nextTrainDictionary")]
pub fn next_train_dictionary(
    samples: Vec<Uint8Array>,
    max_size: Option<f64>,
) -> Result<Vec<u8>, JsValue> {
    let samples: Vec<Vec<u8>> = samples.iter().map(Uint8Array::to_vec).collect();
    coded(unified::train_dictionary(&samples, max_size))
}

/// The codes that the errors of the unified API carry,
/// [`comprs_core::ERROR_CODES`], against which the tests check those of the
/// native binding and the `ErrorCode` type of the TypeScript layer.
#[wasm_bindgen(js_name = "nextErrorCodes")]
pub fn next_error_codes() -> Vec<String> {
    comprs_core::ERROR_CODES.map(String::from).to_vec()
}
