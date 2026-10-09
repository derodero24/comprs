#![no_main]

use comprs_core_fuzz::panic_hook::allow_caught_brotli_encoder_panics;
use comprs_core_fuzz::round_trip::fuzz_round_trip;
use libfuzzer_sys::{Corpus, fuzz_target};

fuzz_target!(
    init: allow_caught_brotli_encoder_panics(),
    |input: &[u8]| -> Corpus {
        match fuzz_round_trip(input) {
            Ok(()) => Corpus::Keep,
            Err(_) => Corpus::Reject,
        }
    }
);
