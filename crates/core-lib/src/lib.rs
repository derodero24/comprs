#![deny(clippy::all)]

pub mod brotli;
pub mod brotli_stream;
pub mod crc;
pub mod detect;
pub mod error;
pub mod gzip;
pub mod gzip_stream;
pub mod lz4;
pub mod lz4_stream;
pub mod zstd;
pub mod zstd_stream;

pub use error::ComprsError;

/// Maximum allowed decompressed size (256 MB) to prevent memory exhaustion.
pub const MAX_DECOMPRESSED_SIZE: usize = 256 * 1024 * 1024;

/// Validate a capacity parameter.
///
/// JavaScript numbers are f64, but capacity must be a non-negative integer
/// that fits in usize. Rejects NaN, Infinity, negative, fractional, and
/// values exceeding usize::MAX.
pub fn validate_capacity(capacity: f64) -> Result<usize, ComprsError> {
    if !capacity.is_finite()
        || capacity < 0.0
        || capacity.fract() != 0.0
        || capacity > usize::MAX as f64
    {
        return Err(ComprsError::InvalidArg(
            "capacity must be a non-negative integer".to_string(),
        ));
    }
    Ok(capacity as usize)
}

/// Validate and return the max output size, defaulting to MAX_DECOMPRESSED_SIZE.
pub fn validate_max_output_size(max_output_size: Option<f64>) -> Result<usize, ComprsError> {
    match max_output_size {
        None => Ok(MAX_DECOMPRESSED_SIZE),
        Some(size) => {
            if !size.is_finite() || size < 0.0 {
                Err(ComprsError::InvalidArg(
                    "maxOutputSize must be a positive finite number".to_string(),
                ))
            } else {
                Ok(size as usize)
            }
        }
    }
}

/// Decompress data from a reader with a size limit.
///
/// Uses `Read::read_to_end` to write directly into the output Vec's spare
/// capacity, avoiding the double-copy through an intermediate stack buffer.
/// The `Take` wrapper enforces the size limit without per-chunk checking.
pub fn decompress_with_limit(
    decoder: impl std::io::Read,
    max_size: usize,
    init_cap: usize,
    context: &'static str,
) -> Result<Vec<u8>, ComprsError> {
    use std::io::Read;
    let mut output = Vec::with_capacity(init_cap);
    decoder
        .take((max_size as u64).saturating_add(1))
        .read_to_end(&mut output)
        .map_err(|e| ComprsError::Operation {
            context,
            source: e.into(),
        })?;
    if output.len() > max_size {
        return Err(ComprsError::SizeLimit {
            context,
            limit: max_size,
        });
    }
    Ok(output)
}
