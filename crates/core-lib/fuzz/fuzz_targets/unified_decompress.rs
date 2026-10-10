#![no_main]

use comprs_core_fuzz::unified::fuzz_unified_decompress;
use libfuzzer_sys::{Corpus, fuzz_target};

fuzz_target!(|input: &[u8]| -> Corpus {
    match fuzz_unified_decompress(input) {
        Ok(()) => Corpus::Keep,
        Err(_) => Corpus::Reject,
    }
});
