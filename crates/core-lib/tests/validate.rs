//! Validation of the numeric arguments that the bindings pass as JavaScript
//! numbers.

mod common;

use common::{BoxedContext, boxed, drive};
use comprs_core::{
    ComprsError, IntArg, MAX_DECOMPRESSED_SIZE, brotli, brotli_stream, crc, gzip, gzip_stream, lz4,
    lz4_stream, validate_capacity, validate_max_output_size, zstd, zstd_stream,
};

/// `Number.MAX_SAFE_INTEGER`, the largest size that the validators accept.
const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;

/// Sizes that the validators reject.
const INVALID_SIZES: [f64; 9] = [
    f64::NAN,
    f64::INFINITY,
    f64::NEG_INFINITY,
    -1.0,
    0.5,
    1.7,
    MAX_SAFE_INTEGER + 1.0,
    // 2^64, which is also `usize::MAX as f64` on 64-bit targets.
    18_446_744_073_709_551_616.0,
    f64::MAX,
];

/// Sizes that the validators accept, with the size they stand for.
fn valid_sizes() -> [(f64, usize); 5] {
    [
        (0.0, 0),
        (-0.0, 0),
        (1.0, 1),
        (4096.0, 4096),
        (
            MAX_SAFE_INTEGER,
            usize::try_from(9_007_199_254_740_991u64).unwrap_or(usize::MAX),
        ),
    ]
}

#[test]
fn size_validators_accept_the_same_numbers() {
    for (value, size) in valid_sizes() {
        assert_eq!(validate_capacity(value).unwrap(), size, "{value}");
        assert_eq!(
            validate_max_output_size(Some(value)).unwrap(),
            size,
            "{value}"
        );
    }
    for value in INVALID_SIZES {
        for (name, result) in [
            ("capacity", validate_capacity(value)),
            ("maxOutputSize", validate_max_output_size(Some(value))),
        ] {
            let Err(err) = result else {
                panic!("{name} {value} was accepted");
            };
            assert!(matches!(err, ComprsError::InvalidArg(_)), "{name} {value}");
            assert_eq!(
                err.to_string(),
                format!("{name} must be an integer between 0 and 9007199254740991")
            );
        }
    }
    assert_eq!(
        validate_max_output_size(None).unwrap(),
        MAX_DECOMPRESSED_SIZE
    );
}

/// A decompression context, created with an output limit.
type NewDecompressor = fn(Option<f64>) -> Result<BoxedContext, ComprsError>;

/// A one-shot encoder of the format that a decompression context reads.
type Encode = fn(&[u8]) -> Result<Vec<u8>, ComprsError>;

const DICT: &[u8] = b"dictionary";

/// Every decompression context, with an encoder of its input.
const DECOMPRESSORS: [(&str, NewDecompressor, Encode); 7] = [
    (
        "gzip",
        |limit| boxed(gzip_stream::GzipDecompressContext::new(limit)),
        |data| gzip::compress(data, None),
    ),
    (
        "deflate",
        |limit| boxed(gzip_stream::DeflateDecompressContext::new(limit)),
        |data| gzip::deflate_compress(data, None),
    ),
    (
        "brotli",
        |limit| boxed(brotli_stream::DecompressContext::new(limit)),
        |data| brotli::compress(data, None),
    ),
    (
        "brotli dict",
        |limit| boxed(brotli_stream::DecompressDictContext::new(DICT, limit)),
        |data| brotli::compress_with_dict(data, DICT, None),
    ),
    (
        "zstd",
        |limit| boxed(zstd_stream::DecompressContext::new(limit)),
        |data| zstd::compress(data, None),
    ),
    (
        "zstd dict",
        |limit| boxed(zstd_stream::DecompressDictContext::new(DICT, limit)),
        |data| zstd::compress_with_dict(data, DICT, None),
    ),
    (
        "lz4",
        |limit| boxed(lz4_stream::DecompressContext::new(limit)),
        lz4::compress,
    ),
];

#[test]
fn decompress_contexts_validate_the_output_limit() {
    for (name, new, _) in DECOMPRESSORS {
        for value in INVALID_SIZES {
            let Err(err) = new(Some(value)) else {
                panic!("{name} accepted a limit of {value}");
            };
            assert_eq!(
                err.to_string(),
                "maxOutputSize must be an integer between 0 and 9007199254740991",
                "{name} {value}"
            );
        }
        for (value, _) in valid_sizes() {
            assert!(new(Some(value)).is_ok(), "{name} {value}");
        }
        assert!(new(None).is_ok(), "{name}");
    }
}

#[test]
fn a_zero_output_limit_accepts_only_empty_streams() {
    for (name, new, encode) in DECOMPRESSORS {
        for limit in [0.0, -0.0] {
            let empty = encode(b"").unwrap();
            let output = drive(&mut *new(Some(limit)).unwrap(), &empty, &[empty.len()]);
            assert_eq!(output.unwrap(), b"", "{name}");

            let one = encode(b"x").unwrap();
            let result = drive(&mut *new(Some(limit)).unwrap(), &one, &[one.len()]);
            assert!(
                matches!(result, Err(ComprsError::SizeLimit { limit: 0, .. })),
                "{name}: {:?}",
                result.map(|output| output.len())
            );
        }
    }
}

/// Check the numbers that `arg` accepts: the integers from its minimum to
/// its maximum, which `min` and `max` give as numbers.
fn check_int_arg<T>(arg: &IntArg<T>, min: f64, max: f64)
where
    T: Copy + PartialOrd + std::fmt::Display + std::fmt::Debug + TryFrom<i64>,
{
    let name = arg.name;
    assert_eq!(arg.check_f64(min).unwrap(), arg.min, "{name}");
    assert_eq!(arg.check_f64(max).unwrap(), arg.max, "{name}");
    if min == 0.0 {
        assert_eq!(arg.check_f64(-0.0).unwrap(), arg.min, "{name}");
    }
    assert_eq!(arg.check_optional_f64(None).unwrap(), None, "{name}");

    let message = format!(
        "{name} must be an integer between {} and {}",
        arg.min, arg.max
    );
    let invalid = [
        min - 1.0,
        max + 1.0,
        min + 0.5,
        max - 0.5,
        f64::NAN,
        f64::INFINITY,
        f64::NEG_INFINITY,
        2f64.powi(53),
        2f64.powi(64),
        -2f64.powi(64),
    ];
    for value in invalid {
        let Err(err) = arg.check_f64(value) else {
            panic!("{name} accepted {value}");
        };
        assert!(matches!(err, ComprsError::InvalidArg(_)), "{name} {value}");
        assert_eq!(err.to_string(), message, "{name} {value}");
        assert!(
            arg.check_optional_f64(Some(value)).is_err(),
            "{name} {value}"
        );
    }
}

#[test]
fn int_args_accept_their_range_only() {
    check_int_arg(&gzip::LEVEL, 0.0, 9.0);
    check_int_arg(&gzip::DEFLATE_LEVEL, 0.0, 9.0);
    check_int_arg(&gzip::MTIME, 0.0, 4_294_967_295.0);
    check_int_arg(&brotli::QUALITY, 0.0, 11.0);
    check_int_arg(&zstd::LEVEL, -131_072.0, 22.0);
    check_int_arg(&zstd::DICT_SIZE, 0.0, 16_777_216.0);
    check_int_arg(&crc::INITIAL_VALUE, 0.0, 4_294_967_295.0);
}
