//! LZ4 frame compression and decompression.

use std::io::Write;

use lz4_flex::frame::{FrameDecoder, FrameEncoder};
use napi::Task;
use napi::bindgen_prelude::*;
use napi_derive::napi;

use crate::ZflateError;

/// Maximum allowed decompressed size (256 MB) to prevent memory exhaustion.
const MAX_DECOMPRESSED_SIZE: usize = 256 * 1024 * 1024;

/// Compress data using LZ4 frame format.
///
/// Returns the compressed data as a Buffer.
#[napi]
pub fn lz4_compress(data: Either<Buffer, Uint8Array>) -> Result<Buffer> {
    let input = crate::as_bytes(&data);

    let mut output = Vec::with_capacity(input.len());
    let mut encoder = FrameEncoder::new(&mut output);
    encoder.write_all(input).map_err(|e| {
        napi::Error::from(ZflateError::Operation {
            context: "lz4 compress",
            source: e.into(),
        })
    })?;
    encoder.finish().map_err(|e| {
        napi::Error::from(ZflateError::Operation {
            context: "lz4 compress",
            source: e.into(),
        })
    })?;

    Ok(output.into())
}

/// Decompress LZ4 frame-compressed data.
///
/// Returns the decompressed data as a Buffer.
/// The maximum decompressed size is 256 MB. Use `lz4DecompressWithCapacity`
/// for larger data.
#[napi]
pub fn lz4_decompress(data: Either<Buffer, Uint8Array>) -> Result<Buffer> {
    let input = crate::as_bytes(&data);
    let decoder = FrameDecoder::new(input);
    let init_cap = input.len().saturating_mul(4).min(MAX_DECOMPRESSED_SIZE);
    crate::decompress_with_limit(decoder, MAX_DECOMPRESSED_SIZE, init_cap, "lz4 decompress")
        .map(|v| v.into())
}

/// Decompress LZ4 frame-compressed data with explicit capacity.
///
/// Use this when the decompressed size exceeds the default 256 MB limit.
/// The `capacity` parameter specifies the maximum decompressed size in bytes.
#[napi]
pub fn lz4_decompress_with_capacity(
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
    let decoder = FrameDecoder::new(input);
    let init_cap = input.len().saturating_mul(4).min(cap);
    crate::decompress_with_limit(decoder, cap, init_cap, "lz4 decompress").map(|v| v.into())
}

// --- Async tasks ---

pub struct Lz4CompressTask {
    data: Vec<u8>,
}

#[napi]
impl Task for Lz4CompressTask {
    type Output = Vec<u8>;
    type JsValue = Buffer;

    fn compute(&mut self) -> Result<Self::Output> {
        let mut output = Vec::with_capacity(self.data.len());
        let mut encoder = FrameEncoder::new(&mut output);
        encoder.write_all(&self.data).map_err(|e| {
            napi::Error::from(ZflateError::Operation {
                context: "lz4 compress",
                source: e.into(),
            })
        })?;
        encoder.finish().map_err(|e| {
            napi::Error::from(ZflateError::Operation {
                context: "lz4 compress",
                source: e.into(),
            })
        })?;
        Ok(output)
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output.into())
    }
}

/// Asynchronously compress data using LZ4 frame format.
///
/// Returns a Promise that resolves to the compressed data as a Buffer.
#[napi]
pub fn lz4_compress_async(data: Either<Buffer, Uint8Array>) -> AsyncTask<Lz4CompressTask> {
    let input = crate::as_bytes(&data).to_vec();
    AsyncTask::new(Lz4CompressTask { data: input })
}

pub struct Lz4DecompressTask {
    data: Vec<u8>,
}

#[napi]
impl Task for Lz4DecompressTask {
    type Output = Vec<u8>;
    type JsValue = Buffer;

    fn compute(&mut self) -> Result<Self::Output> {
        let decoder = FrameDecoder::new(self.data.as_slice());
        let init_cap = self.data.len().saturating_mul(4).min(MAX_DECOMPRESSED_SIZE);
        crate::decompress_with_limit(decoder, MAX_DECOMPRESSED_SIZE, init_cap, "lz4 decompress")
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output.into())
    }
}

/// Asynchronously decompress LZ4 frame-compressed data.
///
/// Returns a Promise that resolves to the decompressed data as a Buffer.
/// The maximum decompressed size is 256 MB. Use `lz4DecompressWithCapacityAsync`
/// for larger data.
#[napi]
pub fn lz4_decompress_async(data: Either<Buffer, Uint8Array>) -> AsyncTask<Lz4DecompressTask> {
    let input = crate::as_bytes(&data).to_vec();
    AsyncTask::new(Lz4DecompressTask { data: input })
}

pub struct Lz4DecompressWithCapacityTask {
    data: Vec<u8>,
    capacity: usize,
}

#[napi]
impl Task for Lz4DecompressWithCapacityTask {
    type Output = Vec<u8>;
    type JsValue = Buffer;

    fn compute(&mut self) -> Result<Self::Output> {
        let decoder = FrameDecoder::new(self.data.as_slice());
        let init_cap = self.data.len().saturating_mul(4).min(self.capacity);
        crate::decompress_with_limit(decoder, self.capacity, init_cap, "lz4 decompress")
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output.into())
    }
}

/// Asynchronously decompress LZ4 frame-compressed data with explicit capacity.
///
/// Use this when the decompressed size exceeds the default 256 MB limit.
/// The `capacity` parameter specifies the maximum decompressed size in bytes.
#[napi]
pub fn lz4_decompress_with_capacity_async(
    data: Either<Buffer, Uint8Array>,
    capacity: f64,
) -> Result<AsyncTask<Lz4DecompressWithCapacityTask>> {
    if !capacity.is_finite() || capacity < 0.0 {
        return Err(ZflateError::InvalidArg(
            "capacity must be a positive finite number".to_string(),
        )
        .into());
    }
    let input = crate::as_bytes(&data).to_vec();
    let cap = capacity as usize;
    Ok(AsyncTask::new(Lz4DecompressWithCapacityTask {
        data: input,
        capacity: cap,
    }))
}

#[cfg(test)]
mod tests {
    use std::io::Read;

    use super::*;

    #[test]
    fn round_trip_basic() {
        let original = b"Hello, zflate! This is a test of LZ4 compression.";
        let mut compressed = Vec::new();
        let mut encoder = FrameEncoder::new(&mut compressed);
        encoder.write_all(original).unwrap();
        encoder.finish().unwrap();

        let mut decoder = FrameDecoder::new(compressed.as_slice());
        let mut decompressed = Vec::new();
        decoder.read_to_end(&mut decompressed).unwrap();
        assert_eq!(original.as_slice(), decompressed.as_slice());
    }

    #[test]
    fn round_trip_empty() {
        let original = b"";
        let mut compressed = Vec::new();
        let mut encoder = FrameEncoder::new(&mut compressed);
        encoder.write_all(original).unwrap();
        encoder.finish().unwrap();

        let mut decoder = FrameDecoder::new(compressed.as_slice());
        let mut decompressed = Vec::new();
        decoder.read_to_end(&mut decompressed).unwrap();
        assert_eq!(original.as_slice(), decompressed.as_slice());
    }

    #[test]
    fn round_trip_large() {
        let original: Vec<u8> = (0..100_000).map(|i| (i % 256) as u8).collect();
        let mut compressed = Vec::new();
        let mut encoder = FrameEncoder::new(&mut compressed);
        encoder.write_all(&original).unwrap();
        encoder.finish().unwrap();

        let mut decoder = FrameDecoder::new(compressed.as_slice());
        let mut decompressed = Vec::new();
        decoder.read_to_end(&mut decompressed).unwrap();
        assert_eq!(original, decompressed);
        assert!(compressed.len() < original.len());
    }

    #[test]
    fn lz4_frame_magic_bytes() {
        let mut compressed = Vec::new();
        let mut encoder = FrameEncoder::new(&mut compressed);
        encoder.write_all(b"test").unwrap();
        encoder.finish().unwrap();

        assert!(compressed.len() >= 4);
        assert_eq!(&compressed[..4], &[0x04, 0x22, 0x4D, 0x18]);
    }
}
