//! The panic hook of the targets that compress with brotli dictionaries.
//!
//! `fuzz_target!` installs libfuzzer-sys's panic hook, which aborts the
//! process at the panic site, before the panic unwinds, so that libFuzzer
//! reports the panic as a crash with the stack where it happened. The hook
//! also aborts on panics that the code under test catches, and comprs-core
//! catches one kind on purpose: brotli 9.0.0's encoder panics on some inputs
//! with a custom dictionary (#623), so comprs-core runs it under
//! `catch_unwind` and compresses again without the dictionary when it panics
//! (#624). [`allow_caught_brotli_encoder_panics`] lets exactly those panics
//! unwind to comprs-core.

use std::panic::{self, Location};

use comprs_core::panic_guard;

/// Source directory of the encoder whose panics comprs-core catches. The
/// version in it ends the exception at the next brotli upgrade: if the new
/// release still panics, the targets fail again, as a reminder to check
/// whether comprs-core's fallback, and this exception, are still needed.
const BROTLI_ENCODER_SOURCE: &str = "brotli-9.0.0/src/enc/";

/// Let the panics of brotli 9.0.0's encoder that comprs-core catches (#623)
/// unwind to its `catch_unwind`, instead of aborting in libfuzzer-sys's
/// panic hook. Every other panic still goes to that hook and aborts at the
/// panic site, including an encoder panic that comprs-core does not catch.
///
/// Call it from the `init:` block of `fuzz_target!`, which runs after
/// libfuzzer-sys installs its hook, in each target that compresses with
/// brotli dictionaries. Remove it together with comprs-core's fallback once
/// a brotli release fixes the encoder.
pub fn allow_caught_brotli_encoder_panics() {
    let abort_hook = panic::take_hook();
    panic::set_hook(Box::new(move |info| match info.location() {
        // A line instead of the default message and backtrace, so that the
        // panics that comprs-core recovers from stay visible in the log.
        Some(location) if is_caught_encoder_panic(location) => eprintln!(
            "Letting comprs-core catch a brotli encoder panic (#623) at {location}: {}",
            info.payload_as_str().unwrap_or_default()
        ),
        _ => abort_hook(info),
    }));
}

/// Whether a panic at `location` happens in brotli 9.0.0's encoder, called
/// from comprs-core's `catch_unwind` around it.
///
/// comprs-core marks the thread while it runs code whose panics it recovers
/// from ([`panic_guard::is_guarded`]). The location narrows that down to the
/// encoder, so that a panic of other code that comprs-core guards still
/// fails the target, and so does one of another brotli release.
fn is_caught_encoder_panic(location: &Location) -> bool {
    location.file().contains(BROTLI_ENCODER_SOURCE) && panic_guard::is_guarded()
}

#[cfg(test)]
mod tests {
    use std::cell::RefCell;
    use std::io::{self, Cursor};
    use std::panic::{self, PanicHookInfo, UnwindSafe};

    use super::*;

    /// Input and dictionary on which brotli 9.0.0's encoder panics at
    /// comprs-core's default quality (#623).
    const INPUT: [u8; 19] = [
        255, 164, 251, 255, 255, 240, 7, 0, 0, 0, 0, 0, 0, 0, 0, 41, 103, 0, 14,
    ];
    const DICT: [u8; 2] = [254, 255];

    thread_local! {
        /// Panics of this thread that the test's panic hook recorded.
        static RECORDED: RefCell<Vec<String>> = const { RefCell::new(Vec::new()) };
    }

    fn record(info: &PanicHookInfo) {
        RECORDED.with_borrow_mut(|recorded| recorded.push(info.to_string()));
    }

    /// The result of `f`, or `None` if it panics, and the panics that the
    /// panic hook recorded meanwhile.
    fn run<T>(f: impl FnOnce() -> T + UnwindSafe) -> (Option<T>, Vec<String>) {
        let result = panic::catch_unwind(f).ok();
        (result, RECORDED.take())
    }

    fn compress_with_dict() -> Vec<u8> {
        comprs_core::brotli::compress_with_dict(&INPUT, &DICT, None)
            .expect("brotli compression with a dictionary succeeds")
    }

    /// Run brotli's encoder with a dictionary as comprs-core does, but
    /// outside its `catch_unwind`.
    fn encode_unguarded() {
        let params = brotli::enc::BrotliEncoderParams {
            quality: comprs_core::brotli::DEFAULT_QUALITY as i32,
            lgwin: comprs_core::brotli::LG_WINDOW_SIZE as i32,
            ..Default::default()
        };
        let mut nop =
            |_: &mut brotli::interface::PredictionModeContextMap<brotli::InputReferenceMut>,
             _: &mut [brotli::interface::StaticCommand],
             _: brotli::InputPair,
             _: &mut brotli::enc::StandardAlloc| {};
        let _ = brotli::BrotliCompressCustomIoCustomDict(
            &mut brotli::IoReaderWrapper(&mut Cursor::new(&INPUT[..])),
            &mut brotli::IoWriterWrapper(&mut Vec::new()),
            &mut [0; comprs_core::brotli::BUFFER_SIZE],
            &mut [0; comprs_core::brotli::BUFFER_SIZE],
            &params,
            brotli::enc::StandardAlloc::default(),
            &mut nop,
            &DICT,
            io::Error::from(io::ErrorKind::UnexpectedEof),
        );
    }

    // A single test, as the panic hook belongs to the whole process.
    #[test]
    fn lets_only_encoder_panics_that_comprs_core_catches_unwind() {
        // Record the panics that the hook lets unwind.
        panic::set_hook(Box::new(|info| {
            if info.location().is_some_and(is_caught_encoder_panic) {
                record(info);
            }
        }));
        let (_, guarded_unwound) = run(compress_with_dict);
        let (unguarded, unguarded_unwound) = run(encode_unguarded);
        let (_, unrelated_unwound) = run(|| panic!("unrelated panic"));

        // Record the panics that the hook passes on to the previous one, which
        // is libfuzzer-sys's in the fuzz targets and aborts.
        panic::set_hook(Box::new(record));
        allow_caught_brotli_encoder_panics();
        let (guarded_with_hook, guarded_aborted) = run(compress_with_dict);
        let (_, unguarded_aborted) = run(encode_unguarded);
        let (_, unrelated_aborted) = run(|| panic!("unrelated panic"));
        drop(panic::take_hook());

        assert!(
            guarded_unwound.len() == 1 && guarded_unwound[0].contains(BROTLI_ENCODER_SOURCE),
            "brotli's encoder no longer panics on the input of #623, or the panic is not let \
             through: if a release fixed the encoder, remove this exception together with \
             comprs-core's fallback; if it still panics, update BROTLI_ENCODER_SOURCE. \
             Panics let through: {guarded_unwound:?}"
        );
        assert!(
            unguarded.is_none(),
            "brotli's encoder panics on the input of #623 outside comprs-core too"
        );
        assert_eq!(unguarded_unwound, Vec::<String>::new());
        assert_eq!(unrelated_unwound, Vec::<String>::new());

        assert_eq!(guarded_aborted, Vec::<String>::new());
        let output = guarded_with_hook.expect("comprs-core catches the encoder panic");
        assert!(
            comprs_core::brotli::decompress_with_dict(&output, &DICT)
                .is_ok_and(|decompressed| decompressed == INPUT)
        );
        assert_eq!(unguarded_aborted.len(), 1, "{unguarded_aborted:?}");
        assert_eq!(unrelated_aborted.len(), 1, "{unrelated_aborted:?}");
    }
}
