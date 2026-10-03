#![deny(clippy::all)]

use js_sys::{Array, ArrayBuffer, Object, Reflect, Uint8Array};
use wasm_bindgen::prelude::*;

use comprs_core::ComprsError;

fn to_js_error(e: ComprsError) -> JsError {
    JsError::new(&e.to_string())
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
    fn read(&self) -> Result<comprs_core::gzip::GzipHeaderOptions, JsValue> {
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
                let seconds =
                    seconds.ok_or_else(|| JsError::new("header.mtime must be a number"))?;
                Some(to_uint32(seconds))
            }
        };
        Ok(comprs_core::gzip::GzipHeaderOptions { filename, mtime })
    }
}

/// Convert a number to a `u32` as N-API does, with ECMAScript's `ToUint32`:
/// truncate it and wrap it modulo 2^32, with NaN and the infinities as 0.
/// The native addon accepts any number this way (#550).
fn to_uint32(value: f64) -> u32 {
    if value.is_finite() {
        value.trunc().rem_euclid(4_294_967_296.0) as u32
    } else {
        0
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
pub fn zstd_compress(data: &Bytes, level: Option<i32>) -> Result<Vec<u8>, JsError> {
    comprs_core::zstd::compress(&data.to_vec("data")?, level).map_err(to_js_error)
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

    let max_size = max_dict_size
        .map(|s| comprs_core::validate_capacity(s).map_err(to_js_error))
        .transpose()?
        .unwrap_or(comprs_core::zstd::DEFAULT_MAX_DICT_SIZE);

    comprs_core::zstd::train_dictionary(&sample_vecs, max_size).map_err(to_js_error)
}

#[wasm_bindgen(js_name = "zstdCompressWithDict")]
pub fn zstd_compress_with_dict(
    data: &Bytes,
    dict: &Bytes,
    level: Option<i32>,
) -> Result<Vec<u8>, JsError> {
    comprs_core::zstd::compress_with_dict(&data.to_vec("data")?, &dict.to_vec("dict")?, level)
        .map_err(to_js_error)
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
pub fn gzip_compress(data: &Bytes, level: Option<u32>) -> Result<Vec<u8>, JsError> {
    comprs_core::gzip::compress(&data.to_vec("data")?, level).map_err(to_js_error)
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
    level: Option<u32>,
) -> Result<Vec<u8>, JsValue> {
    let data = data.to_vec("data")?;
    let header = header.read()?;
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
pub fn deflate_compress(data: &Bytes, level: Option<u32>) -> Result<Vec<u8>, JsError> {
    comprs_core::gzip::deflate_compress(&data.to_vec("data")?, level).map_err(to_js_error)
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
pub fn brotli_compress(data: &Bytes, quality: Option<u32>) -> Result<Vec<u8>, JsError> {
    comprs_core::brotli::compress(&data.to_vec("data")?, quality).map_err(to_js_error)
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
    quality: Option<u32>,
) -> Result<Vec<u8>, JsError> {
    comprs_core::brotli::compress_with_dict(&data.to_vec("data")?, &dict.to_vec("dict")?, quality)
        .map_err(to_js_error)
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
#[wasm_bindgen(js_name = "decompress")]
pub fn decompress(data: &Bytes) -> Result<Vec<u8>, JsError> {
    comprs_core::detect::decompress(&data.to_vec("data")?).map_err(to_js_error)
}

// ---------------------------------------------------------------------------
// CRC32
// ---------------------------------------------------------------------------

#[wasm_bindgen]
pub fn crc32(data: &Bytes, initial_value: Option<u32>) -> Result<u32, JsError> {
    Ok(comprs_core::crc::crc32(
        &data.to_vec("data")?,
        initial_value,
    ))
}

// ===========================================================================
// Streaming contexts
// ===========================================================================

// ---------------------------------------------------------------------------
// Zstd streaming
// ---------------------------------------------------------------------------

#[wasm_bindgen]
pub struct ZstdCompressContext {
    inner: comprs_core::zstd_stream::CompressContext,
}

#[wasm_bindgen]
impl ZstdCompressContext {
    #[wasm_bindgen(constructor)]
    pub fn new(level: Option<i32>) -> Result<ZstdCompressContext, JsError> {
        Ok(Self {
            inner: comprs_core::zstd_stream::CompressContext::new(level).map_err(to_js_error)?,
        })
    }

    pub fn transform(&mut self, chunk: &Bytes) -> Result<Vec<u8>, JsError> {
        self.inner
            .transform(&chunk.to_vec("chunk")?)
            .map_err(to_js_error)
    }

    pub fn flush(&mut self) -> Result<Vec<u8>, JsError> {
        self.inner.flush().map_err(to_js_error)
    }

    pub fn finish(&mut self) -> Result<Vec<u8>, JsError> {
        self.inner.finish().map_err(to_js_error)
    }
}

#[wasm_bindgen]
pub struct ZstdDecompressContext {
    inner: comprs_core::zstd_stream::DecompressContext,
}

#[wasm_bindgen]
impl ZstdDecompressContext {
    #[wasm_bindgen(constructor)]
    pub fn new(max_output_size: Option<f64>) -> Result<ZstdDecompressContext, JsError> {
        Ok(Self {
            inner: comprs_core::zstd_stream::DecompressContext::new(max_output_size)
                .map_err(to_js_error)?,
        })
    }

    pub fn transform(&mut self, chunk: &Bytes) -> Result<Vec<u8>, JsError> {
        self.inner
            .transform(&chunk.to_vec("chunk")?)
            .map_err(to_js_error)
    }

    pub fn flush(&mut self) -> Result<Vec<u8>, JsError> {
        self.inner.flush().map_err(to_js_error)
    }

    pub fn finish(&mut self) -> Result<Vec<u8>, JsError> {
        self.inner.finish().map_err(to_js_error)
    }
}

#[wasm_bindgen]
pub struct ZstdCompressDictContext {
    inner: comprs_core::zstd_stream::CompressDictContext,
}

#[wasm_bindgen]
impl ZstdCompressDictContext {
    #[wasm_bindgen(constructor)]
    pub fn new(dict: &Bytes, level: Option<i32>) -> Result<ZstdCompressDictContext, JsError> {
        Ok(Self {
            inner: comprs_core::zstd_stream::CompressDictContext::new(&dict.to_vec("dict")?, level)
                .map_err(to_js_error)?,
        })
    }

    pub fn transform(&mut self, chunk: &Bytes) -> Result<Vec<u8>, JsError> {
        self.inner
            .transform(&chunk.to_vec("chunk")?)
            .map_err(to_js_error)
    }

    pub fn flush(&mut self) -> Result<Vec<u8>, JsError> {
        self.inner.flush().map_err(to_js_error)
    }

    pub fn finish(&mut self) -> Result<Vec<u8>, JsError> {
        self.inner.finish().map_err(to_js_error)
    }
}

#[wasm_bindgen]
pub struct ZstdDecompressDictContext {
    inner: comprs_core::zstd_stream::DecompressDictContext,
}

#[wasm_bindgen]
impl ZstdDecompressDictContext {
    #[wasm_bindgen(constructor)]
    pub fn new(
        dict: &Bytes,
        max_output_size: Option<f64>,
    ) -> Result<ZstdDecompressDictContext, JsError> {
        Ok(Self {
            inner: comprs_core::zstd_stream::DecompressDictContext::new(
                &dict.to_vec("dict")?,
                max_output_size,
            )
            .map_err(to_js_error)?,
        })
    }

    pub fn transform(&mut self, chunk: &Bytes) -> Result<Vec<u8>, JsError> {
        self.inner
            .transform(&chunk.to_vec("chunk")?)
            .map_err(to_js_error)
    }

    pub fn flush(&mut self) -> Result<Vec<u8>, JsError> {
        self.inner.flush().map_err(to_js_error)
    }

    pub fn finish(&mut self) -> Result<Vec<u8>, JsError> {
        self.inner.finish().map_err(to_js_error)
    }
}

// ---------------------------------------------------------------------------
// Gzip streaming
// ---------------------------------------------------------------------------

#[wasm_bindgen]
pub struct GzipCompressContext {
    inner: comprs_core::gzip_stream::GzipCompressContext,
}

#[wasm_bindgen]
impl GzipCompressContext {
    #[wasm_bindgen(constructor)]
    pub fn new(level: Option<u32>) -> Result<GzipCompressContext, JsError> {
        Ok(Self {
            inner: comprs_core::gzip_stream::GzipCompressContext::new(level)
                .map_err(to_js_error)?,
        })
    }

    pub fn transform(&mut self, chunk: &Bytes) -> Result<Vec<u8>, JsError> {
        self.inner
            .transform(&chunk.to_vec("chunk")?)
            .map_err(to_js_error)
    }

    pub fn flush(&mut self) -> Result<Vec<u8>, JsError> {
        self.inner.flush().map_err(to_js_error)
    }

    pub fn finish(&mut self) -> Result<Vec<u8>, JsError> {
        self.inner.finish().map_err(to_js_error)
    }
}

#[wasm_bindgen]
pub struct GzipDecompressContext {
    inner: comprs_core::gzip_stream::GzipDecompressContext,
}

#[wasm_bindgen]
impl GzipDecompressContext {
    #[wasm_bindgen(constructor)]
    pub fn new(max_output_size: Option<f64>) -> Result<GzipDecompressContext, JsError> {
        Ok(Self {
            inner: comprs_core::gzip_stream::GzipDecompressContext::new(max_output_size)
                .map_err(to_js_error)?,
        })
    }

    pub fn transform(&mut self, chunk: &Bytes) -> Result<Vec<u8>, JsError> {
        self.inner
            .transform(&chunk.to_vec("chunk")?)
            .map_err(to_js_error)
    }

    pub fn flush(&mut self) -> Result<Vec<u8>, JsError> {
        self.inner.flush().map_err(to_js_error)
    }

    pub fn finish(&mut self) -> Result<Vec<u8>, JsError> {
        self.inner.finish().map_err(to_js_error)
    }
}

// ---------------------------------------------------------------------------
// Deflate streaming
// ---------------------------------------------------------------------------

#[wasm_bindgen]
pub struct DeflateCompressContext {
    inner: comprs_core::gzip_stream::DeflateCompressContext,
}

#[wasm_bindgen]
impl DeflateCompressContext {
    #[wasm_bindgen(constructor)]
    pub fn new(level: Option<u32>) -> Result<DeflateCompressContext, JsError> {
        Ok(Self {
            inner: comprs_core::gzip_stream::DeflateCompressContext::new(level)
                .map_err(to_js_error)?,
        })
    }

    pub fn transform(&mut self, chunk: &Bytes) -> Result<Vec<u8>, JsError> {
        self.inner
            .transform(&chunk.to_vec("chunk")?)
            .map_err(to_js_error)
    }

    pub fn flush(&mut self) -> Result<Vec<u8>, JsError> {
        self.inner.flush().map_err(to_js_error)
    }

    pub fn finish(&mut self) -> Result<Vec<u8>, JsError> {
        self.inner.finish().map_err(to_js_error)
    }
}

#[wasm_bindgen]
pub struct DeflateDecompressContext {
    inner: comprs_core::gzip_stream::DeflateDecompressContext,
}

#[wasm_bindgen]
impl DeflateDecompressContext {
    #[wasm_bindgen(constructor)]
    pub fn new(max_output_size: Option<f64>) -> Result<DeflateDecompressContext, JsError> {
        Ok(Self {
            inner: comprs_core::gzip_stream::DeflateDecompressContext::new(max_output_size)
                .map_err(to_js_error)?,
        })
    }

    pub fn transform(&mut self, chunk: &Bytes) -> Result<Vec<u8>, JsError> {
        self.inner
            .transform(&chunk.to_vec("chunk")?)
            .map_err(to_js_error)
    }

    pub fn flush(&mut self) -> Result<Vec<u8>, JsError> {
        self.inner.flush().map_err(to_js_error)
    }

    pub fn finish(&mut self) -> Result<Vec<u8>, JsError> {
        self.inner.finish().map_err(to_js_error)
    }
}

// ---------------------------------------------------------------------------
// Brotli streaming
// ---------------------------------------------------------------------------

#[wasm_bindgen]
pub struct BrotliCompressContext {
    inner: comprs_core::brotli_stream::CompressContext,
}

#[wasm_bindgen]
impl BrotliCompressContext {
    #[wasm_bindgen(constructor)]
    pub fn new(quality: Option<u32>) -> Result<BrotliCompressContext, JsError> {
        Ok(Self {
            inner: comprs_core::brotli_stream::CompressContext::new(quality)
                .map_err(to_js_error)?,
        })
    }

    pub fn transform(&mut self, chunk: &Bytes) -> Result<Vec<u8>, JsError> {
        self.inner
            .transform(&chunk.to_vec("chunk")?)
            .map_err(to_js_error)
    }

    pub fn flush(&mut self) -> Result<Vec<u8>, JsError> {
        self.inner.flush().map_err(to_js_error)
    }

    pub fn finish(&mut self) -> Result<Vec<u8>, JsError> {
        self.inner.finish().map_err(to_js_error)
    }
}

#[wasm_bindgen]
pub struct BrotliDecompressContext {
    inner: comprs_core::brotli_stream::DecompressContext,
}

#[wasm_bindgen]
impl BrotliDecompressContext {
    #[wasm_bindgen(constructor)]
    pub fn new(max_output_size: Option<f64>) -> Result<BrotliDecompressContext, JsError> {
        Ok(Self {
            inner: comprs_core::brotli_stream::DecompressContext::new(max_output_size)
                .map_err(to_js_error)?,
        })
    }

    pub fn transform(&mut self, chunk: &Bytes) -> Result<Vec<u8>, JsError> {
        self.inner
            .transform(&chunk.to_vec("chunk")?)
            .map_err(to_js_error)
    }

    pub fn flush(&mut self) -> Result<Vec<u8>, JsError> {
        self.inner.flush().map_err(to_js_error)
    }

    pub fn finish(&mut self) -> Result<Vec<u8>, JsError> {
        self.inner.finish().map_err(to_js_error)
    }
}

#[wasm_bindgen]
pub struct BrotliCompressDictContext {
    inner: comprs_core::brotli_stream::CompressDictContext,
}

#[wasm_bindgen]
impl BrotliCompressDictContext {
    #[wasm_bindgen(constructor)]
    pub fn new(dict: &Bytes, quality: Option<u32>) -> Result<BrotliCompressDictContext, JsError> {
        Ok(Self {
            inner: comprs_core::brotli_stream::CompressDictContext::new(
                &dict.to_vec("dict")?,
                quality,
            )
            .map_err(to_js_error)?,
        })
    }

    pub fn transform(&mut self, chunk: &Bytes) -> Result<Vec<u8>, JsError> {
        self.inner
            .transform(&chunk.to_vec("chunk")?)
            .map_err(to_js_error)
    }

    pub fn flush(&mut self) -> Result<Vec<u8>, JsError> {
        self.inner.flush().map_err(to_js_error)
    }

    pub fn finish(&mut self) -> Result<Vec<u8>, JsError> {
        self.inner.finish().map_err(to_js_error)
    }
}

#[wasm_bindgen]
pub struct BrotliDecompressDictContext {
    inner: comprs_core::brotli_stream::DecompressDictContext,
}

#[wasm_bindgen]
impl BrotliDecompressDictContext {
    #[wasm_bindgen(constructor)]
    pub fn new(
        dict: &Bytes,
        max_output_size: Option<f64>,
    ) -> Result<BrotliDecompressDictContext, JsError> {
        Ok(Self {
            inner: comprs_core::brotli_stream::DecompressDictContext::new(
                &dict.to_vec("dict")?,
                max_output_size,
            )
            .map_err(to_js_error)?,
        })
    }

    pub fn transform(&mut self, chunk: &Bytes) -> Result<Vec<u8>, JsError> {
        self.inner
            .transform(&chunk.to_vec("chunk")?)
            .map_err(to_js_error)
    }

    pub fn flush(&mut self) -> Result<Vec<u8>, JsError> {
        self.inner.flush().map_err(to_js_error)
    }

    pub fn finish(&mut self) -> Result<Vec<u8>, JsError> {
        self.inner.finish().map_err(to_js_error)
    }
}

// ---------------------------------------------------------------------------
// LZ4 streaming
// ---------------------------------------------------------------------------

#[wasm_bindgen]
pub struct Lz4CompressContext {
    inner: comprs_core::lz4_stream::CompressContext,
}

#[wasm_bindgen]
impl Lz4CompressContext {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Result<Lz4CompressContext, JsError> {
        Ok(Self {
            inner: comprs_core::lz4_stream::CompressContext::new().map_err(to_js_error)?,
        })
    }

    pub fn transform(&mut self, chunk: &Bytes) -> Result<Vec<u8>, JsError> {
        self.inner
            .transform(&chunk.to_vec("chunk")?)
            .map_err(to_js_error)
    }

    pub fn flush(&mut self) -> Result<Vec<u8>, JsError> {
        self.inner.flush().map_err(to_js_error)
    }

    pub fn finish(&mut self) -> Result<Vec<u8>, JsError> {
        self.inner.finish().map_err(to_js_error)
    }
}

#[wasm_bindgen]
pub struct Lz4DecompressContext {
    inner: comprs_core::lz4_stream::DecompressContext,
}

#[wasm_bindgen]
impl Lz4DecompressContext {
    #[wasm_bindgen(constructor)]
    pub fn new(max_output_size: Option<f64>) -> Result<Lz4DecompressContext, JsError> {
        Ok(Self {
            inner: comprs_core::lz4_stream::DecompressContext::new(max_output_size)
                .map_err(to_js_error)?,
        })
    }

    pub fn transform(&mut self, chunk: &Bytes) -> Result<Vec<u8>, JsError> {
        self.inner
            .transform(&chunk.to_vec("chunk")?)
            .map_err(to_js_error)
    }

    pub fn flush(&mut self) -> Result<Vec<u8>, JsError> {
        self.inner.flush().map_err(to_js_error)
    }
}

#[cfg(test)]
mod tests {
    use super::to_uint32;

    #[test]
    fn to_uint32_converts_like_ecmascript() {
        // Expected values from `value >>> 0` in JavaScript.
        let cases = [
            (0.0, 0),
            (-0.5, 0),
            (1.9, 1),
            (-1.0, u32::MAX),
            (-1.9, u32::MAX),
            (4_294_967_295.0, u32::MAX),
            (4_294_967_296.0, 0),
            (4_294_967_301.0, 5),
            (-4_294_967_297.0, u32::MAX),
            (9_007_199_254_740_994.0, 2),
            (1e300, 0),
            (f64::NAN, 0),
            (f64::INFINITY, 0),
            (f64::NEG_INFINITY, 0),
        ];
        for (value, expected) in cases {
            assert_eq!(to_uint32(value), expected, "ToUint32({value})");
        }
    }
}
