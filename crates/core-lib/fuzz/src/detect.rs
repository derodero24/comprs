//! Format detection and auto-detecting decompression.

use comprs_core::detect::{self, Format as Detected};
use comprs_core::{ComprsError, MAX_DECOMPRESSED_SIZE, gzip};

use crate::format::Format;
use crate::{check_heap, heap};

/// Run format detection, auto-detecting decompression and gzip header
/// parsing on `input`. Checks that nothing panics, that detection uses
/// little memory, and that auto-detecting decompression stays within its
/// output limit and rejects data it does not detect.
pub fn fuzz_detect(input: &[u8]) {
    // Detecting brotli decodes the first output byte.
    let (detected, peak) = heap::measure(|| detect::detect(input));
    check_heap(Format::Brotli, "detection", peak, 0, input.len());
    let _ = gzip::read_header(input);

    let (result, peak) = heap::measure(|| detect::decompress(input));
    let format = match detected {
        Detected::Zstd => Format::Zstd,
        Detected::Gzip => Format::Gzip,
        Detected::Brotli => Format::Brotli,
        Detected::Lz4 => Format::Lz4,
        Detected::Unknown => {
            assert!(
                matches!(result, Err(ComprsError::InvalidArg(_))),
                "auto-detecting decompression accepted data of unknown format"
            );
            return;
        }
    };
    let what = "auto-detecting decompression";
    check_heap(format, what, peak, MAX_DECOMPRESSED_SIZE, input.len());
    if let Ok(output) = &result {
        assert!(output.len() <= MAX_DECOMPRESSED_SIZE);
    }
}
