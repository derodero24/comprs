#![deny(clippy::all)]

use js_sys::{Array, ArrayBuffer, Object, Reflect, Uint8Array};
use wasm_bindgen::prelude::*;

use comprs_core::ComprsError;

fn to_js_error(e: ComprsError) -> JsError {
    JsError::new(&e.to_string())
}

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

    #[wasm_bindgen(method, getter)]
    fn buffer(this: &Bytes) -> JsValue;

    #[wasm_bindgen(method, getter, js_name = byteOffset)]
    fn byte_offset(this: &Bytes) -> u32;

    #[wasm_bindgen(method, getter, js_name = byteLength)]
    fn byte_length(this: &Bytes) -> u32;
}

impl Bytes {
    /// Copy the bytes into Wasm memory, or fail, as the native addon does,
    /// if this is not an ArrayBuffer view. `name` names the argument.
    fn to_vec(&self, name: &str) -> Result<Vec<u8>, JsError> {
        if let Some(array) = self.dyn_ref::<Uint8Array>() {
            return Ok(array.to_vec());
        }
        // A view of another type, or a Uint8Array from another realm.
        if !ArrayBuffer::is_view(self) {
            return Err(JsError::new(&format!("{name} must be a Uint8Array")));
        }
        let bytes = Uint8Array::new_with_byte_offset_and_length(
            &self.buffer(),
            self.byte_offset(),
            self.byte_length(),
        );
        Ok(bytes.to_vec())
    }
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
/// calls throw "<name> already finished" or "<name> already closed".
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
        op(self.state()?).map_err(to_js_error)
    }

    /// Run `op`, which ends the stream, then drop the state, whether `op`
    /// succeeded or not: the codecs cannot continue after either.
    fn finish(
        &mut self,
        op: impl FnOnce(&mut T) -> Result<Vec<u8>, ComprsError>,
    ) -> Result<Vec<u8>, JsError> {
        let output = op(self.state()?);
        self.state = State::Finished;
        output.map_err(to_js_error)
    }

    /// Drop the state, unless the stream is already finished or closed.
    fn close(&mut self) {
        if let State::Open(_) = self.state {
            self.state = State::Closed;
        }
    }

    fn state(&mut self) -> Result<&mut T, JsError> {
        match &mut self.state {
            State::Open(state) => Ok(state),
            State::Finished => Err(to_js_error(ComprsError::StreamFinished(self.name))),
            State::Closed => Err(to_js_error(ComprsError::StreamClosed(self.name))),
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

#[wasm_bindgen]
pub struct BrotliCompressDictContext {
    inner: StreamState<comprs_core::brotli_stream::CompressDictContext>,
}

#[wasm_bindgen]
impl BrotliCompressDictContext {
    #[wasm_bindgen(constructor)]
    pub fn new(dict: &Bytes, quality: Option<f64>) -> Result<BrotliCompressDictContext, JsError> {
        let dict = dict.to_vec("dict")?;
        let quality = comprs_core::brotli::QUALITY
            .check_optional_f64(quality)
            .map_err(to_js_error)?;
        Ok(Self {
            inner: StreamState::new(
                comprs_core::brotli_stream::CompressDictContext::new(&dict, quality)
                    .map_err(to_js_error)?,
                "brotli dict stream",
            ),
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

#[wasm_bindgen]
pub struct Lz4DecompressContext {
    inner: StreamState<comprs_core::lz4_stream::DecompressContext>,
}

#[wasm_bindgen]
impl Lz4DecompressContext {
    #[wasm_bindgen(constructor)]
    pub fn new(max_output_size: Option<f64>) -> Result<Lz4DecompressContext, JsError> {
        Ok(Self {
            inner: StreamState::new(
                comprs_core::lz4_stream::DecompressContext::new(max_output_size)
                    .map_err(to_js_error)?,
                "lz4 stream",
            ),
        })
    }
}

stream_context_methods!(Lz4DecompressContext);
