#![deny(clippy::all)]

use wasm_bindgen::prelude::*;

use comprs_core::ComprsError;

fn to_js_error(e: ComprsError) -> JsError {
    JsError::new(&e.to_string())
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
pub fn zstd_compress(data: &[u8], level: Option<f64>) -> Result<Vec<u8>, JsError> {
    let level = comprs_core::zstd::LEVEL
        .check_optional_f64(level)
        .map_err(to_js_error)?;
    comprs_core::zstd::compress(data, level).map_err(to_js_error)
}

#[wasm_bindgen(js_name = "zstdDecompress")]
pub fn zstd_decompress(data: &[u8]) -> Result<Vec<u8>, JsError> {
    comprs_core::zstd::decompress(data).map_err(to_js_error)
}

#[wasm_bindgen(js_name = "zstdDecompressWithCapacity")]
pub fn zstd_decompress_with_capacity(data: &[u8], capacity: f64) -> Result<Vec<u8>, JsError> {
    let cap = comprs_core::validate_capacity(capacity).map_err(to_js_error)?;
    comprs_core::zstd::decompress_with_capacity(data, cap).map_err(to_js_error)
}

#[wasm_bindgen(js_name = "zstdTrainDictionary")]
pub fn zstd_train_dictionary(
    samples: js_sys::Array,
    max_dict_size: Option<f64>,
) -> Result<Vec<u8>, JsError> {
    let max_size = comprs_core::zstd::DICT_SIZE
        .check_optional_f64(max_dict_size)
        .map_err(to_js_error)?
        .unwrap_or(comprs_core::zstd::DEFAULT_MAX_DICT_SIZE);

    let sample_vecs: Vec<Vec<u8>> = samples
        .iter()
        .map(|val| js_sys::Uint8Array::new(&val).to_vec())
        .collect();

    comprs_core::zstd::train_dictionary(&sample_vecs, max_size).map_err(to_js_error)
}

#[wasm_bindgen(js_name = "zstdCompressWithDict")]
pub fn zstd_compress_with_dict(
    data: &[u8],
    dict: &[u8],
    level: Option<f64>,
) -> Result<Vec<u8>, JsError> {
    let level = comprs_core::zstd::LEVEL
        .check_optional_f64(level)
        .map_err(to_js_error)?;
    comprs_core::zstd::compress_with_dict(data, dict, level).map_err(to_js_error)
}

#[wasm_bindgen(js_name = "zstdDecompressWithDict")]
pub fn zstd_decompress_with_dict(data: &[u8], dict: &[u8]) -> Result<Vec<u8>, JsError> {
    comprs_core::zstd::decompress_with_dict(data, dict).map_err(to_js_error)
}

#[wasm_bindgen(js_name = "zstdDecompressWithDictWithCapacity")]
pub fn zstd_decompress_with_dict_with_capacity(
    data: &[u8],
    dict: &[u8],
    capacity: f64,
) -> Result<Vec<u8>, JsError> {
    let cap = comprs_core::validate_capacity(capacity).map_err(to_js_error)?;
    comprs_core::zstd::decompress_with_dict_with_capacity(data, dict, cap).map_err(to_js_error)
}

// ---------------------------------------------------------------------------
// Gzip one-shot
// ---------------------------------------------------------------------------

#[wasm_bindgen(js_name = "gzipCompress")]
pub fn gzip_compress(data: &[u8], level: Option<f64>) -> Result<Vec<u8>, JsError> {
    let level = comprs_core::gzip::LEVEL
        .check_optional_f64(level)
        .map_err(to_js_error)?;
    comprs_core::gzip::compress(data, level).map_err(to_js_error)
}

#[wasm_bindgen(js_name = "gzipDecompress")]
pub fn gzip_decompress(data: &[u8]) -> Result<Vec<u8>, JsError> {
    comprs_core::gzip::decompress(data).map_err(to_js_error)
}

#[wasm_bindgen(js_name = "gzipDecompressWithCapacity")]
pub fn gzip_decompress_with_capacity(data: &[u8], capacity: f64) -> Result<Vec<u8>, JsError> {
    let cap = comprs_core::validate_capacity(capacity).map_err(to_js_error)?;
    comprs_core::gzip::decompress_with_capacity(data, cap).map_err(to_js_error)
}

#[wasm_bindgen(js_name = "gzipCompressWithHeader")]
pub fn gzip_compress_with_header(
    data: &[u8],
    level: Option<f64>,
    filename: Option<String>,
    mtime: Option<f64>,
) -> Result<Vec<u8>, JsError> {
    let level = comprs_core::gzip::LEVEL
        .check_optional_f64(level)
        .map_err(to_js_error)?;
    let mtime = comprs_core::gzip::MTIME
        .check_optional_f64(mtime)
        .map_err(to_js_error)?;
    let header = comprs_core::gzip::GzipHeaderOptions { filename, mtime };
    comprs_core::gzip::compress_with_header(data, &header, level).map_err(to_js_error)
}

#[wasm_bindgen(js_name = "gzipReadHeader")]
pub fn gzip_read_header(data: &[u8]) -> Result<JsValue, JsError> {
    let h = comprs_core::gzip::read_header(data).map_err(to_js_error)?;

    let obj = js_sys::Object::new();

    if let Some(ref filename) = h.filename {
        js_sys::Reflect::set(&obj, &"filename".into(), &filename.into())
            .map_err(|_| JsError::new("failed to set filename"))?;
    } else {
        js_sys::Reflect::set(&obj, &"filename".into(), &JsValue::NULL)
            .map_err(|_| JsError::new("failed to set filename"))?;
    }

    js_sys::Reflect::set(&obj, &"mtime".into(), &h.mtime.into())
        .map_err(|_| JsError::new("failed to set mtime"))?;

    if let Some(ref comment) = h.comment {
        js_sys::Reflect::set(&obj, &"comment".into(), &comment.into())
            .map_err(|_| JsError::new("failed to set comment"))?;
    } else {
        js_sys::Reflect::set(&obj, &"comment".into(), &JsValue::NULL)
            .map_err(|_| JsError::new("failed to set comment"))?;
    }

    js_sys::Reflect::set(&obj, &"os".into(), &h.os.into())
        .map_err(|_| JsError::new("failed to set os"))?;

    if let Some(ref extra) = h.extra {
        let arr = js_sys::Uint8Array::from(extra.as_slice());
        js_sys::Reflect::set(&obj, &"extra".into(), &arr.into())
            .map_err(|_| JsError::new("failed to set extra"))?;
    } else {
        js_sys::Reflect::set(&obj, &"extra".into(), &JsValue::NULL)
            .map_err(|_| JsError::new("failed to set extra"))?;
    }

    Ok(obj.into())
}

// ---------------------------------------------------------------------------
// Deflate one-shot
// ---------------------------------------------------------------------------

#[wasm_bindgen(js_name = "deflateCompress")]
pub fn deflate_compress(data: &[u8], level: Option<f64>) -> Result<Vec<u8>, JsError> {
    let level = comprs_core::gzip::DEFLATE_LEVEL
        .check_optional_f64(level)
        .map_err(to_js_error)?;
    comprs_core::gzip::deflate_compress(data, level).map_err(to_js_error)
}

#[wasm_bindgen(js_name = "deflateDecompress")]
pub fn deflate_decompress(data: &[u8]) -> Result<Vec<u8>, JsError> {
    comprs_core::gzip::deflate_decompress(data).map_err(to_js_error)
}

#[wasm_bindgen(js_name = "deflateDecompressWithCapacity")]
pub fn deflate_decompress_with_capacity(data: &[u8], capacity: f64) -> Result<Vec<u8>, JsError> {
    let cap = comprs_core::validate_capacity(capacity).map_err(to_js_error)?;
    comprs_core::gzip::deflate_decompress_with_capacity(data, cap).map_err(to_js_error)
}

// ---------------------------------------------------------------------------
// Brotli one-shot
// ---------------------------------------------------------------------------

#[wasm_bindgen(js_name = "brotliCompress")]
pub fn brotli_compress(data: &[u8], quality: Option<f64>) -> Result<Vec<u8>, JsError> {
    let quality = comprs_core::brotli::QUALITY
        .check_optional_f64(quality)
        .map_err(to_js_error)?;
    comprs_core::brotli::compress(data, quality).map_err(to_js_error)
}

#[wasm_bindgen(js_name = "brotliDecompress")]
pub fn brotli_decompress(data: &[u8]) -> Result<Vec<u8>, JsError> {
    comprs_core::brotli::decompress(data).map_err(to_js_error)
}

#[wasm_bindgen(js_name = "brotliDecompressWithCapacity")]
pub fn brotli_decompress_with_capacity(data: &[u8], capacity: f64) -> Result<Vec<u8>, JsError> {
    let cap = comprs_core::validate_capacity(capacity).map_err(to_js_error)?;
    comprs_core::brotli::decompress_with_capacity(data, cap).map_err(to_js_error)
}

#[wasm_bindgen(js_name = "brotliCompressWithDict")]
pub fn brotli_compress_with_dict(
    data: &[u8],
    dict: &[u8],
    quality: Option<f64>,
) -> Result<Vec<u8>, JsError> {
    let quality = comprs_core::brotli::QUALITY
        .check_optional_f64(quality)
        .map_err(to_js_error)?;
    comprs_core::brotli::compress_with_dict(data, dict, quality).map_err(to_js_error)
}

#[wasm_bindgen(js_name = "brotliDecompressWithDict")]
pub fn brotli_decompress_with_dict(data: &[u8], dict: &[u8]) -> Result<Vec<u8>, JsError> {
    comprs_core::brotli::decompress_with_dict(data, dict).map_err(to_js_error)
}

#[wasm_bindgen(js_name = "brotliDecompressWithDictWithCapacity")]
pub fn brotli_decompress_with_dict_with_capacity(
    data: &[u8],
    dict: &[u8],
    capacity: f64,
) -> Result<Vec<u8>, JsError> {
    let cap = comprs_core::validate_capacity(capacity).map_err(to_js_error)?;
    comprs_core::brotli::decompress_with_dict_with_capacity(data, dict, cap).map_err(to_js_error)
}

// ---------------------------------------------------------------------------
// LZ4 one-shot
// ---------------------------------------------------------------------------

#[wasm_bindgen(js_name = "lz4Compress")]
pub fn lz4_compress(data: &[u8]) -> Result<Vec<u8>, JsError> {
    comprs_core::lz4::compress(data).map_err(to_js_error)
}

#[wasm_bindgen(js_name = "lz4Decompress")]
pub fn lz4_decompress(data: &[u8]) -> Result<Vec<u8>, JsError> {
    comprs_core::lz4::decompress(data).map_err(to_js_error)
}

#[wasm_bindgen(js_name = "lz4DecompressWithCapacity")]
pub fn lz4_decompress_with_capacity(data: &[u8], capacity: f64) -> Result<Vec<u8>, JsError> {
    let cap = comprs_core::validate_capacity(capacity).map_err(to_js_error)?;
    comprs_core::lz4::decompress_with_capacity(data, cap).map_err(to_js_error)
}

// ---------------------------------------------------------------------------
// Auto-detect
// ---------------------------------------------------------------------------

#[wasm_bindgen(js_name = "detectFormat")]
pub fn detect_format(data: &[u8]) -> String {
    comprs_core::detect::detect(data).to_string()
}

/// Decompress data by auto-detecting the compression format.
#[wasm_bindgen(js_name = "decompress")]
pub fn decompress(data: &[u8]) -> Result<Vec<u8>, JsError> {
    comprs_core::detect::decompress(data).map_err(to_js_error)
}

// ---------------------------------------------------------------------------
// CRC32
// ---------------------------------------------------------------------------

#[wasm_bindgen]
pub fn crc32(data: &[u8], initial_value: Option<f64>) -> Result<u32, JsError> {
    let initial_value = comprs_core::crc::INITIAL_VALUE
        .check_optional_f64(initial_value)
        .map_err(to_js_error)?;
    Ok(comprs_core::crc::crc32(data, initial_value))
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
    pub fn new(level: Option<f64>) -> Result<ZstdCompressContext, JsError> {
        let level = comprs_core::zstd::LEVEL
            .check_optional_f64(level)
            .map_err(to_js_error)?;
        Ok(Self {
            inner: comprs_core::zstd_stream::CompressContext::new(level).map_err(to_js_error)?,
        })
    }

    pub fn transform(&mut self, chunk: &[u8]) -> Result<Vec<u8>, JsError> {
        self.inner.transform(chunk).map_err(to_js_error)
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

    pub fn transform(&mut self, chunk: &[u8]) -> Result<Vec<u8>, JsError> {
        self.inner.transform(chunk).map_err(to_js_error)
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
    pub fn new(dict: &[u8], level: Option<f64>) -> Result<ZstdCompressDictContext, JsError> {
        let level = comprs_core::zstd::LEVEL
            .check_optional_f64(level)
            .map_err(to_js_error)?;
        Ok(Self {
            inner: comprs_core::zstd_stream::CompressDictContext::new(dict, level)
                .map_err(to_js_error)?,
        })
    }

    pub fn transform(&mut self, chunk: &[u8]) -> Result<Vec<u8>, JsError> {
        self.inner.transform(chunk).map_err(to_js_error)
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
        dict: &[u8],
        max_output_size: Option<f64>,
    ) -> Result<ZstdDecompressDictContext, JsError> {
        Ok(Self {
            inner: comprs_core::zstd_stream::DecompressDictContext::new(dict, max_output_size)
                .map_err(to_js_error)?,
        })
    }

    pub fn transform(&mut self, chunk: &[u8]) -> Result<Vec<u8>, JsError> {
        self.inner.transform(chunk).map_err(to_js_error)
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
    pub fn new(level: Option<f64>) -> Result<GzipCompressContext, JsError> {
        let level = comprs_core::gzip::LEVEL
            .check_optional_f64(level)
            .map_err(to_js_error)?;
        Ok(Self {
            inner: comprs_core::gzip_stream::GzipCompressContext::new(level)
                .map_err(to_js_error)?,
        })
    }

    pub fn transform(&mut self, chunk: &[u8]) -> Result<Vec<u8>, JsError> {
        self.inner.transform(chunk).map_err(to_js_error)
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

    pub fn transform(&mut self, chunk: &[u8]) -> Result<Vec<u8>, JsError> {
        self.inner.transform(chunk).map_err(to_js_error)
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
    pub fn new(level: Option<f64>) -> Result<DeflateCompressContext, JsError> {
        let level = comprs_core::gzip::DEFLATE_LEVEL
            .check_optional_f64(level)
            .map_err(to_js_error)?;
        Ok(Self {
            inner: comprs_core::gzip_stream::DeflateCompressContext::new(level)
                .map_err(to_js_error)?,
        })
    }

    pub fn transform(&mut self, chunk: &[u8]) -> Result<Vec<u8>, JsError> {
        self.inner.transform(chunk).map_err(to_js_error)
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

    pub fn transform(&mut self, chunk: &[u8]) -> Result<Vec<u8>, JsError> {
        self.inner.transform(chunk).map_err(to_js_error)
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
    pub fn new(quality: Option<f64>) -> Result<BrotliCompressContext, JsError> {
        let quality = comprs_core::brotli::QUALITY
            .check_optional_f64(quality)
            .map_err(to_js_error)?;
        Ok(Self {
            inner: comprs_core::brotli_stream::CompressContext::new(quality)
                .map_err(to_js_error)?,
        })
    }

    pub fn transform(&mut self, chunk: &[u8]) -> Result<Vec<u8>, JsError> {
        self.inner.transform(chunk).map_err(to_js_error)
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

    pub fn transform(&mut self, chunk: &[u8]) -> Result<Vec<u8>, JsError> {
        self.inner.transform(chunk).map_err(to_js_error)
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
    pub fn new(dict: &[u8], quality: Option<f64>) -> Result<BrotliCompressDictContext, JsError> {
        let quality = comprs_core::brotli::QUALITY
            .check_optional_f64(quality)
            .map_err(to_js_error)?;
        Ok(Self {
            inner: comprs_core::brotli_stream::CompressDictContext::new(dict, quality)
                .map_err(to_js_error)?,
        })
    }

    pub fn transform(&mut self, chunk: &[u8]) -> Result<Vec<u8>, JsError> {
        self.inner.transform(chunk).map_err(to_js_error)
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
        dict: &[u8],
        max_output_size: Option<f64>,
    ) -> Result<BrotliDecompressDictContext, JsError> {
        Ok(Self {
            inner: comprs_core::brotli_stream::DecompressDictContext::new(dict, max_output_size)
                .map_err(to_js_error)?,
        })
    }

    pub fn transform(&mut self, chunk: &[u8]) -> Result<Vec<u8>, JsError> {
        self.inner.transform(chunk).map_err(to_js_error)
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

    pub fn transform(&mut self, chunk: &[u8]) -> Result<Vec<u8>, JsError> {
        self.inner.transform(chunk).map_err(to_js_error)
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

    pub fn transform(&mut self, chunk: &[u8]) -> Result<Vec<u8>, JsError> {
        self.inner.transform(chunk).map_err(to_js_error)
    }

    pub fn flush(&mut self) -> Result<Vec<u8>, JsError> {
        self.inner.flush().map_err(to_js_error)
    }
}
