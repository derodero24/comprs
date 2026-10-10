//! Allocations of LZ4 compression and decompression, observed through a
//! global allocator that records them for each thread. A test binary of its
//! own, so that the allocator records no other tests.

use std::alloc::{GlobalAlloc, Layout, System};
use std::cell::Cell;

use comprs_core::{MemoryUsage, lz4, lz4_stream};

struct TestAllocator;

thread_local! {
    // Without a destructor or lazy initialization, so that the allocator
    // can use them at any time without allocating.

    /// The bytes that the thread has allocated, minus those it has freed.
    static LIVE: Cell<isize> = const { Cell::new(0) };
    /// The allocations and reallocations of at least [`LARGE`] bytes on the
    /// thread since the last reset.
    static LARGE_ALLOCATIONS: Cell<usize> = const { Cell::new(0) };
}

/// Size from which [`LARGE_ALLOCATIONS`] counts an allocation: more than the
/// buffers of an LZ4 frame encoder with 256 KiB blocks.
const LARGE: usize = 512 * 1024;

/// Record that the thread allocated `allocated` bytes and freed `freed`.
fn record(allocated: usize, freed: usize) {
    LIVE.set(LIVE.get() + allocated as isize - freed as isize);
    if allocated >= LARGE {
        LARGE_ALLOCATIONS.set(LARGE_ALLOCATIONS.get() + 1);
    }
}

// SAFETY: every method forwards to `System` with the caller's arguments, so
// the caller's guarantees carry over, and returns what `System` returns.
unsafe impl GlobalAlloc for TestAllocator {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        // SAFETY: forwarded unchanged, see above.
        let ptr = unsafe { System.alloc(layout) };
        if !ptr.is_null() {
            record(layout.size(), 0);
        }
        ptr
    }

    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        // SAFETY: forwarded unchanged, see above.
        let ptr = unsafe { System.alloc_zeroed(layout) };
        if !ptr.is_null() {
            record(layout.size(), 0);
        }
        ptr
    }

    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        // SAFETY: forwarded unchanged, see above.
        let new_ptr = unsafe { System.realloc(ptr, layout, new_size) };
        if !new_ptr.is_null() {
            record(new_size, layout.size());
        }
        new_ptr
    }

    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        // SAFETY: forwarded unchanged, see above.
        unsafe { System.dealloc(ptr, layout) };
        record(0, layout.size());
    }
}

#[global_allocator]
static ALLOCATOR: TestAllocator = TestAllocator;

/// The number of allocations and reallocations of at least [`LARGE`] bytes
/// that `f` makes on this thread.
fn large_allocations<T>(f: impl FnOnce() -> T) -> (T, usize) {
    LARGE_ALLOCATIONS.set(0);
    let result = f();
    (result, LARGE_ALLOCATIONS.get())
}

/// The bytes that `f` allocates on this thread and does not free.
fn retained<T>(f: impl FnOnce() -> T) -> (T, usize) {
    let before = LIVE.get();
    let result = f();
    let retained = LIVE.get() - before;
    (
        result,
        retained.try_into().expect("freed more than allocated"),
    )
}

/// Repetitive text of `len` bytes.
fn text(len: usize) -> Vec<u8> {
    b"comprs compresses LZ4 frames in blocks. "
        .iter()
        .copied()
        .cycle()
        .take(len)
        .collect()
}

/// Pseudo-random bytes, which do not compress.
fn random(len: usize) -> Vec<u8> {
    let mut state = 0x2545_f491_4f6c_dd1du64;
    (0..len)
        .map(|_| {
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            (state >> 32) as u8
        })
        .collect()
}

/// The stream encoder writes 64 KiB blocks whatever the size of the chunks,
/// so the memory that it reports to V8 covers all that it holds. Left to
/// choose, lz4_flex would size the blocks from the first chunk, and a chunk
/// of 1 MiB would make the encoder hold 4 MiB blocks.
#[test]
fn compress_context_holds_no_more_than_it_reports() {
    let data = text(1024 * 1024);
    let ((ctx, output), held) = retained(|| {
        let mut ctx = lz4_stream::CompressContext::new();
        let output = ctx.transform(&data).unwrap();
        (ctx, output)
    });
    // What the context holds, without the output that it has returned.
    let held = held - output.capacity();
    assert!(
        (64 * 1024..=ctx.memory_usage()).contains(&held),
        "holds {held} bytes, reports {}",
        ctx.memory_usage()
    );
}

/// lz4::compress makes room for the whole frame up front, so the output of
/// data that does not compress is allocated once, rather than reallocated
/// and copied before its last block. Left to choose, lz4_flex would also
/// allocate two 4 MiB buffers for 1 MiB.
#[test]
fn compress_allocates_the_output_once() {
    let data = random(1024 * 1024);
    let (compressed, large) = large_allocations(|| lz4::compress(&data).unwrap());
    // Stored, not compressed.
    assert!(compressed.len() > data.len());
    assert_eq!(large, 1);
}
