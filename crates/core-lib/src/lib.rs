#![deny(clippy::all)]

mod args;
pub mod brotli;
pub mod brotli_stream;
pub mod crc;
pub mod detect;
pub mod error;
pub mod gzip;
pub mod gzip_stream;
mod limited;
pub mod lz4;
pub mod lz4_stream;
pub mod zstd;
pub mod zstd_stream;

pub use args::{IntArg, validate_capacity, validate_max_output_size};
pub use error::ComprsError;

/// Maximum allowed decompressed size (256 MB) to prevent memory exhaustion.
pub const MAX_DECOMPRESSED_SIZE: usize = 256 * 1024 * 1024;

/// Reject empty input to a decompressor: no supported format has a valid
/// zero-length encoding, so empty input is treated as truncated.
pub(crate) fn require_input(data: &[u8], format: &'static str) -> Result<(), ComprsError> {
    if data.is_empty() {
        return Err(ComprsError::Truncated(format));
    }
    Ok(())
}

/// Decompress data from a reader with a size limit.
///
/// Uses `Read::read_to_end` to write directly into the output Vec's spare
/// capacity, avoiding the double-copy through an intermediate stack buffer.
/// The `Take` wrapper enforces the size limit without per-chunk checking.
///
/// `init_cap` bytes are reserved up front, so callers derive it from the
/// input; a failed reservation is reported as an error instead of aborting.
pub fn decompress_with_limit(
    decoder: impl std::io::Read,
    max_size: usize,
    init_cap: usize,
    context: &'static str,
) -> Result<Vec<u8>, ComprsError> {
    use std::io::Read;
    let mut output = Vec::new();
    output
        .try_reserve_exact(init_cap)
        .map_err(|e| ComprsError::Operation {
            context,
            source: e.into(),
        })?;
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
