//! Brotli compression and decompression.

use std::io::Write;

use napi::Task;
use napi::bindgen_prelude::*;
use napi_derive::napi;

use crate::ZflateError;

/// Default compression quality for brotli.
const DEFAULT_QUALITY: u32 = 6;

/// Default buffer size for brotli operations.
const BUFFER_SIZE: usize = 4096;

/// Default log2 of the sliding window size for brotli.
const LG_WINDOW_SIZE: u32 = 22;

/// Maximum allowed decompressed size (256 MB) to prevent memory exhaustion.
const MAX_DECOMPRESSED_SIZE: usize = 256 * 1024 * 1024;

/// Compress data using Brotli.
///
/// Returns the compressed data as a Buffer.
/// Quality ranges from 0 (fastest) to 11 (best compression). Default is 6.
#[napi]
pub fn brotli_compress(data: Either<Buffer, Uint8Array>, quality: Option<u32>) -> Result<Buffer> {
    let quality = quality.unwrap_or(DEFAULT_QUALITY);
    if quality > 11 {
        return Err(
            ZflateError::InvalidArg("brotli quality must be between 0 and 11".to_string()).into(),
        );
    }
    let input = crate::as_bytes(&data);

    let mut output = Vec::with_capacity(input.len());
    {
        let mut compressor =
            brotli::CompressorWriter::new(&mut output, BUFFER_SIZE, quality, LG_WINDOW_SIZE);
        compressor.write_all(input).map_err(|e| {
            napi::Error::from(ZflateError::Operation {
                context: "brotli compress",
                source: e.into(),
            })
        })?;
        // Drop compressor to flush and finalize
    }

    Ok(output.into())
}

/// Decompress Brotli-compressed data.
///
/// Returns the decompressed data as a Buffer.
/// The maximum decompressed size is 256 MB.
#[napi]
pub fn brotli_decompress(data: Either<Buffer, Uint8Array>) -> Result<Buffer> {
    let input = crate::as_bytes(&data);
    let decompressor = brotli::Decompressor::new(input, BUFFER_SIZE);
    let init_cap = (input.len() * 4).min(MAX_DECOMPRESSED_SIZE);
    crate::decompress_with_limit(
        decompressor,
        MAX_DECOMPRESSED_SIZE,
        init_cap,
        "brotli decompress",
    )
    .map(|v| v.into())
}

/// Decompress Brotli-compressed data with explicit capacity.
///
/// Use this when the decompressed size exceeds the default 256 MB limit.
/// The `capacity` parameter specifies the maximum decompressed size in bytes.
#[napi]
pub fn brotli_decompress_with_capacity(
    data: Either<Buffer, Uint8Array>,
    capacity: f64,
) -> Result<Buffer> {
    if !capacity.is_finite() || capacity < 0.0 {
        return Err(ZflateError::InvalidArg(
            "capacity must be a positive finite number".to_string(),
        )
        .into());
    }
    let input = crate::as_bytes(&data);
    let cap = capacity as usize;
    let decompressor = brotli::Decompressor::new(input, BUFFER_SIZE);
    let init_cap = (input.len() * 4).min(cap);
    crate::decompress_with_limit(decompressor, cap, init_cap, "brotli decompress").map(|v| v.into())
}

// --- Async tasks ---

pub struct BrotliCompressTask {
    data: Vec<u8>,
    quality: u32,
}

#[napi]
impl Task for BrotliCompressTask {
    type Output = Vec<u8>;
    type JsValue = Buffer;

    fn compute(&mut self) -> Result<Self::Output> {
        let mut output = Vec::with_capacity(self.data.len());
        {
            let mut compressor = brotli::CompressorWriter::new(
                &mut output,
                BUFFER_SIZE,
                self.quality,
                LG_WINDOW_SIZE,
            );
            compressor.write_all(&self.data).map_err(|e| {
                napi::Error::from(ZflateError::Operation {
                    context: "brotli compress",
                    source: e.into(),
                })
            })?;
            // Drop compressor to flush and finalize
        }
        Ok(output)
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output.into())
    }
}

/// Asynchronously compress data using Brotli.
///
/// Returns a Promise that resolves to the compressed data as a Buffer.
/// Quality ranges from 0 (fastest) to 11 (best compression). Default is 6.
#[napi]
pub fn brotli_compress_async(
    data: Either<Buffer, Uint8Array>,
    quality: Option<u32>,
) -> Result<AsyncTask<BrotliCompressTask>> {
    let quality = quality.unwrap_or(DEFAULT_QUALITY);
    if quality > 11 {
        return Err(
            ZflateError::InvalidArg("brotli quality must be between 0 and 11".to_string()).into(),
        );
    }
    let input = crate::as_bytes(&data).to_vec();
    Ok(AsyncTask::new(BrotliCompressTask {
        data: input,
        quality,
    }))
}

pub struct BrotliDecompressTask {
    data: Vec<u8>,
}

#[napi]
impl Task for BrotliDecompressTask {
    type Output = Vec<u8>;
    type JsValue = Buffer;

    fn compute(&mut self) -> Result<Self::Output> {
        let decompressor = brotli::Decompressor::new(self.data.as_slice(), BUFFER_SIZE);
        let init_cap = (self.data.len() * 4).min(MAX_DECOMPRESSED_SIZE);
        crate::decompress_with_limit(
            decompressor,
            MAX_DECOMPRESSED_SIZE,
            init_cap,
            "brotli decompress",
        )
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output.into())
    }
}

/// Asynchronously decompress Brotli-compressed data.
///
/// Returns a Promise that resolves to the decompressed data as a Buffer.
/// The maximum decompressed size is 256 MB.
#[napi]
pub fn brotli_decompress_async(
    data: Either<Buffer, Uint8Array>,
) -> AsyncTask<BrotliDecompressTask> {
    let input = crate::as_bytes(&data).to_vec();
    AsyncTask::new(BrotliDecompressTask { data: input })
}

pub struct BrotliDecompressWithCapacityTask {
    data: Vec<u8>,
    capacity: usize,
}

#[napi]
impl Task for BrotliDecompressWithCapacityTask {
    type Output = Vec<u8>;
    type JsValue = Buffer;

    fn compute(&mut self) -> Result<Self::Output> {
        let decompressor = brotli::Decompressor::new(self.data.as_slice(), BUFFER_SIZE);
        let init_cap = (self.data.len() * 4).min(self.capacity);
        crate::decompress_with_limit(decompressor, self.capacity, init_cap, "brotli decompress")
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output.into())
    }
}

/// Asynchronously decompress Brotli-compressed data with explicit capacity.
///
/// Use this when the decompressed size exceeds the default 256 MB limit.
/// The `capacity` parameter specifies the maximum decompressed size in bytes.
#[napi]
pub fn brotli_decompress_with_capacity_async(
    data: Either<Buffer, Uint8Array>,
    capacity: f64,
) -> Result<AsyncTask<BrotliDecompressWithCapacityTask>> {
    if !capacity.is_finite() || capacity < 0.0 {
        return Err(ZflateError::InvalidArg(
            "capacity must be a positive finite number".to_string(),
        )
        .into());
    }
    let input = crate::as_bytes(&data).to_vec();
    let cap = capacity as usize;
    Ok(AsyncTask::new(BrotliDecompressWithCapacityTask {
        data: input,
        capacity: cap,
    }))
}

#[cfg(test)]
mod tests {
    use std::io::{Read, Write};

    /// Default compression quality for brotli.
    const DEFAULT_QUALITY: u32 = 6;

    /// Default buffer size for brotli operations.
    const BUFFER_SIZE: usize = 4096;

    /// Default log2 of the sliding window size for brotli.
    const LG_WINDOW_SIZE: u32 = 22;

    #[test]
    fn round_trip_basic() {
        let original = b"Hello, zflate! This is a test of brotli compression.";
        let mut compressed = Vec::new();
        {
            let mut compressor = brotli::CompressorWriter::new(
                &mut compressed,
                BUFFER_SIZE,
                DEFAULT_QUALITY,
                LG_WINDOW_SIZE,
            );
            compressor.write_all(original).unwrap();
        }
        let mut decompressor = brotli::Decompressor::new(compressed.as_slice(), BUFFER_SIZE);
        let mut decompressed = Vec::new();
        decompressor.read_to_end(&mut decompressed).unwrap();
        assert_eq!(original.as_slice(), decompressed.as_slice());
    }

    #[test]
    fn round_trip_empty() {
        let original = b"";
        let mut compressed = Vec::new();
        {
            let mut compressor = brotli::CompressorWriter::new(
                &mut compressed,
                BUFFER_SIZE,
                DEFAULT_QUALITY,
                LG_WINDOW_SIZE,
            );
            compressor.write_all(original).unwrap();
        }
        let mut decompressor = brotli::Decompressor::new(compressed.as_slice(), BUFFER_SIZE);
        let mut decompressed = Vec::new();
        decompressor.read_to_end(&mut decompressed).unwrap();
        assert_eq!(original.as_slice(), decompressed.as_slice());
    }

    #[test]
    fn round_trip_large() {
        let original: Vec<u8> = (0..100_000).map(|i| (i % 256) as u8).collect();
        let mut compressed = Vec::new();
        {
            let mut compressor = brotli::CompressorWriter::new(
                &mut compressed,
                BUFFER_SIZE,
                DEFAULT_QUALITY,
                LG_WINDOW_SIZE,
            );
            compressor.write_all(&original).unwrap();
        }
        let mut decompressor = brotli::Decompressor::new(compressed.as_slice(), BUFFER_SIZE);
        let mut decompressed = Vec::new();
        decompressor.read_to_end(&mut decompressed).unwrap();
        assert_eq!(original, decompressed);
        // Compression should actually reduce size for repetitive data
        assert!(compressed.len() < original.len());
    }

    #[test]
    fn compression_quality_levels() {
        let data = b"Repeating data for compression quality testing. ".repeat(100);
        let compress_at = |q: u32| {
            let mut compressed = Vec::new();
            {
                let mut compressor =
                    brotli::CompressorWriter::new(&mut compressed, BUFFER_SIZE, q, LG_WINDOW_SIZE);
                compressor.write_all(&data).unwrap();
            }
            compressed
        };

        let fast = compress_at(0);
        let default = compress_at(DEFAULT_QUALITY);
        let best = compress_at(11);

        // Higher quality should generally produce smaller output
        assert!(best.len() <= default.len());
        assert!(default.len() <= fast.len());
    }

    #[test]
    fn all_quality_levels_round_trip() {
        let data = b"Quality level test data. ".repeat(50);
        for quality in 0..=11 {
            let mut compressed = Vec::new();
            {
                let mut compressor = brotli::CompressorWriter::new(
                    &mut compressed,
                    BUFFER_SIZE,
                    quality,
                    LG_WINDOW_SIZE,
                );
                compressor.write_all(&data).unwrap();
            }
            let mut decompressor = brotli::Decompressor::new(compressed.as_slice(), BUFFER_SIZE);
            let mut decompressed = Vec::new();
            decompressor.read_to_end(&mut decompressed).unwrap();
            assert_eq!(data.as_slice(), decompressed.as_slice());
        }
    }
}
