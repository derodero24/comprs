#![no_main]

use comprs_core_fuzz::Format;
use comprs_core_fuzz::decompress::fuzz_decompress;
use libfuzzer_sys::{Corpus, fuzz_target};

fuzz_target!(|input: &[u8]| -> Corpus {
    match fuzz_decompress(Format::Gzip, input) {
        Ok(()) => Corpus::Keep,
        Err(_) => Corpus::Reject,
    }
});
