//! The hidden binding of the unified API, `@derodero24/comprs/next`, over
//! [`comprs_core::unified`].
//!
//! The TypeScript layer of the unified API is the only caller. It reads the
//! options objects, checks their shapes and types, and passes the values on
//! as positional arguments, so the conversion errors of napi-rs, whose
//! `code` is a napi-rs status such as `InvalidArg` or `NumberExpected`
//! rather than an `ERR_COMPRS_*` code, never reach its callers. comprs-core
//! checks the ranges and the combinations of the values.
//!
//! The functions are registered in the `next` namespace without
//! declarations, and `hide` moves the namespace off the exports, to the
//! property `Symbol.for("@derodero24/comprs/internal")`: neither
//! `index.d.ts`, `index.js` nor the keys of the binding list it.
//!
//! Every error carries the code of its category ([`ComprsError::code`]) as
//! `code`, as `coded_error` describes, except that of a withdrawn task,
//! below. Results are plain `Uint8Array`s: the synchronous functions copy
//! results of up to `SYNC_COPY_LIMIT` into memory that V8 allocates, as
//! `to_uint8array` does. The `*Async` functions copy their inputs when
//! they are called (#548), run on the libuv thread pool and settle as
//! `NextBytes` does.
//!
//! The `*Async` functions take, last, a handle from [`create_withdrawal`] or
//! `undefined`. Through the handle, [`withdraw`] withdraws the task of the
//! call until a thread of the pool reaches it (#559): the TypeScript layer
//! withdraws the task of a call whose signal aborts, and rejects with the
//! reason of the signal itself. The withdrawn task fails with the
//! `Cancelled` status of napi-rs when a thread reaches it, which the
//! TypeScript layer never passes on, since it has settled the call by then.
//! `Withdrawable` tells why the functions take no `AbortSignal`.
//!
//! The `Dictionary` class of the TypeScript layer holds a prepared
//! dictionary as the handle that [`create_dictionary`] returns (#557), which
//! the functions take in place of the bytes of a dictionary.

use std::sync::{Arc, PoisonError, RwLock};

use comprs_core::dictionary::{Dictionary, DictionaryFormat};
use comprs_core::unified::{self, DictionaryRef, Format};
use comprs_core::{ComprsError, MemoryUsage};
use napi::bindgen_prelude::{
    AsyncTask, Env, External, FromNapiValue, JsObjectValue, Object, Property, PropertyAttributes,
    Uint8Array,
};
use napi::sys;
use napi_derive::napi;

use crate::async_args::{AsyncArg, Checked, checked};
use crate::context::NativeState;
use crate::convert::{SYNC_COPY_LIMIT, to_uint8array};
use crate::error::coded_error;
use crate::stream_task::{NextStreamBytes, Op, StreamCodec, StreamTask};
use crate::task::{NextBytes, OneShot, Withdrawable, Withdrawal};

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
type NextTask = AsyncTask<Checked<Withdrawable<OneShot<NextBytes>>>>;

/// The [`Withdrawal`] of `handle`, if the arguments have one, which the task
/// of the call shares.
fn withdrawal(handle: Option<&External<Withdrawal>>) -> Option<Withdrawal> {
    handle.map(|handle| Withdrawal::clone(handle))
}

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
/// `to_uint8array` does, or its error as the error to throw.
fn sync_output(env: &Env, result: Result<Vec<u8>, ComprsError>) -> napi::Result<Uint8Array> {
    let output = result.map_err(|err| coded_error(env, &err))?;
    to_uint8array(env, output, SYNC_COPY_LIMIT)
}

/// A prepared dictionary of the `Dictionary` class of the TypeScript layer,
/// which holds it as the `External` that [`create_dictionary`] returns, until
/// [`close_dictionary`] drops it.
///
/// The functions that take the handle clone the `Arc` on the JavaScript
/// thread, so a call on the thread pool keeps the dictionary alive while
/// `close()` drops the handle's own reference: the memory goes when the last
/// call that uses it ends.
pub struct NextDictionary(RwLock<Option<Arc<Dictionary>>>);

impl NextDictionary {
    /// The prepared dictionary, or [`ComprsError::InvalidArg`] ("this
    /// Dictionary is closed") once [`close_dictionary`] dropped it.
    fn get(&self) -> Result<Arc<Dictionary>, ComprsError> {
        // No code that holds the lock panics, but a poisoned lock would
        // hold a consistent value anyway.
        let dictionary = self.0.read().unwrap_or_else(PoisonError::into_inner);
        dictionary
            .clone()
            .ok_or_else(|| ComprsError::InvalidArg("this Dictionary is closed".to_string()))
    }
}

/// The prepared dictionary of `handle`, if the arguments have one: see
/// [`NextDictionary::get`].
fn prepared(
    handle: Option<&External<NextDictionary>>,
) -> Result<Option<Arc<Dictionary>>, ComprsError> {
    handle.map(|handle| handle.get()).transpose()
}

/// The dictionary of a call: the prepared one if there is one, which the
/// TypeScript layer passes in place of the bytes of a dictionary, or those
/// bytes.
fn dictionary_ref<'a>(
    prepared: Option<&'a Dictionary>,
    bytes: Option<&'a [u8]>,
) -> Option<DictionaryRef<'a>> {
    prepared
        .map(DictionaryRef::Prepared)
        .or(bytes.map(DictionaryRef::Raw))
}

/// Prepare a dictionary for the format named `format`, `zstd` or `brotli`,
/// from a copy of `bytes`, with [`Dictionary::new`], which prepares a zstd
/// dictionary for the compression `level` and for decompression:
/// `Dictionary.from()` of the unified API.
///
/// The `External` reports the memory of the dictionary to V8 when it is
/// created, so that the garbage collector weighs it: the bytes and the
/// prepared zstd dictionaries. The compression levels that a zstd
/// dictionary prepares later, up to 3, are not reported.
#[napi(namespace = "next", skip_typescript)]
pub fn create_dictionary(
    env: Env,
    bytes: &[u8],
    format: String,
    level: Option<f64>,
) -> napi::Result<External<NextDictionary>> {
    let dictionary = format
        .parse::<DictionaryFormat>()
        .and_then(|format| Dictionary::new(bytes, format, level))
        .map_err(|err| coded_error(&env, &err))?;
    let size = dictionary.memory_usage();
    let handle = NextDictionary(RwLock::new(Some(Arc::new(dictionary))));
    Ok(External::new_with_size_hint(handle, size))
}

/// A copy of the bytes of the dictionary of `handle`: `toBytes()` of the
/// `Dictionary` class.
#[napi(namespace = "next", skip_typescript)]
pub fn dictionary_to_bytes(
    env: Env,
    handle: &External<NextDictionary>,
) -> napi::Result<Uint8Array> {
    sync_output(
        &env,
        handle.get().map(|dictionary| dictionary.raw().to_vec()),
    )
}

/// Drop the reference of `handle` to its dictionary, whose memory goes once
/// no call uses it, rather than when the garbage collector collects the
/// `External`: `close()` of the `Dictionary` class. Later calls with the
/// handle fail with "this Dictionary is closed"; closing it again does
/// nothing.
#[napi(namespace = "next", skip_typescript)]
pub fn close_dictionary(handle: &External<NextDictionary>) {
    let mut dictionary = handle.0.write().unwrap_or_else(PoisonError::into_inner);
    *dictionary = None;
}

/// Compress `data` in `format`: `compressSync()` of the unified API, with
/// the fields of its options as positional arguments, which
/// [`unified::compress_fields`] checks in its order.
///
/// `dictionary` holds the bytes of a dictionary, for zstd and brotli.
/// `gzipHeader` tells whether the options have a gzip header, for gzip,
/// which may have no fields; `gzipFilename` and `gzipMtime` hold its fields
/// and imply it. `workers` is the number of zstd worker threads.
/// `dictionaryHandle`, last, holds a prepared dictionary in place of the
/// bytes of one: the TypeScript layer passes at most one of the two, and
/// the prepared one would win.
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
    dictionary_handle: Option<&External<NextDictionary>>,
) -> napi::Result<Uint8Array> {
    let result = prepared(dictionary_handle).and_then(|prepared| {
        unified::compress_fields(
            data,
            &format,
            level,
            dictionary_ref(prepared.as_deref(), dictionary),
            gzip_header,
            gzip_filename,
            gzip_mtime,
            workers,
        )
    });
    sync_output(&env, result)
}

/// [`compress`] on the libuv thread pool: `compress()` of the unified API.
/// `withdrawalHandle`, after `dictionaryHandle`, is the handle from
/// [`create_withdrawal`] through which [`withdraw`] withdraws the task of a
/// call that has a signal.
#[napi(namespace = "next", skip_typescript)]
#[allow(clippy::too_many_arguments)] // The fields of the options, and the withdrawal.
pub fn compress_async(
    data: AsyncArg<&[u8]>,
    format: AsyncArg<String>,
    level: AsyncArg<Option<f64>>,
    dictionary: AsyncArg<Option<&[u8]>>,
    gzip_header: AsyncArg<Option<bool>>,
    gzip_filename: AsyncArg<Option<String>>,
    gzip_mtime: AsyncArg<Option<f64>>,
    workers: AsyncArg<Option<f64>>,
    dictionary_handle: AsyncArg<Option<&External<NextDictionary>>>,
    withdrawal_handle: AsyncArg<Option<&External<Withdrawal>>>,
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
        // On this thread, before close() can drop the handle's reference.
        let prepared = prepared(dictionary_handle.get()?);
        let withdrawal = withdrawal(withdrawal_handle.get()?);
        // The task checks the options, so that their errors reject the
        // Promise with the coded errors of `NextBytes`, as does that of a
        // closed dictionary.
        let task = OneShot::new(move || {
            let prepared = prepared?;
            unified::compress_fields(
                &data,
                &format,
                level,
                dictionary_ref(prepared.as_deref(), dictionary.as_deref()),
                gzip_header,
                gzip_filename,
                gzip_mtime,
                workers,
            )
        });
        Ok(Withdrawable::new(task, withdrawal))
    })
}

/// Decompress `data` in `format`, or in the format that detection finds if
/// `format` is `null` or `undefined`: `decompressSync()` of the unified API,
/// with the fields of its options as positional arguments, which
/// [`unified::decompress_fields`] checks in its order.
///
/// `dictionary` holds the bytes of a dictionary, for zstd and brotli, and
/// `dictionaryHandle` a prepared dictionary in its place, as for
/// [`compress`]. Without a `format`, a prepared dictionary selects its own.
#[napi(namespace = "next", skip_typescript)]
pub fn decompress(
    env: Env,
    data: &[u8],
    format: Option<String>,
    max_output_size: Option<f64>,
    dictionary: Option<&[u8]>,
    dictionary_handle: Option<&External<NextDictionary>>,
) -> napi::Result<Uint8Array> {
    let result = prepared(dictionary_handle).and_then(|prepared| {
        unified::decompress_fields(
            data,
            format.as_deref(),
            max_output_size,
            dictionary_ref(prepared.as_deref(), dictionary),
        )
    });
    sync_output(&env, result)
}

/// [`decompress`] on the libuv thread pool: `decompress()` of the unified
/// API, with a `withdrawalHandle` last, as [`compress_async`] takes.
#[napi(namespace = "next", skip_typescript)]
pub fn decompress_async(
    data: AsyncArg<&[u8]>,
    format: AsyncArg<Option<String>>,
    max_output_size: AsyncArg<Option<f64>>,
    dictionary: AsyncArg<Option<&[u8]>>,
    dictionary_handle: AsyncArg<Option<&External<NextDictionary>>>,
    withdrawal_handle: AsyncArg<Option<&External<Withdrawal>>>,
) -> NextTask {
    checked(|| {
        let data = data.get()?.to_vec();
        let format = format.get()?;
        let max_output_size = max_output_size.get()?;
        let dictionary = dictionary.get()?.map(<[u8]>::to_vec);
        let prepared = prepared(dictionary_handle.get()?);
        let withdrawal = withdrawal(withdrawal_handle.get()?);
        let task = OneShot::new(move || {
            let prepared = prepared?;
            unified::decompress_fields(
                &data,
                format.as_deref(),
                max_output_size,
                dictionary_ref(prepared.as_deref(), dictionary.as_deref()),
            )
        });
        Ok(Withdrawable::new(task, withdrawal))
    })
}

/// The codec state of a stream of the unified API: a compression or a
/// decompression stream of comprs-core, each boxed, as their sizes differ
/// by far: the decompression stream holds the brotli decoder inline.
pub enum NextCodec {
    Compress(Box<unified::CompressContext>),
    Decompress(Box<unified::DecompressContext>),
}

impl MemoryUsage for NextCodec {
    fn memory_usage(&self) -> usize {
        match self {
            NextCodec::Compress(context) => context.memory_usage(),
            NextCodec::Decompress(context) => context.memory_usage(),
        }
    }
}

impl StreamCodec for NextCodec {
    fn transform(&mut self, chunk: &[u8]) -> Result<Vec<u8>, ComprsError> {
        match self {
            NextCodec::Compress(context) => context.transform(chunk),
            NextCodec::Decompress(context) => context.transform(chunk),
        }
    }

    fn flush(&mut self) -> Result<Vec<u8>, ComprsError> {
        match self {
            NextCodec::Compress(context) => context.flush(),
            NextCodec::Decompress(context) => context.flush(),
        }
    }

    fn finish(&mut self) -> Result<Vec<u8>, ComprsError> {
        match self {
            NextCodec::Compress(context) => context.finish(),
            NextCodec::Decompress(context) => context.finish(),
        }
    }
}

/// A stream of the unified API, which the `CompressionStream` and
/// `DecompressionStream` classes of the TypeScript layer hold as the
/// `External` that [`create_compress_context`] or
/// [`create_decompress_context`] returns (#344). The `context*` functions
/// take it.
///
/// The state reports its memory to V8 as the state of the stream context
/// classes does (see `NativeState`): after every call, and down to zero
/// once [`context_finish`] or [`context_close`] drops the state. The
/// `External` closes the state when the garbage collector collects it, as
/// the finalizer of those classes does, so an abandoned stream frees its
/// memory too. A call in flight then drops the state when it settles. The
/// TypeScript layer makes at most one call at a time, so the "is busy"
/// error of `NativeState` does not reach it.
pub struct NextContext {
    state: NativeState<NextCodec>,
    /// The environment that created the stream, whose account of external
    /// memory the state reports to. The `External` is dropped on its thread,
    /// while the environment lives.
    env: Env,
}

impl NextContext {
    /// The `External` of a stream of `codec`, created or failed, whose
    /// errors name it `name`, such as "compression stream".
    fn open(
        env: Env,
        codec: Result<NextCodec, ComprsError>,
        name: &'static str,
    ) -> napi::Result<External<NextContext>> {
        let codec = codec.map_err(|err| coded_error(&env, &err))?;
        let state = NativeState::new(&env, codec, name);
        Ok(External::new(NextContext { state, env }))
    }
}

impl Drop for NextContext {
    fn drop(&mut self) {
        self.state.close(&self.env);
    }
}

/// The type of the task of the asynchronous `context*` functions.
type NextStreamTask = AsyncTask<Checked<StreamTask<NextCodec, NextStreamBytes>>>;

/// A compression stream in `format`, with the options of [`compress`],
/// which [`unified::CompressContext::from_fields`] checks in its order: the
/// state of `new CompressionStream()` of the unified API.
#[napi(namespace = "next", skip_typescript)]
#[allow(clippy::too_many_arguments)] // The fields of the options, and `env`.
pub fn create_compress_context(
    env: Env,
    format: String,
    level: Option<f64>,
    dictionary: Option<&[u8]>,
    gzip_header: Option<bool>,
    gzip_filename: Option<String>,
    gzip_mtime: Option<f64>,
    workers: Option<f64>,
    dictionary_handle: Option<&External<NextDictionary>>,
) -> napi::Result<External<NextContext>> {
    // The context copies what it needs of a prepared dictionary, so it
    // outlives a Dictionary that is closed first.
    let codec = prepared(dictionary_handle).and_then(|prepared| {
        unified::CompressContext::from_fields(
            &format,
            level,
            dictionary_ref(prepared.as_deref(), dictionary),
            gzip_header,
            gzip_filename,
            gzip_mtime,
            workers,
        )
    });
    let codec = codec.map(|context| NextCodec::Compress(Box::new(context)));
    NextContext::open(env, codec, "compression stream")
}

/// A decompression stream in `format`, or one that detects the format if
/// `format` is `null` or `undefined`, with the options of [`decompress`],
/// which [`unified::DecompressContext::from_fields`] checks in its order:
/// the state of `new DecompressionStream()` of the unified API.
#[napi(namespace = "next", skip_typescript)]
pub fn create_decompress_context(
    env: Env,
    format: Option<String>,
    max_output_size: Option<f64>,
    dictionary: Option<&[u8]>,
    dictionary_handle: Option<&External<NextDictionary>>,
) -> napi::Result<External<NextContext>> {
    let codec = prepared(dictionary_handle).and_then(|prepared| {
        unified::DecompressContext::from_fields(
            format.as_deref(),
            max_output_size,
            dictionary_ref(prepared.as_deref(), dictionary),
        )
    });
    let codec = codec.map(|context| NextCodec::Decompress(Box::new(context)));
    NextContext::open(env, codec, "decompression stream")
}

/// Pass `chunk` to the stream of `context`, and return the output that is
/// ready, as `sync_output` returns it.
#[napi(namespace = "next", skip_typescript)]
pub fn context_transform(
    env: Env,
    context: &External<NextContext>,
    chunk: &[u8],
) -> napi::Result<Uint8Array> {
    sync_output(
        &env,
        context.state.run(&env, |codec| codec.transform(chunk)),
    )
}

/// Return the output of the input so far of the stream of `context`.
#[napi(namespace = "next", skip_typescript)]
pub fn context_flush(env: Env, context: &External<NextContext>) -> napi::Result<Uint8Array> {
    sync_output(&env, context.state.run(&env, StreamCodec::flush))
}

/// End the stream of `context`, and return the rest of the output. The
/// state is dropped, whether the call succeeds or not.
#[napi(namespace = "next", skip_typescript)]
pub fn context_finish(env: Env, context: &External<NextContext>) -> napi::Result<Uint8Array> {
    sync_output(&env, context.state.finish(&env, StreamCodec::finish))
}

/// Drop the state of the stream of `context` now, rather than when the
/// garbage collector collects the `External`, unless it is finished or
/// closed already. With a call in flight, the call drops it when it
/// settles.
#[napi(namespace = "next", skip_typescript)]
pub fn context_close(env: Env, context: &External<NextContext>) {
    context.state.close(&env);
}

/// [`context_transform`] on the libuv thread pool, with a copy of `chunk`
/// taken when it is called, which settles as `NextStreamBytes` does.
#[napi(namespace = "next", skip_typescript)]
pub fn context_transform_async(
    context: AsyncArg<&External<NextContext>>,
    chunk: AsyncArg<&[u8]>,
) -> NextStreamTask {
    checked(|| {
        let context = context.get()?;
        let chunk = chunk.get()?.to_vec();
        Ok(StreamTask::new(&context.state, Op::Transform(chunk)))
    })
}

/// [`context_flush`] on the libuv thread pool.
#[napi(namespace = "next", skip_typescript)]
pub fn context_flush_async(context: AsyncArg<&External<NextContext>>) -> NextStreamTask {
    checked(|| Ok(StreamTask::new(&context.get()?.state, Op::Flush)))
}

/// [`context_finish`] on the libuv thread pool.
#[napi(namespace = "next", skip_typescript)]
pub fn context_finish_async(context: AsyncArg<&External<NextContext>>) -> NextStreamTask {
    checked(|| Ok(StreamTask::new(&context.get()?.state, Op::Finish)))
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
/// unified API, with a `withdrawalHandle` last, as [`compress_async`]
/// takes.
#[napi(namespace = "next", skip_typescript)]
pub fn train_dictionary_async(
    samples: AsyncArg<Vec<CopiedBytes>>,
    max_size: AsyncArg<Option<f64>>,
    withdrawal_handle: AsyncArg<Option<&External<Withdrawal>>>,
) -> NextTask {
    checked(|| {
        let samples = sample_bytes(samples.get()?);
        let max_size = max_size.get()?;
        let withdrawal = withdrawal(withdrawal_handle.get()?);
        let task = OneShot::new(move || unified::train_dictionary(&samples, max_size));
        Ok(Withdrawable::new(task, withdrawal))
    })
}

/// A handle for the task of one call of an `*Async` function, which takes it
/// last, and through which [`withdraw`] withdraws the task.
#[napi(namespace = "next", skip_typescript)]
pub fn create_withdrawal() -> External<Withdrawal> {
    External::new(Withdrawal::default())
}

/// Withdraw the task of the call that took `handle`: whether no thread of
/// the pool had reached it. A withdrawn task fails with a `Cancelled` error,
/// without running the codec, when a thread reaches it; the TypeScript layer
/// settles the call at once instead of waiting for that. A task that a
/// thread has reached runs to the end.
#[napi(namespace = "next", skip_typescript)]
pub fn withdraw(handle: &External<Withdrawal>) -> bool {
    handle.withdraw()
}

/// The codes that the errors of the unified API carry,
/// [`comprs_core::ERROR_CODES`], against which the tests check the
/// `ErrorCode` type of the TypeScript layer.
#[napi(namespace = "next", skip_typescript)]
pub fn error_codes() -> Vec<&'static str> {
    comprs_core::ERROR_CODES.to_vec()
}
