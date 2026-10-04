//! Allocations of brotli one-shot decompression, observed through a global
//! allocator that records the largest allocation and can fail large ones. A
//! test binary of its own, so that no other test allocates meanwhile.

use std::alloc::{GlobalAlloc, Layout, System};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Mutex, MutexGuard};

use comprs_core::ComprsError;

struct TestAllocator;

/// The largest allocation since the last reset.
static LARGEST: AtomicUsize = AtomicUsize::new(0);

/// Allocations larger than this fail.
static FAIL_ABOVE: AtomicUsize = AtomicUsize::new(usize::MAX);

/// Record the size of an allocation and decide whether it may proceed.
fn admit(size: usize) -> bool {
    LARGEST.fetch_max(size, Ordering::Relaxed);
    size <= FAIL_ABOVE.load(Ordering::Relaxed)
}

// SAFETY: every method either forwards to `System` with the caller's
// arguments, so the caller's guarantees carry over, or returns null, which
// `GlobalAlloc` allows to report a failed allocation.
unsafe impl GlobalAlloc for TestAllocator {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        if !admit(layout.size()) {
            return std::ptr::null_mut();
        }
        // SAFETY: forwarded unchanged, see above.
        unsafe { System.alloc(layout) }
    }

    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        if !admit(layout.size()) {
            return std::ptr::null_mut();
        }
        // SAFETY: forwarded unchanged, see above.
        unsafe { System.alloc_zeroed(layout) }
    }

    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        if !admit(new_size) {
            return std::ptr::null_mut();
        }
        // SAFETY: forwarded unchanged, see above.
        unsafe { System.realloc(ptr, layout, new_size) }
    }

    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        // SAFETY: forwarded unchanged, see above.
        unsafe { System.dealloc(ptr, layout) }
    }
}

#[global_allocator]
static ALLOCATOR: TestAllocator = TestAllocator;

/// Run the tests one at a time, since they share the allocator's settings.
fn serialize() -> MutexGuard<'static, ()> {
    static LOCK: Mutex<()> = Mutex::new(());
    LOCK.lock().unwrap_or_else(|e| e.into_inner())
}

/// The largest allocation that `f` makes.
fn largest_allocation<T>(f: impl FnOnce() -> T) -> (T, usize) {
    LARGEST.store(0, Ordering::Relaxed);
    let result = f();
    (result, LARGEST.load(Ordering::Relaxed))
}

/// Run `f` with every allocation larger than `limit` failing.
fn failing_above<T>(limit: usize, f: impl FnOnce() -> T) -> T {
    FAIL_ABOVE.store(limit, Ordering::Relaxed);
    let result = f();
    FAIL_ABOVE.store(usize::MAX, Ordering::Relaxed);
    result
}

/// `len` bytes of xorshift noise.
fn random(len: usize) -> Vec<u8> {
    let mut state = 0x9e37_79b9_7f4a_7c15u64;
    (0..len)
        .map(|_| {
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            state as u8
        })
        .collect()
}

/// Incompressible data is stored in uncompressed meta-blocks, so the stream
/// is longer than the decoder's first read used to be, and the decoder used
/// to allocate a ring buffer for the whole 4 MiB window.
#[test]
fn small_brotli_streams_decode_without_a_window_sized_ring_buffer() {
    let _guard = serialize();
    let data = random(10_000);
    let compressed = comprs_core::brotli::compress(&data, Some(6)).unwrap();
    assert!(compressed.len() > 4096, "{} bytes", compressed.len());

    let (output, largest) = largest_allocation(|| comprs_core::brotli::decompress(&compressed));
    assert_eq!(output.unwrap(), data);
    assert!(largest < 64 * 1024, "largest allocation: {largest} bytes");
}

/// The output buffer starts with room for four times the input, so its size
/// follows the input: failing to allocate it is an error, not an abort.
#[test]
fn a_failed_output_allocation_is_reported() {
    let _guard = serialize();
    let data = random(300_000);
    let compressed = comprs_core::brotli::compress(&data, Some(6)).unwrap();

    // Four times the input is more than 1 MiB; the decoder needs less.
    let result = failing_above(1024 * 1024, || comprs_core::brotli::decompress(&compressed));
    assert!(
        matches!(
            result,
            Err(ComprsError::Operation {
                context: "brotli decompress",
                ..
            })
        ),
        "{result:?}"
    );
    assert_eq!(comprs_core::brotli::decompress(&compressed).unwrap(), data);
}
