//! Prepared dictionaries for zstd and brotli.
//!
//! zstd digests a dictionary before it compresses or decompresses the first
//! frame with it, which costs far more than a small message: with a trained
//! 110 KB dictionary, [`crate::zstd::compress_with_dict`] spends most of a
//! call on it (#557). A [`Dictionary`] digests it once, and
//! [`crate::zstd::compress_prepared`] and
//! [`crate::zstd::decompress_prepared`] reuse the result on every call, on
//! any thread.

use std::collections::VecDeque;
use std::fmt;
use std::ops::Deref;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use zstd::zstd_safe::{self, CCtx, CDict, DDict};

use crate::ComprsError;
use crate::zstd::{DEFAULT_LEVEL, LEVEL, effective_level};
use crate::zstd_stream::zstd_error;

/// The format that a [`Dictionary`] is for.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DictionaryFormat {
    Zstd,
    Brotli,
}

impl DictionaryFormat {
    /// The name of the format: "zstd" or "brotli".
    pub fn name(self) -> &'static str {
        match self {
            DictionaryFormat::Zstd => "zstd",
            DictionaryFormat::Brotli => "brotli",
        }
    }
}

/// The most compression levels besides its own that a zstd [`Dictionary`]
/// keeps prepared.
///
/// Each level has a compression dictionary of its own, with a copy of the
/// bytes and match-finder tables sized for the level, so the dictionary
/// keeps only the levels that it prepared last. A level that it dropped is
/// prepared again when it is used next.
const MAX_EXTRA_LEVELS: usize = 3;

/// A dictionary that is digested once and reused by every call that
/// compresses or decompresses with it.
///
/// A zstd dictionary is prepared when it is created: zstd digests it into a
/// compression dictionary for its level and a decompression dictionary. It
/// prepares other compression levels on first use, and keeps up to 3 of
/// them, dropping the one that it prepared first. A brotli dictionary only
/// holds the bytes, which the brotli functions take as they are
/// ([`raw_for`](Self::raw_for)).
///
/// The dictionary copies its bytes, so the caller can change or free them
/// afterwards. It can be shared between threads: the prepared dictionaries
/// are only read, and the other levels are kept behind a lock.
pub struct Dictionary {
    format: DictionaryFormat,
    raw: Box<[u8]>,
    /// The prepared state of a zstd dictionary; `None` for brotli.
    zstd: Option<ZstdPrepared>,
}

/// The digested forms of a zstd dictionary.
struct ZstdPrepared {
    /// The compression level of `cdict`.
    level: i32,
    cdict: CDict<'static>,
    ddict: DDict<'static>,
    extra: Mutex<ExtraLevels>,
}

/// Compression dictionaries for other levels than that of a
/// [`ZstdPrepared`], with their levels, oldest first. A call may still use
/// one after it has been dropped from here, hence the `Arc`.
type ExtraLevels = VecDeque<(i32, Arc<CDict<'static>>)>;

// The bindings share a dictionary between threads, such as the threads that
// run asynchronous calls. zstd documents its digested dictionaries as
// read-only once created, and zstd-safe marks them Send and Sync.
const _: () = {
    const fn assert_send_sync<T: Send + Sync>() {}
    assert_send_sync::<Dictionary>();
};

impl Dictionary {
    /// Copy `raw` and prepare it as a dictionary for `format`.
    ///
    /// `level` is the zstd compression level to prepare, a JavaScript number
    /// as the bindings pass it, which [`LEVEL`] checks. It defaults to
    /// [`DEFAULT_LEVEL`], which level 0 also selects. Brotli dictionaries
    /// take no level.
    ///
    /// Fails with [`ComprsError::InvalidArg`] for an empty `raw`, an invalid
    /// `level`, or any `level` for a brotli dictionary, and with
    /// [`ComprsError::Operation`] if zstd cannot prepare the dictionary: it
    /// is corrupt, such as a trained dictionary cut short inside its entropy
    /// tables, or memory ran out.
    pub fn new(
        raw: &[u8],
        format: DictionaryFormat,
        level: Option<f64>,
    ) -> Result<Self, ComprsError> {
        if raw.is_empty() {
            return Err(ComprsError::InvalidArg(
                "dictionary must not be empty".to_string(),
            ));
        }
        let zstd = match format {
            DictionaryFormat::Zstd => {
                let level = LEVEL.check_optional_f64(level)?.unwrap_or(DEFAULT_LEVEL);
                Some(ZstdPrepared::new(raw, effective_level(level))?)
            }
            DictionaryFormat::Brotli if level.is_some() => {
                return Err(ComprsError::InvalidArg(
                    "level applies to zstd dictionaries only".to_string(),
                ));
            }
            DictionaryFormat::Brotli => None,
        };
        Ok(Self {
            format,
            raw: raw.into(),
            zstd,
        })
    }

    /// The format that the dictionary is for.
    pub fn format(&self) -> DictionaryFormat {
        self.format
    }

    /// The bytes of the dictionary.
    pub fn raw(&self) -> &[u8] {
        &self.raw
    }

    /// The bytes of the dictionary for a function of `format`, such as the
    /// brotli functions, which take the bytes as they are.
    ///
    /// Fails with [`ComprsError::InvalidArg`] if the dictionary is for the
    /// other format: "this Dictionary is for zstd" for a zstd dictionary
    /// passed to brotli.
    pub fn raw_for(&self, format: DictionaryFormat) -> Result<&[u8], ComprsError> {
        if format != self.format {
            return Err(self.wrong_format());
        }
        Ok(&self.raw)
    }

    /// The compression level that a zstd dictionary was prepared for, which
    /// [`crate::zstd::compress_prepared`] uses when it is given no level;
    /// `None` for brotli.
    pub fn level(&self) -> Option<i32> {
        self.zstd.as_ref().map(|zstd| zstd.level)
    }

    /// The heap memory that the dictionary holds, so that bindings can
    /// report it to their runtime: the bytes and, for zstd, the prepared
    /// dictionaries, including those of the other levels that it keeps.
    pub fn memory_usage(&self) -> usize {
        self.raw.len()
            + self.zstd.as_ref().map_or(0, |zstd| {
                let extra: usize = zstd
                    .lock_extra()
                    .iter()
                    .map(|(_, cdict)| cdict.sizeof())
                    .sum();
                zstd.cdict.sizeof() + zstd.ddict.sizeof() + extra
            })
    }

    /// The prepared zstd state, or [`ComprsError::InvalidArg`] for a brotli
    /// dictionary.
    fn zstd(&self) -> Result<&ZstdPrepared, ComprsError> {
        self.zstd.as_ref().ok_or_else(|| self.wrong_format())
    }

    /// The error for a function of the other format than the dictionary's.
    fn wrong_format(&self) -> ComprsError {
        ComprsError::InvalidArg(format!("this Dictionary is for {}", self.format.name()))
    }

    /// [`level`](Self::level), or [`ComprsError::InvalidArg`] for a brotli
    /// dictionary.
    pub(crate) fn zstd_level(&self) -> Result<i32, ComprsError> {
        self.zstd().map(|zstd| zstd.level)
    }

    /// The compression dictionary for `level`, a checked level other than
    /// 0: the one prepared with the dictionary, or one for another level,
    /// which is prepared if the dictionary does not keep it.
    pub(crate) fn zstd_cdict(&self, level: i32) -> Result<CDictRef<'_>, ComprsError> {
        let zstd = self.zstd()?;
        if level == zstd.level {
            return Ok(CDictRef::Prepared(&zstd.cdict));
        }
        if let Some(cdict) = zstd.find_extra(level) {
            return Ok(CDictRef::Extra(cdict));
        }
        // Preparing a level takes a while, so it happens outside the lock,
        // and other threads keep using the dictionary in the meantime. Two
        // threads may prepare the same level at once; the dictionary keeps
        // the compression dictionary that comes first.
        let cdict = Arc::new(prepare_cdict(&self.raw, level)?);
        let mut extra = zstd.lock_extra();
        if let Some((_, kept)) = extra.iter().find(|(kept, _)| *kept == level) {
            return Ok(CDictRef::Extra(Arc::clone(kept)));
        }
        if extra.len() == MAX_EXTRA_LEVELS {
            extra.pop_front();
        }
        extra.push_back((level, Arc::clone(&cdict)));
        Ok(CDictRef::Extra(cdict))
    }

    /// The decompression dictionary, or [`ComprsError::InvalidArg`] for a
    /// brotli dictionary.
    pub(crate) fn zstd_ddict(&self) -> Result<&DDict<'static>, ComprsError> {
        self.zstd().map(|zstd| &zstd.ddict)
    }

    /// The levels besides its own that the dictionary keeps prepared,
    /// oldest first.
    #[cfg(test)]
    fn extra_levels(&self) -> Vec<i32> {
        let zstd = self.zstd.as_ref().unwrap();
        zstd.lock_extra().iter().map(|&(level, _)| level).collect()
    }
}

impl fmt::Debug for Dictionary {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Dictionary")
            .field("format", &self.format)
            .field("len", &self.raw.len())
            .field("level", &self.level())
            .finish_non_exhaustive()
    }
}

impl ZstdPrepared {
    fn new(raw: &[u8], level: i32) -> Result<Self, ComprsError> {
        let ddict = DDict::try_create(raw).ok_or_else(|| prepare_error(raw, level))?;
        Ok(Self {
            level,
            cdict: prepare_cdict(raw, level)?,
            ddict,
            extra: Mutex::new(VecDeque::with_capacity(MAX_EXTRA_LEVELS)),
        })
    }

    /// The compression dictionary that the dictionary keeps for `level`.
    fn find_extra(&self, level: i32) -> Option<Arc<CDict<'static>>> {
        let extra = self.lock_extra();
        let (_, cdict) = extra.iter().find(|(kept, _)| *kept == level)?;
        Some(Arc::clone(cdict))
    }

    /// Lock the compression dictionaries of the other levels. No code that
    /// holds the lock panics, but a poisoned lock would hold a consistent
    /// list anyway.
    fn lock_extra(&self) -> MutexGuard<'_, ExtraLevels> {
        self.extra.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

/// Digest `raw` into a compression dictionary for `level`.
fn prepare_cdict(raw: &[u8], level: i32) -> Result<CDict<'static>, ComprsError> {
    CDict::try_create(raw, level).ok_or_else(|| prepare_error(raw, level))
}

/// The error for a dictionary that zstd failed to digest for `level`.
///
/// zstd returns no dictionary both for a dictionary that it cannot parse and
/// when memory runs out, and its functions that load a dictionary into a
/// context report either as a failed allocation. Compressing empty input
/// with the dictionary parses it the same way and reports the actual
/// reason, such as "Dictionary is corrupted"; if that succeeds, memory ran
/// out.
fn prepare_error(raw: &[u8], level: i32) -> ComprsError {
    let mut frame = Vec::with_capacity(zstd_safe::compress_bound(0));
    let source = match CCtx::create().compress_using_dict(&mut frame, &[], raw, level) {
        Err(code) => zstd_error(code),
        Ok(_) => "not enough memory".into(),
    };
    ComprsError::Operation {
        context: "zstd dictionary preparation",
        source,
    }
}

/// A compression dictionary of a [`Dictionary`], which
/// [`Dictionary::zstd_cdict`] returns.
pub(crate) enum CDictRef<'a> {
    /// The one prepared with the dictionary.
    Prepared(&'a CDict<'static>),
    /// One for another level, which the dictionary may drop while the
    /// caller still uses it.
    Extra(Arc<CDict<'static>>),
}

impl Deref for CDictRef<'_> {
    type Target = CDict<'static>;

    fn deref(&self) -> &CDict<'static> {
        match self {
            CDictRef::Prepared(cdict) => cdict,
            CDictRef::Extra(cdict) => cdict,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const RAW: &[u8] = b"a dictionary of the words that the messages share, a dictionary";

    #[test]
    fn keeps_the_last_three_other_levels() {
        let dict = Dictionary::new(RAW, DictionaryFormat::Zstd, None).unwrap();
        assert!(dict.extra_levels().is_empty());
        // The prepared level needs no other.
        assert!(matches!(
            dict.zstd_cdict(DEFAULT_LEVEL).unwrap(),
            CDictRef::Prepared(_)
        ));
        assert!(dict.extra_levels().is_empty());

        let prepared = dict.memory_usage();
        for level in [1, 5, 9, 1, 19] {
            assert!(matches!(
                dict.zstd_cdict(level).unwrap(),
                CDictRef::Extra(_)
            ));
        }
        // A level that the dictionary keeps is not prepared again, and the
        // oldest goes first.
        assert_eq!(dict.extra_levels(), [5, 9, 19]);
        let cdict = dict.zstd_cdict(-7).unwrap();
        assert_eq!(dict.extra_levels(), [9, 19, -7]);
        let kept = dict.zstd_cdict(-7).unwrap();
        assert!(std::ptr::eq(&*cdict, &*kept));

        // Only the levels that the dictionary keeps count.
        let extra: usize = [9, 19, -7]
            .map(|level| dict.zstd_cdict(level).unwrap().sizeof())
            .iter()
            .sum();
        assert_eq!(dict.memory_usage(), prepared + extra);
    }

    #[test]
    fn a_dropped_level_stays_usable() {
        let dict = Dictionary::new(RAW, DictionaryFormat::Zstd, Some(1.0)).unwrap();
        let cdict = dict.zstd_cdict(2).unwrap();
        for level in [3, 4, 5] {
            dict.zstd_cdict(level).unwrap();
        }
        assert_eq!(dict.extra_levels(), [3, 4, 5]);
        let mut cctx = CCtx::create();
        let mut frame = Vec::with_capacity(256);
        cctx.compress_using_cdict(&mut frame, b"a message", &cdict)
            .unwrap();
        assert_eq!(
            crate::zstd::decompress_with_dict(&frame, RAW).unwrap(),
            b"a message"
        );
    }
}
