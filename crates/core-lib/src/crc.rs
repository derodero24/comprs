//! CRC32 (IEEE polynomial) utility.

/// Compute CRC32 checksum of the given data.
///
/// Optionally accepts an initial CRC value for incremental computation:
/// split data into chunks, pass the result of each chunk as `initial_value`
/// for the next.
pub fn crc32(data: &[u8], initial_value: Option<u32>) -> u32 {
    let mut hasher = match initial_value {
        Some(init) => crc32fast::Hasher::new_with_initial(init),
        None => crc32fast::Hasher::new(),
    };
    hasher.update(data);
    hasher.finalize()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_data() {
        assert_eq!(crc32(b"", None), 0);
    }

    #[test]
    fn known_test_vector() {
        // CRC32 of "123456789" = 0xCBF43926
        assert_eq!(crc32(b"123456789", None), 0xCBF4_3926);
    }

    #[test]
    fn incremental() {
        let full = crc32(b"Hello, World!", None);
        let part1 = crc32(b"Hello", None);
        let part2 = crc32(b", World!", Some(part1));
        assert_eq!(part2, full);
    }
}
