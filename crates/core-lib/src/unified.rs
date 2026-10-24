//! The codec layer of the unified API, `@derodero24/comprs/next`: one
//! function per direction, which takes the format and the options that the
//! format allows, a stream context of each direction, and format detection.
//!
//! Formats go by the names of the Compression Streams standard: `deflate` is
//! the zlib format (RFC 1950) and `deflate-raw` raw deflate (RFC 1951), which
//! the functions of [`crate::gzip`] named after deflate write.
//!
//! The functions call the per-format functions of this crate, so they output
//! the same bytes at the same settings, and decode with the strict decoders:
//! in every format, input cut inside the stream fails with
//! [`ComprsError::Truncated`], and data after the end of the stream with
//! [`ComprsError::Corrupt`]. The per-format functions and stream contexts,
//! [`crate::detect`] and its format enum stay as they are.
//!
//! Every build has this module, also one that leaves out some formats (see
//! the features in Cargo.toml): the functions and contexts fail with
//! [`ComprsError::InvalidArg`] for those formats ("this build of comprs does
//! not include zstd"), before they check the options, and
//! [`Format::is_built`] tells them apart. Detection recognizes the formats
//! with a magic number in every build, and zlib and brotli only in builds
//! with them.

use std::fmt;
use std::str::FromStr;

#[cfg(feature = "gzip")]
use flate2::{Decompress, FlushDecompress, Status};

#[cfg(any(feature = "zstd", feature = "gzip", feature = "brotli"))]
use crate::IntArg;
#[cfg(feature = "brotli")]
use crate::detect::BrotliProbe;
use crate::detect::{self, LZ4_LEGACY_MAGIC, LZ4_MAGIC, SKIPPABLE_MAGIC};
use crate::dictionary::{Dictionary, DictionaryFormat};
use crate::error::not_built;
#[cfg(feature = "gzip")]
use crate::gzip::FlateWrapper;
use crate::{ComprsError, MemoryUsage};
#[cfg(feature = "brotli")]
use crate::{brotli, brotli_stream};
#[cfg(feature = "gzip")]
use crate::{gzip, gzip_stream};
#[cfg(feature = "lz4")]
use crate::{lz4, lz4_stream};
#[cfg(feature = "zstd")]
use crate::{zstd, zstd_stream};

/// A compression format of the unified API.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Format {
    Zstd,
    Gzip,
    /// The zlib format (RFC 1950): deflate data after a 2-byte header,
    /// followed by the Adler-32 checksum of the data.
    Deflate,
    /// Raw deflate (RFC 1951), without a header or a checksum.
    DeflateRaw,
    Brotli,
    Lz4,
}

impl Format {
    /// Every format.
    pub const ALL: [Format; 6] = [
        Format::Zstd,
        Format::Gzip,
        Format::Deflate,
        Format::DeflateRaw,
        Format::Brotli,
        Format::Lz4,
    ];

    /// The format that [`Format::name`] calls `name`, or `None` for any
    /// other name.
    pub fn from_name(name: &str) -> Option<Format> {
        Format::ALL.into_iter().find(|format| format.name() == name)
    }

    /// The name of the format: `zstd`, `gzip`, `deflate`, `deflate-raw`,
    /// `brotli` or `lz4`. The four that the Compression Streams standard has
    /// or proposes keep its names.
    pub fn name(self) -> &'static str {
        match self {
            Format::Zstd => "zstd",
            Format::Gzip => "gzip",
            Format::Deflate => "deflate",
            Format::DeflateRaw => "deflate-raw",
            Format::Brotli => "brotli",
            Format::Lz4 => "lz4",
        }
    }

    /// Whether this build of comprs includes the format.
    pub fn is_built(self) -> bool {
        match self {
            Format::Zstd => cfg!(feature = "zstd"),
            Format::Gzip | Format::Deflate | Format::DeflateRaw => cfg!(feature = "gzip"),
            Format::Brotli => cfg!(feature = "brotli"),
            Format::Lz4 => cfg!(feature = "lz4"),
        }
    }

    /// [`ComprsError::InvalidArg`] for a format that this build leaves out.
    fn check_built(self) -> Result<(), ComprsError> {
        if self.is_built() {
            Ok(())
        } else {
            Err(not_built(self.name()))
        }
    }
}

impl fmt::Display for Format {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.name())
    }
}

/// Parses the names of [`Format::name`], as [`Format::from_name`] does, for
/// the bindings, which take the format as a string: any other name fails
/// with [`ComprsError::InvalidArg`] ("format must be one of zstd, gzip,
/// deflate, deflate-raw, brotli, lz4").
impl FromStr for Format {
    type Err = ComprsError;

    fn from_str(name: &str) -> Result<Format, ComprsError> {
        Format::from_name(name).ok_or_else(|| {
            ComprsError::InvalidArg(format!(
                "format must be one of {}",
                Format::ALL.map(Format::name).join(", ")
            ))
        })
    }
}

impl From<DictionaryFormat> for Format {
    fn from(format: DictionaryFormat) -> Self {
        match format {
            DictionaryFormat::Zstd => Format::Zstd,
            DictionaryFormat::Brotli => Format::Brotli,
        }
    }
}

/// A dictionary for zstd or brotli: its bytes, or a prepared [`Dictionary`].
#[derive(Clone, Copy, Debug)]
pub enum DictionaryRef<'a> {
    /// The bytes of a dictionary. zstd digests them on every call and in
    /// every stream, as [`crate::dictionary`] describes. They must not be
    /// empty.
    Raw(&'a [u8]),
    /// A prepared dictionary, which must be for the format of the call. For
    /// decompression with detection, it sets the format instead.
    Prepared(&'a Dictionary),
}

impl<'a> DictionaryRef<'a> {
    /// The bytes of the dictionary.
    pub fn bytes(self) -> &'a [u8] {
        match self {
            DictionaryRef::Raw(bytes) => bytes,
            DictionaryRef::Prepared(dict) => dict.raw(),
        }
    }
}

/// The options of [`compress`] and [`CompressContext::new`]. Each is for
/// some formats only, and fails with [`ComprsError::InvalidArg`] for the
/// others.
#[derive(Clone, Debug, Default)]
pub struct CompressOptions<'a> {
    /// The compression level, a JavaScript number as the bindings pass it:
    ///
    /// - zstd: a level of [`zstd::LEVEL`], 3 by default, which 0 also
    ///   selects. With a prepared dictionary, the default is the level that
    ///   it was prepared for ([`Dictionary::level`]), while 0 still
    ///   selects 3;
    /// - gzip, deflate and deflate-raw: 0 to 9, 6 by default;
    /// - brotli: 0 to 11, 6 by default.
    ///
    /// lz4 takes no level.
    pub level: Option<f64>,
    /// A dictionary, for zstd and brotli.
    pub dictionary: Option<DictionaryRef<'a>>,
    /// The gzip header, for gzip. Any other format rejects a header, even
    /// one without fields, before its fields are checked.
    pub gzip_header: Option<GzipHeaderOptions>,
    /// The number of worker threads, for zstd: a number of
    /// [`zstd::WORKERS`], 0 by default. Builds without the `zstdmt` feature
    /// accept only 0.
    pub workers: Option<f64>,
}

/// The fields of the gzip header of [`CompressOptions`]: those of
/// [`gzip::GzipHeaderOptions`], with the mtime as a JavaScript number, as
/// the bindings pass it, which [`compress`] checks in the order that it
/// describes.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct GzipHeaderOptions {
    /// The name of the original file. It must not contain NUL characters
    /// and must be at most [`gzip::MAX_FILENAME_LEN`] bytes long.
    pub filename: Option<String>,
    /// The modification time, in seconds since the Unix epoch: an integer
    /// of [`gzip::MTIME`], 0 by default.
    pub mtime: Option<f64>,
}

impl GzipHeaderOptions {
    /// The gzip header of options that a binding takes as positional
    /// arguments: a header if `present`, as the TypeScript layer passes it
    /// for any `gzipHeader` object, even one without fields, or if
    /// `filename` or `mtime` is set, which imply it; `None` otherwise.
    ///
    /// The fields are not checked here: [`compress`] and
    /// [`CompressContext::new`] reject the header for any format but gzip
    /// whatever they hold, and check them for gzip after the other options.
    pub fn from_fields(
        present: bool,
        filename: Option<String>,
        mtime: Option<f64>,
    ) -> Option<GzipHeaderOptions> {
        (present || filename.is_some() || mtime.is_some())
            .then_some(GzipHeaderOptions { filename, mtime })
    }

    /// The header as the per-format functions take it, with its mtime
    /// checked. They check the filename.
    #[cfg(feature = "gzip")]
    fn checked(&self) -> Result<gzip::GzipHeaderOptions, ComprsError> {
        Ok(gzip::GzipHeaderOptions {
            filename: self.filename.clone(),
            mtime: gzip::MTIME.check_optional_f64(self.mtime)?,
        })
    }
}

/// The options of [`decompress`] and [`DecompressContext::new`].
#[derive(Clone, Copy, Debug, Default)]
pub struct DecompressOptions<'a> {
    /// The format of the input, or `None` to detect it as [`detect()`] does.
    /// Detection never picks [`Format::DeflateRaw`], which has no header to
    /// recognize. With a prepared dictionary, `None` selects the format of
    /// the dictionary instead.
    pub format: Option<Format>,
    /// The output limit, [`crate::MAX_DECOMPRESSED_SIZE`] by default, which
    /// [`crate::validate_max_output_size`] checks. For zstd, it also bounds
    /// the window of a frame: under a limit of 64 MiB or less, a frame whose
    /// window is larger than the limit allows fails with
    /// [`ComprsError::SizeLimit`] as well, as
    /// [`zstd_stream::DecompressContext::new`] describes.
    pub max_output_size: Option<f64>,
    /// The dictionary that the input was compressed with, for zstd and
    /// brotli. Raw bytes need a `format`.
    pub dictionary: Option<DictionaryRef<'a>>,
}

/// The levels of the formats other than zstd, which take the levels of
/// their per-format functions under the names of the unified API.
#[cfg(feature = "gzip")]
const GZIP_LEVEL: IntArg<u32> = gzip::LEVEL;
#[cfg(feature = "gzip")]
const DEFLATE_LEVEL: IntArg<u32> = gzip::DEFLATE_LEVEL;
#[cfg(feature = "gzip")]
const DEFLATE_RAW_LEVEL: IntArg<u32> = IntArg {
    name: "deflate-raw compression level",
    ..gzip::LEVEL
};
#[cfg(feature = "brotli")]
const BROTLI_LEVEL: IntArg<u32> = IntArg {
    name: "brotli compression level",
    ..brotli::QUALITY
};

/// The encoder that [`encoder`] chose, with its checked settings.
enum Encoder<'a> {
    #[cfg(feature = "zstd")]
    Zstd {
        level: Option<i32>,
        dictionary: Option<DictionaryRef<'a>>,
        workers: u32,
    },
    #[cfg(feature = "gzip")]
    Gzip {
        level: Option<u32>,
        /// With its mtime checked.
        header: Option<gzip::GzipHeaderOptions>,
    },
    #[cfg(feature = "gzip")]
    Deflate { level: Option<u32> },
    #[cfg(feature = "gzip")]
    DeflateRaw { level: Option<u32> },
    #[cfg(feature = "brotli")]
    Brotli {
        level: Option<u32>,
        dictionary: Option<DictionaryRef<'a>>,
    },
    #[cfg(feature = "lz4")]
    Lz4,
    /// Holds the lifetime of the dictionary, which only zstd and brotli
    /// take, in a build without them. It is never created.
    #[cfg(not(any(feature = "zstd", feature = "brotli")))]
    #[allow(dead_code)]
    Never(std::convert::Infallible, std::marker::PhantomData<&'a ()>),
}

/// Check `options` for compression in `format`, in this order: that the
/// build includes `format`, the dictionary, the gzip header, the workers,
/// the level, then the mtime of the gzip header. The per-format encoder
/// checks the filename of the header last.
fn encoder<'a>(
    format: Format,
    options: &'a CompressOptions<'a>,
) -> Result<Encoder<'a>, ComprsError> {
    format.check_built()?;
    // Only zstd and brotli get past this with a dictionary.
    #[cfg_attr(
        not(any(feature = "zstd", feature = "brotli")),
        allow(unused_variables)
    )]
    let dictionary = options
        .dictionary
        .map(|dictionary| check_dictionary(format, dictionary))
        .transpose()?;
    if options.gzip_header.is_some() && format != Format::Gzip {
        return Err(ComprsError::InvalidArg(
            "gzipHeader applies to gzip compression only".to_string(),
        ));
    }
    #[cfg_attr(not(feature = "zstd"), allow(unused_variables))]
    let workers = match options.workers {
        None => 0,
        #[cfg(feature = "zstd")]
        Some(workers) if format == Format::Zstd => {
            zstd::check_workers(zstd::WORKERS.check_f64(workers)?)?
        }
        Some(_) => {
            return Err(ComprsError::InvalidArg(
                "workers applies to zstd compression only".to_string(),
            ));
        }
    };
    let level = options.level;
    Ok(match format {
        #[cfg(feature = "zstd")]
        Format::Zstd => Encoder::Zstd {
            level: zstd::LEVEL.check_optional_f64(level)?,
            dictionary,
            workers,
        },
        #[cfg(feature = "gzip")]
        Format::Gzip => {
            let level = GZIP_LEVEL.check_optional_f64(level)?;
            // The fields of the header come after the level.
            let header = options
                .gzip_header
                .as_ref()
                .map(GzipHeaderOptions::checked)
                .transpose()?;
            Encoder::Gzip { level, header }
        }
        #[cfg(feature = "gzip")]
        Format::Deflate => Encoder::Deflate {
            level: DEFLATE_LEVEL.check_optional_f64(level)?,
        },
        #[cfg(feature = "gzip")]
        Format::DeflateRaw => Encoder::DeflateRaw {
            level: DEFLATE_RAW_LEVEL.check_optional_f64(level)?,
        },
        #[cfg(feature = "brotli")]
        Format::Brotli => Encoder::Brotli {
            level: BROTLI_LEVEL.check_optional_f64(level)?,
            dictionary,
        },
        #[cfg(feature = "lz4")]
        Format::Lz4 if level.is_some() => {
            return Err(ComprsError::InvalidArg(
                "lz4 does not take a compression level".to_string(),
            ));
        }
        #[cfg(feature = "lz4")]
        Format::Lz4 => Encoder::Lz4,
        #[cfg(not(all_formats))]
        _ => return Err(not_built(format.name())),
    })
}

/// Check that `format` takes `dictionary`: zstd and brotli take a
/// dictionary that is not empty, or a prepared one for the format.
fn check_dictionary(
    format: Format,
    dictionary: DictionaryRef<'_>,
) -> Result<DictionaryRef<'_>, ComprsError> {
    let dictionary_format = match format {
        Format::Zstd => DictionaryFormat::Zstd,
        Format::Brotli => DictionaryFormat::Brotli,
        _ => {
            return Err(ComprsError::InvalidArg(format!(
                "{format} does not support dictionaries"
            )));
        }
    };
    match dictionary {
        // As Dictionary::new rejects it: an empty dictionary is more likely
        // a mistake than a request for none.
        DictionaryRef::Raw([]) => Err(ComprsError::InvalidArg(
            "dictionary must not be empty".to_string(),
        )),
        DictionaryRef::Raw(_) => Ok(dictionary),
        DictionaryRef::Prepared(prepared) => {
            prepared.raw_for(dictionary_format)?;
            Ok(dictionary)
        }
    }
}

/// Compress `data` in `format`.
///
/// The output is that of the per-format function at the same settings:
/// [`zstd::compress_with_workers`], [`zstd::compress_with_dict_and_workers`]
/// or [`zstd::compress_prepared`], [`gzip::compress`] or
/// [`gzip::compress_with_header`], [`gzip::zlib_compress`],
/// [`gzip::deflate_compress`], [`brotli::compress`] or
/// [`brotli::compress_with_dict`], and [`lz4::compress`].
///
/// Fails with [`ComprsError::InvalidArg`] for an option that `format` does
/// not take or an invalid value, as [`CompressOptions`] describes. The
/// options are checked in this order: the dictionary ("gzip does not
/// support dictionaries", "dictionary must not be empty", "this Dictionary
/// is for brotli"), the gzip header, which any format but gzip rejects
/// whatever its fields hold ("gzipHeader applies to gzip compression
/// only"), the workers ("workers applies to zstd compression only", then
/// their number), the level ("deflate-raw compression level must be an
/// integer between 0 and 9", "lz4 does not take a compression level"), then
/// the fields of the gzip header: its mtime ("mtime must be an integer
/// between 0 and 4294967295"), then its filename ("gzip filename must not
/// contain NUL characters").
pub fn compress(
    data: &[u8],
    format: Format,
    options: &CompressOptions,
) -> Result<Vec<u8>, ComprsError> {
    match encoder(format, options)? {
        #[cfg(feature = "zstd")]
        Encoder::Zstd {
            level,
            dictionary: None,
            workers,
        } => zstd::compress_with_workers(data, level, workers),
        #[cfg(feature = "zstd")]
        Encoder::Zstd {
            level,
            dictionary: Some(DictionaryRef::Raw(dict)),
            workers,
        } => zstd::compress_with_dict_and_workers(data, dict, level, workers),
        #[cfg(feature = "zstd")]
        Encoder::Zstd {
            level,
            dictionary: Some(DictionaryRef::Prepared(dict)),
            workers,
        } => zstd::compress_prepared(data, dict, level, workers),
        #[cfg(feature = "gzip")]
        Encoder::Gzip {
            level,
            header: None,
        } => gzip::compress(data, level),
        #[cfg(feature = "gzip")]
        Encoder::Gzip {
            level,
            header: Some(header),
        } => gzip::compress_with_header(data, &header, level),
        #[cfg(feature = "gzip")]
        Encoder::Deflate { level } => gzip::zlib_compress(data, level),
        #[cfg(feature = "gzip")]
        Encoder::DeflateRaw { level } => gzip::deflate_compress(data, level),
        #[cfg(feature = "brotli")]
        Encoder::Brotli {
            level,
            dictionary: None,
        } => brotli::compress(data, level),
        #[cfg(feature = "brotli")]
        Encoder::Brotli {
            level,
            dictionary: Some(DictionaryRef::Raw(dict)),
        } => brotli::compress_with_dict(data, dict, level),
        #[cfg(feature = "brotli")]
        Encoder::Brotli {
            level,
            dictionary: Some(DictionaryRef::Prepared(dict)),
        } => brotli::compress_prepared(data, dict, level),
        #[cfg(feature = "lz4")]
        Encoder::Lz4 => lz4::compress(data),
        #[cfg(not(any(feature = "zstd", feature = "brotli")))]
        Encoder::Never(never, _) => match never {},
    }
}

/// The decoder of a format that [`decoder`] chose, with its checked
/// dictionary.
#[derive(Clone, Copy)]
enum Decoder<'a> {
    #[cfg(feature = "zstd")]
    Zstd(Option<DictionaryRef<'a>>),
    /// gzip, deflate or deflate-raw.
    #[cfg(feature = "gzip")]
    Flate(FlateWrapper),
    #[cfg(feature = "brotli")]
    Brotli(Option<DictionaryRef<'a>>),
    #[cfg(feature = "lz4")]
    Lz4,
    /// As [`Encoder::Never`].
    #[cfg(not(any(feature = "zstd", feature = "brotli")))]
    #[allow(dead_code)]
    Never(std::convert::Infallible, std::marker::PhantomData<&'a ()>),
}

impl Decoder<'_> {
    /// The decoder of `format`, without a dictionary, or
    /// [`ComprsError::InvalidArg`] for a format that this build leaves out.
    fn of(format: Format) -> Result<Self, ComprsError> {
        Ok(match format {
            #[cfg(feature = "zstd")]
            Format::Zstd => Decoder::Zstd(None),
            #[cfg(feature = "gzip")]
            Format::Gzip => Decoder::Flate(FlateWrapper::Gzip),
            #[cfg(feature = "gzip")]
            Format::Deflate => Decoder::Flate(FlateWrapper::Zlib),
            #[cfg(feature = "gzip")]
            Format::DeflateRaw => Decoder::Flate(FlateWrapper::Raw),
            #[cfg(feature = "brotli")]
            Format::Brotli => Decoder::Brotli(None),
            #[cfg(feature = "lz4")]
            Format::Lz4 => Decoder::Lz4,
            #[cfg(not(all_formats))]
            _ => return Err(not_built(format.name())),
        })
    }
}

/// Check the format and the dictionary of `options`, in this order: that
/// the build includes the format, then the dictionary. `None` stands for
/// detection.
fn decoder<'a>(options: &DecompressOptions<'a>) -> Result<Option<Decoder<'a>>, ComprsError> {
    let format = match (options.format, options.dictionary) {
        (Some(format), _) => format,
        (None, None) => return Ok(None),
        (None, Some(DictionaryRef::Raw(_))) => {
            return Err(ComprsError::InvalidArg(
                "pass `format` to decompress with a dictionary".to_string(),
            ));
        }
        (None, Some(DictionaryRef::Prepared(dict))) => dict.format().into(),
    };
    let decoder = Decoder::of(format)?;
    let Some(dictionary) = options.dictionary else {
        return Ok(Some(decoder));
    };
    // Only zstd and brotli get past this.
    #[cfg_attr(
        not(any(feature = "zstd", feature = "brotli")),
        allow(unused_variables)
    )]
    let dictionary = check_dictionary(format, dictionary)?;
    Ok(Some(match decoder {
        #[cfg(feature = "zstd")]
        Decoder::Zstd(_) => Decoder::Zstd(Some(dictionary)),
        #[cfg(feature = "brotli")]
        Decoder::Brotli(_) => Decoder::Brotli(Some(dictionary)),
        // check_dictionary rejected the others. A build with only zstd and
        // brotli has no others.
        #[allow(unreachable_patterns)]
        decoder => decoder,
    }))
}

/// Decompress `data`, in the format of `options` or the one that [`detect()`]
/// finds.
///
/// The decoders are strict, in every format:
///
/// - input that ends before the end of the stream, empty input included,
///   fails with [`ComprsError::Truncated`];
/// - invalid data and data after the end of the stream fail with
///   [`ComprsError::Corrupt`];
/// - output that would exceed the limit fails with
///   [`ComprsError::SizeLimit`], as does, under a limit of 64 MiB or
///   less, a zstd frame whose window is larger than the limit allows (see
///   [`zstd_stream::DecompressContext::new`]).
///
/// The input of zstd and lz4 may hold several frames, and that of gzip
/// several members. The output is the same as that of the per-format
/// functions where they accept the input: [`zstd::decompress_with_capacity`],
/// [`zstd::decompress_with_dict_with_capacity`] or
/// [`zstd::decompress_prepared`], [`gzip::decompress_strict`] for gzip,
/// deflate and deflate-raw, [`brotli::decompress_strict`] and
/// [`lz4::decompress_with_capacity`].
///
/// Without a format or a prepared dictionary, data whose format [`detect()`]
/// does not find, empty input included, fails with
/// [`ComprsError::UnknownFormat`]: "unable to detect the compression
/// format; pass `format`". Brotli has no magic number, so detection only
/// guesses it: data that it takes for brotli but that does not decode as
/// brotli, truncated or corrupt, fails with the same error, as
/// [`crate::detect::decompress`] does.
///
/// Fails with [`ComprsError::InvalidArg`] for a dictionary that the format
/// does not take, as [`compress`] does, for raw dictionary bytes without a
/// format ("pass `format` to decompress with a dictionary"), and then for an
/// invalid `max_output_size`.
pub fn decompress(data: &[u8], options: &DecompressOptions) -> Result<Vec<u8>, ComprsError> {
    let decoder = decoder(options)?;
    let limit = crate::validate_max_output_size(options.max_output_size)?;
    let Some(decoder) = decoder else {
        let format = detect(data).ok_or_else(unknown_format)?;
        return decode(data, Decoder::of(format)?, limit).map_err(|e| detected_error(format, e));
    };
    decode(data, decoder, limit)
}

/// Decompress `data` with `decoder` into at most `limit` bytes.
fn decode(data: &[u8], decoder: Decoder, limit: usize) -> Result<Vec<u8>, ComprsError> {
    match decoder {
        #[cfg(feature = "zstd")]
        Decoder::Zstd(None) => zstd::decompress_with_capacity(data, limit),
        #[cfg(feature = "zstd")]
        Decoder::Zstd(Some(DictionaryRef::Raw(dict))) => {
            zstd::decompress_with_dict_with_capacity(data, dict, limit)
        }
        #[cfg(feature = "zstd")]
        Decoder::Zstd(Some(DictionaryRef::Prepared(dict))) => {
            zstd::decompress_prepared(data, dict, limit)
        }
        #[cfg(feature = "gzip")]
        Decoder::Flate(wrapper) => gzip::decompress_strict(data, wrapper, limit),
        #[cfg(feature = "brotli")]
        Decoder::Brotli(dict) => {
            brotli::decompress_strict(data, dict.map_or(&[], DictionaryRef::bytes), limit)
        }
        #[cfg(feature = "lz4")]
        Decoder::Lz4 => lz4::decompress_with_capacity(data, limit),
        #[cfg(not(any(feature = "zstd", feature = "brotli")))]
        Decoder::Never(never, _) => match never {},
    }
}

/// The error for data whose format detection does not find.
fn unknown_format() -> ComprsError {
    ComprsError::UnknownFormat("unable to detect the compression format; pass `format`".to_string())
}

/// The error to report for `error`, which the decoder of `format` returned
/// for data in the format that detection found: a brotli stream that does
/// not decode is no brotli stream, but data of unknown format, as
/// [`decompress`] describes.
fn detected_error(format: Format, error: ComprsError) -> ComprsError {
    match error {
        ComprsError::Corrupt { .. } | ComprsError::Truncated(_) if format == Format::Brotli => {
            unknown_format()
        }
        error => error,
    }
}

/// The largest dictionary that [`train_dictionary`] may train:
/// [`zstd::DICT_SIZE`] under the name of the unified API, `maxSize`.
#[cfg(feature = "zstd")]
pub const DICTIONARY_SIZE: IntArg<usize> = IntArg {
    name: "maxSize",
    ..zstd::DICT_SIZE
};

/// Train a zstd dictionary of at most `max_size` bytes from `samples`, as
/// [`zstd::train_dictionary`] does. `max_size` is a JavaScript number, as
/// the bindings pass it: an integer of [`DICTIONARY_SIZE`],
/// [`zstd::DEFAULT_MAX_DICT_SIZE`] by default.
///
/// Fails with [`ComprsError::InvalidArg`] for any other `max_size` ("maxSize
/// must be an integer between 0 and 16777216"), and with
/// [`ComprsError::Operation`] when zstd cannot train a dictionary, such as
/// from no samples or too little data. A build without zstd fails with
/// [`ComprsError::InvalidArg`] ("this build of comprs does not include
/// zstd").
pub fn train_dictionary(
    samples: &[Vec<u8>],
    max_size: Option<f64>,
) -> Result<Vec<u8>, ComprsError> {
    #[cfg(feature = "zstd")]
    {
        let max_size = DICTIONARY_SIZE
            .check_optional_f64(max_size)?
            .unwrap_or(zstd::DEFAULT_MAX_DICT_SIZE);
        zstd::train_dictionary(samples, max_size)
    }
    #[cfg(not(feature = "zstd"))]
    {
        let _ = (samples, max_size);
        Err(not_built(Format::Zstd.name()))
    }
}

/// Compress `data` in the format named `format` with [`compress`], with the
/// options as the bindings take them from the TypeScript layer of the
/// unified API: as positional arguments.
///
/// `gzip_header` tells whether the options have a gzip header, which may
/// have no fields; `gzip_filename` and `gzip_mtime` hold its fields and
/// imply it, as [`GzipHeaderOptions::from_fields`] describes. The name of
/// the format is checked first, as [`Format`]'s `FromStr` does ("format
/// must be one of zstd, gzip, deflate, deflate-raw, brotli, lz4"), then the
/// options, in the order that [`compress`] describes.
#[allow(clippy::too_many_arguments)] // The fields of the options.
pub fn compress_fields(
    data: &[u8],
    format: &str,
    level: Option<f64>,
    dictionary: Option<DictionaryRef<'_>>,
    gzip_header: Option<bool>,
    gzip_filename: Option<String>,
    gzip_mtime: Option<f64>,
    workers: Option<f64>,
) -> Result<Vec<u8>, ComprsError> {
    let format: Format = format.parse()?;
    let options = compress_options(
        level,
        dictionary,
        gzip_header,
        gzip_filename,
        gzip_mtime,
        workers,
    );
    compress(data, format, &options)
}

/// The options of [`compress`] from the positional arguments of
/// [`compress_fields`].
fn compress_options(
    level: Option<f64>,
    dictionary: Option<DictionaryRef<'_>>,
    gzip_header: Option<bool>,
    gzip_filename: Option<String>,
    gzip_mtime: Option<f64>,
    workers: Option<f64>,
) -> CompressOptions<'_> {
    CompressOptions {
        level,
        dictionary,
        gzip_header: GzipHeaderOptions::from_fields(
            gzip_header == Some(true),
            gzip_filename,
            gzip_mtime,
        ),
        workers,
    }
}

/// Decompress `data` in the format named `format`, or in the format that
/// detection finds for `None`, with [`decompress`], with the options as the
/// bindings take them, as [`compress_fields`] does. The name of the format
/// is checked first, then the options, in the order that [`decompress`]
/// describes.
pub fn decompress_fields(
    data: &[u8],
    format: Option<&str>,
    max_output_size: Option<f64>,
    dictionary: Option<DictionaryRef<'_>>,
) -> Result<Vec<u8>, ComprsError> {
    let options = decompress_options(format, max_output_size, dictionary)?;
    decompress(data, &options)
}

/// The options of [`decompress`] from the positional arguments of
/// [`decompress_fields`], with the name of the format checked.
fn decompress_options<'a>(
    format: Option<&str>,
    max_output_size: Option<f64>,
    dictionary: Option<DictionaryRef<'a>>,
) -> Result<DecompressOptions<'a>, ComprsError> {
    Ok(DecompressOptions {
        format: format.map(str::parse).transpose()?,
        max_output_size,
        dictionary,
    })
}

/// How much of the input detection decodes to recognize zlib and brotli,
/// and how much input [`AutoDecoder`] holds at most: 64 KiB. A build without
/// gzip and brotli holds as much, since zstd and LZ4 frames can follow
/// skippable frames.
const MAX_PREFIX: usize = detect::BROTLI_PROBE_SIZE;

/// What [`detect_prefix`] found in the start of some data.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Detection {
    /// The data is in this format.
    Known(Format),
    /// More input is needed to tell.
    NeedMore,
    /// The data is in no format that detection recognizes.
    Unknown,
}

/// Detect the format of the data that starts with `data`. `is_final` tells
/// that no more data follows.
///
/// The formats are tried in this order:
///
/// 1. gzip, by its magic number and compression method: `1f 8b 08`;
/// 2. zstd and LZ4 frames, including LZ4 legacy frames, by their magic
///    numbers, after any skippable frames, which only they have;
/// 3. zlib, by a header that names the deflate method with a window of at
///    most 32 KiB and has a valid checksum and no preset dictionary, and
///    then by inflating up to the first 64 KiB into up to 64 KiB of
///    output, which must go without error;
/// 4. brotli, which has no magic number, by decoding up to the first
///    64 KiB as [`crate::detect::detect`] does: they must decode without
///    error and either hold a whole brotli stream that ends where the data
///    ends, decode to more bytes than they hold, or fill the 64 KiB. Unlike
///    [`crate::detect::detect`], which gives up when the first 4 KiB of
///    output that the decoder writes on running out of input do not exceed
///    the input, it takes all the output of the input, so that a compressed
///    brotli stream stays detected as more of it arrives.
///
/// It returns [`Detection::NeedMore`] while more data could change the
/// answer, which only happens without `is_final`:
///
/// - zlib is known once its stream ends, it inflates to 64 KiB, the data
///   fills 64 KiB or `is_final` is set;
/// - brotli is known once the data fills 64 KiB while the stream goes on,
///   or once the decoder has written more bytes than it has read, which
///   detection checks each time the decoder has written 4 KiB and where
///   the data ends. A stream that ends before a check shows this, such as
///   a whole stream that decodes to at most 4 KiB, is only a guess, unlike a
///   whole zlib stream with its checksum, and data after its end rules it
///   out: it is unknown if data follows it, and needs more until
///   `is_final` if it ends where the data ends.
///
/// With `is_final`, it returns [`Detection::Known`] or
/// [`Detection::Unknown`], which [`detect()`] maps to an `Option`.
///
/// It never returns [`Format::DeflateRaw`], which has no header to
/// recognize. A build without gzip skips step 3, and one without brotli
/// step 4: data that the steps of the build do not recognize is unknown.
/// The formats with a magic number are detected in every build, and the
/// decoder then fails for those that the build leaves out, as for a format
/// that is passed.
pub fn detect_prefix(data: &[u8], is_final: bool) -> Detection {
    // 1. gzip.
    if data.starts_with(&[0x1f, 0x8b, 0x08]) {
        return Detection::Known(Format::Gzip);
    }
    if !is_final && [0x1f, 0x8b, 0x08].starts_with(data) {
        return Detection::NeedMore;
    }

    // 2. zstd and LZ4, after any skippable frames.
    let Some(frame) = detect::skip_skippable_frames(data) else {
        // The data ends inside a skippable frame.
        return if is_final {
            Detection::Unknown
        } else {
            Detection::NeedMore
        };
    };
    match frame.first_chunk().map(|magic| u32::from_le_bytes(*magic)) {
        Some(detect::ZSTD_MAGIC) => return Detection::Known(Format::Zstd),
        Some(LZ4_MAGIC | LZ4_LEGACY_MAGIC) => return Detection::Known(Format::Lz4),
        None if !is_final && is_magic_prefix(frame) => return Detection::NeedMore,
        // Only zstd and LZ4 frames follow skippable frames.
        _ if frame.len() < data.len() => return Detection::Unknown,
        _ => {}
    }

    // 3. zlib.
    #[cfg(feature = "gzip")]
    if let Some(detection) = detect_zlib(data, is_final) {
        return detection;
    }

    // 4. brotli.
    #[cfg(not(feature = "brotli"))]
    return Detection::Unknown;
    #[cfg(feature = "brotli")]
    match detect::probe_brotli(data, true) {
        BrotliProbe::Invalid => Detection::Unknown,
        BrotliProbe::Expands => Detection::Known(Format::Brotli),
        // Data after the end of the stream.
        BrotliProbe::Ended(len) if len < data.len() => Detection::Unknown,
        BrotliProbe::Ended(_) if is_final => Detection::Known(Format::Brotli),
        BrotliProbe::NeedsMoreInput if data.len() >= MAX_PREFIX => Detection::Known(Format::Brotli),
        BrotliProbe::NeedsMoreInput if is_final => Detection::Unknown,
        // More data may follow the end of the stream.
        BrotliProbe::Ended(_) | BrotliProbe::NeedsMoreInput => Detection::NeedMore,
    }
}

/// Detect the format of `data`, as [`detect_prefix`] does with no more data
/// to follow: `None` if no format is detected.
pub fn detect(data: &[u8]) -> Option<Format> {
    match detect_prefix(data, true) {
        Detection::Known(format) => Some(format),
        Detection::NeedMore | Detection::Unknown => None,
    }
}

/// Whether `data`, shorter than a magic number, could be the start of the
/// magic number of a zstd frame, an LZ4 frame or a skippable frame.
fn is_magic_prefix(data: &[u8]) -> bool {
    [detect::ZSTD_MAGIC, LZ4_MAGIC, LZ4_LEGACY_MAGIC]
        .into_iter()
        .chain(SKIPPABLE_MAGIC)
        .any(|magic| magic.to_le_bytes().starts_with(data))
}

/// Detect a zlib stream at the start of `data`, as [`detect_prefix`]
/// describes: `None` if the data is no zlib stream.
#[cfg(feature = "gzip")]
fn detect_zlib(data: &[u8], is_final: bool) -> Option<Detection> {
    let need_more = (!is_final).then_some(Detection::NeedMore);
    let Some(&cmf) = data.first() else {
        return need_more;
    };
    // The deflate method, with a window of at most 32 KiB.
    if cmf & 0x0f != 8 || cmf >> 4 > 7 {
        return None;
    }
    let Some(&flg) = data.get(1) else {
        return need_more;
    };
    // The header checksum, and no preset dictionary.
    if (u16::from(cmf) << 8 | u16::from(flg)) % 31 != 0 || flg & 0x20 != 0 {
        return None;
    }
    let prefix = &data[..data.len().min(MAX_PREFIX)];
    match inflate_zlib(prefix)? {
        ZlibPrefix::Ended | ZlibPrefix::Inflated => Some(Detection::Known(Format::Deflate)),
        ZlibPrefix::Incomplete if is_final || prefix.len() == MAX_PREFIX => {
            Some(Detection::Known(Format::Deflate))
        }
        ZlibPrefix::Incomplete => Some(Detection::NeedMore),
    }
}

/// What inflating the start of a zlib stream found, without an error.
#[cfg(feature = "gzip")]
enum ZlibPrefix {
    /// The stream ended, after its checksum.
    Ended,
    /// The stream inflated to [`ZLIB_PROBE_OUTPUT`] bytes, so far without
    /// an error.
    Inflated,
    /// The stream needs more input.
    Incomplete,
}

/// Most output that [`inflate_zlib`] inflates: 64 KiB.
///
/// Data that is not zlib practically never inflates as far without an
/// error: random data after a zlib header fails within 1.5 KiB of output.
/// The bound keeps detection about as cheap as its input, which 64 KiB of
/// zlib data would not be: they can inflate to 64 MiB.
#[cfg(feature = "gzip")]
const ZLIB_PROBE_OUTPUT: usize = 64 * 1024;

/// Inflate `prefix` as the start of a zlib stream into at most
/// [`ZLIB_PROBE_OUTPUT`] bytes, dropping the output: `None` if the decoder
/// fails.
#[cfg(feature = "gzip")]
fn inflate_zlib(prefix: &[u8]) -> Option<ZlibPrefix> {
    let mut inflater = Decompress::new(true);
    let mut output = vec![0; ZLIB_PROBE_OUTPUT];
    let mut input = prefix;
    loop {
        let total_in = inflater.total_in();
        let written = inflater.total_out() as usize;
        let status = inflater
            .decompress(input, &mut output[written..], FlushDecompress::None)
            .ok()?;
        if status == Status::StreamEnd {
            return Some(ZlibPrefix::Ended);
        }
        if inflater.total_out() as usize == output.len() {
            return Some(ZlibPrefix::Inflated);
        }
        let consumed = (inflater.total_in() - total_in) as usize;
        input = &input[consumed..];
        // zlib stops before the input runs out only when the output buffer
        // is full; the check of `consumed` only guards against looping
        // forever.
        if input.is_empty() || consumed == 0 {
            return Some(ZlibPrefix::Incomplete);
        }
    }
}

/// A compression stream in any format, with the stream context of the
/// format.
///
/// Its output is that of the per-format context:
/// [`zstd_stream::CompressContext::with_workers`],
/// [`zstd_stream::CompressDictContext::with_workers`] or
/// [`zstd_stream::CompressDictContext::with_prepared`], which loads the
/// bytes of a prepared dictionary once for the stream,
/// [`gzip_stream::GzipCompressContext`], [`gzip_stream::ZlibCompressContext`],
/// [`gzip_stream::DeflateCompressContext`], [`brotli_stream::CompressContext`]
/// or [`brotli_stream::CompressDictContext`] in its incremental mode, which
/// holds at most the first [`brotli_stream::DICT_REACH`] bytes of input and
/// then streams, and [`lz4_stream::CompressContext`].
pub enum CompressContext {
    #[cfg(feature = "zstd")]
    Zstd(zstd_stream::CompressContext),
    #[cfg(feature = "zstd")]
    ZstdDict(zstd_stream::CompressDictContext),
    #[cfg(feature = "gzip")]
    Gzip(gzip_stream::GzipCompressContext),
    #[cfg(feature = "gzip")]
    Deflate(gzip_stream::ZlibCompressContext),
    #[cfg(feature = "gzip")]
    DeflateRaw(gzip_stream::DeflateCompressContext),
    #[cfg(feature = "brotli")]
    Brotli(Box<brotli_stream::CompressContext>),
    #[cfg(feature = "brotli")]
    BrotliDict(brotli_stream::CompressDictContext),
    #[cfg(feature = "lz4")]
    Lz4(lz4_stream::CompressContext),
}

/// Call `$method` with `$args` on the context of `$context`, a
/// [`CompressContext`].
macro_rules! each_compressor {
    ($context:expr, $method:ident($($args:expr),*)) => {
        match $context {
            #[cfg(feature = "zstd")]
            CompressContext::Zstd(ctx) => ctx.$method($($args),*),
            #[cfg(feature = "zstd")]
            CompressContext::ZstdDict(ctx) => ctx.$method($($args),*),
            #[cfg(feature = "gzip")]
            CompressContext::Gzip(ctx) => ctx.$method($($args),*),
            #[cfg(feature = "gzip")]
            CompressContext::Deflate(ctx) => ctx.$method($($args),*),
            #[cfg(feature = "gzip")]
            CompressContext::DeflateRaw(ctx) => ctx.$method($($args),*),
            #[cfg(feature = "brotli")]
            CompressContext::Brotli(ctx) => ctx.$method($($args),*),
            #[cfg(feature = "brotli")]
            CompressContext::BrotliDict(ctx) => ctx.$method($($args),*),
            #[cfg(feature = "lz4")]
            CompressContext::Lz4(ctx) => ctx.$method($($args),*),
        }
    };
}

impl CompressContext {
    /// Create a compression stream in `format`, with the options and the
    /// checks of [`compress`].
    pub fn new(format: Format, options: &CompressOptions) -> Result<Self, ComprsError> {
        Ok(match encoder(format, options)? {
            #[cfg(feature = "zstd")]
            Encoder::Zstd {
                level,
                dictionary: None,
                workers,
            } => Self::Zstd(zstd_stream::CompressContext::with_workers(level, workers)?),
            #[cfg(feature = "zstd")]
            Encoder::Zstd {
                level,
                dictionary: Some(DictionaryRef::Raw(dict)),
                workers,
            } => Self::ZstdDict(zstd_stream::CompressDictContext::with_workers(
                dict, level, workers,
            )?),
            #[cfg(feature = "zstd")]
            Encoder::Zstd {
                level,
                dictionary: Some(DictionaryRef::Prepared(dict)),
                workers,
            } => Self::ZstdDict(zstd_stream::CompressDictContext::with_prepared(
                dict, level, workers,
            )?),
            #[cfg(feature = "gzip")]
            Encoder::Gzip {
                level,
                header: None,
            } => Self::Gzip(gzip_stream::GzipCompressContext::new(level)?),
            #[cfg(feature = "gzip")]
            Encoder::Gzip {
                level,
                header: Some(header),
            } => Self::Gzip(gzip_stream::GzipCompressContext::with_header(
                level, &header,
            )?),
            #[cfg(feature = "gzip")]
            Encoder::Deflate { level } => {
                Self::Deflate(gzip_stream::ZlibCompressContext::new(level)?)
            }
            #[cfg(feature = "gzip")]
            Encoder::DeflateRaw { level } => {
                Self::DeflateRaw(gzip_stream::DeflateCompressContext::new(level)?)
            }
            #[cfg(feature = "brotli")]
            Encoder::Brotli {
                level,
                dictionary: None,
            } => Self::Brotli(Box::new(brotli_stream::CompressContext::new(level)?)),
            #[cfg(feature = "brotli")]
            Encoder::Brotli {
                level,
                dictionary: Some(DictionaryRef::Raw(dict)),
            } => Self::BrotliDict(brotli_stream::CompressDictContext::incremental(
                dict, level,
            )?),
            #[cfg(feature = "brotli")]
            Encoder::Brotli {
                level,
                dictionary: Some(DictionaryRef::Prepared(dict)),
            } => Self::BrotliDict(brotli_stream::CompressDictContext::incremental_prepared(
                dict, level,
            )?),
            #[cfg(feature = "lz4")]
            Encoder::Lz4 => Self::Lz4(lz4_stream::CompressContext::new()),
            #[cfg(not(any(feature = "zstd", feature = "brotli")))]
            Encoder::Never(never, _) => match never {},
        })
    }

    /// Create a compression stream in the format named `format`, with the
    /// options as the bindings take them, as [`compress_fields`] does: the
    /// name of the format is checked first, then the options, in the order
    /// that [`compress`] describes.
    pub fn from_fields(
        format: &str,
        level: Option<f64>,
        dictionary: Option<DictionaryRef<'_>>,
        gzip_header: Option<bool>,
        gzip_filename: Option<String>,
        gzip_mtime: Option<f64>,
        workers: Option<f64>,
    ) -> Result<Self, ComprsError> {
        let format: Format = format.parse()?;
        let options = compress_options(
            level,
            dictionary,
            gzip_header,
            gzip_filename,
            gzip_mtime,
            workers,
        );
        Self::new(format, &options)
    }

    pub fn transform(&mut self, chunk: &[u8]) -> Result<Vec<u8>, ComprsError> {
        each_compressor!(self, transform(chunk))
    }

    pub fn flush(&mut self) -> Result<Vec<u8>, ComprsError> {
        each_compressor!(self, flush())
    }

    pub fn finish(&mut self) -> Result<Vec<u8>, ComprsError> {
        each_compressor!(self, finish())
    }
}

impl MemoryUsage for CompressContext {
    fn memory_usage(&self) -> usize {
        each_compressor!(self, memory_usage())
    }
}

/// A decompression stream in any format, with the stream context of the
/// format, or one that detects the format.
///
/// The contexts decode as strictly as [`decompress`] does:
/// [`zstd_stream::DecompressContext`] or
/// [`zstd_stream::DecompressDictContext`], which loads the bytes of a
/// prepared dictionary once for the stream,
/// [`gzip_stream::StrictDecompressContext`] for gzip, deflate and
/// deflate-raw, [`brotli_stream::DecompressContext`] or
/// [`brotli_stream::DecompressDictContext`], [`lz4_stream::DecompressContext`]
/// in its incremental mode, which decodes each block as it arrives, and
/// [`AutoDecoder`].
// A build with gzip and none of zstd, brotli and lz4 has only the deflate
// context besides the small AutoDecoder, which a stream holds only until it
// detects the format.
#[cfg_attr(not(all_formats), allow(clippy::large_enum_variant))]
pub enum DecompressContext {
    #[cfg(feature = "zstd")]
    Zstd(zstd_stream::DecompressContext),
    #[cfg(feature = "zstd")]
    ZstdDict(zstd_stream::DecompressDictContext),
    /// gzip, deflate or deflate-raw.
    #[cfg(feature = "gzip")]
    Flate(gzip_stream::StrictDecompressContext),
    #[cfg(feature = "brotli")]
    Brotli(brotli_stream::DecompressContext),
    #[cfg(feature = "brotli")]
    BrotliDict(brotli_stream::DecompressDictContext),
    #[cfg(feature = "lz4")]
    Lz4(lz4_stream::DecompressContext),
    Auto(AutoDecoder),
}

/// Call `$method` with `$args` on the context of `$context`, a
/// [`DecompressContext`].
macro_rules! each_decompressor {
    ($context:expr, $method:ident($($args:expr),*)) => {
        match $context {
            #[cfg(feature = "zstd")]
            DecompressContext::Zstd(ctx) => ctx.$method($($args),*),
            #[cfg(feature = "zstd")]
            DecompressContext::ZstdDict(ctx) => ctx.$method($($args),*),
            #[cfg(feature = "gzip")]
            DecompressContext::Flate(ctx) => ctx.$method($($args),*),
            #[cfg(feature = "brotli")]
            DecompressContext::Brotli(ctx) => ctx.$method($($args),*),
            #[cfg(feature = "brotli")]
            DecompressContext::BrotliDict(ctx) => ctx.$method($($args),*),
            #[cfg(feature = "lz4")]
            DecompressContext::Lz4(ctx) => ctx.$method($($args),*),
            DecompressContext::Auto(ctx) => ctx.$method($($args),*),
        }
    };
}

impl DecompressContext {
    /// Create a decompression stream with the options and the checks of
    /// [`decompress`].
    pub fn new(options: &DecompressOptions) -> Result<Self, ComprsError> {
        let decoder = decoder(options)?;
        let max_output_size = options.max_output_size;
        crate::validate_max_output_size(max_output_size)?;
        let Some(decoder) = decoder else {
            return Ok(Self::Auto(AutoDecoder {
                state: AutoState::Detecting {
                    held: Vec::new(),
                    tried: 0,
                    flush_budget: FLUSH_TRY_BUDGET,
                },
                max_output_size,
            }));
        };
        Self::with_decoder(decoder, max_output_size)
    }

    /// Create a decompression stream in the format named `format`, or one
    /// that detects the format for `None`, with the options as the bindings
    /// take them, as [`decompress_fields`] does: the name of the format is
    /// checked first, then the options, in the order that [`decompress`]
    /// describes.
    pub fn from_fields(
        format: Option<&str>,
        max_output_size: Option<f64>,
        dictionary: Option<DictionaryRef<'_>>,
    ) -> Result<Self, ComprsError> {
        Self::new(&decompress_options(format, max_output_size, dictionary)?)
    }

    /// Create the context of `decoder`, with a checked `max_output_size`.
    fn with_decoder(decoder: Decoder, max_output_size: Option<f64>) -> Result<Self, ComprsError> {
        Ok(match decoder {
            #[cfg(feature = "zstd")]
            Decoder::Zstd(None) => {
                Self::Zstd(zstd_stream::DecompressContext::new(max_output_size)?)
            }
            #[cfg(feature = "zstd")]
            Decoder::Zstd(Some(DictionaryRef::Raw(dict))) => Self::ZstdDict(
                zstd_stream::DecompressDictContext::new(dict, max_output_size)?,
            ),
            #[cfg(feature = "zstd")]
            Decoder::Zstd(Some(DictionaryRef::Prepared(dict))) => Self::ZstdDict(
                zstd_stream::DecompressDictContext::with_prepared(dict, max_output_size)?,
            ),
            #[cfg(feature = "gzip")]
            Decoder::Flate(wrapper) => Self::Flate(gzip_stream::StrictDecompressContext::new(
                wrapper,
                max_output_size,
            )?),
            #[cfg(feature = "brotli")]
            Decoder::Brotli(None) => {
                Self::Brotli(brotli_stream::DecompressContext::new(max_output_size)?)
            }
            #[cfg(feature = "brotli")]
            Decoder::Brotli(Some(DictionaryRef::Raw(dict))) => Self::BrotliDict(
                brotli_stream::DecompressDictContext::new(dict, max_output_size)?,
            ),
            #[cfg(feature = "brotli")]
            Decoder::Brotli(Some(DictionaryRef::Prepared(dict))) => Self::BrotliDict(
                brotli_stream::DecompressDictContext::with_prepared(dict, max_output_size)?,
            ),
            #[cfg(feature = "lz4")]
            Decoder::Lz4 => Self::Lz4(lz4_stream::DecompressContext::incremental(max_output_size)?),
            #[cfg(not(any(feature = "zstd", feature = "brotli")))]
            Decoder::Never(never, _) => match never {},
        })
    }

    pub fn transform(&mut self, chunk: &[u8]) -> Result<Vec<u8>, ComprsError> {
        each_decompressor!(self, transform(chunk))
    }

    pub fn flush(&mut self) -> Result<Vec<u8>, ComprsError> {
        each_decompressor!(self, flush())
    }

    pub fn finish(&mut self) -> Result<Vec<u8>, ComprsError> {
        each_decompressor!(self, finish())
    }
}

impl MemoryUsage for DecompressContext {
    fn memory_usage(&self) -> usize {
        each_decompressor!(self, memory_usage())
    }
}

// The bindings move stream contexts between threads, such as the threads
// that run asynchronous calls.
const _: () = {
    const fn assert_send<T: Send>() {}
    assert_send::<CompressContext>();
    assert_send::<DecompressContext>();
};

/// How much input [`AutoDecoder`] holds before it first runs detection.
const FIRST_TRY: usize = 4;

/// How much input the detection that [`AutoDecoder::flush`] runs decodes in
/// all, at most: 256 KiB.
const FLUSH_TRY_BUDGET: usize = 4 * MAX_PREFIX;

/// What [`ComprsError::StreamFinished`] calls a finished [`AutoDecoder`].
const AUTO_STREAM: &str = "auto stream";

/// A decompression stream that detects the format of its input, as
/// [`decompress`] does without a format.
///
/// It holds the input until [`detect_prefix`] decides: once it holds
/// 4 bytes, then each time the input that it holds doubles, up to 64 KiB,
/// where it decides as if the input ended there. `flush` tries as well when
/// the input held has grown since the last try, and `finish` decides with
/// the input as final. Each try decodes the input held again, so the tries
/// of `flush` stop once they have decoded 256 KiB in all: detection then
/// decodes less than 512 KiB, however the input is split and however often
/// `flush` is called.
///
/// Once the format is known, the stream creates the decompression context
/// of the format, passes it the input that it held and then every call,
/// and returns its output. Until then, `transform` and `flush` return no
/// output, and some data is known late or not at all:
///
/// - a zlib stream that does not inflate to 64 KiB is known once a try
///   sees the end of the stream, after 64 KiB of input or on `finish`;
/// - a brotli stream is known once a try sees it decode to more bytes than
///   it holds, as [`detect_prefix`] describes, and otherwise after 64 KiB
///   of input or on `finish`. So a stream whose data does not compress is
///   known late, and one that ends before a try sees it decode to more than
///   it holds, such as a whole stream that decodes to at most 4 KiB, only
///   on `finish`, since data may still follow it, which would make it no
///   brotli stream;
/// - zstd and LZ4 frames whose magic number, after skippable frames, does
///   not fit in the first 64 KiB are not detected at all: [`decompress`]
///   finds them, but the stream fails once it holds 64 KiB.
///
/// When detection fails, the call fails with [`ComprsError::UnknownFormat`],
/// as does every later call until `finish` ends the stream. Errors of a
/// stream that it took for brotli are reported as [`decompress`] reports
/// them.
pub struct AutoDecoder {
    state: AutoState,
    /// The checked output limit of the context to create.
    max_output_size: Option<f64>,
}

/// The state of an [`AutoDecoder`].
enum AutoState {
    /// Detection has not decided on the input held. It last ran on the
    /// first `tried` bytes, none before it first runs, and the tries of
    /// `flush` may still decode `flush_budget` bytes.
    Detecting {
        held: Vec<u8>,
        tried: usize,
        flush_budget: usize,
    },
    /// The context of the detected format.
    Decoding {
        format: Format,
        inner: Box<DecompressContext>,
    },
    /// Detection failed with this error, which the later calls report
    /// again.
    Failed(ComprsError),
    /// `finish` was called.
    Finished,
}

impl AutoDecoder {
    pub fn transform(&mut self, chunk: &[u8]) -> Result<Vec<u8>, ComprsError> {
        let (held, tried) = match &mut self.state {
            AutoState::Detecting { held, tried, .. } => (held, tried),
            AutoState::Decoding { format, inner } => {
                let format = *format;
                return inner
                    .transform(chunk)
                    .map_err(|e| detected_error(format, e));
            }
            AutoState::Failed(error) => return Err(error.duplicate()),
            AutoState::Finished => return Err(ComprsError::StreamFinished(AUTO_STREAM)),
        };
        let mut rest = chunk;
        loop {
            // Detection runs again once the input held is twice as long as
            // when it last ran, here or in flush.
            let next_try = (2 * *tried).clamp(FIRST_TRY, MAX_PREFIX);
            let take = (next_try - held.len()).min(rest.len());
            // Room for every byte up to the next try at once, so that small
            // chunks do not reallocate the buffer for each byte.
            held.reserve_exact(next_try - held.len());
            held.extend_from_slice(&rest[..take]);
            rest = &rest[take..];
            if held.len() < next_try {
                return Ok(Vec::new());
            }
            *tried = next_try;
            // At the limit, detection decides as if the input ended there.
            match detect_prefix(held, next_try == MAX_PREFIX) {
                Detection::NeedMore => {}
                detection => {
                    let held = std::mem::take(held);
                    let mut output = self.decide(detection, &held)?;
                    if !rest.is_empty() {
                        output.extend(self.transform(rest)?);
                    }
                    return Ok(output);
                }
            }
        }
    }

    pub fn flush(&mut self) -> Result<Vec<u8>, ComprsError> {
        let (held, tried, flush_budget) = match &mut self.state {
            AutoState::Detecting {
                held,
                tried,
                flush_budget,
            } => (held, tried, flush_budget),
            AutoState::Decoding { format, inner } => {
                let format = *format;
                return inner.flush().map_err(|e| detected_error(format, e));
            }
            AutoState::Failed(error) => return Err(error.duplicate()),
            AutoState::Finished => return Err(ComprsError::StreamFinished(AUTO_STREAM)),
        };
        // Calls that alternate small chunks and flushes would otherwise
        // decode the input held again for each byte.
        if held.len() <= *tried || held.len() > *flush_budget {
            return Ok(Vec::new());
        }
        *tried = held.len();
        *flush_budget -= held.len();
        match detect_prefix(held, false) {
            Detection::NeedMore => Ok(Vec::new()),
            detection => {
                let held = std::mem::take(held);
                let mut output = self.decide(detection, &held)?;
                output.extend(self.flush()?);
                Ok(output)
            }
        }
    }

    /// Finalize the decompression stream, returning any remaining output.
    ///
    /// Before the format is known, it detects the format of the input held
    /// as final input: empty input fails with [`ComprsError::UnknownFormat`].
    /// It ends the stream, whether it succeeds or not.
    pub fn finish(&mut self) -> Result<Vec<u8>, ComprsError> {
        match std::mem::replace(&mut self.state, AutoState::Finished) {
            AutoState::Detecting { held, .. } => {
                let result =
                    self.decide(detect_prefix(&held, true), &held)
                        .and_then(|mut output| {
                            output.extend(self.finish()?);
                            Ok(output)
                        });
                self.state = AutoState::Finished;
                result
            }
            AutoState::Decoding { format, mut inner } => {
                inner.finish().map_err(|e| detected_error(format, e))
            }
            AutoState::Failed(error) => Err(error),
            AutoState::Finished => Err(ComprsError::StreamFinished(AUTO_STREAM)),
        }
    }

    /// Act on the `detection` of the input `held`: create the context of the
    /// format and pass it `held`, returning its output, or fail with
    /// [`ComprsError::UnknownFormat`], which the later calls report again.
    fn decide(&mut self, detection: Detection, held: &[u8]) -> Result<Vec<u8>, ComprsError> {
        let Detection::Known(format) = detection else {
            return Err(self.fail(unknown_format()));
        };
        let inner = match Decoder::of(format)
            .and_then(|decoder| DecompressContext::with_decoder(decoder, self.max_output_size))
        {
            Ok(inner) => inner,
            Err(error) => return Err(self.fail(error)),
        };
        self.state = AutoState::Decoding {
            format,
            inner: Box::new(inner),
        };
        self.transform(held)
    }

    /// Fail with `error`, which the later calls report again.
    fn fail(&mut self, error: ComprsError) -> ComprsError {
        self.state = AutoState::Failed(error.duplicate());
        error
    }
}

impl MemoryUsage for AutoDecoder {
    /// The input held, or the memory of the context of the detected format.
    fn memory_usage(&self) -> usize {
        match &self.state {
            AutoState::Detecting { held, .. } => held.capacity(),
            AutoState::Decoding { inner, .. } => inner.memory_usage(),
            AutoState::Failed(_) | AutoState::Finished => 0,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(feature = "gzip")]
    #[test]
    fn auto_decoder_bounds_the_input_that_detection_decodes() {
        // Stored blocks, which detection takes for zlib only at 64 KiB, fed
        // a byte at a time with a flush after each byte.
        let data = gzip::zlib_compress(&[0; MAX_PREFIX], Some(0)).unwrap();
        let DecompressContext::Auto(mut ctx) =
            DecompressContext::new(&DecompressOptions::default()).unwrap()
        else {
            panic!("no auto decoder");
        };
        let mut decoded = 0;
        let mut last_try = 0;
        for byte in &data[..MAX_PREFIX - 1] {
            assert!(ctx.transform(&[*byte]).unwrap().is_empty());
            assert!(ctx.flush().unwrap().is_empty());
            let AutoState::Detecting { tried, .. } = ctx.state else {
                panic!("detection decided before 64 KiB");
            };
            // Each try decodes the first `tried` bytes.
            if tried != last_try {
                decoded += tried;
                last_try = tried;
            }
            assert!(decoded < 512 * 1024, "{decoded} bytes decoded");
        }
        // The flushes tried until they had decoded 256 KiB.
        assert!(decoded > FLUSH_TRY_BUDGET, "{decoded} bytes decoded");
        let mut output = ctx.transform(&data[MAX_PREFIX - 1..]).unwrap();
        output.extend(ctx.finish().unwrap());
        assert!(output == [0; MAX_PREFIX]);
    }

    #[test]
    fn rejects_the_formats_that_the_build_leaves_out() {
        let not_built =
            |format: Format| format!("this build of comprs does not include {}", format.name());
        for format in Format::ALL {
            let compressed = compress(b"data", format, &CompressOptions::default());
            let context = CompressContext::new(format, &CompressOptions::default());
            let options = DecompressOptions {
                format: Some(format),
                ..DecompressOptions::default()
            };
            if format.is_built() {
                let compressed = compressed.unwrap();
                assert!(context.is_ok(), "{format}");
                assert_eq!(decompress(&compressed, &options).unwrap(), b"data");
                continue;
            }
            for error in [
                compressed.err(),
                context.err(),
                decompress(b"data", &options).err(),
                DecompressContext::new(&options).err(),
            ] {
                match error {
                    Some(ComprsError::InvalidArg(message)) => {
                        assert_eq!(message, not_built(format), "{format}");
                    }
                    other => panic!("{format}: {other:?}"),
                }
            }
        }
    }

    // The format is checked before the options that it does not take.
    #[cfg(not(all_formats))]
    #[test]
    fn rejects_a_format_left_out_before_its_options() {
        let format = Format::ALL
            .into_iter()
            .find(|format| !format.is_built())
            .unwrap();
        let options = CompressOptions {
            level: Some(-1000.0),
            workers: Some(1.0),
            ..CompressOptions::default()
        };
        match compress(b"data", format, &options) {
            Err(ComprsError::InvalidArg(message)) => assert_eq!(
                message,
                format!("this build of comprs does not include {}", format.name())
            ),
            other => panic!("{other:?}"),
        }
    }
}
