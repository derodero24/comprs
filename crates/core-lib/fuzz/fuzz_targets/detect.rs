#![no_main]

use comprs_core_fuzz::detect::fuzz_detect;
use libfuzzer_sys::fuzz_target;

fuzz_target!(|input: &[u8]| fuzz_detect(input));
