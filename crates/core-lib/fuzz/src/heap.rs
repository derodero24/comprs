//! Heap accounting for the fuzz targets.
//!
//! [`CountingAlloc`] wraps the system allocator and records how many bytes
//! the Rust heap holds and the most it has held. [`measure`] reports the peak
//! of one call, so a target can check that decoding allocates in proportion
//! to its output limit rather than to size hints in the input.
//!
//! Only allocations made through Rust's global allocator are counted: that
//! covers comprs-core, brotli, lz4_flex and zlib-rs, but not the zstd C
//! library, whose window buffers libFuzzer's `-rss_limit_mb` bounds instead.
//! Unlike the resident set size, the count includes memory that was reserved
//! but never written, such as an output buffer sized from a forged header.

use std::alloc::{GlobalAlloc, Layout, System};
use std::sync::atomic::{AtomicUsize, Ordering};

/// Bytes currently allocated.
static LIVE: AtomicUsize = AtomicUsize::new(0);
/// Most bytes allocated at once since the last [`measure`] started.
static PEAK: AtomicUsize = AtomicUsize::new(0);

/// Global allocator that counts the bytes allocated through it.
pub struct CountingAlloc;

impl CountingAlloc {
    fn add(size: usize) {
        let live = LIVE.fetch_add(size, Ordering::Relaxed) + size;
        PEAK.fetch_max(live, Ordering::Relaxed);
    }

    fn sub(size: usize) {
        LIVE.fetch_sub(size, Ordering::Relaxed);
    }
}

// SAFETY: every method forwards to `System` with the caller's arguments, so
// the caller's guarantees carry over; the counters do not affect allocation.
unsafe impl GlobalAlloc for CountingAlloc {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        // SAFETY: forwarded unchanged, see above.
        let ptr = unsafe { System.alloc(layout) };
        if !ptr.is_null() {
            Self::add(layout.size());
        }
        ptr
    }

    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        // SAFETY: forwarded unchanged, see above.
        let ptr = unsafe { System.alloc_zeroed(layout) };
        if !ptr.is_null() {
            Self::add(layout.size());
        }
        ptr
    }

    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        // SAFETY: forwarded unchanged, see above.
        unsafe { System.dealloc(ptr, layout) };
        Self::sub(layout.size());
    }

    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        // SAFETY: forwarded unchanged, see above.
        let new_ptr = unsafe { System.realloc(ptr, layout, new_size) };
        if !new_ptr.is_null() {
            // Count both blocks at once, as a move needs them.
            Self::add(new_size);
            Self::sub(layout.size());
        }
        new_ptr
    }
}

/// Call `f` and return its result with the most heap memory that was
/// allocated at once during the call, beyond what was allocated before it.
///
/// The fuzz targets are single-threaded, so the count belongs to `f` alone.
pub fn measure<T>(f: impl FnOnce() -> T) -> (T, usize) {
    let base = LIVE.load(Ordering::Relaxed);
    PEAK.store(base, Ordering::Relaxed);
    let result = f();
    (result, PEAK.load(Ordering::Relaxed) - base)
}
