//! CRC32 (IEEE polynomial) utility.

use napi::bindgen_prelude::*;
use napi_derive::napi;

/// Compute CRC32 checksum of the given data.
///
/// Optionally accepts an initial CRC value for incremental computation:
/// split data into chunks, pass the result of each chunk as `initial_value`
/// for the next.
#[napi]
pub fn crc32(data: Either<Buffer, Uint8Array>, initial_value: Option<u32>) -> u32 {
    let bytes = crate::as_bytes(&data);
    let mut hasher = match initial_value {
        Some(init) => crc32fast::Hasher::new_with_initial(init),
        None => crc32fast::Hasher::new(),
    };
    hasher.update(bytes);
    hasher.finalize()
}

#[cfg(test)]
mod tests {
    fn compute(data: &[u8], init: Option<u32>) -> u32 {
        let mut hasher = match init {
            Some(v) => crc32fast::Hasher::new_with_initial(v),
            None => crc32fast::Hasher::new(),
        };
        hasher.update(data);
        hasher.finalize()
    }

    #[test]
    fn empty_data() {
        assert_eq!(compute(b"", None), 0);
    }

    #[test]
    fn known_test_vector() {
        // CRC32 of "123456789" = 0xCBF43926
        assert_eq!(compute(b"123456789", None), 0xCBF4_3926);
    }

    #[test]
    fn incremental() {
        let full = compute(b"Hello, World!", None);
        let part1 = compute(b"Hello", None);
        let part2 = compute(b", World!", Some(part1));
        assert_eq!(part2, full);
    }
}
