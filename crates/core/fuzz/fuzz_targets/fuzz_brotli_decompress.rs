#![no_main]
use libfuzzer_sys::fuzz_target;
use std::io::Read;
use brotli::Decompressor;

fuzz_target!(|data: &[u8]| {
    let mut decoder = Decompressor::new(data, 4096);
    let mut output = Vec::new();
    let _ = decoder.take(1024 * 1024).read_to_end(&mut output);
});
