//! The hidden binding of the unified API, `@derodero24/comprs/next`, over
//! [`comprs_core::unified`].
//!
//! The TypeScript layer of the unified API is the only caller. It reads the
//! options objects, checks their shapes and types, and passes the values on
//! as positional arguments, so the conversion errors of napi-rs, which carry
//! no `code`, never reach its callers. comprs-core checks the ranges and the
//! combinations of the values.
//!
//! The functions are registered in the `next` namespace without
//! declarations, and [`hide`] moves the namespace off the exports, to the
//! property `Symbol.for("@derodero24/comprs/internal")`: neither
//! `index.d.ts`, `index.js` nor the keys of the binding list it.
//!
//! Every error carries the code of its category ([`ComprsError::code`]) as
//! `code`, as [`coded_error`] describes. Results are plain `Uint8Array`s:
//! the synchronous functions copy results of up to [`SYNC_COPY_LIMIT`] into
//! memory that V8 allocates, as [`to_uint8array`] does. The `*Async`
//! functions copy their inputs when they are called (#548), run on the libuv
//! thread pool and settle as [`NextBytes`] does.

use comprs_core::ComprsError;
use comprs_core::unified::{
    self, CompressOptions, DecompressOptions, DictionaryRef, Format, GzipHeaderOptions,
};
use napi::bindgen_prelude::{
    AsyncTask, Env, FromNapiValue, JsObjectValue, Object, Property, PropertyAttributes, Uint8Array,
};
use napi::sys;
use napi_derive::napi;

use crate::async_args::{AsyncArg, Checked, checked};
use crate::convert::{SYNC_COPY_LIMIT, to_uint8array};
use crate::error::coded_error;
use crate::task::{NextBytes, OneShot};

/// The description of the symbol, `Symbol.for(INTERNAL_KEY)`, that keys the
/// binding on the exports.
const INTERNAL_KEY: &str = "@derodero24/comprs/internal";

/// Move the `next` namespace, the functions of this module, from `exports`
/// to the property `Symbol.for("@derodero24/comprs/internal")`, which is
/// neither enumerable, writable nor configurable.
///
/// The functions back the TypeScript layer of the unified API and are no
/// API of their own. `require()` returns the whole binding, and runtimes and
/// bundlers that import it from an ES module list its string keys, so as
/// `next` they would show next to the declared names (#568). The symbol is
/// in the global registry, so the TypeScript layer reaches the property
/// without an export of its own.
pub(crate) fn hide(env: &Env, exports: &mut Object) -> napi::Result<()> {
    let next: Object = exports.get_named_property_unchecked("next")?;
    exports.delete_named_property("next")?;
    let key = env.symbol_for(INTERNAL_KEY)?;
    let property = Property::new()
        .with_name(env, key)?
        .with_value(&next)
        .with_property_attributes(PropertyAttributes::Default);
    exports.define_properties(&[property])
}

/// The task of the `*Async` functions.
type NextTask = AsyncTask<Checked<OneShot<NextBytes>>>;

/// The bytes of a `Uint8Array` in an array argument, copied as napi-rs
/// converts the element.
///
/// napi-rs reads the elements of an array one by one, and reading one can
/// run JavaScript, such as a getter, which could detach the buffer of an
/// element read before. A `&[u8]` of that element would then dangle; a copy
/// cannot. The other byte arguments can be borrowed: converting the
/// primitives that follow them runs no JavaScript.
pub struct CopiedBytes(Vec<u8>);

impl FromNapiValue for CopiedBytes {
    unsafe fn from_napi_value(env: sys::napi_env, value: sys::napi_value) -> napi::Result<Self> {
        // SAFETY: the caller passes a valid `env` and a value of it, which
        // the slice borrows only until it is copied.
        let bytes = unsafe { <&[u8]>::from_napi_value(env, value) }?;
        Ok(Self(bytes.to_vec()))
    }
}

/// The bytes of `samples`.
fn sample_bytes(samples: Vec<CopiedBytes>) -> Vec<Vec<u8>> {
    samples.into_iter().map(|sample| sample.0).collect()
}

/// Return the result of a synchronous call as a `Uint8Array`, as
/// [`to_uint8array`] does, or its error as the error to throw.
fn sync_output(env: &Env, result: Result<Vec<u8>, ComprsError>) -> napi::Result<Uint8Array> {
    let output = result.map_err(|err| coded_error(env, &err))?;
    to_uint8array(env, output, SYNC_COPY_LIMIT)
}

/// Compress `data` in the format named `format` with
/// [`unified::compress`], which checks the options in its order. The gzip
/// header is that of [`GzipHeaderOptions::from_fields`].
#[allow(clippy::too_many_arguments)] // The fields of the options.
fn compress_data(
    data: &[u8],
    format: &str,
    level: Option<f64>,
    dictionary: Option<&[u8]>,
    gzip_header: Option<bool>,
    gzip_filename: Option<String>,
    gzip_mtime: Option<f64>,
    workers: Option<f64>,
) -> Result<Vec<u8>, ComprsError> {
    let format: Format = format.parse()?;
    let options = CompressOptions {
        level,
        dictionary: dictionary.map(DictionaryRef::Raw),
        gzip_header: GzipHeaderOptions::from_fields(
            gzip_header == Some(true),
            gzip_filename,
            gzip_mtime,
        ),
        workers,
    };
    unified::compress(data, format, &options)
}

/// Decompress `data` in the format named `format`, or the format that
/// detection finds for `None`, with [`unified::decompress`].
fn decompress_data(
    data: &[u8],
    format: Option<&str>,
    max_output_size: Option<f64>,
    dictionary: Option<&[u8]>,
) -> Result<Vec<u8>, ComprsError> {
    let options = DecompressOptions {
        format: format.map(str::parse).transpose()?,
        max_output_size,
        dictionary: dictionary.map(DictionaryRef::Raw),
    };
    unified::decompress(data, &options)
}

/// Compress `data` in `format`: `compressSync()` of the unified API, with
/// the fields of its options as positional arguments.
///
/// `dictionary` holds the bytes of a dictionary, for zstd and brotli.
/// `gzipHeader` tells whether the options have a gzip header, for gzip,
/// which may have no fields; `gzipFilename` and `gzipMtime` hold its fields
/// and imply it. `workers` is the number of zstd worker threads.
#[napi(namespace = "next", skip_typescript)]
#[allow(clippy::too_many_arguments)] // The fields of the options, and `env`.
pub fn compress(
    env: Env,
    data: &[u8],
    format: String,
    level: Option<f64>,
    dictionary: Option<&[u8]>,
    gzip_header: Option<bool>,
    gzip_filename: Option<String>,
    gzip_mtime: Option<f64>,
    workers: Option<f64>,
) -> napi::Result<Uint8Array> {
    sync_output(
        &env,
        compress_data(
            data,
            &format,
            level,
            dictionary,
            gzip_header,
            gzip_filename,
            gzip_mtime,
            workers,
        ),
    )
}

/// [`compress`] on the libuv thread pool: `compress()` of the unified API.
#[napi(namespace = "next", skip_typescript)]
#[allow(clippy::too_many_arguments)] // The fields of the options.
pub fn compress_async(
    data: AsyncArg<&[u8]>,
    format: AsyncArg<String>,
    level: AsyncArg<Option<f64>>,
    dictionary: AsyncArg<Option<&[u8]>>,
    gzip_header: AsyncArg<Option<bool>>,
    gzip_filename: AsyncArg<Option<String>>,
    gzip_mtime: AsyncArg<Option<f64>>,
    workers: AsyncArg<Option<f64>>,
) -> NextTask {
    checked(|| {
        let data = data.get()?.to_vec();
        let format = format.get()?;
        let level = level.get()?;
        let dictionary = dictionary.get()?.map(<[u8]>::to_vec);
        let gzip_header = gzip_header.get()?;
        let gzip_filename = gzip_filename.get()?;
        let gzip_mtime = gzip_mtime.get()?;
        let workers = workers.get()?;
        // The task checks the options, so that their errors reject the
        // Promise with the coded errors of `NextBytes`.
        Ok(OneShot::new(move || {
            compress_data(
                &data,
                &format,
                level,
                dictionary.as_deref(),
                gzip_header,
                gzip_filename,
                gzip_mtime,
                workers,
            )
        }))
    })
}

/// Decompress `data` in `format`, or in the format that detection finds if
/// `format` is `null` or `undefined`: `decompressSync()` of the unified API,
/// with the fields of its options as positional arguments.
#[napi(namespace = "next", skip_typescript)]
pub fn decompress(
    env: Env,
    data: &[u8],
    format: Option<String>,
    max_output_size: Option<f64>,
    dictionary: Option<&[u8]>,
) -> napi::Result<Uint8Array> {
    sync_output(
        &env,
        decompress_data(data, format.as_deref(), max_output_size, dictionary),
    )
}

/// [`decompress`] on the libuv thread pool: `decompress()` of the unified
/// API.
#[napi(namespace = "next", skip_typescript)]
pub fn decompress_async(
    data: AsyncArg<&[u8]>,
    format: AsyncArg<Option<String>>,
    max_output_size: AsyncArg<Option<f64>>,
    dictionary: AsyncArg<Option<&[u8]>>,
) -> NextTask {
    checked(|| {
        let data = data.get()?.to_vec();
        let format = format.get()?;
        let max_output_size = max_output_size.get()?;
        let dictionary = dictionary.get()?.map(<[u8]>::to_vec);
        Ok(OneShot::new(move || {
            decompress_data(
                &data,
                format.as_deref(),
                max_output_size,
                dictionary.as_deref(),
            )
        }))
    })
}

/// The name of the format of `data` that [`unified::detect`] finds, or
/// `null`. It is never `deflate-raw`, which has no header to recognize.
#[napi(namespace = "next", skip_typescript)]
pub fn detect_format(data: &[u8]) -> Option<&'static str> {
    unified::detect(data).map(Format::name)
}

/// Train a zstd dictionary of at most `maxSize` bytes from `samples`, with
/// [`unified::train_dictionary`]: `trainDictionarySync()` of the unified
/// API.
#[napi(namespace = "next", skip_typescript)]
pub fn train_dictionary(
    env: Env,
    samples: Vec<CopiedBytes>,
    max_size: Option<f64>,
) -> napi::Result<Uint8Array> {
    let samples = sample_bytes(samples);
    sync_output(&env, unified::train_dictionary(&samples, max_size))
}

/// [`train_dictionary`] on the libuv thread pool: `trainDictionary()` of the
/// unified API.
#[napi(namespace = "next", skip_typescript)]
pub fn train_dictionary_async(
    samples: AsyncArg<Vec<CopiedBytes>>,
    max_size: AsyncArg<Option<f64>>,
) -> NextTask {
    checked(|| {
        let samples = sample_bytes(samples.get()?);
        let max_size = max_size.get()?;
        Ok(OneShot::new(move || {
            unified::train_dictionary(&samples, max_size)
        }))
    })
}

/// The codes that the errors of the unified API carry,
/// [`comprs_core::ERROR_CODES`], against which the tests check the
/// `ErrorCode` type of the TypeScript layer.
#[napi(namespace = "next", skip_typescript)]
pub fn error_codes() -> Vec<&'static str> {
    comprs_core::ERROR_CODES.to_vec()
}
