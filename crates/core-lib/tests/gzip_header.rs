//! gzip header metadata: `gzip::compress_with_header` and
//! `gzip::read_header`.

mod common;

use common::text;
use comprs_core::{ComprsError, crc, gzip, zstd};

/// The OS byte that comprs writes: 255, "unknown", so that the output does
/// not depend on the platform.
const OS_UNKNOWN: u8 = 255;

/// FLG bits of a gzip header (RFC 1952, section 2.3.1).
const FEXTRA: u8 = 0x04;
const FNAME: u8 = 0x08;
const FCOMMENT: u8 = 0x10;

/// The fields of a gzip header that another encoder may write.
struct Fields<'a> {
    mtime: u32,
    os: u8,
    extra: &'a [u8],
    filename: &'a [u8],
    comment: &'a [u8],
}

/// A gzip member of `data` whose header holds `fields`, built byte by byte
/// rather than with comprs' encoder, which writes no comment or extra field.
fn member(fields: &Fields, data: &[u8]) -> Vec<u8> {
    let mut member = vec![0x1f, 0x8b, 8, FEXTRA | FNAME | FCOMMENT];
    member.extend(fields.mtime.to_le_bytes());
    // XFL 2: the encoder used its slowest, strongest setting.
    member.extend([2, fields.os]);
    member.extend(u16::try_from(fields.extra.len()).unwrap().to_le_bytes());
    member.extend(fields.extra);
    for field in [fields.filename, fields.comment] {
        member.extend(field);
        member.push(0);
    }
    member.extend(gzip::deflate_compress(data, Some(9)).unwrap());
    member.extend(crc::crc32(data, None).to_le_bytes());
    member.extend(u32::try_from(data.len()).unwrap().to_le_bytes());
    member
}

/// An extra field with one subfield, "AP" with 4 bytes of data.
const EXTRA: &[u8] = b"AP\x04\x00data";

#[test]
fn compress_with_header_round_trips_through_read_header() {
    let data = text(10_000);
    let cases = [
        (Some("data.txt"), Some(1_700_000_000)),
        (Some("données/ファイル.txt"), Some(u32::MAX)),
        (Some(""), Some(0)),
        (None, Some(1)),
        (Some("name only"), None),
        (None, None),
    ];
    for (filename, mtime) in cases {
        let options = gzip::GzipHeaderOptions {
            filename: filename.map(str::to_string),
            mtime,
        };
        let compressed = gzip::compress_with_header(&data, &options, None).unwrap();
        let header = gzip::read_header(&compressed).unwrap();
        let case = format!("{filename:?}, {mtime:?}");
        assert_eq!(header.filename.as_deref(), filename, "{case}");
        assert_eq!(header.mtime, mtime.unwrap_or(0), "{case}");
        assert_eq!(header.os, OS_UNKNOWN, "{case}");
        assert_eq!(header.comment, None, "{case}");
        assert_eq!(header.extra, None, "{case}");
        assert!(gzip::decompress(&compressed).unwrap() == data, "{case}");
    }

    let header = gzip::read_header(&gzip::compress(&data, None).unwrap()).unwrap();
    assert_eq!(header.filename, None);
    assert_eq!(header.mtime, 0);
    assert_eq!(header.os, OS_UNKNOWN);
}

#[test]
fn read_header_reports_every_field() {
    let data = text(1000);
    let fields = Fields {
        mtime: 1_234_567_890,
        os: 3,
        extra: EXTRA,
        filename: b"archive.tar",
        comment: b"written by another encoder",
    };
    let compressed = member(&fields, &data);
    let header = gzip::read_header(&compressed).unwrap();
    assert_eq!(header.filename.as_deref(), Some("archive.tar"));
    assert_eq!(
        header.comment.as_deref(),
        Some("written by another encoder")
    );
    assert_eq!(header.extra.as_deref(), Some(EXTRA));
    assert_eq!(header.mtime, 1_234_567_890);
    assert_eq!(header.os, 3);
    assert!(gzip::decompress(&compressed).unwrap() == data);
}

#[test]
fn read_header_replaces_invalid_utf8() {
    // RFC 1952 names and comments are ISO 8859-1; bytes that are not UTF-8
    // become U+FFFD.
    let fields = Fields {
        mtime: 0,
        os: 0,
        extra: b"",
        filename: b"caf\xe9.txt",
        comment: b"\xff",
    };
    let header = gzip::read_header(&member(&fields, b"data")).unwrap();
    assert_eq!(header.filename.as_deref(), Some("caf\u{fffd}.txt"));
    assert_eq!(header.comment.as_deref(), Some("\u{fffd}"));
    assert_eq!(header.extra.as_deref(), Some(&b""[..]));
}

#[test]
fn read_header_reads_only_the_header() {
    let options = gzip::GzipHeaderOptions {
        filename: Some("corrupt.bin".to_string()),
        mtime: Some(42),
    };
    let mut compressed = gzip::compress_with_header(&text(1000), &options, None).unwrap();
    // Corrupt everything after the header, the 10 fixed bytes and the name.
    let body = 10 + "corrupt.bin\0".len();
    compressed[body..].fill(0xff);
    assert!(gzip::decompress(&compressed).is_err());

    let header = gzip::read_header(&compressed).unwrap();
    assert_eq!(header.filename.as_deref(), Some("corrupt.bin"));
    assert_eq!(header.mtime, 42);
    // The header alone is enough.
    assert_eq!(gzip::read_header(&compressed[..body]).unwrap().mtime, 42);
}

#[test]
fn read_header_rejects_invalid_data() {
    let valid = gzip::compress_with_header(
        b"data",
        &gzip::GzipHeaderOptions {
            filename: Some("name.txt".to_string()),
            mtime: None,
        },
        None,
    )
    .unwrap();
    let invalid: [&[u8]; 6] = [
        b"",
        b"not gzip data",
        &zstd::compress(b"data", None).unwrap(),
        // The fixed part of the header, cut short.
        &valid[..5],
        // The filename without its terminating NUL.
        &valid[..14],
        // An unknown compression method.
        &[&valid[..2], &[7], &valid[3..]].concat(),
    ];
    for input in invalid {
        let result = gzip::read_header(input);
        let Err(err) = result else {
            panic!("{input:?} has a gzip header");
        };
        assert!(matches!(err, ComprsError::InvalidArg(_)), "{input:?}");
        assert_eq!(
            err.to_string(),
            "invalid gzip data: unable to parse header",
            "{input:?}"
        );
    }
}
