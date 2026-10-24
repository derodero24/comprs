//! Module setup, which installs the panic hook for the panics that
//! comprs-core recovers from, hides the binding of the unified API and adds
//! `[Symbol.dispose]()` to the stream context classes, and the native state
//! and shared methods of those classes.

use std::panic;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, Once, PoisonError};

use comprs_core::panic_guard::quiet_guarded_panics;
use comprs_core::{ComprsError, MemoryUsage};
use napi::bindgen_prelude::{Buffer, Env, JsObjectValue, Object, Property, Unknown, ValueType};
use napi_derive::napi;

use crate::convert::sync_result;

/// The stream context classes, which [`init`] makes disposable.
const CONTEXT_CLASSES: [&str; 14] = [
    "BrotliCompressContext",
    "BrotliCompressDictContext",
    "BrotliDecompressContext",
    "BrotliDecompressDictContext",
    "DeflateCompressContext",
    "DeflateDecompressContext",
    "GzipCompressContext",
    "GzipDecompressContext",
    "Lz4CompressContext",
    "Lz4DecompressContext",
    "ZstdCompressContext",
    "ZstdCompressDictContext",
    "ZstdDecompressContext",
    "ZstdDecompressDictContext",
];

/// Set up the module once napi-rs has registered its exports: keep the
/// panics that comprs-core recovers from off stderr, hide the binding of the
/// unified API, and make the stream contexts disposable.
///
/// The contexts get `[Symbol.dispose]()` as an alias of `close()`, so that a
/// `using` declaration closes its context at the end of the scope. napi-rs
/// names methods with strings only, so the alias is added to the prototypes
/// once the classes are registered. Runtimes without `Symbol.dispose` go
/// without it.
#[napi(module_exports)]
pub fn init(mut exports: Object, env: Env) -> napi::Result<()> {
    quiet_recovered_panics();
    // Before the return below, so that every runtime gets the binding.
    crate::next::hide(&env, &mut exports)?;
    // `Symbol` and the classes are functions, which the checked getters
    // reject as objects.
    let dispose: Unknown = env
        .get_global()?
        .get_named_property_unchecked::<Object>("Symbol")?
        .get_named_property("dispose")?;
    if dispose.get_type()? != ValueType::Symbol {
        return Ok(());
    }
    for name in CONTEXT_CLASSES {
        let mut prototype: Object = exports
            .get_named_property_unchecked::<Object>(name)?
            .get_named_property("prototype")?;
        let close: Unknown = prototype.get_named_property("close")?;
        let alias = Property::new().with_name(&env, dispose)?.with_value(&close);
        prototype.define_properties(&[alias])?;
    }
    Ok(())
}

/// Keep the panics that comprs-core recovers from off stderr.
///
/// brotli 9.0.0's encoder panics on some inputs with a custom dictionary.
/// comprs-core catches the panic and compresses again without the
/// dictionary, so the call succeeds, but the panic hook runs first, and
/// Rust's default hook would print a "panicked at" message to the
/// application's stderr for every such call (#650). The hook installed here
/// says nothing about the panics that comprs-core recovers from and passes
/// every other panic on to the hook that it replaces.
///
/// The hook is global to the process, but the addon links its own copy of
/// the Rust standard library, so it sees the panics of this addon only, not
/// those of other native addons. Node.js runs [`init`] in every environment
/// that loads the addon, such as a worker thread: the `Once` keeps the hook
/// from wrapping itself again each time.
fn quiet_recovered_panics() {
    static INSTALL: Once = Once::new();
    INSTALL.call_once(|| panic::set_hook(quiet_guarded_panics(panic::take_hook())));
}

/// The engine's account of memory held outside its heap, which it counts
/// towards the limits that schedule garbage collection.
pub(crate) trait ExternalMemory {
    /// Add `change` bytes, which may be negative, to the account.
    fn adjust(&self, change: i64);
}

impl ExternalMemory for Env {
    fn adjust(&self, change: i64) {
        // napi_adjust_external_memory fails only for invalid arguments, and
        // the account only steers garbage collection: a failed update must
        // not fail the call that compressed or decompressed the data.
        let _ = self.adjust_external_memory(change);
    }
}

/// The codec state of a stream context, with its memory reported to V8.
///
/// V8 sees only the small JavaScript object of a context, not the encoder
/// or decoder state behind it, which can reach tens of megabytes. Abandoned
/// contexts would then pile up until an unrelated garbage collection. The
/// memory of the state is therefore reported to V8 as external memory. The
/// report follows [`MemoryUsage`] after every call, since codecs allocate
/// most of their state once data arrives, and drops to zero when the state
/// is dropped: by `finish()`, by `close()` or when the garbage collector
/// finalizes the object.
///
/// The state is shared with the task of an asynchronous method, such as
/// `transformAsync()`, which runs the codec on the libuv thread pool (see
/// [`crate::stream_task`]). At most one such call is in flight per context:
/// the task marks the context as busy from its creation until it settles,
/// and every other call fails fast meanwhile instead of waiting for the
/// lock. `close()` and the finalizer cannot drop the state while the task
/// holds it, so they leave that to the task, which drops it when it
/// settles.
pub(crate) struct NativeState<T> {
    shared: Arc<Shared<T>>,
}

/// What a stream context shares with the task of its asynchronous call.
///
/// The flags are set and cleared on the JavaScript thread only: `busy` when
/// a task is created and when it settles, `close_requested` by `close()`
/// and the finalizer. The thread pool takes the lock only while `busy` is
/// set and the task runs, and the JavaScript thread only while `busy` is
/// clear or once the task has run, so the lock is never contended.
pub(crate) struct Shared<T> {
    slot: Mutex<Slot<T>>,
    /// Whether an asynchronous call is in flight.
    busy: AtomicBool,
    /// Whether `close()` or the finalizer ran before the stream finished:
    /// the state is dropped already, or is dropped once the call in flight
    /// settles. Later calls fail with [`ComprsError::StreamClosed`].
    close_requested: AtomicBool,
    /// Name of the stream in errors, such as "zstd stream".
    name: &'static str,
}

/// The codec state and the memory reported for it.
struct Slot<T> {
    state: State<T>,
    /// Bytes currently reported.
    reported: i64,
}

enum State<T> {
    Open(T),
    Finished,
    Closed,
}

// Every stream context of comprs-core can move to the thread pool, which
// the task of an asynchronous method takes it to.
const _: () = {
    const fn assert_send<T: Send>() {}
    assert_send::<comprs_core::brotli_stream::CompressContext>();
    assert_send::<comprs_core::brotli_stream::CompressDictContext>();
    assert_send::<comprs_core::brotli_stream::DecompressContext>();
    assert_send::<comprs_core::brotli_stream::DecompressDictContext>();
    assert_send::<comprs_core::gzip_stream::DeflateCompressContext>();
    assert_send::<comprs_core::gzip_stream::DeflateDecompressContext>();
    assert_send::<comprs_core::gzip_stream::GzipCompressContext>();
    assert_send::<comprs_core::gzip_stream::GzipDecompressContext>();
    assert_send::<comprs_core::gzip_stream::StrictDecompressContext>();
    assert_send::<comprs_core::gzip_stream::ZlibCompressContext>();
    assert_send::<comprs_core::lz4_stream::CompressContext>();
    assert_send::<comprs_core::lz4_stream::DecompressContext>();
    assert_send::<comprs_core::unified::AutoDecoder>();
    assert_send::<comprs_core::unified::CompressContext>();
    assert_send::<comprs_core::unified::DecompressContext>();
    assert_send::<comprs_core::zstd_stream::CompressContext>();
    assert_send::<comprs_core::zstd_stream::CompressDictContext>();
    assert_send::<comprs_core::zstd_stream::DecompressContext>();
    assert_send::<comprs_core::zstd_stream::DecompressDictContext>();
};

impl<T: MemoryUsage> NativeState<T> {
    /// Take a newly created codec state and report its memory.
    pub(crate) fn new(memory: &impl ExternalMemory, state: T, name: &'static str) -> Self {
        let shared = Shared {
            slot: Mutex::new(Slot {
                state: State::Open(state),
                reported: 0,
            }),
            busy: AtomicBool::new(false),
            close_requested: AtomicBool::new(false),
            name,
        };
        shared.lock().report(memory);
        Self {
            shared: Arc::new(shared),
        }
    }

    /// Run `op` on the state and update the memory reported for it.
    pub(crate) fn run(
        &self,
        memory: &impl ExternalMemory,
        op: impl FnOnce(&mut T) -> Result<Vec<u8>, ComprsError>,
    ) -> Result<Vec<u8>, ComprsError> {
        self.shared.check_idle()?;
        let mut slot = self.shared.lock();
        let output = slot.state(self.shared.name).and_then(op);
        slot.report(memory);
        output
    }

    /// Run `op`, which ends the stream, then drop the state, whether `op`
    /// succeeded or not: the codecs cannot continue after either.
    pub(crate) fn finish(
        &self,
        memory: &impl ExternalMemory,
        op: impl FnOnce(&mut T) -> Result<Vec<u8>, ComprsError>,
    ) -> Result<Vec<u8>, ComprsError> {
        self.shared.check_idle()?;
        let mut slot = self.shared.lock();
        let output = slot.state(self.shared.name).and_then(op);
        slot.state = State::Finished;
        slot.report(memory);
        output
    }

    /// Drop the state, unless the stream is already finished or closed, and
    /// withdraw its memory from the report. While an asynchronous call is in
    /// flight, only mark the stream as closed: the call drops the state
    /// when it settles.
    pub(crate) fn close(&self, memory: &impl ExternalMemory) {
        if self.shared.busy.load(Ordering::Acquire) {
            self.shared.close_requested.store(true, Ordering::Release);
            return;
        }
        let mut slot = self.shared.lock();
        if let State::Open(_) = slot.state {
            slot.state = State::Closed;
            self.shared.close_requested.store(true, Ordering::Release);
        }
        slot.report(memory);
    }

    /// [`run`](Self::run) for a method of a stream context class: return the
    /// output as a `Buffer`, as [`sync_result`] does, or throw the error.
    pub(crate) fn call(
        &self,
        env: &Env,
        op: impl FnOnce(&mut T) -> Result<Vec<u8>, ComprsError>,
    ) -> napi::Result<Buffer> {
        sync_result(env, self.run(env, op))
    }

    /// [`finish`](Self::finish) for the `finish()` method of a stream context
    /// class: return the output as a `Buffer`, as [`sync_result`] does, or
    /// throw the error.
    pub(crate) fn call_finish(
        &self,
        env: &Env,
        op: impl FnOnce(&mut T) -> Result<Vec<u8>, ComprsError>,
    ) -> napi::Result<Buffer> {
        sync_result(env, self.finish(env, op))
    }

    /// Mark the stream as busy for an asynchronous call, and return the
    /// state that its task shares, or the error to reject the call with:
    /// [`ComprsError::StreamClosed`] after `close()`, which takes precedence
    /// so that a call after `close()` fails the same way whether or not a
    /// call is still in flight, then [`ComprsError::StreamBusy`]. The task
    /// must call [`Shared::settle`] once it has run.
    pub(crate) fn begin_async(&self) -> Result<Arc<Shared<T>>, ComprsError> {
        let shared = &self.shared;
        if shared.close_requested.load(Ordering::Acquire) {
            return Err(ComprsError::StreamClosed(shared.name));
        }
        shared
            .busy
            .compare_exchange(false, true, Ordering::Acquire, Ordering::Relaxed)
            .map_err(|_| ComprsError::StreamBusy(shared.name))?;
        Ok(Arc::clone(shared))
    }
}

impl<T: MemoryUsage> Shared<T> {
    /// Fail as a synchronous call must while the stream is closed or an
    /// asynchronous call is in flight. Closed comes first, as in
    /// [`NativeState::begin_async`].
    fn check_idle(&self) -> Result<(), ComprsError> {
        if self.close_requested.load(Ordering::Acquire) {
            return Err(ComprsError::StreamClosed(self.name));
        }
        if self.busy.load(Ordering::Acquire) {
            return Err(ComprsError::StreamBusy(self.name));
        }
        Ok(())
    }

    /// Lock the slot. Only a panic while the lock is held poisons it, and a
    /// panic that leaves comprs-core aborts the process, on the JavaScript
    /// thread and on the thread pool alike, so a poisoned lock is taken as
    /// it is.
    fn lock(&self) -> MutexGuard<'_, Slot<T>> {
        self.slot.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Run `op` on the state for an asynchronous call, on the thread pool,
    /// and drop the state after `finish()` (`ends`), whether `op` succeeded
    /// or not, or once the stream has been closed meanwhile. Dropping the
    /// state here keeps that work off the JavaScript thread;
    /// [`settle`](Self::settle) reports the memory.
    pub(crate) fn run_async(
        &self,
        ends: bool,
        op: impl FnOnce(&mut T) -> Result<Vec<u8>, ComprsError>,
    ) -> Result<Vec<u8>, ComprsError> {
        let mut slot = self.lock();
        let output = slot.state(self.name).and_then(op);
        if ends {
            slot.state = State::Finished;
        } else if self.close_requested.load(Ordering::Acquire) {
            slot.close();
        }
        output
    }

    /// End an asynchronous call, on the JavaScript thread: drop the state if
    /// the stream was closed while the call was in flight, report its
    /// memory, and clear the busy mark.
    pub(crate) fn settle(&self, memory: &impl ExternalMemory) {
        let mut slot = self.lock();
        if self.close_requested.load(Ordering::Acquire) {
            slot.close();
        }
        slot.report(memory);
        drop(slot);
        self.busy.store(false, Ordering::Release);
    }

    /// Clear the busy mark of a call that cannot settle, as when Node.js
    /// cancels its task while the environment shuts down, without a report.
    pub(crate) fn abandon(&self) {
        self.busy.store(false, Ordering::Release);
    }
}

impl<T: MemoryUsage> Slot<T> {
    fn state(&mut self, name: &'static str) -> Result<&mut T, ComprsError> {
        match &mut self.state {
            State::Open(state) => Ok(state),
            State::Finished => Err(ComprsError::StreamFinished(name)),
            State::Closed => Err(ComprsError::StreamClosed(name)),
        }
    }

    /// Drop the state unless the stream is already finished or closed.
    fn close(&mut self) {
        if let State::Open(_) = self.state {
            self.state = State::Closed;
        }
    }

    /// Report the change in the memory of the state since the last report.
    fn report(&mut self, memory: &impl ExternalMemory) {
        let usage = match &self.state {
            State::Open(state) => i64::try_from(state.memory_usage()).unwrap_or(i64::MAX),
            State::Finished | State::Closed => 0,
        };
        if usage != self.reported {
            memory.adjust(usage - self.reported);
            self.reported = usage;
        }
    }
}

/// Add `close()`, the asynchronous methods and the finalizer, which every
/// stream context class has in the same form, to `$class`: a
/// `#[napi(custom_finalize)]` struct whose `inner` field is a
/// [`NativeState`] of `$codec`. The methods go into an `impl` block of their
/// own, which napi-rs merges into the class.
///
/// Each class writes its constructor, `transform(chunk)`, `flush()` and
/// `finish()` itself, around [`NativeState::call`] and
/// [`NativeState::call_finish`], because their doc comments differ from
/// class to class and a macro cannot pass them on: `macro_rules!` turns a
/// doc comment of its input into `#[doc = r"..."]`, and napi-derive 3.6
/// takes the doc text from the source of the literal, so `index.d.ts` would
/// get the `r"` of the raw string. Doc comments written in the macro itself,
/// such as the one of `close()`, reach napi-derive intact.
///
/// The asynchronous methods copy their chunk before they return, as the
/// one-shot `*Async` functions copy their input (#548), and take it as an
/// [`AsyncArg`](crate::async_args::AsyncArg), so that an invalid argument
/// rejects the Promise instead of throwing (#619).
///
/// The expansion names the `napi` attribute and the items of
/// `napi::bindgen_prelude` without a path, as the stream modules import them.
macro_rules! stream_context_methods {
    ($class:ident, $codec:ty) => {
        #[napi]
        impl $class {
            /// Release the native state of the context now rather than when the
            /// context is garbage-collected. Later calls throw, and `finish()`
            /// releases the state too. Closing a finished or closed context does
            /// nothing. `[Symbol.dispose]()` is the same method, for `using`
            /// declarations.
            #[napi]
            pub fn close(&mut self, env: Env) {
                self.inner.close(&env);
            }

            /// `transform(chunk)` on the libuv thread pool: returns a Promise of
            /// the output, and reports every error, an invalid argument included,
            /// by rejecting it. The chunk is copied before the method returns, so
            /// the caller may reuse its memory at once. In the browser build, it
            /// runs synchronously, on the calling thread.
            ///
            /// At most one asynchronous call may be in flight per context: until
            /// its Promise settles, another asynchronous call rejects and a
            /// synchronous call throws `<name> is busy: an asynchronous call has
            /// not finished`, such as `zstd stream is busy: an asynchronous call
            /// has not finished`. `close()` while a call is in flight releases
            /// the native state once the call settles, and its Promise still
            /// settles. After `close()`, calls reject with `<name> already
            /// closed`.
            #[napi(
                ts_args_type = "chunk: Buffer | Uint8Array",
                ts_return_type = "Promise<Buffer>"
            )]
            pub fn transform_async(
                &self,
                chunk: crate::async_args::AsyncArg<Either<Buffer, Uint8Array>>,
            ) -> AsyncTask<
                crate::async_args::Checked<
                    crate::stream_task::StreamTask<$codec, crate::stream_task::StreamBuffer>,
                >,
            > {
                crate::async_args::checked(|| {
                    let chunk = crate::as_bytes(&chunk.get()?).to_vec();
                    Ok(crate::stream_task::StreamTask::new(
                        &self.inner,
                        crate::stream_task::Op::Transform(chunk),
                    ))
                })
            }

            /// `flush()` on the libuv thread pool: returns a Promise of the
            /// output, and reports every error by rejecting it. In the browser
            /// build, it runs synchronously, on the calling thread.
            ///
            /// At most one asynchronous call may be in flight per context: until
            /// its Promise settles, another asynchronous call rejects and a
            /// synchronous call throws `<name> is busy: an asynchronous call has
            /// not finished`. After `close()`, calls reject with `<name> already
            /// closed`.
            #[napi(ts_return_type = "Promise<Buffer>")]
            pub fn flush_async(
                &self,
            ) -> AsyncTask<crate::stream_task::StreamTask<$codec, crate::stream_task::StreamBuffer>>
            {
                AsyncTask::new(crate::stream_task::StreamTask::new(
                    &self.inner,
                    crate::stream_task::Op::Flush,
                ))
            }

            /// `finish()` on the libuv thread pool: returns a Promise of the rest
            /// of the output, and reports every error by rejecting it. The native
            /// state is released once the call has run, whether it succeeded or
            /// not. In the browser build, it runs synchronously, on the calling
            /// thread.
            ///
            /// At most one asynchronous call may be in flight per context: until
            /// its Promise settles, another asynchronous call rejects and a
            /// synchronous call throws `<name> is busy: an asynchronous call has
            /// not finished`. After `close()`, calls reject with `<name> already
            /// closed`.
            #[napi(ts_return_type = "Promise<Buffer>")]
            pub fn finish_async(
                &self,
            ) -> AsyncTask<crate::stream_task::StreamTask<$codec, crate::stream_task::StreamBuffer>>
            {
                AsyncTask::new(crate::stream_task::StreamTask::new(
                    &self.inner,
                    crate::stream_task::Op::Finish,
                ))
            }
        }

        impl ObjectFinalize for $class {
            fn finalize(self, env: Env) -> Result<()> {
                self.inner.close(&env);
                Ok(())
            }
        }
    };
}

pub(crate) use stream_context_methods;

#[cfg(test)]
mod tests {
    use std::cell::Cell;

    use super::*;

    /// Records the external memory reported to it.
    #[derive(Default)]
    struct Account {
        total: Cell<i64>,
        adjustments: Cell<usize>,
    }

    impl ExternalMemory for Account {
        fn adjust(&self, change: i64) {
            self.total.set(self.total.get() + change);
            self.adjustments.set(self.adjustments.get() + 1);
        }
    }

    /// A codec state that holds `size` bytes, as its operations set it.
    struct Codec {
        size: usize,
    }

    impl MemoryUsage for Codec {
        fn memory_usage(&self) -> usize {
            self.size
        }
    }

    fn open(account: &Account, size: usize) -> NativeState<Codec> {
        NativeState::new(account, Codec { size }, "test stream")
    }

    /// Grow the state to `size` bytes and return `output`.
    fn grow(size: usize, output: &[u8]) -> impl FnOnce(&mut Codec) -> Result<Vec<u8>, ComprsError> {
        move |codec| {
            codec.size = size;
            Ok(output.to_vec())
        }
    }

    #[test]
    fn reports_the_state_from_creation_until_finish() {
        let account = Account::default();
        let state = open(&account, 100);
        assert_eq!(account.total.get(), 100);

        assert_eq!(state.run(&account, grow(5000, b"out")).unwrap(), b"out");
        assert_eq!(account.total.get(), 5000);

        assert_eq!(state.finish(&account, grow(6000, b"end")).unwrap(), b"end");
        assert_eq!(account.total.get(), 0);
    }

    #[test]
    fn reports_only_changes() {
        let account = Account::default();
        let state = open(&account, 100);
        state.run(&account, grow(100, b"")).unwrap();
        state.run(&account, grow(100, b"")).unwrap();
        assert_eq!(account.adjustments.get(), 1);
    }

    #[test]
    fn reports_the_state_after_a_failed_call() {
        let account = Account::default();
        let state = open(&account, 100);
        let result = state.run(&account, |codec| {
            codec.size = 300;
            Err(ComprsError::Truncated("test"))
        });
        assert!(matches!(result, Err(ComprsError::Truncated("test"))));
        assert_eq!(account.total.get(), 300);
    }

    #[test]
    fn finish_ends_the_stream_when_it_fails() {
        let account = Account::default();
        let state = open(&account, 100);
        let result = state.finish(&account, |_| Err(ComprsError::Truncated("test")));
        assert!(matches!(result, Err(ComprsError::Truncated("test"))));
        assert_eq!(account.total.get(), 0);

        let result = state.run(&account, grow(100, b""));
        assert_eq!(
            result.unwrap_err().to_string(),
            "test stream already finished"
        );
        // Closing a finished stream changes nothing.
        state.close(&account);
        let result = state.finish(&account, grow(100, b""));
        assert_eq!(
            result.unwrap_err().to_string(),
            "test stream already finished"
        );
        assert_eq!(account.total.get(), 0);
    }

    #[test]
    fn close_withdraws_the_state_once() {
        let account = Account::default();
        let state = open(&account, 100);
        state.run(&account, grow(5000, b"")).unwrap();
        state.close(&account);
        assert_eq!(account.total.get(), 0);
        state.close(&account);
        assert_eq!(account.total.get(), 0);
        assert_eq!(account.adjustments.get(), 3);

        let result = state.run(&account, grow(100, b""));
        assert_eq!(
            result.unwrap_err().to_string(),
            "test stream already closed"
        );
        let result = state.finish(&account, grow(100, b""));
        assert_eq!(
            result.unwrap_err().to_string(),
            "test stream already closed"
        );
        assert_eq!(account.total.get(), 0);
    }

    #[test]
    fn a_call_in_flight_makes_other_calls_fail_fast() {
        let account = Account::default();
        let state = open(&account, 100);
        let shared = state.begin_async().unwrap();

        let busy = "test stream is busy: an asynchronous call has not finished";
        assert_eq!(state.begin_async().err().unwrap().to_string(), busy);
        let result = state.run(&account, grow(100, b""));
        assert_eq!(result.unwrap_err().to_string(), busy);
        let result = state.finish(&account, grow(100, b""));
        assert_eq!(result.unwrap_err().to_string(), busy);

        assert_eq!(shared.run_async(false, grow(5000, b"out")).unwrap(), b"out");
        // The memory is reported on the JavaScript thread, when the call
        // settles.
        assert_eq!(account.total.get(), 100);
        shared.settle(&account);
        assert_eq!(account.total.get(), 5000);
        assert_eq!(state.run(&account, grow(5000, b"next")).unwrap(), b"next");
    }

    #[test]
    fn an_async_finish_ends_the_stream() {
        let account = Account::default();
        let state = open(&account, 100);
        let shared = state.begin_async().unwrap();
        let result = shared.run_async(true, |_| Err(ComprsError::Truncated("test")));
        assert!(matches!(result, Err(ComprsError::Truncated("test"))));
        shared.settle(&account);
        assert_eq!(account.total.get(), 0);

        let result = state.run(&account, grow(100, b""));
        assert_eq!(
            result.unwrap_err().to_string(),
            "test stream already finished"
        );
        let shared = state.begin_async().unwrap();
        let result = shared.run_async(false, grow(100, b""));
        assert_eq!(
            result.unwrap_err().to_string(),
            "test stream already finished"
        );
        shared.settle(&account);
        assert_eq!(account.total.get(), 0);
    }

    #[test]
    fn close_waits_for_the_call_in_flight() {
        let account = Account::default();
        let state = open(&account, 100);
        let shared = state.begin_async().unwrap();
        state.close(&account);
        // The call in flight holds the state, which close() leaves alone.
        assert_eq!(account.total.get(), 100);

        // Later calls fail as closed, not as busy.
        let closed = "test stream already closed";
        assert_eq!(state.begin_async().err().unwrap().to_string(), closed);
        let result = state.run(&account, grow(100, b""));
        assert_eq!(result.unwrap_err().to_string(), closed);

        // The call in flight still runs, and drops the state when it settles.
        assert_eq!(shared.run_async(false, grow(5000, b"out")).unwrap(), b"out");
        shared.settle(&account);
        assert_eq!(account.total.get(), 0);
        let result = state.finish(&account, grow(100, b""));
        assert_eq!(result.unwrap_err().to_string(), closed);
    }

    #[test]
    fn close_after_a_settled_call_drops_the_state_at_once() {
        let account = Account::default();
        let state = open(&account, 100);
        let shared = state.begin_async().unwrap();
        shared.run_async(false, grow(5000, b"")).unwrap();
        shared.settle(&account);
        state.close(&account);
        assert_eq!(account.total.get(), 0);
        assert_eq!(
            state.begin_async().err().unwrap().to_string(),
            "test stream already closed"
        );
    }

    #[test]
    fn a_dropped_state_survives_until_the_call_settles() {
        let account = Account::default();
        let state = open(&account, 100);
        let shared = state.begin_async().unwrap();
        // As the finalizer does when V8 collects a context with a call in
        // flight.
        state.close(&account);
        drop(state);
        assert_eq!(shared.run_async(false, grow(300, b"out")).unwrap(), b"out");
        shared.settle(&account);
        assert_eq!(account.total.get(), 0);
    }

    #[test]
    fn an_abandoned_call_clears_the_busy_mark() {
        let account = Account::default();
        let state = open(&account, 100);
        let shared = state.begin_async().unwrap();
        shared.abandon();
        assert_eq!(state.run(&account, grow(100, b"out")).unwrap(), b"out");
    }
}
