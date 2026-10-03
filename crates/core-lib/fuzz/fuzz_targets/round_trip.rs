#![no_main]

use comprs_core_fuzz::round_trip::fuzz_round_trip;
use libfuzzer_sys::{Corpus, fuzz_target};

fuzz_target!(|input: &[u8]| -> Corpus {
    match fuzz_round_trip(input) {
        Ok(()) => Corpus::Keep,
        Err(_) => Corpus::Reject,
    }
});
