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
//! `nextTrainDictionary` and `nextErrorCodes`, with the class
//! `NextDictionary`; the browser entry, browser/index.js, does not.
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
//!
//! The `Dictionary` class of the TypeScript layer holds a prepared
//! dictionary as a [`NextDictionary`] (#557), whose `compress()` and
//! `decompress()` are `nextCompress()` and `nextDecompress()` with it in
//! place of the bytes of a dictionary. The glue cannot take an optional
//! reference to the class as an argument of a function, as the native
//! binding takes its handle.

use comprs_core::ComprsError;
use comprs_core::dictionary::Dictionary;
use comprs_core::unified::{self, DictionaryRef};
use js_sys::{Reflect, Uint8Array};
use wasm_bindgen::prelude::*;

use crate::StreamState;

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
        dictionary.as_deref().map(DictionaryRef::Raw),
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
        dictionary.as_deref().map(DictionaryRef::Raw),
    ))
}

/// A prepared dictionary, which the `Dictionary` class of the TypeScript
/// layer holds and frees with `free()` when it is closed. The glue frees it
/// too when the garbage collector collects the object.
#[wasm_bindgen(js_name = "NextDictionary")]
pub struct NextDictionary(Dictionary);

#[wasm_bindgen(js_class = "NextDictionary")]
impl NextDictionary {
    /// Prepare a dictionary for the format named `format`, `zstd` or
    /// `brotli`, from a copy of `bytes`, with [`Dictionary::new`], which
    /// prepares a zstd dictionary for the compression `level` and for
    /// decompression: `Dictionary.from()` of the unified API.
    #[wasm_bindgen(constructor)]
    pub fn new(bytes: &[u8], format: &str, level: Option<f64>) -> Result<NextDictionary, JsValue> {
        let dictionary = format
            .parse()
            .and_then(|format| Dictionary::new(bytes, format, level));
        coded(dictionary).map(NextDictionary)
    }

    /// [`next_compress`] with this dictionary in place of the bytes of one.
    #[allow(clippy::too_many_arguments)] // The fields of the options.
    pub fn compress(
        &self,
        data: &[u8],
        format: &str,
        level: Option<f64>,
        gzip_header: Option<bool>,
        gzip_filename: Option<String>,
        gzip_mtime: Option<f64>,
        workers: Option<f64>,
    ) -> Result<Vec<u8>, JsValue> {
        coded(unified::compress_fields(
            data,
            format,
            level,
            Some(DictionaryRef::Prepared(&self.0)),
            gzip_header,
            gzip_filename,
            gzip_mtime,
            workers,
        ))
    }

    /// [`next_decompress`] with this dictionary in place of the bytes of
    /// one, which selects its own format if `format` is `null` or
    /// `undefined`.
    pub fn decompress(
        &self,
        data: &[u8],
        format: Option<String>,
        max_output_size: Option<f64>,
    ) -> Result<Vec<u8>, JsValue> {
        coded(unified::decompress_fields(
            data,
            format.as_deref(),
            max_output_size,
            Some(DictionaryRef::Prepared(&self.0)),
        ))
    }

    /// A copy of the bytes of the dictionary: `toBytes()` of the
    /// `Dictionary` class.
    #[wasm_bindgen(js_name = "toBytes")]
    pub fn to_bytes(&self) -> Vec<u8> {
        self.0.raw().to_vec()
    }

    /// A compression stream with this dictionary in place of the bytes of
    /// one, as [`NextCompressContext::new`] creates it.
    #[wasm_bindgen(js_name = "compressContext")]
    pub fn compress_context(
        &self,
        format: &str,
        level: Option<f64>,
        gzip_header: Option<bool>,
        gzip_filename: Option<String>,
        gzip_mtime: Option<f64>,
        workers: Option<f64>,
    ) -> Result<NextCompressContext, JsValue> {
        let context = unified::CompressContext::from_fields(
            format,
            level,
            Some(DictionaryRef::Prepared(&self.0)),
            gzip_header,
            gzip_filename,
            gzip_mtime,
            workers,
        );
        coded(context).map(NextCompressContext::open)
    }

    /// A decompression stream with this dictionary in place of the bytes of
    /// one, as [`NextDecompressContext::new`] creates it, which takes the
    /// format of the dictionary if `format` is `null` or `undefined`.
    #[wasm_bindgen(js_name = "decompressContext")]
    pub fn decompress_context(
        &self,
        format: Option<String>,
        max_output_size: Option<f64>,
    ) -> Result<NextDecompressContext, JsValue> {
        let context = unified::DecompressContext::from_fields(
            format.as_deref(),
            max_output_size,
            Some(DictionaryRef::Prepared(&self.0)),
        );
        coded(context).map(NextDecompressContext::open)
    }
}

/// A compression stream of the unified API, over
/// [`unified::CompressContext`]: the `CompressionStream` class of the
/// TypeScript layer drives it through its browser backend, and frees it
/// with `free()` once the stream ends, fails or is cancelled. The glue frees
/// it too when the garbage collector collects the object. The context
/// copies what it needs of a prepared dictionary, so it outlives a
/// `NextDictionary` that is freed first.
#[wasm_bindgen(js_name = "NextCompressContext")]
pub struct NextCompressContext(StreamState<unified::CompressContext>);

#[wasm_bindgen(js_class = "NextCompressContext")]
impl NextCompressContext {
    /// Create a compression stream in `format`, with the options of
    /// [`next_compress`], which [`unified::CompressContext::from_fields`]
    /// checks in its order.
    #[wasm_bindgen(constructor)]
    pub fn new(
        format: &str,
        level: Option<f64>,
        dictionary: Option<Vec<u8>>,
        gzip_header: Option<bool>,
        gzip_filename: Option<String>,
        gzip_mtime: Option<f64>,
        workers: Option<f64>,
    ) -> Result<NextCompressContext, JsValue> {
        let context = unified::CompressContext::from_fields(
            format,
            level,
            dictionary.as_deref().map(DictionaryRef::Raw),
            gzip_header,
            gzip_filename,
            gzip_mtime,
            workers,
        );
        coded(context).map(Self::open)
    }

    fn open(context: unified::CompressContext) -> Self {
        Self(StreamState::new(context, "compression stream"))
    }

    /// Compress a chunk of input, and return the output that is ready.
    pub fn transform(&mut self, chunk: &[u8]) -> Result<Vec<u8>, JsValue> {
        coded(self.0.try_run(|context| context.transform(chunk)))
    }

    /// End the stream, and return the rest of the output. Later calls
    /// throw.
    pub fn finish(&mut self) -> Result<Vec<u8>, JsValue> {
        coded(self.0.try_finish(unified::CompressContext::finish))
    }
}

/// A decompression stream of the unified API, over
/// [`unified::DecompressContext`], which the `DecompressionStream` class of
/// the TypeScript layer drives and frees as [`NextCompressContext`]
/// describes.
#[wasm_bindgen(js_name = "NextDecompressContext")]
pub struct NextDecompressContext(StreamState<unified::DecompressContext>);

#[wasm_bindgen(js_class = "NextDecompressContext")]
impl NextDecompressContext {
    /// Create a decompression stream in `format`, or one that detects the
    /// format if `format` is `null` or `undefined`, with the options of
    /// [`next_decompress`], which [`unified::DecompressContext::from_fields`]
    /// checks in its order.
    #[wasm_bindgen(constructor)]
    pub fn new(
        format: Option<String>,
        max_output_size: Option<f64>,
        dictionary: Option<Vec<u8>>,
    ) -> Result<NextDecompressContext, JsValue> {
        let context = unified::DecompressContext::from_fields(
            format.as_deref(),
            max_output_size,
            dictionary.as_deref().map(DictionaryRef::Raw),
        );
        coded(context).map(Self::open)
    }

    fn open(context: unified::DecompressContext) -> Self {
        Self(StreamState::new(context, "decompression stream"))
    }

    /// Decompress a chunk of input, and return the output that is ready.
    pub fn transform(&mut self, chunk: &[u8]) -> Result<Vec<u8>, JsValue> {
        coded(self.0.try_run(|context| context.transform(chunk)))
    }

    /// End the stream, and return the rest of the output: it fails if the
    /// input did not hold the whole compressed stream. Later calls throw.
    pub fn finish(&mut self) -> Result<Vec<u8>, JsValue> {
        coded(self.0.try_finish(unified::DecompressContext::finish))
    }
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
