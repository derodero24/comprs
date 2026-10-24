//! The memory functions that every libbrotli instance of this crate gets:
//! they allocate through Rust's global allocator and count the bytes that
//! the instance holds.
//!
//! Going through Rust's allocator gives libbrotli the allocator of the
//! build, such as mimalloc in comprs's musl builds, and needs no C library
//! where there is none, as in WebAssembly. The count is what the
//! `memory_usage` methods report.

use std::alloc::Layout;
use std::ffi::c_void;
use std::sync::atomic::{AtomicUsize, Ordering};

use crate::ffi::{AllocFunc, FreeFunc};

/// The alignment of the blocks, and the size of the header in front of each
/// that holds its size: 16 bytes, the alignment that `malloc` gives on the
/// 64-bit targets, which libbrotli's structures may assume.
const ALIGN: usize = 16;

/// The bytes that the blocks of one libbrotli instance hold, headers
/// included. libbrotli passes a pointer to it, its "opaque", to [`alloc`]
/// and [`free`], so it must stay at one address for as long as the
/// instance lives: the instances keep it in a `Box`.
#[derive(Debug, Default)]
pub(crate) struct Counter(AtomicUsize);

impl Counter {
    /// The bytes that the instance holds.
    pub(crate) fn get(&self) -> usize {
        self.0.load(Ordering::Relaxed)
    }

    /// The opaque pointer for libbrotli: `self`, which [`alloc`] and [`free`]
    /// only read and update atomically.
    pub(crate) fn opaque(&self) -> *mut c_void {
        std::ptr::from_ref(self).cast_mut().cast()
    }
}

/// The memory functions to pass to libbrotli with [`Counter::opaque`].
pub(crate) const FUNCTIONS: (Option<AllocFunc>, Option<FreeFunc>) = (Some(alloc), Some(free));

/// The layout of a block of `size` bytes and its header, if there is one.
fn layout(size: usize) -> Option<Layout> {
    Layout::from_size_align(size.checked_add(ALIGN)?, ALIGN).ok()
}

/// `brotli_alloc_func`: `size` bytes, or null if they cannot be allocated,
/// which libbrotli reports as a failure.
///
/// # Safety
///
/// `opaque` must be the [`Counter::opaque`] of a live [`Counter`].
unsafe extern "C" fn alloc(opaque: *mut c_void, size: usize) -> *mut c_void {
    let Some(layout) = layout(size) else {
        return std::ptr::null_mut();
    };
    // SAFETY: the layout is not zero-sized, as it holds the header.
    let block = unsafe { std::alloc::alloc(layout) };
    if block.is_null() {
        return std::ptr::null_mut();
    }
    // SAFETY: the block holds `ALIGN` bytes of header, aligned for a usize,
    // in front of the `size` bytes that libbrotli gets.
    unsafe {
        block.cast::<usize>().write(size);
        // SAFETY (opaque): the caller passes the pointer to a live Counter.
        (*opaque.cast::<Counter>())
            .0
            .fetch_add(layout.size(), Ordering::Relaxed);
        block.add(ALIGN).cast()
    }
}

/// `brotli_free_func`: free a block of [`alloc`]; nothing for null.
///
/// # Safety
///
/// `opaque` must be the [`Counter::opaque`] of the live [`Counter`] that
/// `address` was allocated with, and `address` null or a block of [`alloc`]
/// that is not freed yet.
unsafe extern "C" fn free(opaque: *mut c_void, address: *mut c_void) {
    if address.is_null() {
        return;
    }
    // SAFETY: `address` follows the header of a block of `alloc`, which
    // holds its size, so `layout` gives the layout that it was allocated
    // with.
    unsafe {
        let block = address.cast::<u8>().sub(ALIGN);
        let size = block.cast::<usize>().read();
        let layout = layout(size).unwrap_or_else(|| unreachable!("a block of {size} bytes"));
        (*opaque.cast::<Counter>())
            .0
            .fetch_sub(layout.size(), Ordering::Relaxed);
        std::alloc::dealloc(block, layout);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn counts_the_blocks_that_are_held() {
        let counter = Counter::default();
        // SAFETY: the counter is live, and each block is freed once.
        unsafe {
            let a = alloc(counter.opaque(), 100);
            let b = alloc(counter.opaque(), 1);
            assert!(!a.is_null() && !b.is_null());
            assert_eq!(a as usize % ALIGN, 0);
            assert_eq!(counter.get(), 100 + 1 + 2 * ALIGN);
            a.cast::<u8>().write_bytes(7, 100);
            free(counter.opaque(), a);
            assert_eq!(counter.get(), 1 + ALIGN);
            free(counter.opaque(), b);
            free(counter.opaque(), std::ptr::null_mut());
        }
        assert_eq!(counter.get(), 0);
    }

    #[test]
    fn fails_for_a_size_that_has_no_layout() {
        let counter = Counter::default();
        // SAFETY: the counter is live.
        let block = unsafe { alloc(counter.opaque(), usize::MAX) };
        assert!(block.is_null());
        assert_eq!(counter.get(), 0);
    }
}
