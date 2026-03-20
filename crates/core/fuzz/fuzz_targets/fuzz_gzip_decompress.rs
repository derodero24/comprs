#![no_main]
use libfuzzer_sys::fuzz_target;
use std::io::Read;
use flate2::read::GzDecoder;

fuzz_target!(|data: &[u8]| {
    let mut decoder = GzDecoder::new(data);
    let mut output = Vec::new();
    // Decompression of arbitrary data must never panic
    let _ = decoder.take(1024 * 1024).read_to_end(&mut output);
});
