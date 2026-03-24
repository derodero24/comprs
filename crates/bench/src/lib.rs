/// Deterministic pseudo-random data generator using a linear congruential generator.
/// Matches the JS bench-fixtures.ts implementation for consistent cross-language comparison.
pub fn deterministic_bytes(size: usize, seed: u32) -> Vec<u8> {
    let mut out = vec![0u8; size];
    let mut x = seed;
    for b in &mut out {
        x = x.wrapping_mul(1664525).wrapping_add(1013904223);
        *b = (x & 0xff) as u8;
    }
    out
}

/// 10 KB patterned data (compressible).
pub fn patterned_10kb() -> Vec<u8> {
    (0..10_000).map(|i| (i % 256) as u8).collect()
}

/// 1 MB patterned data (compressible).
pub fn patterned_1mb() -> Vec<u8> {
    (0..1_000_000).map(|i| (i % 256) as u8).collect()
}

/// 10 KB pseudo-random data (incompressible).
pub fn random_10kb() -> Vec<u8> {
    deterministic_bytes(10_000, 0x5678)
}

/// 1 MB pseudo-random data (incompressible).
pub fn random_1mb() -> Vec<u8> {
    deterministic_bytes(1_000_000, 0x9abc)
}
