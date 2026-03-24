#![no_main]
use libfuzzer_sys::fuzz_target;

fuzz_target!(|data: &[u8]| {
    // Decompression of arbitrary data must never panic
    let _ = zstd::bulk::decompress(data, 1024 * 1024); // 1MB limit for fuzzing
});
