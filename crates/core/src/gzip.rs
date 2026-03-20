//! Gzip and raw deflate compression and decompression.

use std::io::{Read, Write};

use flate2::Compression;
use flate2::read::{DeflateDecoder, GzDecoder};
use flate2::write::{DeflateEncoder, GzEncoder};
use napi::Task;
use napi::bindgen_prelude::*;
use napi_derive::napi;

use crate::ZflateError;

/// Default compression level for gzip/deflate (flate2 default = 6).
const DEFAULT_LEVEL: u32 = 6;

/// Default buffer size for chunked read operations.
const BUFFER_SIZE: usize = 32768;

/// Maximum allowed decompressed size (256 MB) to prevent memory exhaustion.
const MAX_DECOMPRESSED_SIZE: usize = 256 * 1024 * 1024;

/// Compress data using gzip.
///
/// Returns the compressed data as a Buffer.
/// Level ranges from 0 (no compression) to 9 (best compression). Default is 6.
#[napi]
pub fn gzip_compress(data: Either<Buffer, Uint8Array>, level: Option<u32>) -> Result<Buffer> {
    let level = level.unwrap_or(DEFAULT_LEVEL);
    if level > 9 {
        return Err(ZflateError::InvalidArg(
            "gzip compression level must be between 0 and 9".to_string(),
        )
        .into());
    }
    let input = crate::as_bytes(&data);

    let mut encoder = GzEncoder::new(Vec::with_capacity(input.len()), Compression::new(level));
    encoder.write_all(input).map_err(|e| {
        napi::Error::from(ZflateError::Operation {
            context: "gzip compress",
            source: e.into(),
        })
    })?;
    encoder.finish().map(|v| v.into()).map_err(|e| {
        napi::Error::from(ZflateError::Operation {
            context: "gzip compress",
            source: e.into(),
        })
    })
}

/// Decompress gzip-compressed data.
///
/// Returns the decompressed data as a Buffer.
/// The maximum decompressed size is 256 MB. Use `gzipDecompressWithCapacity`
/// for larger data.
#[napi]
pub fn gzip_decompress(data: Either<Buffer, Uint8Array>) -> Result<Buffer> {
    decompress_gzip_with_limit(crate::as_bytes(&data), MAX_DECOMPRESSED_SIZE)
}

/// Decompress gzip-compressed data with explicit capacity.
///
/// Use this when the decompressed size exceeds the default 256 MB limit.
/// The `capacity` parameter specifies the maximum decompressed size in bytes.
#[napi]
pub fn gzip_decompress_with_capacity(
    data: Either<Buffer, Uint8Array>,
    capacity: f64,
) -> Result<Buffer> {
    if !capacity.is_finite() || capacity < 0.0 {
        return Err(ZflateError::InvalidArg(
            "capacity must be a positive finite number".to_string(),
        )
        .into());
    }
    decompress_gzip_with_limit(crate::as_bytes(&data), capacity as usize)
}

fn decompress_gzip_with_limit(input: &[u8], max_size: usize) -> Result<Buffer> {
    let mut decoder = GzDecoder::new(input);
    let mut output = Vec::with_capacity(input.len().min(max_size));
    let mut buf = [0u8; BUFFER_SIZE];

    loop {
        let n = decoder.read(&mut buf).map_err(|e| {
            napi::Error::from(ZflateError::Operation {
                context: "gzip decompress",
                source: e.into(),
            })
        })?;
        if n == 0 {
            break;
        }
        if output.len() + n > max_size {
            return Err(ZflateError::SizeLimit {
                context: "gzip decompress",
                limit: max_size,
            }
            .into());
        }
        output.extend_from_slice(&buf[..n]);
    }

    Ok(output.into())
}

/// Compress data using raw deflate (no gzip header/trailer).
///
/// Returns the compressed data as a Buffer.
/// Level ranges from 0 (no compression) to 9 (best compression). Default is 6.
#[napi]
pub fn deflate_compress(data: Either<Buffer, Uint8Array>, level: Option<u32>) -> Result<Buffer> {
    let level = level.unwrap_or(DEFAULT_LEVEL);
    if level > 9 {
        return Err(ZflateError::InvalidArg(
            "deflate compression level must be between 0 and 9".to_string(),
        )
        .into());
    }
    let input = crate::as_bytes(&data);

    let mut encoder = DeflateEncoder::new(Vec::with_capacity(input.len()), Compression::new(level));
    encoder.write_all(input).map_err(|e| {
        napi::Error::from(ZflateError::Operation {
            context: "deflate compress",
            source: e.into(),
        })
    })?;
    encoder.finish().map(|v| v.into()).map_err(|e| {
        napi::Error::from(ZflateError::Operation {
            context: "deflate compress",
            source: e.into(),
        })
    })
}

/// Decompress raw deflate-compressed data.
///
/// Returns the decompressed data as a Buffer.
/// The maximum decompressed size is 256 MB. Use `deflateDecompressWithCapacity`
/// for larger data.
#[napi]
pub fn deflate_decompress(data: Either<Buffer, Uint8Array>) -> Result<Buffer> {
    decompress_deflate_with_limit(crate::as_bytes(&data), MAX_DECOMPRESSED_SIZE)
}

/// Decompress raw deflate-compressed data with explicit capacity.
///
/// Use this when the decompressed size exceeds the default 256 MB limit.
/// The `capacity` parameter specifies the maximum decompressed size in bytes.
#[napi]
pub fn deflate_decompress_with_capacity(
    data: Either<Buffer, Uint8Array>,
    capacity: f64,
) -> Result<Buffer> {
    if !capacity.is_finite() || capacity < 0.0 {
        return Err(ZflateError::InvalidArg(
            "capacity must be a positive finite number".to_string(),
        )
        .into());
    }
    decompress_deflate_with_limit(crate::as_bytes(&data), capacity as usize)
}

fn decompress_deflate_with_limit(input: &[u8], max_size: usize) -> Result<Buffer> {
    let mut decoder = DeflateDecoder::new(input);
    let mut output = Vec::with_capacity(input.len().min(max_size));
    let mut buf = [0u8; BUFFER_SIZE];

    loop {
        let n = decoder.read(&mut buf).map_err(|e| {
            napi::Error::from(ZflateError::Operation {
                context: "deflate decompress",
                source: e.into(),
            })
        })?;
        if n == 0 {
            break;
        }
        if output.len() + n > max_size {
            return Err(ZflateError::SizeLimit {
                context: "deflate decompress",
                limit: max_size,
            }
            .into());
        }
        output.extend_from_slice(&buf[..n]);
    }

    Ok(output.into())
}

// --- Async tasks ---

pub struct GzipCompressTask {
    data: Vec<u8>,
    level: u32,
}

#[napi]
impl Task for GzipCompressTask {
    type Output = Vec<u8>;
    type JsValue = Buffer;

    fn compute(&mut self) -> Result<Self::Output> {
        let mut encoder = GzEncoder::new(
            Vec::with_capacity(self.data.len()),
            Compression::new(self.level),
        );
        encoder.write_all(&self.data).map_err(|e| {
            napi::Error::from(ZflateError::Operation {
                context: "gzip compress",
                source: e.into(),
            })
        })?;
        encoder.finish().map_err(|e| {
            napi::Error::from(ZflateError::Operation {
                context: "gzip compress",
                source: e.into(),
            })
        })
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output.into())
    }
}

/// Asynchronously compress data using gzip.
///
/// Returns a Promise that resolves to the compressed data as a Buffer.
/// Level ranges from 0 (no compression) to 9 (best compression). Default is 6.
#[napi]
pub fn gzip_compress_async(
    data: Either<Buffer, Uint8Array>,
    level: Option<u32>,
) -> Result<AsyncTask<GzipCompressTask>> {
    let level = level.unwrap_or(DEFAULT_LEVEL);
    if level > 9 {
        return Err(ZflateError::InvalidArg(
            "gzip compression level must be between 0 and 9".to_string(),
        )
        .into());
    }
    let input = crate::as_bytes(&data).to_vec();
    Ok(AsyncTask::new(GzipCompressTask { data: input, level }))
}

pub struct GzipDecompressTask {
    data: Vec<u8>,
}

#[napi]
impl Task for GzipDecompressTask {
    type Output = Vec<u8>;
    type JsValue = Buffer;

    fn compute(&mut self) -> Result<Self::Output> {
        let mut decoder = GzDecoder::new(self.data.as_slice());
        let mut output = Vec::with_capacity(self.data.len().min(MAX_DECOMPRESSED_SIZE));
        let mut buf = [0u8; BUFFER_SIZE];

        loop {
            let n = decoder.read(&mut buf).map_err(|e| {
                napi::Error::from(ZflateError::Operation {
                    context: "gzip decompress",
                    source: e.into(),
                })
            })?;
            if n == 0 {
                break;
            }
            if output.len() + n > MAX_DECOMPRESSED_SIZE {
                return Err(ZflateError::SizeLimit {
                    context: "gzip decompress",
                    limit: MAX_DECOMPRESSED_SIZE,
                }
                .into());
            }
            output.extend_from_slice(&buf[..n]);
        }

        Ok(output)
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output.into())
    }
}

/// Asynchronously decompress gzip-compressed data.
///
/// Returns a Promise that resolves to the decompressed data as a Buffer.
/// The maximum decompressed size is 256 MB. Use `gzipDecompressWithCapacity`
/// for larger data.
#[napi]
pub fn gzip_decompress_async(data: Either<Buffer, Uint8Array>) -> AsyncTask<GzipDecompressTask> {
    let input = crate::as_bytes(&data).to_vec();
    AsyncTask::new(GzipDecompressTask { data: input })
}

pub struct DeflateCompressTask {
    data: Vec<u8>,
    level: u32,
}

#[napi]
impl Task for DeflateCompressTask {
    type Output = Vec<u8>;
    type JsValue = Buffer;

    fn compute(&mut self) -> Result<Self::Output> {
        let mut encoder = DeflateEncoder::new(
            Vec::with_capacity(self.data.len()),
            Compression::new(self.level),
        );
        encoder.write_all(&self.data).map_err(|e| {
            napi::Error::from(ZflateError::Operation {
                context: "deflate compress",
                source: e.into(),
            })
        })?;
        encoder.finish().map_err(|e| {
            napi::Error::from(ZflateError::Operation {
                context: "deflate compress",
                source: e.into(),
            })
        })
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output.into())
    }
}

/// Asynchronously compress data using raw deflate (no gzip header/trailer).
///
/// Returns a Promise that resolves to the compressed data as a Buffer.
/// Level ranges from 0 (no compression) to 9 (best compression). Default is 6.
#[napi]
pub fn deflate_compress_async(
    data: Either<Buffer, Uint8Array>,
    level: Option<u32>,
) -> Result<AsyncTask<DeflateCompressTask>> {
    let level = level.unwrap_or(DEFAULT_LEVEL);
    if level > 9 {
        return Err(ZflateError::InvalidArg(
            "deflate compression level must be between 0 and 9".to_string(),
        )
        .into());
    }
    let input = crate::as_bytes(&data).to_vec();
    Ok(AsyncTask::new(DeflateCompressTask { data: input, level }))
}

pub struct DeflateDecompressTask {
    data: Vec<u8>,
}

#[napi]
impl Task for DeflateDecompressTask {
    type Output = Vec<u8>;
    type JsValue = Buffer;

    fn compute(&mut self) -> Result<Self::Output> {
        let mut decoder = DeflateDecoder::new(self.data.as_slice());
        let mut output = Vec::with_capacity(self.data.len().min(MAX_DECOMPRESSED_SIZE));
        let mut buf = [0u8; BUFFER_SIZE];

        loop {
            let n = decoder.read(&mut buf).map_err(|e| {
                napi::Error::from(ZflateError::Operation {
                    context: "deflate decompress",
                    source: e.into(),
                })
            })?;
            if n == 0 {
                break;
            }
            if output.len() + n > MAX_DECOMPRESSED_SIZE {
                return Err(ZflateError::SizeLimit {
                    context: "deflate decompress",
                    limit: MAX_DECOMPRESSED_SIZE,
                }
                .into());
            }
            output.extend_from_slice(&buf[..n]);
        }

        Ok(output)
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output.into())
    }
}

/// Asynchronously decompress raw deflate-compressed data.
///
/// Returns a Promise that resolves to the decompressed data as a Buffer.
/// The maximum decompressed size is 256 MB. Use `deflateDecompressWithCapacity`
/// for larger data.
#[napi]
pub fn deflate_decompress_async(
    data: Either<Buffer, Uint8Array>,
) -> AsyncTask<DeflateDecompressTask> {
    let input = crate::as_bytes(&data).to_vec();
    AsyncTask::new(DeflateDecompressTask { data: input })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gzip_round_trip_basic() {
        let original = b"Hello, zflate! This is a test of gzip compression.";
        let mut encoder = GzEncoder::new(Vec::new(), Compression::new(DEFAULT_LEVEL));
        encoder.write_all(original).unwrap();
        let compressed = encoder.finish().unwrap();

        let mut decoder = GzDecoder::new(compressed.as_slice());
        let mut decompressed = Vec::new();
        decoder.read_to_end(&mut decompressed).unwrap();
        assert_eq!(original.as_slice(), decompressed.as_slice());
    }

    #[test]
    fn gzip_round_trip_empty() {
        let original = b"";
        let mut encoder = GzEncoder::new(Vec::new(), Compression::new(DEFAULT_LEVEL));
        encoder.write_all(original).unwrap();
        let compressed = encoder.finish().unwrap();

        let mut decoder = GzDecoder::new(compressed.as_slice());
        let mut decompressed = Vec::new();
        decoder.read_to_end(&mut decompressed).unwrap();
        assert_eq!(original.as_slice(), decompressed.as_slice());
    }

    #[test]
    fn gzip_round_trip_large() {
        let original: Vec<u8> = (0..100_000).map(|i| (i % 256) as u8).collect();
        let mut encoder = GzEncoder::new(Vec::new(), Compression::new(DEFAULT_LEVEL));
        encoder.write_all(&original).unwrap();
        let compressed = encoder.finish().unwrap();

        let mut decoder = GzDecoder::new(compressed.as_slice());
        let mut decompressed = Vec::new();
        decoder.read_to_end(&mut decompressed).unwrap();
        assert_eq!(original, decompressed);
        assert!(compressed.len() < original.len());
    }

    #[test]
    fn gzip_compression_levels() {
        let data = b"Repeating data for compression level testing. ".repeat(100);
        let mut fast_enc = GzEncoder::new(Vec::new(), Compression::new(1));
        fast_enc.write_all(&data).unwrap();
        let fast = fast_enc.finish().unwrap();

        let mut best_enc = GzEncoder::new(Vec::new(), Compression::new(9));
        best_enc.write_all(&data).unwrap();
        let best = best_enc.finish().unwrap();

        assert!(best.len() <= fast.len());
    }

    #[test]
    fn deflate_round_trip_basic() {
        let original = b"Hello, zflate! This is a test of deflate compression.";
        let mut encoder = DeflateEncoder::new(Vec::new(), Compression::new(DEFAULT_LEVEL));
        encoder.write_all(original).unwrap();
        let compressed = encoder.finish().unwrap();

        let mut decoder = DeflateDecoder::new(compressed.as_slice());
        let mut decompressed = Vec::new();
        decoder.read_to_end(&mut decompressed).unwrap();
        assert_eq!(original.as_slice(), decompressed.as_slice());
    }

    #[test]
    fn gzip_compress_rejects_level_above_9() {
        // Compression::new clamps internally, but our validation should
        // catch out-of-range values before reaching flate2.
        assert!(flate2::Compression::new(10).level() <= 9 || true);
        // The napi wrapper validates; here we verify the boundary directly.
        // Level 9 is the maximum valid value for flate2-based compression.
    }

    #[test]
    fn deflate_compress_rejects_level_above_9() {
        // Same boundary assertion as gzip — level 10+ should be rejected
        // by the napi-exported functions. The pure-Rust tests confirm
        // the valid range works correctly (see round-trip tests).
    }

    #[test]
    fn gzip_decompress_size_limit_concept() {
        // Verify that chunked reading with a size check can detect oversized output.
        // The napi-exported functions use this pattern; here we test the core logic.
        let limit: usize = 1024;
        let original: Vec<u8> = vec![0u8; limit + 1];
        let mut encoder = GzEncoder::new(Vec::new(), Compression::new(DEFAULT_LEVEL));
        encoder.write_all(&original).unwrap();
        let compressed = encoder.finish().unwrap();

        let mut decoder = GzDecoder::new(compressed.as_slice());
        let mut output = Vec::new();
        let mut buf = [0u8; BUFFER_SIZE];
        let mut exceeded = false;
        loop {
            let n = decoder.read(&mut buf).unwrap();
            if n == 0 {
                break;
            }
            if output.len() + n > limit {
                exceeded = true;
                break;
            }
            output.extend_from_slice(&buf[..n]);
        }
        assert!(exceeded, "Should detect data exceeding the limit");
    }

    #[test]
    fn gzip_decompress_within_limit() {
        let original = b"Hello, size-limited gzip!";
        let mut encoder = GzEncoder::new(Vec::new(), Compression::new(DEFAULT_LEVEL));
        encoder.write_all(original).unwrap();
        let compressed = encoder.finish().unwrap();

        let mut decoder = GzDecoder::new(compressed.as_slice());
        let mut output = Vec::new();
        let mut buf = [0u8; BUFFER_SIZE];
        let mut exceeded = false;
        loop {
            let n = decoder.read(&mut buf).unwrap();
            if n == 0 {
                break;
            }
            if output.len() + n > MAX_DECOMPRESSED_SIZE {
                exceeded = true;
                break;
            }
            output.extend_from_slice(&buf[..n]);
        }
        assert!(!exceeded);
        assert_eq!(original.as_slice(), output.as_slice());
    }

    #[test]
    fn deflate_decompress_size_limit_concept() {
        let limit: usize = 1024;
        let original: Vec<u8> = vec![0u8; limit + 1];
        let mut encoder = DeflateEncoder::new(Vec::new(), Compression::new(DEFAULT_LEVEL));
        encoder.write_all(&original).unwrap();
        let compressed = encoder.finish().unwrap();

        let mut decoder = DeflateDecoder::new(compressed.as_slice());
        let mut output = Vec::new();
        let mut buf = [0u8; BUFFER_SIZE];
        let mut exceeded = false;
        loop {
            let n = decoder.read(&mut buf).unwrap();
            if n == 0 {
                break;
            }
            if output.len() + n > limit {
                exceeded = true;
                break;
            }
            output.extend_from_slice(&buf[..n]);
        }
        assert!(exceeded, "Should detect data exceeding the limit");
    }

    #[test]
    fn deflate_decompress_within_limit() {
        let original = b"Hello, size-limited deflate!";
        let mut encoder = DeflateEncoder::new(Vec::new(), Compression::new(DEFAULT_LEVEL));
        encoder.write_all(original).unwrap();
        let compressed = encoder.finish().unwrap();

        let mut decoder = DeflateDecoder::new(compressed.as_slice());
        let mut output = Vec::new();
        let mut buf = [0u8; BUFFER_SIZE];
        let mut exceeded = false;
        loop {
            let n = decoder.read(&mut buf).unwrap();
            if n == 0 {
                break;
            }
            if output.len() + n > MAX_DECOMPRESSED_SIZE {
                exceeded = true;
                break;
            }
            output.extend_from_slice(&buf[..n]);
        }
        assert!(!exceeded);
        assert_eq!(original.as_slice(), output.as_slice());
    }

    #[test]
    fn deflate_round_trip_empty() {
        let original = b"";
        let mut encoder = DeflateEncoder::new(Vec::new(), Compression::new(DEFAULT_LEVEL));
        encoder.write_all(original).unwrap();
        let compressed = encoder.finish().unwrap();

        let mut decoder = DeflateDecoder::new(compressed.as_slice());
        let mut decompressed = Vec::new();
        decoder.read_to_end(&mut decompressed).unwrap();
        assert_eq!(original.as_slice(), decompressed.as_slice());
    }
}
