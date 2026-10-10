//! Harness for the comprs-core fuzz targets.
//!
//! Each target reads its parameters (output limits, dictionaries, chunk
//! sizes, ...) from the front of the fuzzer's input with
//! [`Unstructured`](libfuzzer_sys::arbitrary::Unstructured) and uses the
//! rest as the data to decompress or compress.

#![deny(clippy::all)]

pub mod decompress;
pub mod detect;
pub mod format;
pub mod heap;
pub mod panic_hook;
pub mod plan;
pub mod round_trip;
pub mod unified;

pub use format::Format;

#[global_allocator]
static ALLOC: heap::CountingAlloc = heap::CountingAlloc;

/// Most heap memory that decoding `input_len` bytes of `format` into at most
/// `limit` bytes may use at once.
///
/// Output buffers grow by doubling, and a buffer that moves exists twice for
/// a moment, so three times the output limit is allowed; the same goes for
/// input that a context buffers, and for a dictionary that it copies.
pub fn heap_bound(format: Format, limit: usize, input_len: usize) -> usize {
    3usize
        .saturating_mul(limit.saturating_add(1))
        .saturating_add(3usize.saturating_mul(input_len))
        .saturating_add(format.decoder_overhead())
}

/// Fail the target if decoding used more heap memory than [`heap_bound`].
fn check_heap(format: Format, what: &str, peak: usize, limit: usize, input_len: usize) {
    let bound = heap_bound(format, limit, input_len);
    assert!(
        peak <= bound,
        "{format:?} {what} used {peak} bytes of heap memory with an output limit of {limit} \
         bytes and {input_len} bytes of input; expected at most {bound}"
    );
}
