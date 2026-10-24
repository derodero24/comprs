//! Prepared dictionaries for zstd and brotli.
//!
//! zstd digests a dictionary before it compresses or decompresses the first
//! frame with it, which costs far more than a small message: with a trained
//! 110 KB dictionary, [`crate::zstd::compress_with_dict`] spends most of a
//! call on it (#557). A [`Dictionary`] digests it once, and
//! [`crate::zstd::compress_prepared`] and
//! [`crate::zstd::decompress_prepared`] reuse the result on every call, on
//! any thread. libbrotli hashes a dictionary before its encoder can refer
//! to it, and a brotli [`Dictionary`] keeps that too (#707).
//!
//! A build without zstd or brotli (see the features in Cargo.toml) has the
//! type, but [`Dictionary::new`] rejects the format that it leaves out.

#[cfg(feature = "zstd")]
use std::collections::VecDeque;
use std::fmt;
#[cfg(feature = "zstd")]
use std::ops::Deref;
use std::str::FromStr;
use std::sync::Arc;
#[cfg(feature = "zstd")]
use std::sync::{Mutex, MutexGuard, PoisonError};

#[cfg(feature = "brotli")]
use comprs_brotli::PreparedDictionary;
#[cfg(feature = "zstd")]
use zstd::zstd_safe::{self, CCtx, CDict, DDict};

use crate::ComprsError;
#[cfg(feature = "brotli")]
use crate::brotli::{QUALITY, operation_error};
use crate::error::not_built;
#[cfg(feature = "zstd")]
use crate::zstd::{DEFAULT_LEVEL, LEVEL, effective_level};
#[cfg(feature = "zstd")]
use crate::zstd_stream::zstd_error;

/// The format that a [`Dictionary`] is for.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DictionaryFormat {
    Zstd,
    Brotli,
}

impl DictionaryFormat {
    /// Both formats.
    pub const ALL: [DictionaryFormat; 2] = [DictionaryFormat::Zstd, DictionaryFormat::Brotli];

    /// The name of the format: "zstd" or "brotli".
    pub fn name(self) -> &'static str {
        match self {
            DictionaryFormat::Zstd => "zstd",
            DictionaryFormat::Brotli => "brotli",
        }
    }

    /// Whether this build of comprs includes the format.
    pub fn is_built(self) -> bool {
        match self {
            DictionaryFormat::Zstd => cfg!(feature = "zstd"),
            DictionaryFormat::Brotli => cfg!(feature = "brotli"),
        }
    }
}

/// Parses the names of [`DictionaryFormat::name`], for the bindings, which
/// take the format as a string: any other name, that of a format without
/// dictionaries included, fails with [`ComprsError::InvalidArg`] ("format
/// must be one of zstd, brotli").
impl FromStr for DictionaryFormat {
    type Err = ComprsError;

    fn from_str(name: &str) -> Result<DictionaryFormat, ComprsError> {
        DictionaryFormat::ALL
            .into_iter()
            .find(|format| format.name() == name)
            .ok_or_else(|| {
                ComprsError::InvalidArg(format!(
                    "format must be one of {}",
                    DictionaryFormat::ALL.map(DictionaryFormat::name).join(", ")
                ))
            })
    }
}

/// The most compression levels besides its own that a zstd [`Dictionary`]
/// keeps prepared.
///
/// Each level has a compression dictionary of its own, with a copy of the
/// bytes and match-finder tables sized for the level, so the dictionary
/// keeps only the levels that it prepared last. A level that it dropped is
/// prepared again when it is used next.
#[cfg(feature = "zstd")]
const MAX_EXTRA_LEVELS: usize = 3;

/// A dictionary that is digested once and reused by every call that
/// compresses or decompresses with it.
///
/// A zstd dictionary is prepared when it is created: zstd digests it into a
/// compression dictionary for its level and a decompression dictionary. It
/// prepares other compression levels on first use, and keeps up to 3 of
/// them, dropping the one that it prepared first. A brotli dictionary is
/// prepared for the encoder when it is created, for every quality; the
/// decoder takes the bytes as they are, and shares them.
///
/// The dictionary copies its bytes, so the caller can change or free them
/// afterwards. It can be shared between threads: the prepared dictionaries
/// are only read, and the other levels are kept behind a lock.
pub struct Dictionary {
    format: DictionaryFormat,
    raw: Arc<[u8]>,
    /// The prepared state of a zstd dictionary; `None` for brotli.
    #[cfg(feature = "zstd")]
    zstd: Option<ZstdPrepared>,
    /// The bytes prepared for the brotli encoder, which shares them with
    /// `raw`; `None` for zstd.
    #[cfg(feature = "brotli")]
    brotli: Option<Arc<PreparedDictionary<'static>>>,
}

/// The digested forms of a zstd dictionary.
#[cfg(feature = "zstd")]
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
#[cfg(feature = "zstd")]
type ExtraLevels = VecDeque<(i32, Arc<CDict<'static>>)>;

// The bindings share a dictionary between threads, such as the threads that
// run asynchronous calls. zstd documents its digested dictionaries as
// read-only once created, and zstd-safe marks them Send and Sync, as
// comprs-brotli does its prepared dictionaries.
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
    /// Fails with [`ComprsError::InvalidArg`] for a format that this build
    /// leaves out, an empty `raw`, an invalid `level`, or any `level` for a
    /// brotli dictionary, and with
    /// [`ComprsError::Operation`] if zstd cannot prepare the dictionary: it
    /// is corrupt, such as a trained dictionary cut short inside its entropy
    /// tables, or memory ran out, or if libbrotli runs out of memory
    /// preparing it.
    pub fn new(
        raw: &[u8],
        format: DictionaryFormat,
        level: Option<f64>,
    ) -> Result<Self, ComprsError> {
        if !format.is_built() {
            return Err(not_built(format.name()));
        }
        if raw.is_empty() {
            return Err(ComprsError::InvalidArg(
                "dictionary must not be empty".to_string(),
            ));
        }
        if format == DictionaryFormat::Brotli && level.is_some() {
            return Err(ComprsError::InvalidArg(
                "level applies to zstd dictionaries only".to_string(),
            ));
        }
        let raw: Arc<[u8]> = raw.into();
        Ok(Self {
            format,
            #[cfg(feature = "zstd")]
            zstd: match format {
                DictionaryFormat::Zstd => {
                    let level = LEVEL.check_optional_f64(level)?.unwrap_or(DEFAULT_LEVEL);
                    Some(ZstdPrepared::new(&raw, effective_level(level))?)
                }
                DictionaryFormat::Brotli => None,
            },
            #[cfg(feature = "brotli")]
            brotli: match format {
                // libbrotli prepares a raw dictionary the same way for every
                // quality.
                DictionaryFormat::Brotli => Some(Arc::new(
                    PreparedDictionary::shared(Arc::clone(&raw), QUALITY.max)
                        .map_err(|e| operation_error("brotli dictionary preparation", e))?,
                )),
                DictionaryFormat::Zstd => None,
            },
            raw,
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
        #[cfg(feature = "zstd")]
        return self.zstd.as_ref().map(|zstd| zstd.level);
        #[cfg(not(feature = "zstd"))]
        None
    }

    /// The heap memory that the dictionary holds, so that bindings can
    /// report it to their runtime: the bytes and the prepared dictionaries,
    /// for zstd including those of the other levels that it keeps.
    pub fn memory_usage(&self) -> usize {
        self.raw.len() + self.brotli_memory_usage() + self.zstd_memory_usage()
    }

    /// The heap memory of the prepared brotli dictionary.
    fn brotli_memory_usage(&self) -> usize {
        #[cfg(feature = "brotli")]
        return self
            .brotli
            .as_ref()
            .map_or(0, |prepared| prepared.memory_usage());
        #[cfg(not(feature = "brotli"))]
        0
    }

    /// The heap memory of the prepared zstd dictionaries, including those of
    /// the other levels.
    fn zstd_memory_usage(&self) -> usize {
        #[cfg(feature = "zstd")]
        return self.zstd.as_ref().map_or(0, |zstd| {
            let extra: usize = zstd
                .lock_extra()
                .iter()
                .map(|(_, cdict)| cdict.sizeof())
                .sum();
            zstd.cdict.sizeof() + zstd.ddict.sizeof() + extra
        });
        #[cfg(not(feature = "zstd"))]
        0
    }

    /// The bytes of the dictionary, shared, for a brotli decoder, or
    /// [`ComprsError::InvalidArg`] for a zstd dictionary.
    #[cfg(feature = "brotli")]
    pub(crate) fn brotli_raw(&self) -> Result<Arc<[u8]>, ComprsError> {
        self.brotli_prepared()?;
        Ok(Arc::clone(&self.raw))
    }

    /// The dictionary prepared for the brotli encoder, or
    /// [`ComprsError::InvalidArg`] for a zstd dictionary.
    #[cfg(feature = "brotli")]
    pub(crate) fn brotli_prepared(&self) -> Result<&Arc<PreparedDictionary<'static>>, ComprsError> {
        self.brotli.as_ref().ok_or_else(|| self.wrong_format())
    }

    /// The prepared zstd state, or [`ComprsError::InvalidArg`] for a brotli
    /// dictionary.
    #[cfg(feature = "zstd")]
    fn zstd(&self) -> Result<&ZstdPrepared, ComprsError> {
        self.zstd.as_ref().ok_or_else(|| self.wrong_format())
    }

    /// The error for a function of the other format than the dictionary's.
    fn wrong_format(&self) -> ComprsError {
        ComprsError::InvalidArg(format!("this Dictionary is for {}", self.format.name()))
    }

    /// [`level`](Self::level), or [`ComprsError::InvalidArg`] for a brotli
    /// dictionary.
    #[cfg(feature = "zstd")]
    pub(crate) fn zstd_level(&self) -> Result<i32, ComprsError> {
        self.zstd().map(|zstd| zstd.level)
    }

    /// The compression dictionary for `level`, a checked level other than
    /// 0: the one prepared with the dictionary, or one for another level,
    /// which is prepared if the dictionary does not keep it.
    #[cfg(feature = "zstd")]
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
    #[cfg(feature = "zstd")]
    pub(crate) fn zstd_ddict(&self) -> Result<&DDict<'static>, ComprsError> {
        self.zstd().map(|zstd| &zstd.ddict)
    }

    /// The levels besides its own that the dictionary keeps prepared,
    /// oldest first.
    #[cfg(all(test, feature = "zstd"))]
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

#[cfg(feature = "zstd")]
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
#[cfg(feature = "zstd")]
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
#[cfg(feature = "zstd")]
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
#[cfg(feature = "zstd")]
pub(crate) enum CDictRef<'a> {
    /// The one prepared with the dictionary.
    Prepared(&'a CDict<'static>),
    /// One for another level, which the dictionary may drop while the
    /// caller still uses it.
    Extra(Arc<CDict<'static>>),
}

#[cfg(feature = "zstd")]
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
    fn parses_the_names_of_the_formats() {
        for format in DictionaryFormat::ALL {
            assert_eq!(format.name().parse::<DictionaryFormat>().unwrap(), format);
        }
        for name in ["gzip", "Zstd", "zstd ", ""] {
            match name.parse::<DictionaryFormat>() {
                Err(ComprsError::InvalidArg(message)) => {
                    assert_eq!(message, "format must be one of zstd, brotli");
                }
                other => panic!("{name:?} parsed as {other:?}"),
            }
        }
    }

    #[cfg(feature = "zstd")]
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

    #[cfg(feature = "zstd")]
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

    #[cfg(feature = "brotli")]
    #[test]
    fn a_brotli_dictionary_compresses_as_its_bytes_do() {
        let dict = Dictionary::new(RAW, DictionaryFormat::Brotli, None).unwrap();
        let message = b"a message of the words that the messages share";
        for quality in [None, Some(0), Some(5), Some(11)] {
            assert_eq!(
                crate::brotli::compress_prepared(message, &dict, quality).unwrap(),
                crate::brotli::compress_with_dict(message, RAW, quality).unwrap(),
                "quality {quality:?}"
            );
        }
    }

    // The prepared dictionary does not copy the bytes again, and its tables
    // count.
    #[cfg(all(feature = "zstd", feature = "brotli"))]
    #[test]
    fn a_brotli_dictionary_reports_its_prepared_tables() {
        let dict = Dictionary::new(RAW, DictionaryFormat::Brotli, None).unwrap();
        let prepared = dict.brotli_prepared().unwrap();
        assert!(std::ptr::eq(prepared.bytes(), dict.raw()));
        assert!(prepared.memory_usage() > 0);
        assert_eq!(dict.memory_usage(), RAW.len() + prepared.memory_usage());
        assert!(dict.zstd_ddict().is_err());
    }

    #[cfg(all(feature = "zstd", feature = "brotli"))]
    #[test]
    fn a_zstd_dictionary_is_not_one_for_brotli() {
        let dict = Dictionary::new(RAW, DictionaryFormat::Zstd, None).unwrap();
        for result in [
            crate::brotli::compress_prepared(b"a message", &dict, None).map(drop),
            dict.brotli_raw().map(drop),
        ] {
            match result {
                Err(ComprsError::InvalidArg(message)) => {
                    assert_eq!(message, "this Dictionary is for zstd");
                }
                other => panic!("{other:?}"),
            }
        }
    }

    #[test]
    fn rejects_the_formats_that_the_build_leaves_out() {
        for format in DictionaryFormat::ALL {
            let result = Dictionary::new(RAW, format, None);
            if format.is_built() {
                assert_eq!(result.unwrap().format(), format);
                continue;
            }
            match result {
                Err(ComprsError::InvalidArg(message)) => assert_eq!(
                    message,
                    format!("this build of comprs does not include {}", format.name())
                ),
                other => panic!("{other:?}"),
            }
        }
    }
}
