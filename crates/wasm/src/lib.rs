#![deny(clippy::all)]

use std::alloc::{GlobalAlloc, Layout, handle_alloc_error};

use wasm_bindgen::prelude::*;

use comprs_core::ComprsError;

// The functions of the unified API, `@derodero24/comprs/next`, whose errors
// carry codes, in every build.
mod next;

// The per-format functions and stream contexts of the classic API, which keep
// the errors of comprs 2.x, for the browser entry of the package. Only the
// build with every format has them, the default: the per-format builds of
// the unified API (#342) leave them out.
#[cfg(feature = "classic")]
mod classic;

// ---------------------------------------------------------------------------
// Global allocator
// ---------------------------------------------------------------------------
//
// zstd links the C library, and on wasm32 zstd-sys replaces its malloc,
// calloc and free with a shim backed by Rust's global allocator (the
// `wasm_shim_alloc` in zstd-sys 2.1.0+zstd.1.5.7, built for
// wasm32-unknown-unknown and wasm32-wasi*). That shim does not check the
// allocator for failure: on a null result it writes a size header through the
// null pointer and returns a non-null pointer (address 4) to zstd, which then
// writes its window and tables into the start of linear memory and traps on
// an out-of-bounds access. zstd never sees a null, so it cannot report
// ZSTD_error_memory_allocation. The default allocator on wasm32 returns null
// (rather than aborting) once the module's memory cannot grow, which a frame
// with a large window or a high compression level can force.
//
// Wrapping the allocator so a null result becomes `handle_alloc_error` means
// the shim can never receive null: an allocation that cannot be satisfied
// aborts at the allocation site, which wasm turns into a trap that JS sees as
// a RuntimeError, instead of corrupting memory. The shim calls the global
// allocator, so this covers every zstd allocation.
//
// This matters only where that shim is linked, so the allocator is installed
// for wasm32 alone; the wrapper is still compiled for the host so its logic
// can be unit-tested there.
#[cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]
struct AbortOnOom<A>(A);

// SAFETY: every method forwards to the inner allocator with the same
// arguments and returns its pointer unchanged when it is non-null, so the
// allocator contract is upheld; the only added behavior is aborting instead
// of propagating a null (failure) result.
unsafe impl<A: GlobalAlloc> GlobalAlloc for AbortOnOom<A> {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        nonnull_or_abort(unsafe { self.0.alloc(layout) }, layout)
    }

    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        nonnull_or_abort(unsafe { self.0.alloc_zeroed(layout) }, layout)
    }

    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        let new_ptr = unsafe { self.0.realloc(ptr, layout, new_size) };
        if new_ptr.is_null() {
            // On failure the original allocation is untouched; the layout for
            // the error is the requested new size at the existing alignment.
            handle_alloc_error(Layout::from_size_align(new_size, layout.align()).unwrap_or(layout));
        }
        new_ptr
    }

    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        unsafe { self.0.dealloc(ptr, layout) }
    }
}

/// Return `ptr`, or abort via [`handle_alloc_error`] if it is null.
#[cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]
#[inline]
fn nonnull_or_abort(ptr: *mut u8, layout: Layout) -> *mut u8 {
    if ptr.is_null() {
        handle_alloc_error(layout);
    }
    ptr
}

#[cfg(target_arch = "wasm32")]
#[global_allocator]
static ALLOCATOR: AbortOnOom<std::alloc::System> = AbortOnOom(std::alloc::System);

// ---------------------------------------------------------------------------
// Panics
// ---------------------------------------------------------------------------

#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(js_namespace = console, js_name = error)]
    fn console_error(message: &str);
}

/// Runs when the module is instantiated.
///
/// On wasm32-unknown-unknown, a panic aborts with a trap, which JS sees as a
/// bare `RuntimeError: unreachable`, and the default panic hook has nowhere
/// to print its message. Log the message instead.
#[wasm_bindgen(start)]
fn start() {
    std::panic::set_hook(Box::new(|info| console_error(&info.to_string())));
}

// ===========================================================================
// Streaming contexts
// ===========================================================================

/// The codec state of a stream context, kept as the native addon keeps it
/// (`NativeState` in crates/core/src/context.rs), without the report of its
/// memory to the engine: `finish()` and `close()` drop the state, and later
/// calls throw `<name> already finished` or `<name> already closed`.
struct StreamState<T> {
    state: State<T>,
    /// Name of the stream in errors, such as "zstd stream".
    name: &'static str,
}

enum State<T> {
    Open(T),
    Finished,
    /// Only the classic API closes its streams: the glue frees those of the
    /// unified API.
    #[cfg_attr(not(feature = "classic"), allow(dead_code))]
    Closed,
}

impl<T> StreamState<T> {
    fn new(state: T, name: &'static str) -> Self {
        Self {
            state: State::Open(state),
            name,
        }
    }

    /// Run `op` on the state, for the streams of the unified API, whose
    /// errors carry codes. The classic API maps the error to its own.
    fn try_run(
        &mut self,
        op: impl FnOnce(&mut T) -> Result<Vec<u8>, ComprsError>,
    ) -> Result<Vec<u8>, ComprsError> {
        op(self.state()?)
    }

    /// Run `op`, which ends the stream, then drop the state, whether `op`
    /// succeeded or not: the codecs cannot continue after either. With the
    /// error of comprs-core, as [`try_run`](Self::try_run).
    fn try_finish(
        &mut self,
        op: impl FnOnce(&mut T) -> Result<Vec<u8>, ComprsError>,
    ) -> Result<Vec<u8>, ComprsError> {
        let output = op(self.state()?);
        self.state = State::Finished;
        output
    }

    fn state(&mut self) -> Result<&mut T, ComprsError> {
        match &mut self.state {
            State::Open(state) => Ok(state),
            State::Finished => Err(ComprsError::StreamFinished(self.name)),
            State::Closed => Err(ComprsError::StreamClosed(self.name)),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn layout() -> Layout {
        Layout::from_size_align(64, 8).unwrap()
    }

    /// An inner allocator whose results the wrapper tests drive. The returned
    /// pointers are only compared, never dereferenced or freed.
    struct Fixed(*mut u8);

    unsafe impl GlobalAlloc for Fixed {
        unsafe fn alloc(&self, _layout: Layout) -> *mut u8 {
            self.0
        }
        unsafe fn alloc_zeroed(&self, _layout: Layout) -> *mut u8 {
            self.0
        }
        unsafe fn realloc(&self, _ptr: *mut u8, _layout: Layout, _new_size: usize) -> *mut u8 {
            self.0
        }
        unsafe fn dealloc(&self, _ptr: *mut u8, _layout: Layout) {}
    }

    const FAKE: *mut u8 = 0x1000 as *mut u8;

    #[test]
    fn passes_through_a_successful_allocation() {
        let alloc = AbortOnOom(Fixed(FAKE));
        unsafe {
            assert_eq!(alloc.alloc(layout()), FAKE);
            assert_eq!(alloc.alloc_zeroed(layout()), FAKE);
            assert_eq!(alloc.realloc(FAKE, layout(), 128), FAKE);
        }
    }

    /// An inner allocator that always fails.
    struct AlwaysNull;

    unsafe impl GlobalAlloc for AlwaysNull {
        unsafe fn alloc(&self, _layout: Layout) -> *mut u8 {
            core::ptr::null_mut()
        }
        unsafe fn alloc_zeroed(&self, _layout: Layout) -> *mut u8 {
            core::ptr::null_mut()
        }
        unsafe fn realloc(&self, _ptr: *mut u8, _layout: Layout, _new_size: usize) -> *mut u8 {
            core::ptr::null_mut()
        }
        unsafe fn dealloc(&self, _ptr: *mut u8, _layout: Layout) {}
    }

    const CHILD_ENV: &str = "COMPRS_WASM_ABORT_CHILD";

    /// A failing allocation must abort, never return null: the zstd wasm shim
    /// treats whatever it gets back as a valid buffer, so a null would be
    /// written through and a bogus pointer handed to zstd. `handle_alloc_error`
    /// aborts the process, so the failing call runs in a child process and the
    /// parent checks that the child aborted instead of returning.
    #[test]
    fn aborts_when_the_allocation_fails() {
        if std::env::var_os(CHILD_ENV).is_some() {
            let alloc = AbortOnOom(AlwaysNull);
            // Must abort before the next line; exiting 0 fails the parent's
            // assertion.
            let _ = unsafe { alloc.alloc(layout()) };
            std::process::exit(0);
        }

        let exe = std::env::current_exe().unwrap();
        let output = std::process::Command::new(exe)
            .args(["tests::aborts_when_the_allocation_fails", "--exact"])
            .env(CHILD_ENV, "1")
            .output()
            .unwrap();
        assert!(
            !output.status.success(),
            "the child returned instead of aborting on a failed allocation"
        );
    }
}
