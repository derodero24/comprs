#![no_main]

use comprs_core_fuzz::Format;
use comprs_core_fuzz::decompress::fuzz_decompress;
use comprs_core_fuzz::panic_hook::allow_caught_brotli_encoder_panics;
use libfuzzer_sys::{Corpus, fuzz_target};

fuzz_target!(
    init: allow_caught_brotli_encoder_panics(),
    |input: &[u8]| -> Corpus {
        match fuzz_decompress(Format::Brotli, input) {
            Ok(()) => Corpus::Keep,
            Err(_) => Corpus::Reject,
        }
    }
);
