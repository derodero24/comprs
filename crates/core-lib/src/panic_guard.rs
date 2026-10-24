//! Panics that comprs-core catches and recovers from.
//!
//! brotli 9.0.0's encoder panics on some inputs with a custom dictionary
//! (#623). comprs-core runs it under [`std::panic::catch_unwind`] and, when
//! it panics, compresses the input again without the dictionary, so the call
//! succeeds. The panic hook runs first, though, at the panic site, and
//! Rust's default hook prints the panic to stderr as if the program had
//! failed (#650). comprs-core therefore marks the thread while it runs code
//! whose panics it recovers from: [`is_guarded`] reads the mark, and
//! [`quiet_guarded_panics`] builds a panic hook that says nothing about those
//! panics.
//!
//! comprs-core installs no panic hook: the hook belongs to the program. The
//! native addon installs the one that [`quiet_guarded_panics`] builds when it
//! loads. The WebAssembly build keeps logging every panic, as panics abort
//! there and nothing is caught.

use std::cell::Cell;
use std::panic::{PanicHookInfo, UnwindSafe};

/// A panic hook, as [`std::panic::take_hook`] returns it and
/// [`std::panic::set_hook`] takes it.
pub type PanicHook = Box<dyn Fn(&PanicHookInfo<'_>) + Sync + Send + 'static>;

thread_local! {
    /// Whether the thread runs a closure of [`catch`].
    static GUARDED: Cell<bool> = const { Cell::new(false) };
}

/// Marks the thread as guarded from its creation until it is dropped, which
/// also happens while a panic unwinds.
struct Mark {
    /// The mark that a nested [`catch`] restores.
    previous: bool,
}

impl Mark {
    fn set() -> Self {
        Self {
            previous: GUARDED.replace(true),
        }
    }
}

impl Drop for Mark {
    fn drop(&mut self) {
        GUARDED.set(self.previous);
    }
}

/// Run `f` under [`std::panic::catch_unwind`], with the thread marked as
/// guarded ([`is_guarded`]) for as long as `f` runs.
///
/// Only for code whose panics the caller recovers from, as the mark tells
/// panic hooks to say nothing about them. Where panics abort, as on wasm32,
/// nothing is caught, and the thread is not marked.
///
/// A panic in a destructor while a panic of `f` unwinds aborts the process,
/// and a hook that trusts the mark leaves out the panic messages: only the
/// runtime's line about the abort remains. brotli's encoder, the only code
/// that runs this way, has no destructor that panics.
pub(crate) fn catch<R>(f: impl FnOnce() -> R + UnwindSafe) -> std::thread::Result<R> {
    std::panic::catch_unwind(|| {
        let _mark = cfg!(panic = "unwind").then(Mark::set);
        f()
    })
}

/// Whether comprs-core catches a panic of the current thread at this point
/// and recovers from it.
///
/// True while the thread runs code that comprs-core calls under
/// [`std::panic::catch_unwind`] to recover from its panics: such a panic
/// unwinds to that `catch_unwind`, and the comprs-core function that it
/// interrupted still returns its result. Today that code is brotli 9.0.0's
/// encoder with a custom dictionary. A panic hook runs at the panic site,
/// before the panic unwinds, so it can tell these panics from the others,
/// which comprs-core does not catch: see [`quiet_guarded_panics`].
///
/// Always false where panics abort, and on any other thread, which the
/// `catch_unwind` does not cover.
pub fn is_guarded() -> bool {
    GUARDED.get()
}

/// Wrap the panic hook `previous` into one that says nothing about the
/// panics that comprs-core recovers from ([`is_guarded`]) and passes every
/// other panic on to `previous`.
///
/// It only builds the hook: a program that wants it installs it with
/// [`std::panic::set_hook`], usually over the hook that
/// [`std::panic::take_hook`] returns. Without it, Rust's default hook prints
/// each of these panics to stderr, with a backtrace if `RUST_BACKTRACE` is
/// set, although the call that panicked succeeds.
pub fn quiet_guarded_panics(previous: PanicHook) -> PanicHook {
    Box::new(move |info| {
        if !is_guarded() {
            previous(info);
        }
    })
}

#[cfg(test)]
mod tests {
    use std::panic;
    use std::sync::{Arc, Mutex};
    use std::thread;

    use super::*;

    #[test]
    fn catch_marks_the_thread_while_the_closure_runs() {
        assert!(!is_guarded());
        assert!(catch(is_guarded).unwrap());
        assert!(!is_guarded());

        let panicked: thread::Result<()> = catch(|| panic!("a guarded panic"));
        assert!(panicked.is_err());
        assert!(!is_guarded());
    }

    #[test]
    fn catch_marks_only_its_own_thread() {
        let spawned = catch(|| thread::spawn(is_guarded).join().unwrap());
        assert!(!spawned.unwrap());
    }

    #[test]
    fn nested_catch_keeps_the_outer_mark() {
        let outer = catch(|| {
            let inner: thread::Result<()> = catch(|| panic!("a nested guarded panic"));
            inner.is_err() && is_guarded()
        });
        assert!(outer.unwrap());
        assert!(!is_guarded());
    }

    /// The panic hook belongs to the whole process, so this is the only test
    /// that installs one. The other tests run meanwhile: the hook passes
    /// their panics on to the hook it replaced, and that hook is back before
    /// anything is checked, so that a failed check gets reported.
    #[test]
    fn quiet_hook_passes_on_only_unguarded_panics() {
        let replaced = Arc::new(panic::take_hook());
        let test_thread = thread::current().id();
        let passed_on = Arc::new(Mutex::new(Vec::new()));
        let previous: PanicHook = {
            let replaced = Arc::clone(&replaced);
            let passed_on = Arc::clone(&passed_on);
            Box::new(move |info| {
                if thread::current().id() == test_thread {
                    let message = info.payload().downcast_ref::<&str>().copied();
                    passed_on.lock().unwrap().push(message.unwrap_or_default());
                } else {
                    replaced(info);
                }
            })
        };
        panic::set_hook(quiet_guarded_panics(previous));
        let guarded: thread::Result<()> = catch(|| panic!("a guarded panic"));
        let unguarded: thread::Result<()> = panic::catch_unwind(|| panic!("an unguarded panic"));
        drop(panic::take_hook());
        panic::set_hook(Arc::into_inner(replaced).expect("the test's hook is dropped"));

        assert!(guarded.is_err() && unguarded.is_err());
        assert_eq!(*passed_on.lock().unwrap(), ["an unguarded panic"]);
    }
}
