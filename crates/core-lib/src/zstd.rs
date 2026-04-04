//! Zstandard compression and decompression.

use crate::ComprsError;

/// Default compression level for zstd (same as the C library default).
pub const DEFAULT_LEVEL: i32 = 3;

/// Default maximum dictionary size (110 KB, zstd default).
pub const DEFAULT_MAX_DICT_SIZE: usize = 110 * 1024;

/// Compress data using Zstandard.
pub fn compress(data: &[u8], level: Option<i32>) -> Result<Vec<u8>, ComprsError> {
    let level = level.unwrap_or(DEFAULT_LEVEL);
    if !(-131072..=22).contains(&level) {
        return Err(ComprsError::InvalidArg(
            "zstd compression level must be between -131072 and 22".to_string(),
        ));
    }

    zstd::bulk::compress(data, level).map_err(|e| ComprsError::Operation {
        context: "zstd compress",
        source: e.into(),
    })
}

/// Decompress Zstandard-compressed data.
///
/// Uses the frame content size header to determine initial capacity,
/// capped at MAX_DECOMPRESSED_SIZE.
pub fn decompress(data: &[u8]) -> Result<Vec<u8>, ComprsError> {
    let capacity = match zstd::zstd_safe::get_frame_content_size(data) {
        Ok(Some(size)) => (size as usize).min(crate::MAX_DECOMPRESSED_SIZE),
        _ => crate::MAX_DECOMPRESSED_SIZE,
    };
    let capacity = capacity.max(1024);

    zstd::bulk::decompress(data, capacity).map_err(|e| ComprsError::Operation {
        context: "zstd decompress",
        source: e.into(),
    })
}

/// Decompress Zstandard-compressed data with explicit capacity.
pub fn decompress_with_capacity(data: &[u8], capacity: usize) -> Result<Vec<u8>, ComprsError> {
    zstd::bulk::decompress(data, capacity).map_err(|e| ComprsError::Operation {
        context: "zstd decompress",
        source: e.into(),
    })
}

/// Train a zstd dictionary from sample data.
pub fn train_dictionary(samples: &[Vec<u8>], max_dict_size: usize) -> Result<Vec<u8>, ComprsError> {
    zstd::dict::from_samples(samples, max_dict_size).map_err(|e| ComprsError::Operation {
        context: "zstd dictionary training",
        source: e.into(),
    })
}

/// Compress data using Zstandard with a pre-trained dictionary.
pub fn compress_with_dict(
    data: &[u8],
    dict: &[u8],
    level: Option<i32>,
) -> Result<Vec<u8>, ComprsError> {
    let level = level.unwrap_or(DEFAULT_LEVEL);
    if !(-131072..=22).contains(&level) {
        return Err(ComprsError::InvalidArg(
            "zstd compression level must be between -131072 and 22".to_string(),
        ));
    }

    let mut compressor = zstd::bulk::Compressor::with_dictionary(level, dict).map_err(|e| {
        ComprsError::Operation {
            context: "zstd compressor init",
            source: e.into(),
        }
    })?;

    compressor
        .compress(data)
        .map_err(|e| ComprsError::Operation {
            context: "zstd compress with dict",
            source: e.into(),
        })
}

/// Decompress Zstandard-compressed data that was compressed with a dictionary.
pub fn decompress_with_dict(data: &[u8], dict: &[u8]) -> Result<Vec<u8>, ComprsError> {
    let capacity = match zstd::zstd_safe::get_frame_content_size(data) {
        Ok(Some(size)) => (size as usize).min(crate::MAX_DECOMPRESSED_SIZE),
        _ => crate::MAX_DECOMPRESSED_SIZE,
    };
    let capacity = capacity.max(1024);

    let mut decompressor =
        zstd::bulk::Decompressor::with_dictionary(dict).map_err(|e| ComprsError::Operation {
            context: "zstd decompressor init",
            source: e.into(),
        })?;

    decompressor
        .decompress(data, capacity)
        .map_err(|e| ComprsError::Operation {
            context: "zstd decompress with dict",
            source: e.into(),
        })
}

/// Decompress Zstandard-compressed data with a dictionary and explicit capacity.
pub fn decompress_with_dict_with_capacity(
    data: &[u8],
    dict: &[u8],
    capacity: usize,
) -> Result<Vec<u8>, ComprsError> {
    let mut decompressor =
        zstd::bulk::Decompressor::with_dictionary(dict).map_err(|e| ComprsError::Operation {
            context: "zstd decompressor init",
            source: e.into(),
        })?;

    decompressor
        .decompress(data, capacity)
        .map_err(|e| ComprsError::Operation {
            context: "zstd decompress with dict",
            source: e.into(),
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trip_basic() {
        let original = b"Hello, comprs! This is a test of zstd compression.";
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

    #[test]
    fn compress_validates_level() {
        let data = b"test";
        assert!(compress(data, Some(23)).is_err());
        assert!(compress(data, Some(-131073)).is_err());
        assert!(compress(data, Some(22)).is_ok());
        assert!(compress(data, Some(-131072)).is_ok());
    }

    #[test]
    fn compress_decompress_round_trip() {
        let original = b"Hello from core-lib!";
        let compressed = compress(original, None).unwrap();
        let decompressed = decompress(&compressed).unwrap();
        assert_eq!(original.as_slice(), decompressed.as_slice());
    }

    #[test]
    fn dict_round_trip_via_api() {
        let samples: Vec<Vec<u8>> = (0..100)
            .map(|i| format!(r#"{{"key":{},"value":"item_{}"}}"#, i, i).into_bytes())
            .collect();
        let dict = train_dictionary(&samples, DEFAULT_MAX_DICT_SIZE).unwrap();
        let original = br#"{"key":42,"value":"item_42"}"#;
        let compressed = compress_with_dict(original, &dict, None).unwrap();
        let decompressed = decompress_with_dict(&compressed, &dict).unwrap();
        assert_eq!(original.as_slice(), decompressed.as_slice());
    }
}
