//! Structured error types for comprs.

use thiserror::Error;

/// Errors produced by comprs compression and decompression operations.
///
/// [`ComprsError::code`] names the category of each error. The categories,
/// listed in [`ERROR_CODES`], are the stable part: variants may be added.
#[derive(Error, Debug)]
#[non_exhaustive]
pub enum ComprsError {
    /// Compression or decompression operation failure other than invalid
    /// input, such as a failed allocation, encoder or dictionary training.
    #[error("{context} failed: {source}")]
    Operation {
        context: &'static str,
        #[source]
        source: Box<dyn std::error::Error + Send + Sync>,
    },

    /// The input is not data that the decoder accepts: it is invalid or
    /// corrupted, has unexpected data after the end of the stream, or uses a
    /// feature that comprs does not decode. A few decoders also report a cut
    /// stream as corrupt, as [`ERROR_CODES`] lists. The message has the same
    /// form as that of [`ComprsError::Operation`].
    #[error("{context} failed: {source}")]
    Corrupt {
        context: &'static str,
        #[source]
        source: Box<dyn std::error::Error + Send + Sync>,
    },

    /// Resource creation failure (e.g. encoder/decoder initialization).
    #[error("failed to create {context}: {source}")]
    Creation {
        context: &'static str,
        #[source]
        source: Box<dyn std::error::Error + Send + Sync>,
    },

    /// Invalid argument.
    #[error("{0}")]
    InvalidArg(String),

    /// Auto-detection could not determine the compression format.
    #[error("{0}")]
    UnknownFormat(String),

    /// Decompressed output exceeded maximum size, or, under a maximum size
    /// of 64 MiB or less, a zstd frame declares a window larger than that
    /// size allows, which the context "zstd frame window" reports (see
    /// [`crate::zstd_stream::DecompressContext::new`]).
    #[error("{context} exceeded maximum size of {limit} bytes")]
    SizeLimit { context: &'static str, limit: usize },

    /// Stream context has already been finalized.
    #[error("{0} already finished")]
    StreamFinished(&'static str),

    /// Stream context has been closed, which released its state.
    #[error("{0} already closed")]
    StreamClosed(&'static str),

    /// A stream context was called while an asynchronous call on it, which
    /// runs on another thread, had not finished. Holds the stream name.
    ///
    /// Only the bindings, which run those calls, raise it. Its code is
    /// `ERR_COMPRS_OPERATION_FAILED`.
    #[error("{0} is busy: an asynchronous call has not finished")]
    StreamBusy(&'static str),

    /// Input ended before the end of the compressed stream, including empty
    /// input. Holds the format name.
    ///
    /// A few decoders report a cut stream as [`ComprsError::Corrupt`]
    /// instead, as [`ERROR_CODES`] lists.
    #[error("{0} stream is truncated: unexpected end of input")]
    Truncated(&'static str),
}

/// The codes that [`ComprsError::code`] returns:
///
/// - `ERR_COMPRS_INVALID_ARG`: an argument is out of range or malformed,
///   such as a compression level, an output limit or a gzip header field.
/// - `ERR_COMPRS_UNKNOWN_FORMAT`: auto-detection could not determine the
///   compression format of the input, which includes empty input and data
///   that it took for brotli but that does not decode as brotli.
/// - `ERR_COMPRS_CORRUPT_DATA`: the input is not data that the decoder
///   accepts: it is invalid or corrupted, has unexpected data after the end
///   of the stream, or uses a feature that comprs does not decode.
/// - `ERR_COMPRS_TRUNCATED`: the input ended before the end of the
///   compressed stream, including empty input given to the decoder of a
///   format. A few decoders report a cut stream as
///   `ERR_COMPRS_CORRUPT_DATA` instead; see below.
/// - `ERR_COMPRS_SIZE_LIMIT`: the output would exceed the output limit, or
///   a zstd frame declares a window larger than an output limit of 64 MiB
///   or less allows.
/// - `ERR_COMPRS_STREAM_FINISHED`: a stream context was used after
///   `finish()`.
/// - `ERR_COMPRS_STREAM_CLOSED`: a stream context was used after `close()`.
/// - `ERR_COMPRS_OPERATION_FAILED`: any other failure, such as a failed
///   allocation or encoder.
///
/// `ERR_COMPRS_STREAM_FINISHED` and `ERR_COMPRS_STREAM_CLOSED` report a
/// misuse of the stream context, not a problem with the data. New codes may
/// be added in minor releases, so callers should expect codes that this
/// list does not hold yet.
///
/// These decoders report input that is cut inside the compressed stream as
/// `ERR_COMPRS_CORRUPT_DATA`, because they cannot tell it from corrupt data
/// or keep the message that they have always given for it:
///
/// - the one-shot gzip functions, such as [`crate::gzip::decompress`], also
///   when [`crate::detect::decompress`] calls them: flate2's
///   `MultiGzDecoder` fails with the same error for input that ends inside a
///   member as for a few bytes of garbage after a member;
/// - [`crate::gzip_stream::GzipDecompressContext`], for input that ends
///   after the header of a member: flate2 reports the missing trailer as a
///   checksum error. Input that ends inside the header is
///   `ERR_COMPRS_TRUNCATED`;
/// - the one-shot brotli functions other than
///   [`crate::brotli::decompress_strict`], including those that take a
///   dictionary, such as [`crate::brotli::decompress`]: they report a cut
///   stream as "Invalid Data".
///
/// Empty input is `ERR_COMPRS_TRUNCATED` for these decoders as well. The
/// decompression contexts of zstd, deflate, brotli and lz4, the one-shot
/// functions of zstd, deflate and lz4, the strict decoders of gzip, zlib and
/// raw deflate ([`crate::gzip::decompress_strict`] and
/// [`crate::gzip_stream::StrictDecompressContext`]) and of brotli
/// ([`crate::brotli::decompress_strict`]), and the unified layer
/// ([`crate::unified`]), which decodes with these, tell a cut stream apart
/// and report it as `ERR_COMPRS_TRUNCATED`, and so do the decoders that
/// later releases add. Only when the unified layer detects the format does
/// it report a cut or corrupt stream that it took for brotli as
/// `ERR_COMPRS_UNKNOWN_FORMAT`, as [`crate::detect::decompress`] does.
pub const ERROR_CODES: [&str; 8] = [
    "ERR_COMPRS_INVALID_ARG",
    "ERR_COMPRS_UNKNOWN_FORMAT",
    "ERR_COMPRS_CORRUPT_DATA",
    "ERR_COMPRS_TRUNCATED",
    "ERR_COMPRS_SIZE_LIMIT",
    "ERR_COMPRS_STREAM_FINISHED",
    "ERR_COMPRS_STREAM_CLOSED",
    "ERR_COMPRS_OPERATION_FAILED",
];

impl ComprsError {
    /// The code of the error's category, one of [`ERROR_CODES`].
    pub fn code(&self) -> &'static str {
        match self {
            ComprsError::InvalidArg(_) => "ERR_COMPRS_INVALID_ARG",
            ComprsError::UnknownFormat(_) => "ERR_COMPRS_UNKNOWN_FORMAT",
            ComprsError::Corrupt { .. } => "ERR_COMPRS_CORRUPT_DATA",
            ComprsError::Truncated(_) => "ERR_COMPRS_TRUNCATED",
            ComprsError::SizeLimit { .. } => "ERR_COMPRS_SIZE_LIMIT",
            ComprsError::StreamFinished(_) => "ERR_COMPRS_STREAM_FINISHED",
            ComprsError::StreamClosed(_) => "ERR_COMPRS_STREAM_CLOSED",
            ComprsError::Operation { .. }
            | ComprsError::Creation { .. }
            | ComprsError::StreamBusy(_) => "ERR_COMPRS_OPERATION_FAILED",
        }
    }

    /// A copy of the error, with the same variant and message, for a stream
    /// context that reports its error again on every call after it failed.
    ///
    /// The error is not `Clone`, because some variants box their source: the
    /// copy's source holds only the message of the original's.
    pub(crate) fn duplicate(&self) -> ComprsError {
        match self {
            ComprsError::Operation { context, source } => ComprsError::Operation {
                context,
                source: source.to_string().into(),
            },
            ComprsError::Corrupt { context, source } => ComprsError::Corrupt {
                context,
                source: source.to_string().into(),
            },
            ComprsError::Creation { context, source } => ComprsError::Creation {
                context,
                source: source.to_string().into(),
            },
            ComprsError::InvalidArg(message) => ComprsError::InvalidArg(message.clone()),
            ComprsError::UnknownFormat(message) => ComprsError::UnknownFormat(message.clone()),
            ComprsError::SizeLimit { context, limit } => ComprsError::SizeLimit {
                context,
                limit: *limit,
            },
            ComprsError::StreamFinished(name) => ComprsError::StreamFinished(name),
            ComprsError::StreamClosed(name) => ComprsError::StreamClosed(name),
            ComprsError::StreamBusy(name) => ComprsError::StreamBusy(name),
            ComprsError::Truncated(name) => ComprsError::Truncated(name),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// An error of every variant, in the order of [`variant_index`].
    /// StreamClosed and StreamBusy are raised only by the bindings, which
    /// close their contexts and run their asynchronous calls.
    fn every_variant() -> [ComprsError; 10] {
        [
            ComprsError::Operation {
                context: "test",
                source: "operation".into(),
            },
            ComprsError::Corrupt {
                context: "test",
                source: "corrupt".into(),
            },
            ComprsError::Creation {
                context: "test",
                source: "creation".into(),
            },
            ComprsError::InvalidArg("invalid".to_string()),
            ComprsError::UnknownFormat("unknown".to_string()),
            ComprsError::SizeLimit {
                context: "test",
                limit: 1,
            },
            ComprsError::StreamFinished("test stream"),
            ComprsError::StreamClosed("test stream"),
            ComprsError::Truncated("test"),
            ComprsError::StreamBusy("test stream"),
        ]
    }

    /// The position of the variant of `error` in [`every_variant`].
    ///
    /// The match has no wildcard, which the crate that defines a
    /// non_exhaustive enum may leave out, so a new variant does not compile
    /// until it gets a position here. Add it to [`every_variant`] at that
    /// position as well.
    fn variant_index(error: &ComprsError) -> usize {
        match error {
            ComprsError::Operation { .. } => 0,
            ComprsError::Corrupt { .. } => 1,
            ComprsError::Creation { .. } => 2,
            ComprsError::InvalidArg(_) => 3,
            ComprsError::UnknownFormat(_) => 4,
            ComprsError::SizeLimit { .. } => 5,
            ComprsError::StreamFinished(_) => 6,
            ComprsError::StreamClosed(_) => 7,
            ComprsError::Truncated(_) => 8,
            ComprsError::StreamBusy(_) => 9,
        }
    }

    #[test]
    fn every_variant_holds_each_variant_once() {
        let indices = every_variant().map(|error| variant_index(&error));
        assert_eq!(indices, std::array::from_fn(|i| i));
    }

    #[test]
    fn every_code_is_listed() {
        for error in every_variant() {
            assert!(ERROR_CODES.contains(&error.code()), "{error:?}");
        }
    }

    #[test]
    fn every_listed_code_is_the_code_of_a_variant() {
        let codes = every_variant().map(|error| error.code());
        for code in ERROR_CODES {
            assert!(codes.contains(&code), "{code}");
        }
    }

    #[test]
    fn listed_codes_are_distinct() {
        for (i, code) in ERROR_CODES.iter().enumerate() {
            assert!(!ERROR_CODES[i + 1..].contains(code), "{code}");
        }
    }

    #[test]
    fn duplicate_keeps_the_variant_and_the_message() {
        for error in every_variant() {
            let copy = error.duplicate();
            assert_eq!(variant_index(&copy), variant_index(&error), "{error:?}");
            assert_eq!(copy.to_string(), error.to_string());
        }
    }

    // Busy is a misuse of a binding's stream context that the unified API,
    // which never overlaps calls, cannot reach, so it has no code of its own.
    #[test]
    fn stream_busy_is_an_operation_failure() {
        let busy = ComprsError::StreamBusy("lz4 stream");
        assert_eq!(busy.code(), "ERR_COMPRS_OPERATION_FAILED");
        assert_eq!(
            busy.to_string(),
            "lz4 stream is busy: an asynchronous call has not finished"
        );
    }

    #[test]
    fn corrupt_has_the_message_of_operation() {
        let corrupt = ComprsError::Corrupt {
            context: "gzip decompress",
            source: "corrupt deflate stream".into(),
        };
        let operation = ComprsError::Operation {
            context: "gzip decompress",
            source: "corrupt deflate stream".into(),
        };
        assert_eq!(corrupt.to_string(), operation.to_string());
        assert_eq!(
            corrupt.to_string(),
            "gzip decompress failed: corrupt deflate stream"
        );
    }
}
