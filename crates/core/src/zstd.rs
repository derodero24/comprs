//! Zstandard compression and decompression.

use napi::Task;
use napi::bindgen_prelude::*;
use napi_derive::napi;

/// Default compression level for zstd (same as the C library default).
const DEFAULT_LEVEL: i32 = 3;

/// Maximum allowed decompressed size (256 MB) to prevent memory exhaustion.
const MAX_DECOMPRESSED_SIZE: usize = 256 * 1024 * 1024;

/// Compress data using Zstandard.
///
/// Returns the compressed data as a Buffer.
/// Level ranges from 1 (fastest) to 22 (best compression). Default is 3.
/// Negative levels (e.g., -1 to -131072) enable fast mode, trading compression
/// ratio for speed. Level 0 is equivalent to the default level (3).
#[napi]
pub fn zstd_compress(data: Either<Buffer, Uint8Array>, level: Option<i32>) -> Result<Buffer> {
    let level = level.unwrap_or(DEFAULT_LEVEL);
    let input = crate::as_bytes(&data);

    zstd::bulk::compress(input, level)
        .map(|v| v.into())
        .map_err(|e| Error::new(Status::GenericFailure, format!("zstd compress failed: {e}")))
}

pub struct ZstdCompressTask {
    data: Vec<u8>,
    level: i32,
}

#[napi]
impl Task for ZstdCompressTask {
    type Output = Vec<u8>;
    type JsValue = Buffer;

    fn compute(&mut self) -> Result<Self::Output> {
        zstd::bulk::compress(&self.data, self.level)
            .map_err(|e| Error::new(Status::GenericFailure, format!("zstd compress failed: {e}")))
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output.into())
    }
}

/// Asynchronously compress data using Zstandard.
///
/// Returns a Promise that resolves to the compressed data as a Buffer.
/// Level ranges from 1 (fastest) to 22 (best compression). Default is 3.
/// Negative levels (e.g., -1 to -131072) enable fast mode, trading compression
/// ratio for speed. Level 0 is equivalent to the default level (3).
#[napi]
pub fn zstd_compress_async(
    data: Either<Buffer, Uint8Array>,
    level: Option<i32>,
) -> AsyncTask<ZstdCompressTask> {
    let input = crate::as_bytes(&data).to_vec();
    AsyncTask::new(ZstdCompressTask {
        data: input,
        level: level.unwrap_or(DEFAULT_LEVEL),
    })
}

pub struct ZstdDecompressTask {
    data: Vec<u8>,
}

#[napi]
impl Task for ZstdDecompressTask {
    type Output = Vec<u8>;
    type JsValue = Buffer;

    fn compute(&mut self) -> Result<Self::Output> {
        let capacity = match zstd::zstd_safe::get_frame_content_size(&self.data) {
            Ok(Some(size)) => (size as usize).min(MAX_DECOMPRESSED_SIZE),
            _ => MAX_DECOMPRESSED_SIZE,
        };
        let capacity = capacity.max(1024);

        zstd::bulk::decompress(&self.data, capacity).map_err(|e| {
            Error::new(
                Status::GenericFailure,
                format!("zstd decompress failed: {e}"),
            )
        })
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output.into())
    }
}

/// Asynchronously decompress Zstandard-compressed data.
///
/// Returns a Promise that resolves to the decompressed data as a Buffer.
/// The maximum decompressed size is 256 MB. Use `zstdDecompressWithCapacity`
/// for larger data.
#[napi]
pub fn zstd_decompress_async(data: Either<Buffer, Uint8Array>) -> AsyncTask<ZstdDecompressTask> {
    let input = crate::as_bytes(&data).to_vec();
    AsyncTask::new(ZstdDecompressTask { data: input })
}

/// Decompress Zstandard-compressed data.
///
/// Returns the decompressed data as a Buffer.
/// The maximum decompressed size is 256 MB. Use `zstdDecompressWithCapacity`
/// for larger data.
#[napi]
pub fn zstd_decompress(data: Either<Buffer, Uint8Array>) -> Result<Buffer> {
    let input = crate::as_bytes(&data);

    // Try to read the frame content size from the header
    let capacity = match zstd::zstd_safe::get_frame_content_size(input) {
        Ok(Some(size)) => (size as usize).min(MAX_DECOMPRESSED_SIZE),
        _ => MAX_DECOMPRESSED_SIZE,
    };

    // Use at least 1KB initial capacity
    let capacity = capacity.max(1024);

    zstd::bulk::decompress(input, capacity)
        .map(|v| v.into())
        .map_err(|e| {
            Error::new(
                Status::GenericFailure,
                format!("zstd decompress failed: {e}"),
            )
        })
}

/// Decompress Zstandard-compressed data with explicit capacity.
///
/// Use this when the decompressed size exceeds the default 256 MB limit.
/// The `capacity` parameter specifies the maximum decompressed size in bytes.
#[napi]
pub fn zstd_decompress_with_capacity(
    data: Either<Buffer, Uint8Array>,
    capacity: f64,
) -> Result<Buffer> {
    if !capacity.is_finite() || capacity < 0.0 {
        return Err(Error::new(
            Status::InvalidArg,
            "capacity must be a positive finite number",
        ));
    }
    let input = crate::as_bytes(&data);
    let cap = capacity as usize;

    zstd::bulk::decompress(input, cap)
        .map(|v| v.into())
        .map_err(|e| {
            Error::new(
                Status::GenericFailure,
                format!("zstd decompress failed: {e}"),
            )
        })
}

/// Default maximum dictionary size (110 KB, zstd default).
const DEFAULT_MAX_DICT_SIZE: usize = 110 * 1024;

/// Train a zstd dictionary from sample data.
///
/// The dictionary can be used with `zstdCompressWithDict` and `zstdDecompressWithDict`
/// to achieve better compression ratios on small, similar data.
///
/// `maxDictSize` is optional and defaults to 110 KB (the zstd default).
#[napi]
pub fn zstd_train_dictionary(
    samples: Vec<Either<Buffer, Uint8Array>>,
    max_dict_size: Option<f64>,
) -> Result<Buffer> {
    let max_size = max_dict_size
        .map(|s| s as usize)
        .unwrap_or(DEFAULT_MAX_DICT_SIZE);

    let sample_vecs: Vec<Vec<u8>> = samples
        .iter()
        .map(|s| crate::as_bytes(s).to_vec())
        .collect();

    zstd::dict::from_samples(&sample_vecs, max_size)
        .map(|v| v.into())
        .map_err(|e| {
            Error::new(
                Status::GenericFailure,
                format!("zstd dictionary training failed: {e}"),
            )
        })
}

/// Compress data using Zstandard with a pre-trained dictionary.
///
/// The same dictionary must be used for decompression via `zstdDecompressWithDict`.
/// Level ranges from 1 (fastest) to 22 (best compression). Default is 3.
#[napi]
pub fn zstd_compress_with_dict(
    data: Either<Buffer, Uint8Array>,
    dict: Either<Buffer, Uint8Array>,
    level: Option<i32>,
) -> Result<Buffer> {
    let level = level.unwrap_or(DEFAULT_LEVEL);
    let input = crate::as_bytes(&data);
    let dict_bytes = crate::as_bytes(&dict);

    let mut compressor =
        zstd::bulk::Compressor::with_dictionary(level, dict_bytes).map_err(|e| {
            Error::new(
                Status::GenericFailure,
                format!("zstd compressor init failed: {e}"),
            )
        })?;

    compressor.compress(input).map(|v| v.into()).map_err(|e| {
        Error::new(
            Status::GenericFailure,
            format!("zstd compress with dict failed: {e}"),
        )
    })
}

/// Decompress Zstandard-compressed data that was compressed with a dictionary.
///
/// The same dictionary used for compression must be provided.
#[napi]
pub fn zstd_decompress_with_dict(
    data: Either<Buffer, Uint8Array>,
    dict: Either<Buffer, Uint8Array>,
) -> Result<Buffer> {
    let input = crate::as_bytes(&data);
    let dict_bytes = crate::as_bytes(&dict);

    let capacity = match zstd::zstd_safe::get_frame_content_size(input) {
        Ok(Some(size)) => (size as usize).min(MAX_DECOMPRESSED_SIZE),
        _ => MAX_DECOMPRESSED_SIZE,
    };
    let capacity = capacity.max(1024);

    let mut decompressor = zstd::bulk::Decompressor::with_dictionary(dict_bytes).map_err(|e| {
        Error::new(
            Status::GenericFailure,
            format!("zstd decompressor init failed: {e}"),
        )
    })?;

    decompressor
        .decompress(input, capacity)
        .map(|v| v.into())
        .map_err(|e| {
            Error::new(
                Status::GenericFailure,
                format!("zstd decompress with dict failed: {e}"),
            )
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trip_basic() {
        let original = b"Hello, zflate! This is a test of zstd compression.";
        let compressed = zstd::bulk::compress(original, DEFAULT_LEVEL).unwrap();
        let decompressed = zstd::bulk::decompress(&compressed, original.len()).unwrap();
        assert_eq!(original.as_slice(), decompressed.as_slice());
    }

    #[test]
    fn round_trip_empty() {
        let original = b"";
        let compressed = zstd::bulk::compress(original, DEFAULT_LEVEL).unwrap();
        let decompressed = zstd::bulk::decompress(&compressed, 1024).unwrap();
        assert_eq!(original.as_slice(), decompressed.as_slice());
    }

    #[test]
    fn round_trip_large() {
        let original: Vec<u8> = (0..100_000).map(|i| (i % 256) as u8).collect();
        let compressed = zstd::bulk::compress(&original, DEFAULT_LEVEL).unwrap();
        let decompressed = zstd::bulk::decompress(&compressed, original.len()).unwrap();
        assert_eq!(original, decompressed);
        // Compression should actually reduce size for repetitive data
        assert!(compressed.len() < original.len());
    }

    #[test]
    fn compression_levels() {
        let data = b"Repeating data for compression level testing. ".repeat(100);
        let fast = zstd::bulk::compress(&data, 1).unwrap();
        let default = zstd::bulk::compress(&data, DEFAULT_LEVEL).unwrap();
        let best = zstd::bulk::compress(&data, 19).unwrap();

        // Higher levels should generally produce smaller output
        assert!(best.len() <= default.len());
        assert!(default.len() <= fast.len());
    }

    #[test]
    fn level_zero_uses_default() {
        let data = b"Level zero test data. ".repeat(50);
        let with_zero = zstd::bulk::compress(&data, 0).unwrap();
        let decompressed = zstd::bulk::decompress(&with_zero, data.len()).unwrap();
        assert_eq!(data.as_slice(), decompressed.as_slice());
    }

    #[test]
    fn negative_levels() {
        let data = b"Negative level test data. ".repeat(50);
        for level in [-1, -7, -50] {
            let compressed = zstd::bulk::compress(&data, level).unwrap();
            let decompressed = zstd::bulk::decompress(&compressed, data.len()).unwrap();
            assert_eq!(data.as_slice(), decompressed.as_slice());
        }
    }

    #[test]
    fn level_22_max_standard() {
        let data = b"Max level test data. ".repeat(50);
        let compressed = zstd::bulk::compress(&data, 22).unwrap();
        let decompressed = zstd::bulk::decompress(&compressed, data.len()).unwrap();
        assert_eq!(data.as_slice(), decompressed.as_slice());
    }

    #[test]
    fn dict_train_and_round_trip() {
        // Generate sample data (JSON-like patterns)
        let samples: Vec<Vec<u8>> = (0..100)
            .map(|i| {
                format!(
                    r#"{{"id":{},"name":"user_{}","email":"user{}@example.com","active":{}}}"#,
                    i,
                    i,
                    i,
                    i % 2 == 0
                )
                .into_bytes()
            })
            .collect();

        let dict = zstd::dict::from_samples(&samples, DEFAULT_MAX_DICT_SIZE).unwrap();
        assert!(!dict.is_empty());

        // Compress and decompress with dictionary
        let original = br#"{"id":999,"name":"test_user","email":"test@example.com","active":true}"#;
        let mut compressor = zstd::bulk::Compressor::with_dictionary(DEFAULT_LEVEL, &dict).unwrap();
        let compressed = compressor.compress(original).unwrap();

        let mut decompressor = zstd::bulk::Decompressor::with_dictionary(&dict).unwrap();
        let decompressed = decompressor
            .decompress(&compressed, original.len())
            .unwrap();
        assert_eq!(original.as_slice(), decompressed.as_slice());
    }
}
