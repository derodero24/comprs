//! Zstandard compression and decompression.

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
#[napi]
pub fn zstd_compress(data: Buffer, level: Option<i32>) -> Result<Buffer> {
    let level = level.unwrap_or(DEFAULT_LEVEL);
    let input = data.as_ref();

    zstd::bulk::compress(input, level)
        .map(|v| v.into())
        .map_err(|e| Error::new(Status::GenericFailure, format!("zstd compress failed: {e}")))
}

/// Decompress Zstandard-compressed data.
///
/// Returns the decompressed data as a Buffer.
/// The maximum decompressed size is 256 MB. Use `zstdDecompressWithCapacity`
/// for larger data.
#[napi]
pub fn zstd_decompress(data: Buffer) -> Result<Buffer> {
    let input = data.as_ref();

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
pub fn zstd_decompress_with_capacity(data: Buffer, capacity: f64) -> Result<Buffer> {
    if !capacity.is_finite() || capacity < 0.0 {
        return Err(Error::new(
            Status::InvalidArg,
            "capacity must be a positive finite number",
        ));
    }
    let input = data.as_ref();
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
}
