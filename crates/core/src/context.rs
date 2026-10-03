//! Native state of the stream context classes.

use comprs_core::{ComprsError, MemoryUsage};
use napi::bindgen_prelude::{Env, JsObjectValue, Object, Property, Unknown, ValueType};
use napi_derive::napi;

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

/// Make the stream contexts disposable: alias `[Symbol.dispose]()` to
/// `close()`, so that a `using` declaration closes its context at the end of
/// the scope.
///
/// napi-rs names methods with strings only, so the alias is added to the
/// prototypes once the classes are registered. Runtimes without
/// `Symbol.dispose` go without it.
#[napi(module_exports)]
pub fn init(exports: Object, env: Env) -> napi::Result<()> {
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
pub(crate) struct NativeState<T> {
    state: State<T>,
    /// Name of the stream in errors, such as "zstd stream".
    name: &'static str,
    /// Bytes currently reported.
    reported: i64,
}

enum State<T> {
    Open(T),
    Finished,
    Closed,
}

impl<T: MemoryUsage> NativeState<T> {
    /// Take a newly created codec state and report its memory.
    pub(crate) fn new(memory: &impl ExternalMemory, state: T, name: &'static str) -> Self {
        let mut native = Self {
            state: State::Open(state),
            name,
            reported: 0,
        };
        native.report(memory);
        native
    }

    /// Run `op` on the state and update the memory reported for it.
    pub(crate) fn run(
        &mut self,
        memory: &impl ExternalMemory,
        op: impl FnOnce(&mut T) -> Result<Vec<u8>, ComprsError>,
    ) -> Result<Vec<u8>, ComprsError> {
        let output = op(self.state()?);
        self.report(memory);
        output
    }

    /// Run `op`, which ends the stream, then drop the state, whether `op`
    /// succeeded or not: the codecs cannot continue after either.
    pub(crate) fn finish(
        &mut self,
        memory: &impl ExternalMemory,
        op: impl FnOnce(&mut T) -> Result<Vec<u8>, ComprsError>,
    ) -> Result<Vec<u8>, ComprsError> {
        let output = op(self.state()?);
        self.state = State::Finished;
        self.report(memory);
        output
    }

    /// Drop the state, unless the stream is already finished or closed, and
    /// withdraw its memory from the report.
    pub(crate) fn close(&mut self, memory: &impl ExternalMemory) {
        if let State::Open(_) = self.state {
            self.state = State::Closed;
        }
        self.report(memory);
    }

    fn state(&mut self) -> Result<&mut T, ComprsError> {
        match &mut self.state {
            State::Open(state) => Ok(state),
            State::Finished => Err(ComprsError::StreamFinished(self.name)),
            State::Closed => Err(ComprsError::StreamClosed(self.name)),
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
        let mut state = open(&account, 100);
        assert_eq!(account.total.get(), 100);

        assert_eq!(state.run(&account, grow(5000, b"out")).unwrap(), b"out");
        assert_eq!(account.total.get(), 5000);

        assert_eq!(state.finish(&account, grow(6000, b"end")).unwrap(), b"end");
        assert_eq!(account.total.get(), 0);
    }

    #[test]
    fn reports_only_changes() {
        let account = Account::default();
        let mut state = open(&account, 100);
        state.run(&account, grow(100, b"")).unwrap();
        state.run(&account, grow(100, b"")).unwrap();
        assert_eq!(account.adjustments.get(), 1);
    }

    #[test]
    fn reports_the_state_after_a_failed_call() {
        let account = Account::default();
        let mut state = open(&account, 100);
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
        let mut state = open(&account, 100);
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
        let mut state = open(&account, 100);
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
}
