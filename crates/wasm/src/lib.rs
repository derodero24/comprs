#![deny(clippy::all)]

use std::alloc::{GlobalAlloc, Layout, handle_alloc_error};
use std::mem::MaybeUninit;

use js_sys::{Array, ArrayBuffer, Function, Object, Reflect, Symbol, Uint8Array};
use wasm_bindgen::prelude::*;

use comprs_core::ComprsError;

// The functions of the unified API, `@derodero24/comprs/next`, whose errors
// carry codes, unlike those of the functions below, which keep the errors of
// comprs 2.x.
mod next;

fn to_js_error(e: ComprsError) -> JsError {
    JsError::new(&e.to_string())
}

// ---------------------------------------------------------------------------
// Global allocator
// ---------------------------------------------------------------------------
//
// zstd links the C library, and on wasm32 zstd-sys replaces its malloc,
// calloc and free with a shim backed by Rust's global allocator (the
// `wasm_shim_alloc` in zstd-sys 2.1.0+zstd.1.5.7, built for
// wasm32-unknown-unknown and wasm32-wasi*). That shim does not check the
// allocator for failure: on a null result it writes a size header through the
// null pointer and returns a non-null pointer (address 4) to zstd, which then
// writes its window and tables into the start of linear memory and traps on
// an out-of-bounds access. zstd never sees a null, so it cannot report
// ZSTD_error_memory_allocation. The default allocator on wasm32 returns null
// (rather than aborting) once the module's memory cannot grow, which a frame
// with a large window or a high compression level can force.
//
// Wrapping the allocator so a null result becomes `handle_alloc_error` means
// the shim can never receive null: an allocation that cannot be satisfied
// aborts at the allocation site, which wasm turns into a trap that JS sees as
// a RuntimeError, instead of corrupting memory. The shim calls the global
// allocator, so this covers every zstd allocation.
//
// This matters only where that shim is linked, so the allocator is installed
// for wasm32 alone; the wrapper is still compiled for the host so its logic
// can be unit-tested there.
#[cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]
struct AbortOnOom<A>(A);

// SAFETY: every method forwards to the inner allocator with the same
// arguments and returns its pointer unchanged when it is non-null, so the
// allocator contract is upheld; the only added behavior is aborting instead
// of propagating a null (failure) result.
unsafe impl<A: GlobalAlloc> GlobalAlloc for AbortOnOom<A> {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        nonnull_or_abort(unsafe { self.0.alloc(layout) }, layout)
    }

    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        nonnull_or_abort(unsafe { self.0.alloc_zeroed(layout) }, layout)
    }

    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        let new_ptr = unsafe { self.0.realloc(ptr, layout, new_size) };
        if new_ptr.is_null() {
            // On failure the original allocation is untouched; the layout for
            // the error is the requested new size at the existing alignment.
            handle_alloc_error(Layout::from_size_align(new_size, layout.align()).unwrap_or(layout));
        }
        new_ptr
    }

    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        unsafe { self.0.dealloc(ptr, layout) }
    }
}

/// Return `ptr`, or abort via [`handle_alloc_error`] if it is null.
#[cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]
#[inline]
fn nonnull_or_abort(ptr: *mut u8, layout: Layout) -> *mut u8 {
    if ptr.is_null() {
        handle_alloc_error(layout);
    }
    ptr
}

#[cfg(target_arch = "wasm32")]
#[global_allocator]
static ALLOCATOR: AbortOnOom<std::alloc::System> = AbortOnOom(std::alloc::System);

// ---------------------------------------------------------------------------
// Panics
// ---------------------------------------------------------------------------

#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(js_namespace = console, js_name = error)]
    fn console_error(message: &str);
}

/// Runs when the module is instantiated.
///
/// On wasm32-unknown-unknown, a panic aborts with a trap, which JS sees as a
/// bare `RuntimeError: unreachable`, and the default panic hook has nowhere
/// to print its message. Log the message instead.
#[wasm_bindgen(start)]
fn start() {
    std::panic::set_hook(Box::new(|info| console_error(&info.to_string())));
}

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------
//
// The bindings take and return what the native addon (crates/core) does.

#[wasm_bindgen]
extern "C" {
    /// A byte array argument: a `Uint8Array` (or `Buffer`), or another
    /// ArrayBuffer view, whose bytes the native addon reads as well.
    ///
    /// The glue that wasm-bindgen generates for a `&[u8]` argument does not
    /// check its type: it reads an ArrayBuffer as empty, and a string as one
    /// zero byte per character. Byte arrays are taken as this type instead,
    /// and checked by `Bytes::to_vec`.
    #[wasm_bindgen(typescript_type = "Uint8Array")]
    pub type Bytes;

    /// The getter of a property of `%TypedArray%.prototype` or
    /// `DataView.prototype`, which reads an internal slot of a view. Those
    /// of `buffer`, `byteOffset`, `byteLength` and `length` throw for
    /// anything but a view of their kind.
    #[wasm_bindgen(extends = Function)]
    type Getter;

    /// `getter.call(value)`, for the getter of
    /// `%TypedArray%.prototype[Symbol.toStringTag]`: it returns the name of
    /// the type of a typed array, which the glue reads as `Some(true)`, and
    /// `undefined` for any other value, which it reads as `None`, without
    /// the heap slot that a `JsValue` would take. This needs the release
    /// glue, which `debug-js-glue = false` in Cargo.toml pins for the
    /// profile that scripts/build-wasm-bindgen.js builds with: the debug glue
    /// (`wasm-pack build --dev`) throws for a value that is not a boolean.
    #[wasm_bindgen(method, js_name = call)]
    fn call_tag(this: &Getter, value: &Bytes) -> Option<bool>;

    /// `getter.call(view)`, for a getter that returns a number.
    #[wasm_bindgen(method, catch, js_name = call)]
    fn try_call(this: &Getter, view: &Bytes) -> Result<f64, JsValue>;

    /// `getter.call(view)`, for a getter that returns a number and does not
    /// throw for `view`.
    #[wasm_bindgen(method, js_name = call)]
    fn call(this: &Getter, view: &Bytes) -> f64;

    /// `getter.call(view)`, for a getter that does not throw for `view`.
    #[wasm_bindgen(method, js_name = call)]
    fn call_value(this: &Getter, view: &Bytes) -> JsValue;

    /// A `Uint8Array` over the bytes of a view.
    #[wasm_bindgen(extends = Bytes, js_name = Uint8Array)]
    type ByteView;

    /// `new Uint8Array(buffer, byteOffset, length)`, with numbers that may
    /// exceed those of `Uint8Array::new_with_byte_offset_and_length`.
    #[wasm_bindgen(constructor, js_class = "Uint8Array")]
    fn new(buffer: &JsValue, byte_offset: f64, length: f64) -> ByteView;

    /// `Uint8Array.prototype.set.call(target, source)`: copy the bytes of
    /// `source`, a typed array of bytes that holds as many as `target`, into
    /// `target`.
    #[wasm_bindgen(js_namespace = Uint8Array, js_name = "prototype.set.call")]
    fn copy_bytes(target: &mut [MaybeUninit<u8>], source: &Bytes);

    /// `Uint8Array.prototype`, whose prototype is `%TypedArray%.prototype`.
    #[wasm_bindgen(thread_local_v2, js_namespace = Uint8Array, js_name = prototype)]
    static UINT8_ARRAY_PROTOTYPE: Object;

    /// `DataView.prototype`.
    #[wasm_bindgen(thread_local_v2, js_namespace = DataView, js_name = prototype)]
    static DATA_VIEW_PROTOTYPE: Object;
}

impl Bytes {
    /// Copy the bytes into Wasm memory, or fail, as the native addon does,
    /// if this is not an ArrayBuffer view. `name` names the argument.
    ///
    /// Like the native addon, this reads the internal slots of the view,
    /// through the getters of its kind (#697): its own properties, or those
    /// of a subclass, can say anything. The glue of js-sys's
    /// `Uint8Array::to_vec`, for one, sizes its copy by `length`.
    // One copy of this, rather than one in each function that takes bytes,
    // keeps the module smaller.
    #[inline(never)]
    fn to_vec(&self, name: &str) -> Result<Vec<u8>, JsError> {
        VIEW_GETTERS.with(|getters| {
            if getters.tag.call_tag(self).is_some() {
                // A typed array, of any type and realm. Its getters return 0
                // when its ArrayBuffer is detached, or has shrunk to end
                // before the typed array does.
                let byte_length = getters.typed_array.byte_length.call(self);
                // A Uint8Array (or Buffer), Int8Array or Uint8ClampedArray,
                // whose elements are its bytes.
                if getters.length.call(self) == byte_length {
                    return Ok(copy(self, byte_length));
                }
                return Ok(getters.typed_array.copy(self, byte_length));
            }
            if !ArrayBuffer::is_view(self) {
                return Err(JsError::new(&format!("{name} must be a Uint8Array")));
            }
            // A DataView. Its getters throw where those of a typed array
            // return 0. The native addon reads no bytes then.
            Ok(match getters.data_view.byte_length.try_call(self) {
                Ok(byte_length) => getters.data_view.copy(self, byte_length),
                Err(_) => Vec::new(),
            })
        })
    }
}

/// Copy `source`, a typed array of `byte_length` elements of a byte each, as
/// the getters of `%TypedArray%.prototype` read it, into Wasm memory.
fn copy(source: &Bytes, byte_length: f64) -> Vec<u8> {
    // An empty typed array, or one whose ArrayBuffer is detached, which
    // Uint8Array.prototype.set() rejects.
    if byte_length == 0.0 {
        return Vec::new();
    }
    // A length that Wasm memory cannot hold traps here, as an allocation
    // that cannot be satisfied does (see `AbortOnOom`).
    let length = byte_length as usize;
    let mut bytes = Vec::with_capacity(length);
    copy_bytes(&mut bytes.spare_capacity_mut()[..length], source);
    // SAFETY: set() has written each of the first `length` bytes of the
    // allocation: it copies every element of `source`, or throws if they do
    // not fit, and `source` holds `length` elements of a byte each, as the
    // getters, which read its internal slots, say. No JavaScript code runs
    // on this thread between them and set(). Other threads can only grow a
    // SharedArrayBuffer, and growing Wasm memory for the allocation only
    // detaches the ArrayBuffer of that memory; set() throws if either
    // changed `source`.
    unsafe { bytes.set_len(length) };
    bytes
}

/// The getters of the `buffer`, `byteOffset` and `byteLength` properties
/// that a kind of ArrayBuffer view inherits.
struct KindGetters {
    buffer: Getter,
    byte_offset: Getter,
    byte_length: Getter,
}

impl KindGetters {
    /// The getters of the properties of `prototype`.
    fn of(prototype: &Object) -> Self {
        Self {
            buffer: getter(prototype, &"buffer".into()),
            byte_offset: getter(prototype, &"byteOffset".into()),
            byte_length: getter(prototype, &"byteLength".into()),
        }
    }

    /// Copy the bytes of `view`, whose `byteLength` getter returned
    /// `byte_length`, into Wasm memory. The other getters do not throw then.
    fn copy(&self, view: &Bytes, byte_length: f64) -> Vec<u8> {
        if byte_length == 0.0 {
            return Vec::new();
        }
        let buffer = self.buffer.call_value(view);
        let byte_offset = self.byte_offset.call(view);
        let bytes = ByteView::new(&buffer, byte_offset, byte_length);
        copy(&bytes, byte_length)
    }
}

/// The getter of the property `key` of `prototype`.
fn getter(prototype: &Object, key: &JsValue) -> Getter {
    let descriptor = Object::get_own_property_descriptor(prototype, key);
    Reflect::get(&descriptor, &"get".into())
        .unwrap_or_default()
        .unchecked_into()
}

/// The getters that ArrayBuffer views inherit.
struct ViewGetters {
    /// Those of `%TypedArray%.prototype`, which every typed array inherits.
    typed_array: KindGetters,
    /// The getter of `%TypedArray%.prototype[Symbol.toStringTag]`.
    tag: Getter,
    /// The getter of `%TypedArray%.prototype.length`.
    length: Getter,
    /// Those of `DataView.prototype`.
    data_view: KindGetters,
}

thread_local! {
    /// The getters that ArrayBuffer views inherit, read once.
    static VIEW_GETTERS: ViewGetters = {
        let typed_array =
            UINT8_ARRAY_PROTOTYPE.with(|prototype| Object::get_prototype_of(prototype));
        ViewGetters {
            tag: getter(&typed_array, &Symbol::to_string_tag()),
            length: getter(&typed_array, &"length".into()),
            typed_array: KindGetters::of(&typed_array),
            data_view: DATA_VIEW_PROTOTYPE.with(KindGetters::of),
        }
    };
}

#[wasm_bindgen(typescript_custom_section)]
const GZIP_HEADER_TYPES: &str = r#"
export interface GzipHeaderOptions {
  filename?: string;
  mtime?: number;
}

export interface GzipHeader {
  filename?: string;
  mtime: number;
  comment?: string;
  os: number;
  extra?: Uint8Array;
}
"#;

#[wasm_bindgen]
extern "C" {
    /// The `header` argument of `gzipCompressWithHeader()`.
    #[wasm_bindgen(typescript_type = "GzipHeaderOptions")]
    pub type GzipHeaderOptions;

    #[wasm_bindgen(method, getter, catch)]
    fn filename(this: &GzipHeaderOptions) -> Result<JsValue, JsValue>;

    #[wasm_bindgen(method, getter, catch)]
    fn mtime(this: &GzipHeaderOptions) -> Result<JsValue, JsValue>;
}

impl GzipHeaderOptions {
    /// Read the header fields as the native addon does: reading them throws
    /// a TypeError if the header is `null` or `undefined`, other values are
    /// read as objects, and only `undefined` leaves a field out.
    ///
    /// Returns the file name and the mtime as a number, which the caller
    /// validates with `gzip::MTIME` after the level, in the native addon's
    /// order.
    fn read(&self) -> Result<(Option<String>, Option<f64>), JsValue> {
        let filename = match self.filename()? {
            value if value.is_undefined() => None,
            value => {
                let name = value.as_string();
                Some(name.ok_or_else(|| JsError::new("header.filename must be a string"))?)
            }
        };
        let mtime = match self.mtime()? {
            value if value.is_undefined() => None,
            value => {
                let seconds = value.as_f64();
                Some(seconds.ok_or_else(|| JsError::new("header.mtime must be a number"))?)
            }
        };
        Ok((filename, mtime))
    }
}

#[wasm_bindgen(typescript_custom_section)]
const STREAM_CONTEXT_OPTIONS_TYPES: &str = r#"
export interface StreamContextOptions {
  incremental?: boolean | undefined;
}
"#;

/// Read the `options` argument of a stream context constructor, as the
/// native addon does (crates/core/src/options.rs): whether it sets
/// `incremental`. `undefined` and `null` stand for no options, and for no
/// `incremental`; other values that are not objects, and an `incremental`
/// that is not a boolean, are rejected with the native addon's messages.
/// wasm-bindgen does not check the type of an object argument, so the value
/// is taken as it is and checked here. A getter that throws throws its
/// error.
fn stream_context_options(options: &JsValue) -> Result<bool, JsValue> {
    if options.is_undefined() || options.is_null() {
        return Ok(false);
    }
    if !options.is_object() {
        return Err(invalid_arg("options must be an object"));
    }
    let incremental = Reflect::get(options, &JsValue::from_str("incremental"))?;
    if incremental.is_undefined() || incremental.is_null() {
        return Ok(false);
    }
    incremental
        .as_bool()
        .ok_or_else(|| invalid_arg("incremental must be a boolean"))
}

fn invalid_arg(message: &str) -> JsValue {
    to_js_error(ComprsError::InvalidArg(message.to_string())).into()
}

// ---------------------------------------------------------------------------
// Version
// ---------------------------------------------------------------------------

#[wasm_bindgen]
pub fn version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

// ---------------------------------------------------------------------------
// Zstd one-shot
// ---------------------------------------------------------------------------

#[wasm_bindgen(js_name = "zstdCompress")]
pub fn zstd_compress(data: &Bytes, level: Option<f64>) -> Result<Vec<u8>, JsError> {
    let data = data.to_vec("data")?;
    let level = comprs_core::zstd::LEVEL
        .check_optional_f64(level)
        .map_err(to_js_error)?;
    comprs_core::zstd::compress(&data, level).map_err(to_js_error)
}

#[wasm_bindgen(js_name = "zstdDecompress")]
pub fn zstd_decompress(data: &Bytes) -> Result<Vec<u8>, JsError> {
    comprs_core::zstd::decompress(&data.to_vec("data")?).map_err(to_js_error)
}

#[wasm_bindgen(js_name = "zstdDecompressWithCapacity")]
pub fn zstd_decompress_with_capacity(data: &Bytes, capacity: f64) -> Result<Vec<u8>, JsError> {
    let data = data.to_vec("data")?;
    let cap = comprs_core::validate_capacity(capacity).map_err(to_js_error)?;
    comprs_core::zstd::decompress_with_capacity(&data, cap).map_err(to_js_error)
}

#[wasm_bindgen(js_name = "zstdTrainDictionary")]
pub fn zstd_train_dictionary(
    #[wasm_bindgen(unchecked_param_type = "Uint8Array[]")] samples: &JsValue,
    max_dict_size: Option<f64>,
) -> Result<Vec<u8>, JsError> {
    if !Array::is_array(samples) {
        return Err(JsError::new("samples must be an array"));
    }
    let sample_vecs = samples
        .unchecked_ref::<Array>()
        .iter()
        .map(|sample| sample.unchecked_into::<Bytes>().to_vec("every sample"))
        .collect::<Result<Vec<_>, _>>()?;

    let max_size = comprs_core::zstd::DICT_SIZE
        .check_optional_f64(max_dict_size)
        .map_err(to_js_error)?
        .unwrap_or(comprs_core::zstd::DEFAULT_MAX_DICT_SIZE);

    comprs_core::zstd::train_dictionary(&sample_vecs, max_size).map_err(to_js_error)
}

#[wasm_bindgen(js_name = "zstdCompressWithDict")]
pub fn zstd_compress_with_dict(
    data: &Bytes,
    dict: &Bytes,
    level: Option<f64>,
) -> Result<Vec<u8>, JsError> {
    let data = data.to_vec("data")?;
    let dict = dict.to_vec("dict")?;
    let level = comprs_core::zstd::LEVEL
        .check_optional_f64(level)
        .map_err(to_js_error)?;
    comprs_core::zstd::compress_with_dict(&data, &dict, level).map_err(to_js_error)
}

#[wasm_bindgen(js_name = "zstdDecompressWithDict")]
pub fn zstd_decompress_with_dict(data: &Bytes, dict: &Bytes) -> Result<Vec<u8>, JsError> {
    comprs_core::zstd::decompress_with_dict(&data.to_vec("data")?, &dict.to_vec("dict")?)
        .map_err(to_js_error)
}

#[wasm_bindgen(js_name = "zstdDecompressWithDictWithCapacity")]
pub fn zstd_decompress_with_dict_with_capacity(
    data: &Bytes,
    dict: &Bytes,
    capacity: f64,
) -> Result<Vec<u8>, JsError> {
    let data = data.to_vec("data")?;
    let dict = dict.to_vec("dict")?;
    let cap = comprs_core::validate_capacity(capacity).map_err(to_js_error)?;
    comprs_core::zstd::decompress_with_dict_with_capacity(&data, &dict, cap).map_err(to_js_error)
}

// ---------------------------------------------------------------------------
// Gzip one-shot
// ---------------------------------------------------------------------------

#[wasm_bindgen(js_name = "gzipCompress")]
pub fn gzip_compress(data: &Bytes, level: Option<f64>) -> Result<Vec<u8>, JsError> {
    let data = data.to_vec("data")?;
    let level = comprs_core::gzip::LEVEL
        .check_optional_f64(level)
        .map_err(to_js_error)?;
    comprs_core::gzip::compress(&data, level).map_err(to_js_error)
}

#[wasm_bindgen(js_name = "gzipDecompress")]
pub fn gzip_decompress(data: &Bytes) -> Result<Vec<u8>, JsError> {
    comprs_core::gzip::decompress(&data.to_vec("data")?).map_err(to_js_error)
}

#[wasm_bindgen(js_name = "gzipDecompressWithCapacity")]
pub fn gzip_decompress_with_capacity(data: &Bytes, capacity: f64) -> Result<Vec<u8>, JsError> {
    let data = data.to_vec("data")?;
    let cap = comprs_core::validate_capacity(capacity).map_err(to_js_error)?;
    comprs_core::gzip::decompress_with_capacity(&data, cap).map_err(to_js_error)
}

#[wasm_bindgen(js_name = "gzipCompressWithHeader")]
pub fn gzip_compress_with_header(
    data: &Bytes,
    header: &GzipHeaderOptions,
    level: Option<f64>,
) -> Result<Vec<u8>, JsValue> {
    let data = data.to_vec("data")?;
    let (filename, mtime) = header.read()?;
    let level = comprs_core::gzip::LEVEL
        .check_optional_f64(level)
        .map_err(to_js_error)?;
    let mtime = comprs_core::gzip::MTIME
        .check_optional_f64(mtime)
        .map_err(to_js_error)?;
    let header = comprs_core::gzip::GzipHeaderOptions { filename, mtime };
    comprs_core::gzip::compress_with_header(&data, &header, level)
        .map_err(|e| to_js_error(e).into())
}

#[wasm_bindgen(js_name = "gzipReadHeader", unchecked_return_type = "GzipHeader")]
pub fn gzip_read_header(data: &Bytes) -> Result<JsValue, JsValue> {
    let h = comprs_core::gzip::read_header(&data.to_vec("data")?).map_err(to_js_error)?;

    // The fields of the native addon's GzipHeader, in its order: the ones it
    // always has, then the optional ones that the header has.
    let header = Object::new();
    let set = |key: &str, value: JsValue| Reflect::set(&header, &key.into(), &value).map(drop);
    set("mtime", h.mtime.into())?;
    set("os", h.os.into())?;
    if let Some(filename) = h.filename {
        set("filename", filename.into())?;
    }
    if let Some(comment) = h.comment {
        set("comment", comment.into())?;
    }
    if let Some(extra) = h.extra {
        set("extra", Uint8Array::from(extra.as_slice()).into())?;
    }
    Ok(header.into())
}

// ---------------------------------------------------------------------------
// Deflate one-shot
// ---------------------------------------------------------------------------

#[wasm_bindgen(js_name = "deflateCompress")]
pub fn deflate_compress(data: &Bytes, level: Option<f64>) -> Result<Vec<u8>, JsError> {
    let data = data.to_vec("data")?;
    let level = comprs_core::gzip::DEFLATE_LEVEL
        .check_optional_f64(level)
        .map_err(to_js_error)?;
    comprs_core::gzip::deflate_compress(&data, level).map_err(to_js_error)
}

#[wasm_bindgen(js_name = "deflateDecompress")]
pub fn deflate_decompress(data: &Bytes) -> Result<Vec<u8>, JsError> {
    comprs_core::gzip::deflate_decompress(&data.to_vec("data")?).map_err(to_js_error)
}

#[wasm_bindgen(js_name = "deflateDecompressWithCapacity")]
pub fn deflate_decompress_with_capacity(data: &Bytes, capacity: f64) -> Result<Vec<u8>, JsError> {
    let data = data.to_vec("data")?;
    let cap = comprs_core::validate_capacity(capacity).map_err(to_js_error)?;
    comprs_core::gzip::deflate_decompress_with_capacity(&data, cap).map_err(to_js_error)
}

// ---------------------------------------------------------------------------
// Brotli one-shot
// ---------------------------------------------------------------------------

#[wasm_bindgen(js_name = "brotliCompress")]
pub fn brotli_compress(data: &Bytes, quality: Option<f64>) -> Result<Vec<u8>, JsError> {
    let data = data.to_vec("data")?;
    let quality = comprs_core::brotli::QUALITY
        .check_optional_f64(quality)
        .map_err(to_js_error)?;
    comprs_core::brotli::compress(&data, quality).map_err(to_js_error)
}

#[wasm_bindgen(js_name = "brotliDecompress")]
pub fn brotli_decompress(data: &Bytes) -> Result<Vec<u8>, JsError> {
    comprs_core::brotli::decompress(&data.to_vec("data")?).map_err(to_js_error)
}

#[wasm_bindgen(js_name = "brotliDecompressWithCapacity")]
pub fn brotli_decompress_with_capacity(data: &Bytes, capacity: f64) -> Result<Vec<u8>, JsError> {
    let data = data.to_vec("data")?;
    let cap = comprs_core::validate_capacity(capacity).map_err(to_js_error)?;
    comprs_core::brotli::decompress_with_capacity(&data, cap).map_err(to_js_error)
}

#[wasm_bindgen(js_name = "brotliCompressWithDict")]
pub fn brotli_compress_with_dict(
    data: &Bytes,
    dict: &Bytes,
    quality: Option<f64>,
) -> Result<Vec<u8>, JsError> {
    let data = data.to_vec("data")?;
    let dict = dict.to_vec("dict")?;
    let quality = comprs_core::brotli::QUALITY
        .check_optional_f64(quality)
        .map_err(to_js_error)?;
    comprs_core::brotli::compress_with_dict(&data, &dict, quality).map_err(to_js_error)
}

#[wasm_bindgen(js_name = "brotliDecompressWithDict")]
pub fn brotli_decompress_with_dict(data: &Bytes, dict: &Bytes) -> Result<Vec<u8>, JsError> {
    comprs_core::brotli::decompress_with_dict(&data.to_vec("data")?, &dict.to_vec("dict")?)
        .map_err(to_js_error)
}

#[wasm_bindgen(js_name = "brotliDecompressWithDictWithCapacity")]
pub fn brotli_decompress_with_dict_with_capacity(
    data: &Bytes,
    dict: &Bytes,
    capacity: f64,
) -> Result<Vec<u8>, JsError> {
    let data = data.to_vec("data")?;
    let dict = dict.to_vec("dict")?;
    let cap = comprs_core::validate_capacity(capacity).map_err(to_js_error)?;
    comprs_core::brotli::decompress_with_dict_with_capacity(&data, &dict, cap).map_err(to_js_error)
}

// ---------------------------------------------------------------------------
// LZ4 one-shot
// ---------------------------------------------------------------------------

#[wasm_bindgen(js_name = "lz4Compress")]
pub fn lz4_compress(data: &Bytes) -> Result<Vec<u8>, JsError> {
    comprs_core::lz4::compress(&data.to_vec("data")?).map_err(to_js_error)
}

#[wasm_bindgen(js_name = "lz4Decompress")]
pub fn lz4_decompress(data: &Bytes) -> Result<Vec<u8>, JsError> {
    comprs_core::lz4::decompress(&data.to_vec("data")?).map_err(to_js_error)
}

#[wasm_bindgen(js_name = "lz4DecompressWithCapacity")]
pub fn lz4_decompress_with_capacity(data: &Bytes, capacity: f64) -> Result<Vec<u8>, JsError> {
    let data = data.to_vec("data")?;
    let cap = comprs_core::validate_capacity(capacity).map_err(to_js_error)?;
    comprs_core::lz4::decompress_with_capacity(&data, cap).map_err(to_js_error)
}

// ---------------------------------------------------------------------------
// Auto-detect
// ---------------------------------------------------------------------------

#[wasm_bindgen(js_name = "detectFormat")]
pub fn detect_format(data: &Bytes) -> Result<String, JsError> {
    Ok(comprs_core::detect::detect(&data.to_vec("data")?).to_string())
}

/// Decompress data by auto-detecting the compression format.
///
/// `max_output_size` limits the output size and defaults to 256 MB.
#[wasm_bindgen(js_name = "decompress")]
pub fn decompress(data: &Bytes, max_output_size: Option<f64>) -> Result<Vec<u8>, JsError> {
    let data = data.to_vec("data")?;
    let max_size = comprs_core::validate_max_output_size(max_output_size).map_err(to_js_error)?;
    comprs_core::detect::decompress_with_capacity(&data, max_size).map_err(to_js_error)
}

// ---------------------------------------------------------------------------
// CRC32
// ---------------------------------------------------------------------------

#[wasm_bindgen]
pub fn crc32(data: &Bytes, initial_value: Option<f64>) -> Result<u32, JsError> {
    let data = data.to_vec("data")?;
    let initial_value = comprs_core::crc::INITIAL_VALUE
        .check_optional_f64(initial_value)
        .map_err(to_js_error)?;
    Ok(comprs_core::crc::crc32(&data, initial_value))
}

// ===========================================================================
// Streaming contexts
// ===========================================================================

/// The codec state of a stream context, kept as the native addon keeps it
/// (`NativeState` in crates/core/src/context.rs), without the report of its
/// memory to the engine: `finish()` and `close()` drop the state, and later
/// calls throw `<name> already finished` or `<name> already closed`.
struct StreamState<T> {
    state: State<T>,
    /// Name of the stream in errors, such as "zstd stream".
    name: &'static str,
}

enum State<T> {
    Open(T),
    Finished,
    Closed,
}

impl<T> StreamState<T> {
    fn new(state: T, name: &'static str) -> Self {
        Self {
            state: State::Open(state),
            name,
        }
    }

    /// Run `op` on the state.
    fn run(
        &mut self,
        op: impl FnOnce(&mut T) -> Result<Vec<u8>, ComprsError>,
    ) -> Result<Vec<u8>, JsError> {
        self.try_run(op).map_err(to_js_error)
    }

    /// Run `op`, which ends the stream, then drop the state, whether `op`
    /// succeeded or not: the codecs cannot continue after either.
    fn finish(
        &mut self,
        op: impl FnOnce(&mut T) -> Result<Vec<u8>, ComprsError>,
    ) -> Result<Vec<u8>, JsError> {
        self.try_finish(op).map_err(to_js_error)
    }

    /// [`run`](Self::run), with the error of comprs-core, for the streams of
    /// the unified API, whose errors carry codes.
    fn try_run(
        &mut self,
        op: impl FnOnce(&mut T) -> Result<Vec<u8>, ComprsError>,
    ) -> Result<Vec<u8>, ComprsError> {
        op(self.state()?)
    }

    /// [`finish`](Self::finish), with the error of comprs-core, as
    /// [`try_run`](Self::try_run).
    fn try_finish(
        &mut self,
        op: impl FnOnce(&mut T) -> Result<Vec<u8>, ComprsError>,
    ) -> Result<Vec<u8>, ComprsError> {
        let output = op(self.state()?);
        self.state = State::Finished;
        output
    }

    /// Drop the state, unless the stream is already finished or closed.
    fn close(&mut self) {
        if let State::Open(_) = self.state {
            self.state = State::Closed;
        }
    }

    fn state(&mut self) -> Result<&mut T, ComprsError> {
        match &mut self.state {
            State::Open(state) => Ok(state),
            State::Finished => Err(ComprsError::StreamFinished(self.name)),
            State::Closed => Err(ComprsError::StreamClosed(self.name)),
        }
    }
}

/// The methods that every stream context class has, as in the native addon.
/// The glue that wasm-bindgen generates adds `free()`, which also frees the
/// object itself, and browser/index.js makes `[Symbol.dispose]()` an alias of
/// `close()`, as the native addon does.
macro_rules! stream_context_methods {
    ($class:ident) => {
        #[wasm_bindgen]
        impl $class {
            /// Process a chunk of input and return the output that is ready.
            pub fn transform(&mut self, chunk: &Bytes) -> Result<Vec<u8>, JsError> {
                let chunk = chunk.to_vec("chunk")?;
                self.inner.run(|ctx| ctx.transform(&chunk))
            }

            /// Return the output of the input so far.
            pub fn flush(&mut self) -> Result<Vec<u8>, JsError> {
                self.inner.run(|ctx| ctx.flush())
            }

            /// End the stream and return the rest of the output. Later calls
            /// throw.
            pub fn finish(&mut self) -> Result<Vec<u8>, JsError> {
                self.inner.finish(|ctx| ctx.finish())
            }

            /// Release the codec state now, for a stream that will not be
            /// finished. Later calls throw; closing a finished or closed
            /// context does nothing.
            pub fn close(&mut self) {
                self.inner.close();
            }
        }
    };
}

// ---------------------------------------------------------------------------
// Zstd streaming
// ---------------------------------------------------------------------------

#[wasm_bindgen]
pub struct ZstdCompressContext {
    inner: StreamState<comprs_core::zstd_stream::CompressContext>,
}

#[wasm_bindgen]
impl ZstdCompressContext {
    #[wasm_bindgen(constructor)]
    pub fn new(level: Option<f64>) -> Result<ZstdCompressContext, JsError> {
        let level = comprs_core::zstd::LEVEL
            .check_optional_f64(level)
            .map_err(to_js_error)?;
        Ok(Self {
            inner: StreamState::new(
                comprs_core::zstd_stream::CompressContext::new(level).map_err(to_js_error)?,
                "zstd stream",
            ),
        })
    }
}

stream_context_methods!(ZstdCompressContext);

#[wasm_bindgen]
pub struct ZstdDecompressContext {
    inner: StreamState<comprs_core::zstd_stream::DecompressContext>,
}

#[wasm_bindgen]
impl ZstdDecompressContext {
    #[wasm_bindgen(constructor)]
    pub fn new(max_output_size: Option<f64>) -> Result<ZstdDecompressContext, JsError> {
        Ok(Self {
            inner: StreamState::new(
                comprs_core::zstd_stream::DecompressContext::new(max_output_size)
                    .map_err(to_js_error)?,
                "zstd stream",
            ),
        })
    }
}

stream_context_methods!(ZstdDecompressContext);

#[wasm_bindgen]
pub struct ZstdCompressDictContext {
    inner: StreamState<comprs_core::zstd_stream::CompressDictContext>,
}

#[wasm_bindgen]
impl ZstdCompressDictContext {
    #[wasm_bindgen(constructor)]
    pub fn new(dict: &Bytes, level: Option<f64>) -> Result<ZstdCompressDictContext, JsError> {
        let dict = dict.to_vec("dict")?;
        let level = comprs_core::zstd::LEVEL
            .check_optional_f64(level)
            .map_err(to_js_error)?;
        Ok(Self {
            inner: StreamState::new(
                comprs_core::zstd_stream::CompressDictContext::new(&dict, level)
                    .map_err(to_js_error)?,
                "zstd stream",
            ),
        })
    }
}

stream_context_methods!(ZstdCompressDictContext);

#[wasm_bindgen]
pub struct ZstdDecompressDictContext {
    inner: StreamState<comprs_core::zstd_stream::DecompressDictContext>,
}

#[wasm_bindgen]
impl ZstdDecompressDictContext {
    #[wasm_bindgen(constructor)]
    pub fn new(
        dict: &Bytes,
        max_output_size: Option<f64>,
    ) -> Result<ZstdDecompressDictContext, JsError> {
        Ok(Self {
            inner: StreamState::new(
                comprs_core::zstd_stream::DecompressDictContext::new(
                    &dict.to_vec("dict")?,
                    max_output_size,
                )
                .map_err(to_js_error)?,
                "zstd stream",
            ),
        })
    }
}

stream_context_methods!(ZstdDecompressDictContext);

// ---------------------------------------------------------------------------
// Gzip streaming
// ---------------------------------------------------------------------------

#[wasm_bindgen]
pub struct GzipCompressContext {
    inner: StreamState<comprs_core::gzip_stream::GzipCompressContext>,
}

#[wasm_bindgen]
impl GzipCompressContext {
    #[wasm_bindgen(constructor)]
    pub fn new(level: Option<f64>) -> Result<GzipCompressContext, JsError> {
        let level = comprs_core::gzip::LEVEL
            .check_optional_f64(level)
            .map_err(to_js_error)?;
        Ok(Self {
            inner: StreamState::new(
                comprs_core::gzip_stream::GzipCompressContext::new(level).map_err(to_js_error)?,
                "gzip stream",
            ),
        })
    }
}

stream_context_methods!(GzipCompressContext);

#[wasm_bindgen]
pub struct GzipDecompressContext {
    inner: StreamState<comprs_core::gzip_stream::GzipDecompressContext>,
}

#[wasm_bindgen]
impl GzipDecompressContext {
    #[wasm_bindgen(constructor)]
    pub fn new(max_output_size: Option<f64>) -> Result<GzipDecompressContext, JsError> {
        Ok(Self {
            inner: StreamState::new(
                comprs_core::gzip_stream::GzipDecompressContext::new(max_output_size)
                    .map_err(to_js_error)?,
                "gzip stream",
            ),
        })
    }
}

stream_context_methods!(GzipDecompressContext);

// ---------------------------------------------------------------------------
// Deflate streaming
// ---------------------------------------------------------------------------

#[wasm_bindgen]
pub struct DeflateCompressContext {
    inner: StreamState<comprs_core::gzip_stream::DeflateCompressContext>,
}

#[wasm_bindgen]
impl DeflateCompressContext {
    #[wasm_bindgen(constructor)]
    pub fn new(level: Option<f64>) -> Result<DeflateCompressContext, JsError> {
        let level = comprs_core::gzip::DEFLATE_LEVEL
            .check_optional_f64(level)
            .map_err(to_js_error)?;
        Ok(Self {
            inner: StreamState::new(
                comprs_core::gzip_stream::DeflateCompressContext::new(level)
                    .map_err(to_js_error)?,
                "deflate stream",
            ),
        })
    }
}

stream_context_methods!(DeflateCompressContext);

#[wasm_bindgen]
pub struct DeflateDecompressContext {
    inner: StreamState<comprs_core::gzip_stream::DeflateDecompressContext>,
}

#[wasm_bindgen]
impl DeflateDecompressContext {
    #[wasm_bindgen(constructor)]
    pub fn new(max_output_size: Option<f64>) -> Result<DeflateDecompressContext, JsError> {
        Ok(Self {
            inner: StreamState::new(
                comprs_core::gzip_stream::DeflateDecompressContext::new(max_output_size)
                    .map_err(to_js_error)?,
                "deflate stream",
            ),
        })
    }
}

stream_context_methods!(DeflateDecompressContext);

// ---------------------------------------------------------------------------
// Brotli streaming
// ---------------------------------------------------------------------------

#[wasm_bindgen]
pub struct BrotliCompressContext {
    inner: StreamState<comprs_core::brotli_stream::CompressContext>,
}

#[wasm_bindgen]
impl BrotliCompressContext {
    #[wasm_bindgen(constructor)]
    pub fn new(quality: Option<f64>) -> Result<BrotliCompressContext, JsError> {
        let quality = comprs_core::brotli::QUALITY
            .check_optional_f64(quality)
            .map_err(to_js_error)?;
        Ok(Self {
            inner: StreamState::new(
                comprs_core::brotli_stream::CompressContext::new(quality).map_err(to_js_error)?,
                "brotli stream",
            ),
        })
    }
}

stream_context_methods!(BrotliCompressContext);

#[wasm_bindgen]
pub struct BrotliDecompressContext {
    inner: StreamState<comprs_core::brotli_stream::DecompressContext>,
}

#[wasm_bindgen]
impl BrotliDecompressContext {
    #[wasm_bindgen(constructor)]
    pub fn new(max_output_size: Option<f64>) -> Result<BrotliDecompressContext, JsError> {
        Ok(Self {
            inner: StreamState::new(
                comprs_core::brotli_stream::DecompressContext::new(max_output_size)
                    .map_err(to_js_error)?,
                "brotli stream",
            ),
        })
    }
}

stream_context_methods!(BrotliDecompressContext);

/// Streaming brotli compression context with custom dictionary, in the
/// modes of the native addon's: by default, `transform()` and `flush()`
/// return nothing and `finish()` compresses all of the input; with
/// `{ incremental: true }`, it holds at most the first 4 MiB less 16 bytes
/// of input (4,194,288 bytes), then compresses each chunk as it arrives,
/// without the dictionary.
#[wasm_bindgen]
pub struct BrotliCompressDictContext {
    inner: StreamState<comprs_core::brotli_stream::CompressDictContext>,
}

#[wasm_bindgen]
impl BrotliCompressDictContext {
    #[wasm_bindgen(constructor)]
    pub fn new(
        dict: &Bytes,
        quality: Option<f64>,
        #[wasm_bindgen(unchecked_param_type = "StreamContextOptions | null")] options: JsValue,
    ) -> Result<BrotliCompressDictContext, JsValue> {
        let dict = dict.to_vec("dict")?;
        let quality = comprs_core::brotli::QUALITY
            .check_optional_f64(quality)
            .map_err(to_js_error)?;
        let context = if stream_context_options(&options)? {
            comprs_core::brotli_stream::CompressDictContext::incremental(&dict, quality)
        } else {
            comprs_core::brotli_stream::CompressDictContext::new(&dict, quality)
        };
        Ok(Self {
            inner: StreamState::new(context.map_err(to_js_error)?, "brotli dict stream"),
        })
    }
}

stream_context_methods!(BrotliCompressDictContext);

#[wasm_bindgen]
pub struct BrotliDecompressDictContext {
    inner: StreamState<comprs_core::brotli_stream::DecompressDictContext>,
}

#[wasm_bindgen]
impl BrotliDecompressDictContext {
    #[wasm_bindgen(constructor)]
    pub fn new(
        dict: &Bytes,
        max_output_size: Option<f64>,
    ) -> Result<BrotliDecompressDictContext, JsError> {
        Ok(Self {
            inner: StreamState::new(
                comprs_core::brotli_stream::DecompressDictContext::new(
                    &dict.to_vec("dict")?,
                    max_output_size,
                )
                .map_err(to_js_error)?,
                "brotli dict stream",
            ),
        })
    }
}

stream_context_methods!(BrotliDecompressDictContext);

// ---------------------------------------------------------------------------
// LZ4 streaming
// ---------------------------------------------------------------------------

#[wasm_bindgen]
pub struct Lz4CompressContext {
    inner: StreamState<comprs_core::lz4_stream::CompressContext>,
}

#[wasm_bindgen]
impl Lz4CompressContext {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Result<Lz4CompressContext, JsError> {
        Ok(Self {
            inner: StreamState::new(
                comprs_core::lz4_stream::CompressContext::new(),
                "lz4 stream",
            ),
        })
    }
}

stream_context_methods!(Lz4CompressContext);

/// Streaming LZ4 frame decompression context, in the modes of the native
/// addon's: by default, `transform()` buffers the input and returns nothing,
/// and `flush()` decodes what has been buffered, with `maxOutputSize`
/// applying to each `flush()`; with `{ incremental: true }`, `transform()`
/// returns each block once all of it has arrived, `flush()` returns nothing,
/// `finish()` throws unless the input ended between frames, and
/// `maxOutputSize` applies to the whole stream.
#[wasm_bindgen]
pub struct Lz4DecompressContext {
    inner: StreamState<comprs_core::lz4_stream::DecompressContext>,
}

#[wasm_bindgen]
impl Lz4DecompressContext {
    #[wasm_bindgen(constructor)]
    pub fn new(
        max_output_size: Option<f64>,
        #[wasm_bindgen(unchecked_param_type = "StreamContextOptions | null")] options: JsValue,
    ) -> Result<Lz4DecompressContext, JsValue> {
        let context = if stream_context_options(&options)? {
            comprs_core::lz4_stream::DecompressContext::incremental(max_output_size)
        } else {
            comprs_core::lz4_stream::DecompressContext::new(max_output_size)
        };
        Ok(Self {
            inner: StreamState::new(context.map_err(to_js_error)?, "lz4 stream"),
        })
    }
}

stream_context_methods!(Lz4DecompressContext);

#[cfg(test)]
mod tests {
    use super::*;

    fn layout() -> Layout {
        Layout::from_size_align(64, 8).unwrap()
    }

    /// An inner allocator whose results the wrapper tests drive. The returned
    /// pointers are only compared, never dereferenced or freed.
    struct Fixed(*mut u8);

    unsafe impl GlobalAlloc for Fixed {
        unsafe fn alloc(&self, _layout: Layout) -> *mut u8 {
            self.0
        }
        unsafe fn alloc_zeroed(&self, _layout: Layout) -> *mut u8 {
            self.0
        }
        unsafe fn realloc(&self, _ptr: *mut u8, _layout: Layout, _new_size: usize) -> *mut u8 {
            self.0
        }
        unsafe fn dealloc(&self, _ptr: *mut u8, _layout: Layout) {}
    }

    const FAKE: *mut u8 = 0x1000 as *mut u8;

    #[test]
    fn passes_through_a_successful_allocation() {
        let alloc = AbortOnOom(Fixed(FAKE));
        unsafe {
            assert_eq!(alloc.alloc(layout()), FAKE);
            assert_eq!(alloc.alloc_zeroed(layout()), FAKE);
            assert_eq!(alloc.realloc(FAKE, layout(), 128), FAKE);
        }
    }

    /// An inner allocator that always fails.
    struct AlwaysNull;

    unsafe impl GlobalAlloc for AlwaysNull {
        unsafe fn alloc(&self, _layout: Layout) -> *mut u8 {
            core::ptr::null_mut()
        }
        unsafe fn alloc_zeroed(&self, _layout: Layout) -> *mut u8 {
            core::ptr::null_mut()
        }
        unsafe fn realloc(&self, _ptr: *mut u8, _layout: Layout, _new_size: usize) -> *mut u8 {
            core::ptr::null_mut()
        }
        unsafe fn dealloc(&self, _ptr: *mut u8, _layout: Layout) {}
    }

    const CHILD_ENV: &str = "COMPRS_WASM_ABORT_CHILD";

    /// A failing allocation must abort, never return null: the zstd wasm shim
    /// treats whatever it gets back as a valid buffer, so a null would be
    /// written through and a bogus pointer handed to zstd. `handle_alloc_error`
    /// aborts the process, so the failing call runs in a child process and the
    /// parent checks that the child aborted instead of returning.
    #[test]
    fn aborts_when_the_allocation_fails() {
        if std::env::var_os(CHILD_ENV).is_some() {
            let alloc = AbortOnOom(AlwaysNull);
            // Must abort before the next line; exiting 0 fails the parent's
            // assertion.
            let _ = unsafe { alloc.alloc(layout()) };
            std::process::exit(0);
        }

        let exe = std::env::current_exe().unwrap();
        let output = std::process::Command::new(exe)
            .args(["tests::aborts_when_the_allocation_fails", "--exact"])
            .env(CHILD_ENV, "1")
            .output()
            .unwrap();
        assert!(
            !output.status.success(),
            "the child returned instead of aborting on a failed allocation"
        );
    }
}
