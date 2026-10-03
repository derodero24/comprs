//! Inputs and helpers for the Criterion benchmarks in `benches/`.
//!
//! The generators match `__test__/bench-fixtures.ts`, so the Rust and JS
//! benchmarks compress the same bytes.

use std::fmt::Debug;

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

/// 84 KB JSON array of 1,000 user records (realistic).
///
/// Matches `JSON_DATA` in bench-fixtures.ts.
pub fn json_84kb() -> Vec<u8> {
    let records: Vec<String> = (0..1000).map(json_record).collect();
    format!("[{}]", records.join(",")).into_bytes()
}

/// The inputs of the one-shot benchmarks, with their names in the
/// benchmark names.
pub fn inputs() -> [(&'static str, Vec<u8>); 5] {
    [
        ("patterned 10KB", patterned_10kb()),
        ("patterned 1MB", patterned_1mb()),
        ("random 10KB", random_10kb()),
        ("random 1MB", random_1mb()),
        ("json 84KB", json_84kb()),
    ]
}

/// Chunk size for the stream context benchmarks: the default
/// `highWaterMark` of Node.js file streams.
pub const STREAM_CHUNK_SIZE: usize = 64 * 1024;

/// The inputs of the stream benchmarks: the 1 MB ones, which span 16
/// chunks of [`STREAM_CHUNK_SIZE`] bytes.
pub fn stream_inputs() -> [(&'static str, Vec<u8>); 2] {
    [
        ("patterned 1MB", patterned_1mb()),
        ("random 1MB", random_1mb()),
    ]
}

/// Run a stream context over `data` in [`STREAM_CHUNK_SIZE`] chunks, then
/// end the stream with `finish`. Returns the total output length.
pub fn run_stream<C, E: Debug>(
    mut context: C,
    data: &[u8],
    transform: impl Fn(&mut C, &[u8]) -> Result<Vec<u8>, E>,
    finish: impl FnOnce(&mut C) -> Result<Vec<u8>, E>,
) -> usize {
    let mut len = 0;
    for chunk in data.chunks(STREAM_CHUNK_SIZE) {
        len += transform(&mut context, chunk).unwrap().len();
    }
    len + finish(&mut context).unwrap().len()
}

/// Size of the dictionaries in the dictionary benchmarks.
pub const DICT_SIZE: usize = 4 * 1024;

/// Samples for the dictionaries of the dictionary benchmarks: the records
/// of [`json_84kb`], one per sample.
pub fn dict_samples() -> Vec<Vec<u8>> {
    (0..1000).map(|i| json_record(i).into_bytes()).collect()
}

/// The input of the dictionary benchmarks: a record like the
/// [`dict_samples`], but not one of them. Dictionaries are meant for small
/// messages, which makes the cost of setting up the dictionary stand out.
pub fn dict_message() -> Vec<u8> {
    json_record(1000).into_bytes()
}

/// The `i`th record of [`json_84kb`], as `JSON.stringify` writes it.
fn json_record(i: u32) -> String {
    format!(
        r#"{{"id":{i},"name":"user_{i}","email":"user{i}@example.com","active":{},"score":{}}}"#,
        !i.is_multiple_of(3),
        json_score(i)
    )
}

/// `Math.round(Math.sin(i) * 1000) / 10`, as `JSON.stringify` writes it.
fn json_score(i: u32) -> String {
    // Math.round rounds halfway cases up, and the result is a whole number
    // of tenths, which JSON.stringify writes with at most one decimal and
    // without the sign of a negative zero.
    let tenths = (f64::from(i).sin() * 1000.0 + 0.5).floor() as i32;
    let sign = if tenths < 0 { "-" } else { "" };
    let tenths = tenths.unsigned_abs();
    match tenths % 10 {
        0 => format!("{sign}{}", tenths / 10),
        frac => format!("{sign}{}.{frac}", tenths / 10),
    }
}

#[cfg(test)]
mod tests {
    use comprs_core::crc::crc32;

    use super::*;

    // __test__/bench-fixtures.spec.ts checks the same values.

    #[test]
    fn json_matches_the_js_fixture() {
        let json = json_84kb();
        assert_eq!(json.len(), 86_216);
        assert_eq!(crc32(&json, None), 0xb2e2_ca75);
    }
}
