//! The results of every LZ4 decoder for a corpus of valid, cut and invalid
//! input: the output length, or the variant and the message of the error.
//!
//! The messages are comprs-owned, and JavaScript sees them as they are, so
//! a change to the decoders must keep them. The expected results were
//! recorded from the decoder that decodes the whole input at once.

use std::io::Write;

use comprs_core::{ComprsError, lz4, lz4_stream};
use lz4_flex::frame::{BlockMode, BlockSize, FrameEncoder, FrameInfo};
use twox_hash::XxHash32;

/// Magic number of an LZ4 frame.
const FRAME_MAGIC: [u8; 4] = 0x184D_2204_u32.to_le_bytes();

/// Output limit of [`lz4::decompress_with_capacity`]: less than some of the
/// valid input decodes to.
const CAPACITY: usize = 50_000;

/// `len` bytes of text-like data: words picked by xorshift noise, which
/// compress into many sequences and blocks.
fn text(len: usize) -> Vec<u8> {
    const WORDS: [&[u8]; 8] = [
        b"frame ",
        b"block ",
        b"magic ",
        b"checksum ",
        b"size ",
        b"legacy ",
        b"skip ",
        b"\n",
    ];
    let mut state = 0x2545_f491_4f6c_dd1du64;
    let mut output = Vec::with_capacity(len + 9);
    while output.len() < len {
        state ^= state << 13;
        state ^= state >> 7;
        state ^= state << 17;
        output.extend_from_slice(WORDS[(state >> 61) as usize]);
    }
    output.truncate(len);
    output
}

/// Compress `data` into one frame with the given settings.
fn compress_with(data: &[u8], frame_info: FrameInfo) -> Vec<u8> {
    let mut encoder = FrameEncoder::with_frame_info(frame_info, Vec::new());
    encoder.write_all(data).unwrap();
    encoder.finish().unwrap()
}

/// A frame with `descriptor` (FLG, BD and the optional fields), its header
/// checksum, and then `blocks`.
fn frame_with_descriptor(descriptor: &[u8], blocks: &[u8]) -> Vec<u8> {
    let header_checksum = (XxHash32::oneshot(0, descriptor) >> 8) as u8;
    [&FRAME_MAGIC, descriptor, &[header_checksum], blocks].concat()
}

/// A skippable frame carrying `payload`.
fn skippable_frame(payload: &[u8]) -> Vec<u8> {
    let mut frame = 0x184D_2A5F_u32.to_le_bytes().to_vec();
    frame.extend((payload.len() as u32).to_le_bytes());
    frame.extend(payload);
    frame
}

/// "abc" in an uncompressed block.
const ABC_BLOCK: &[u8] = &[0x03, 0x00, 0x00, 0x80, b'a', b'b', b'c'];

/// A compressed block that repeats the 4 bytes before it and adds "z".
const REPEAT_BLOCK: &[u8] = &[0x05, 0x00, 0x00, 0x00, 0x00, 0x04, 0x00, 0x10, b'z'];

/// The end mark of a frame.
const END_MARK: &[u8] = &[0x00; 4];

/// `lz4 -c -l` (v1.9.4): a legacy frame of 44 bytes of text.
const LEGACY_FRAME: &[u8] = &[
    0x02, 0x21, 0x4c, 0x18, 0x1a, 0x00, 0x00, 0x00, 0xff, 0x00, 0x6c, 0x7a, 0x34, 0x20, 0x43, 0x4c,
    0x49, 0x20, 0x66, 0x72, 0x61, 0x6d, 0x65, 0x2c, 0x20, 0x0f, 0x00, 0x05, 0x50, 0x72, 0x61, 0x6d,
    0x65, 0x2e,
];

/// The input of every case, by name.
fn corpus() -> Vec<(String, Vec<u8>)> {
    let mut cases: Vec<(String, Vec<u8>)> = Vec::new();
    let mut add = |name: &str, input: Vec<u8>| cases.push((name.to_string(), input));

    // lz4::compress: independent 64 KiB blocks and a content checksum.
    let small = lz4::compress(&text(1000)).unwrap();
    // 256 KiB blocks.
    let large = lz4::compress(&text(300_000)).unwrap();
    // Linked 64 KiB blocks with every optional field.
    let linked = compress_with(
        &text(200_000),
        FrameInfo::new()
            .block_size(BlockSize::Max64KB)
            .block_mode(BlockMode::Linked)
            .block_checksums(true)
            .content_checksum(true)
            .content_size(Some(200_000)),
    );
    let skippable = skippable_frame(b"metadata");

    add("empty", Vec::new());
    add("small", small.clone());
    add("large", large.clone());
    add("linked", linked.clone());
    add("legacy", LEGACY_FRAME.to_vec());
    add("skippable", skippable.clone());
    add(
        "concatenated",
        [&small[..], &skippable, LEGACY_FRAME, &linked, &skippable].concat(),
    );

    // Input cut inside the magic number, the descriptor, a block size, a
    // block, its checksum, the end mark and the content checksum.
    let cuts = [1, 3, 4, 5, 6, 7, 10, 11, 12, small.len() / 2];
    for len in cuts
        .into_iter()
        .chain([8, 5, 4, 1].map(|end| small.len() - end))
    {
        add(&format!("small cut to {len}"), small[..len].to_vec());
    }
    let cuts = [6, 13, 14, 18, 19, 22, 23, 1000, linked.len() / 2];
    for len in cuts
        .into_iter()
        .chain([8, 4, 1].map(|end| linked.len() - end))
    {
        add(&format!("linked cut to {len}"), linked[..len].to_vec());
    }
    for len in [1, 4, 5, 7, 8, 9, 20, LEGACY_FRAME.len() - 1] {
        add(
            &format!("legacy cut to {len}"),
            LEGACY_FRAME[..len].to_vec(),
        );
    }
    for len in [1, 4, 5, 7, 8, 9, skippable.len() - 1] {
        add(
            &format!("skippable cut to {len}"),
            skippable[..len].to_vec(),
        );
    }
    for len in [1, 4, 8, small.len() / 2, small.len() - 1] {
        add(
            &format!("small then small cut to {len}"),
            [&small[..], &small[..len]].concat(),
        );
    }
    add(
        "legacy then frame cut",
        [LEGACY_FRAME, &small[..small.len() / 2]].concat(),
    );

    // Corrupt blocks.
    let mut flipped = small.clone();
    let last_literal = flipped.len() - 9;
    flipped[last_literal] ^= 0x01;
    add("small with a flipped literal", flipped);
    let mut flipped = linked.clone();
    flipped[100] ^= 0x10;
    add("linked with a flipped block byte", flipped);
    let mut flipped = large.clone();
    flipped[100] ^= 0xff;
    add("large with a flipped block byte", flipped);
    add(
        "match before the frame",
        frame_with_descriptor(&[0x60, 0x40], &[REPEAT_BLOCK, END_MARK].concat()),
    );
    let referring = frame_with_descriptor(&[0x40, 0x40], &[REPEAT_BLOCK, END_MARK].concat());
    add(
        "match into the previous frame",
        [&small[..], &referring[..]].concat(),
    );
    add(
        "block of a truncated sequence",
        frame_with_descriptor(
            &[0x60, 0x40],
            &[&[0x02, 0, 0, 0, 0xf0, 0xff][..], END_MARK].concat(),
        ),
    );

    // Checksums.
    let mut header = small.clone();
    header[6] ^= 0x01;
    add("bad header checksum", header);
    let checksum = &XxHash32::oneshot(0, b"abc").to_le_bytes()[..];
    let wrong: &[u8] = &[0xff; 4];
    add(
        "bad block checksum",
        frame_with_descriptor(&[0x70, 0x40], &[ABC_BLOCK, wrong, END_MARK].concat()),
    );
    add(
        "bad content checksum",
        frame_with_descriptor(&[0x64, 0x40], &[ABC_BLOCK, END_MARK, wrong].concat()),
    );
    add(
        "good checksums",
        frame_with_descriptor(
            &[0x74, 0x40],
            &[ABC_BLOCK, checksum, END_MARK, checksum].concat(),
        ),
    );
    let mut content = linked.clone();
    let last = content.len() - 1;
    content[last] ^= 0x80;
    add("linked with a bad content checksum", content);

    // Content sizes.
    let content_size = |size: u64| [&[0x68, 0x40][..], &size.to_le_bytes()].concat();
    add(
        "content size too large",
        frame_with_descriptor(&content_size(4), &[ABC_BLOCK, END_MARK].concat()),
    );
    add(
        "content size too small",
        frame_with_descriptor(&content_size(2), &[ABC_BLOCK, END_MARK].concat()),
    );
    add(
        "content size too small, checksum cut",
        frame_with_descriptor(
            &[&[0x6c, 0x40][..], &2u64.to_le_bytes()].concat(),
            &[ABC_BLOCK, END_MARK].concat(),
        ),
    );

    // Descriptors.
    for (name, descriptor) in [
        ("version 00", vec![0x20, 0x40]),
        ("version 10", vec![0xa0, 0x40]),
        ("reserved FLG bit", vec![0x62, 0x40]),
        ("reserved BD bits", vec![0x60, 0xc0]),
        ("reserved BD low bits", vec![0x60, 0x41]),
        ("block size 3", vec![0x60, 0x30]),
        ("dictionary id", vec![0x61, 0x40, 0x01, 0x00, 0x00, 0x00]),
    ] {
        add(
            name,
            frame_with_descriptor(&descriptor, &[ABC_BLOCK, END_MARK].concat()),
        );
    }
    add(
        "bad version, cut descriptor",
        [&FRAME_MAGIC[..], &[0x20, 0x40]].concat(),
    );
    add(
        "block too big",
        frame_with_descriptor(&[0x60, 0x40], &[0x01, 0x00, 0x01, 0x80]),
    );
    add(
        "block too big, linked",
        frame_with_descriptor(&[0x40, 0x40], &[0x01, 0x00, 0x01, 0x00]),
    );

    // Data after a frame and data that is not a frame.
    for (name, trailing) in [
        ("garbage", &b"garbage"[..]),
        ("a newline", b"\n"),
        ("zeros", &[0; 4]),
        ("a magic prefix", &FRAME_MAGIC[..2]),
        ("a magic number", &FRAME_MAGIC),
        ("a skippable magic number", &[0x50, 0x2a, 0x4d, 0x18]),
    ] {
        add(
            &format!("small then {name}"),
            [&small[..], trailing].concat(),
        );
        add(
            &format!("legacy then {name}"),
            [LEGACY_FRAME, trailing].concat(),
        );
        add(&format!("{name} alone"), trailing.to_vec());
    }
    add("not lz4", b"this is not lz4 data".to_vec());
    cases
}

/// The variant and the message of `error`.
fn describe(error: &ComprsError) -> String {
    let variant = match error {
        ComprsError::Operation { .. } => "Operation",
        ComprsError::Corrupt { .. } => "Corrupt",
        ComprsError::Creation { .. } => "Creation",
        ComprsError::InvalidArg(_) => "InvalidArg",
        ComprsError::UnknownFormat(_) => "UnknownFormat",
        ComprsError::SizeLimit { .. } => "SizeLimit",
        ComprsError::StreamFinished(_) => "StreamFinished",
        ComprsError::StreamClosed(_) => "StreamClosed",
        ComprsError::Truncated(_) => "Truncated",
        _ => "unknown variant",
    };
    format!("{variant}: {error}")
}

/// The output length, or the error, of `result`.
fn outcome(result: Result<Vec<u8>, ComprsError>) -> String {
    match result {
        Ok(output) => format!("Ok: {} bytes", output.len()),
        Err(error) => describe(&error),
    }
}

/// The result of every decoder for `input`, one line each.
fn results(name: &str, input: &[u8]) -> Vec<String> {
    let context = |end: fn(&mut lz4_stream::DecompressContext) -> _| {
        let mut ctx = lz4_stream::DecompressContext::new(None).unwrap();
        assert!(ctx.transform(input).unwrap().is_empty());
        end(&mut ctx)
    };
    [
        ("decompress", outcome(lz4::decompress(input))),
        (
            "capacity",
            outcome(lz4::decompress_with_capacity(input, CAPACITY)),
        ),
        (
            "flush",
            outcome(context(lz4_stream::DecompressContext::flush)),
        ),
        (
            "finish",
            outcome(context(lz4_stream::DecompressContext::finish)),
        ),
    ]
    .into_iter()
    .map(|(decoder, outcome)| format!("{name} | {decoder} | {outcome}"))
    .collect()
}

#[test]
fn lz4_decoders_keep_their_errors() {
    let actual: Vec<String> = corpus()
        .iter()
        .flat_map(|(name, input)| results(name, input))
        .collect();
    let expected: Vec<&str> = GOLDEN.lines().collect();
    for (actual, expected) in actual.iter().zip(&expected) {
        assert_eq!(actual, expected);
    }
    assert_eq!(
        actual.len(),
        expected.len(),
        "results of the corpus and of the table"
    );
}

/// The expected results, one line for each case and decoder.
const GOLDEN: &str = "\
empty | decompress | Truncated: lz4 stream is truncated: unexpected end of input
empty | capacity | Truncated: lz4 stream is truncated: unexpected end of input
empty | flush | Truncated: lz4 stream is truncated: unexpected end of input
empty | finish | Truncated: lz4 stream is truncated: unexpected end of input
small | decompress | Ok: 1000 bytes
small | capacity | Ok: 1000 bytes
small | flush | Ok: 1000 bytes
small | finish | Ok: 1000 bytes
large | decompress | Ok: 300000 bytes
large | capacity | SizeLimit: lz4 decompress exceeded maximum size of 50000 bytes
large | flush | Ok: 300000 bytes
large | finish | Ok: 300000 bytes
linked | decompress | Ok: 200000 bytes
linked | capacity | SizeLimit: lz4 decompress exceeded maximum size of 50000 bytes
linked | flush | Ok: 200000 bytes
linked | finish | Ok: 200000 bytes
legacy | decompress | Ok: 44 bytes
legacy | capacity | Ok: 44 bytes
legacy | flush | Ok: 44 bytes
legacy | finish | Ok: 44 bytes
skippable | decompress | Ok: 0 bytes
skippable | capacity | Ok: 0 bytes
skippable | flush | Ok: 0 bytes
skippable | finish | Ok: 0 bytes
concatenated | decompress | Ok: 201044 bytes
concatenated | capacity | SizeLimit: lz4 decompress exceeded maximum size of 50000 bytes
concatenated | flush | Ok: 201044 bytes
concatenated | finish | Ok: 201044 bytes
small cut to 1 | decompress | Truncated: lz4 stream is truncated: unexpected end of input
small cut to 1 | capacity | Truncated: lz4 stream is truncated: unexpected end of input
small cut to 1 | flush | Truncated: lz4 stream is truncated: unexpected end of input
small cut to 1 | finish | Truncated: lz4 stream is truncated: unexpected end of input
small cut to 3 | decompress | Truncated: lz4 stream is truncated: unexpected end of input
small cut to 3 | capacity | Truncated: lz4 stream is truncated: unexpected end of input
small cut to 3 | flush | Truncated: lz4 stream is truncated: unexpected end of input
small cut to 3 | finish | Truncated: lz4 stream is truncated: unexpected end of input
small cut to 4 | decompress | Truncated: lz4 stream is truncated: unexpected end of input
small cut to 4 | capacity | Truncated: lz4 stream is truncated: unexpected end of input
small cut to 4 | flush | Truncated: lz4 stream is truncated: unexpected end of input
small cut to 4 | finish | Truncated: lz4 stream is truncated: unexpected end of input
small cut to 5 | decompress | Truncated: lz4 stream is truncated: unexpected end of input
small cut to 5 | capacity | Truncated: lz4 stream is truncated: unexpected end of input
small cut to 5 | flush | Truncated: lz4 stream is truncated: unexpected end of input
small cut to 5 | finish | Truncated: lz4 stream is truncated: unexpected end of input
small cut to 6 | decompress | Truncated: lz4 stream is truncated: unexpected end of input
small cut to 6 | capacity | Truncated: lz4 stream is truncated: unexpected end of input
small cut to 6 | flush | Truncated: lz4 stream is truncated: unexpected end of input
small cut to 6 | finish | Truncated: lz4 stream is truncated: unexpected end of input
small cut to 7 | decompress | Truncated: lz4 stream is truncated: unexpected end of input
small cut to 7 | capacity | Truncated: lz4 stream is truncated: unexpected end of input
small cut to 7 | flush | Truncated: lz4 stream is truncated: unexpected end of input
small cut to 7 | finish | Truncated: lz4 stream is truncated: unexpected end of input
small cut to 10 | decompress | Truncated: lz4 stream is truncated: unexpected end of input
small cut to 10 | capacity | Truncated: lz4 stream is truncated: unexpected end of input
small cut to 10 | flush | Truncated: lz4 stream is truncated: unexpected end of input
small cut to 10 | finish | Truncated: lz4 stream is truncated: unexpected end of input
small cut to 11 | decompress | Truncated: lz4 stream is truncated: unexpected end of input
small cut to 11 | capacity | Truncated: lz4 stream is truncated: unexpected end of input
small cut to 11 | flush | Truncated: lz4 stream is truncated: unexpected end of input
small cut to 11 | finish | Truncated: lz4 stream is truncated: unexpected end of input
small cut to 12 | decompress | Truncated: lz4 stream is truncated: unexpected end of input
small cut to 12 | capacity | Truncated: lz4 stream is truncated: unexpected end of input
small cut to 12 | flush | Truncated: lz4 stream is truncated: unexpected end of input
small cut to 12 | finish | Truncated: lz4 stream is truncated: unexpected end of input
small cut to 229 | decompress | Truncated: lz4 stream is truncated: unexpected end of input
small cut to 229 | capacity | Truncated: lz4 stream is truncated: unexpected end of input
small cut to 229 | flush | Truncated: lz4 stream is truncated: unexpected end of input
small cut to 229 | finish | Truncated: lz4 stream is truncated: unexpected end of input
small cut to 450 | decompress | Truncated: lz4 stream is truncated: unexpected end of input
small cut to 450 | capacity | Truncated: lz4 stream is truncated: unexpected end of input
small cut to 450 | flush | Truncated: lz4 stream is truncated: unexpected end of input
small cut to 450 | finish | Truncated: lz4 stream is truncated: unexpected end of input
small cut to 453 | decompress | Truncated: lz4 stream is truncated: unexpected end of input
small cut to 453 | capacity | Truncated: lz4 stream is truncated: unexpected end of input
small cut to 453 | flush | Truncated: lz4 stream is truncated: unexpected end of input
small cut to 453 | finish | Truncated: lz4 stream is truncated: unexpected end of input
small cut to 454 | decompress | Truncated: lz4 stream is truncated: unexpected end of input
small cut to 454 | capacity | Truncated: lz4 stream is truncated: unexpected end of input
small cut to 454 | flush | Truncated: lz4 stream is truncated: unexpected end of input
small cut to 454 | finish | Truncated: lz4 stream is truncated: unexpected end of input
small cut to 457 | decompress | Truncated: lz4 stream is truncated: unexpected end of input
small cut to 457 | capacity | Truncated: lz4 stream is truncated: unexpected end of input
small cut to 457 | flush | Truncated: lz4 stream is truncated: unexpected end of input
small cut to 457 | finish | Truncated: lz4 stream is truncated: unexpected end of input
linked cut to 6 | decompress | Truncated: lz4 stream is truncated: unexpected end of input
linked cut to 6 | capacity | Truncated: lz4 stream is truncated: unexpected end of input
linked cut to 6 | flush | Truncated: lz4 stream is truncated: unexpected end of input
linked cut to 6 | finish | Truncated: lz4 stream is truncated: unexpected end of input
linked cut to 13 | decompress | Truncated: lz4 stream is truncated: unexpected end of input
linked cut to 13 | capacity | Truncated: lz4 stream is truncated: unexpected end of input
linked cut to 13 | flush | Truncated: lz4 stream is truncated: unexpected end of input
linked cut to 13 | finish | Truncated: lz4 stream is truncated: unexpected end of input
linked cut to 14 | decompress | Truncated: lz4 stream is truncated: unexpected end of input
linked cut to 14 | capacity | Truncated: lz4 stream is truncated: unexpected end of input
linked cut to 14 | flush | Truncated: lz4 stream is truncated: unexpected end of input
linked cut to 14 | finish | Truncated: lz4 stream is truncated: unexpected end of input
linked cut to 18 | decompress | Truncated: lz4 stream is truncated: unexpected end of input
linked cut to 18 | capacity | Truncated: lz4 stream is truncated: unexpected end of input
linked cut to 18 | flush | Truncated: lz4 stream is truncated: unexpected end of input
linked cut to 18 | finish | Truncated: lz4 stream is truncated: unexpected end of input
linked cut to 19 | decompress | Truncated: lz4 stream is truncated: unexpected end of input
linked cut to 19 | capacity | Truncated: lz4 stream is truncated: unexpected end of input
linked cut to 19 | flush | Truncated: lz4 stream is truncated: unexpected end of input
linked cut to 19 | finish | Truncated: lz4 stream is truncated: unexpected end of input
linked cut to 22 | decompress | Truncated: lz4 stream is truncated: unexpected end of input
linked cut to 22 | capacity | Truncated: lz4 stream is truncated: unexpected end of input
linked cut to 22 | flush | Truncated: lz4 stream is truncated: unexpected end of input
linked cut to 22 | finish | Truncated: lz4 stream is truncated: unexpected end of input
linked cut to 23 | decompress | Truncated: lz4 stream is truncated: unexpected end of input
linked cut to 23 | capacity | Truncated: lz4 stream is truncated: unexpected end of input
linked cut to 23 | flush | Truncated: lz4 stream is truncated: unexpected end of input
linked cut to 23 | finish | Truncated: lz4 stream is truncated: unexpected end of input
linked cut to 1000 | decompress | Truncated: lz4 stream is truncated: unexpected end of input
linked cut to 1000 | capacity | Truncated: lz4 stream is truncated: unexpected end of input
linked cut to 1000 | flush | Truncated: lz4 stream is truncated: unexpected end of input
linked cut to 1000 | finish | Truncated: lz4 stream is truncated: unexpected end of input
linked cut to 40589 | decompress | Truncated: lz4 stream is truncated: unexpected end of input
linked cut to 40589 | capacity | SizeLimit: lz4 decompress exceeded maximum size of 50000 bytes
linked cut to 40589 | flush | Truncated: lz4 stream is truncated: unexpected end of input
linked cut to 40589 | finish | Truncated: lz4 stream is truncated: unexpected end of input
linked cut to 81170 | decompress | Truncated: lz4 stream is truncated: unexpected end of input
linked cut to 81170 | capacity | SizeLimit: lz4 decompress exceeded maximum size of 50000 bytes
linked cut to 81170 | flush | Truncated: lz4 stream is truncated: unexpected end of input
linked cut to 81170 | finish | Truncated: lz4 stream is truncated: unexpected end of input
linked cut to 81174 | decompress | Truncated: lz4 stream is truncated: unexpected end of input
linked cut to 81174 | capacity | SizeLimit: lz4 decompress exceeded maximum size of 50000 bytes
linked cut to 81174 | flush | Truncated: lz4 stream is truncated: unexpected end of input
linked cut to 81174 | finish | Truncated: lz4 stream is truncated: unexpected end of input
linked cut to 81177 | decompress | Truncated: lz4 stream is truncated: unexpected end of input
linked cut to 81177 | capacity | SizeLimit: lz4 decompress exceeded maximum size of 50000 bytes
linked cut to 81177 | flush | Truncated: lz4 stream is truncated: unexpected end of input
linked cut to 81177 | finish | Truncated: lz4 stream is truncated: unexpected end of input
legacy cut to 1 | decompress | Truncated: lz4 stream is truncated: unexpected end of input
legacy cut to 1 | capacity | Truncated: lz4 stream is truncated: unexpected end of input
legacy cut to 1 | flush | Truncated: lz4 stream is truncated: unexpected end of input
legacy cut to 1 | finish | Truncated: lz4 stream is truncated: unexpected end of input
legacy cut to 4 | decompress | Ok: 0 bytes
legacy cut to 4 | capacity | Ok: 0 bytes
legacy cut to 4 | flush | Ok: 0 bytes
legacy cut to 4 | finish | Ok: 0 bytes
legacy cut to 5 | decompress | Truncated: lz4 stream is truncated: unexpected end of input
legacy cut to 5 | capacity | Truncated: lz4 stream is truncated: unexpected end of input
legacy cut to 5 | flush | Truncated: lz4 stream is truncated: unexpected end of input
legacy cut to 5 | finish | Truncated: lz4 stream is truncated: unexpected end of input
legacy cut to 7 | decompress | Truncated: lz4 stream is truncated: unexpected end of input
legacy cut to 7 | capacity | Truncated: lz4 stream is truncated: unexpected end of input
legacy cut to 7 | flush | Truncated: lz4 stream is truncated: unexpected end of input
legacy cut to 7 | finish | Truncated: lz4 stream is truncated: unexpected end of input
legacy cut to 8 | decompress | Truncated: lz4 stream is truncated: unexpected end of input
legacy cut to 8 | capacity | Truncated: lz4 stream is truncated: unexpected end of input
legacy cut to 8 | flush | Truncated: lz4 stream is truncated: unexpected end of input
legacy cut to 8 | finish | Truncated: lz4 stream is truncated: unexpected end of input
legacy cut to 9 | decompress | Truncated: lz4 stream is truncated: unexpected end of input
legacy cut to 9 | capacity | Truncated: lz4 stream is truncated: unexpected end of input
legacy cut to 9 | flush | Truncated: lz4 stream is truncated: unexpected end of input
legacy cut to 9 | finish | Truncated: lz4 stream is truncated: unexpected end of input
legacy cut to 20 | decompress | Truncated: lz4 stream is truncated: unexpected end of input
legacy cut to 20 | capacity | Truncated: lz4 stream is truncated: unexpected end of input
legacy cut to 20 | flush | Truncated: lz4 stream is truncated: unexpected end of input
legacy cut to 20 | finish | Truncated: lz4 stream is truncated: unexpected end of input
legacy cut to 33 | decompress | Truncated: lz4 stream is truncated: unexpected end of input
legacy cut to 33 | capacity | Truncated: lz4 stream is truncated: unexpected end of input
legacy cut to 33 | flush | Truncated: lz4 stream is truncated: unexpected end of input
legacy cut to 33 | finish | Truncated: lz4 stream is truncated: unexpected end of input
skippable cut to 1 | decompress | Truncated: lz4 stream is truncated: unexpected end of input
skippable cut to 1 | capacity | Truncated: lz4 stream is truncated: unexpected end of input
skippable cut to 1 | flush | Truncated: lz4 stream is truncated: unexpected end of input
skippable cut to 1 | finish | Truncated: lz4 stream is truncated: unexpected end of input
skippable cut to 4 | decompress | Truncated: lz4 stream is truncated: unexpected end of input
skippable cut to 4 | capacity | Truncated: lz4 stream is truncated: unexpected end of input
skippable cut to 4 | flush | Truncated: lz4 stream is truncated: unexpected end of input
skippable cut to 4 | finish | Truncated: lz4 stream is truncated: unexpected end of input
skippable cut to 5 | decompress | Truncated: lz4 stream is truncated: unexpected end of input
skippable cut to 5 | capacity | Truncated: lz4 stream is truncated: unexpected end of input
skippable cut to 5 | flush | Truncated: lz4 stream is truncated: unexpected end of input
skippable cut to 5 | finish | Truncated: lz4 stream is truncated: unexpected end of input
skippable cut to 7 | decompress | Truncated: lz4 stream is truncated: unexpected end of input
skippable cut to 7 | capacity | Truncated: lz4 stream is truncated: unexpected end of input
skippable cut to 7 | flush | Truncated: lz4 stream is truncated: unexpected end of input
skippable cut to 7 | finish | Truncated: lz4 stream is truncated: unexpected end of input
skippable cut to 8 | decompress | Truncated: lz4 stream is truncated: unexpected end of input
skippable cut to 8 | capacity | Truncated: lz4 stream is truncated: unexpected end of input
skippable cut to 8 | flush | Truncated: lz4 stream is truncated: unexpected end of input
skippable cut to 8 | finish | Truncated: lz4 stream is truncated: unexpected end of input
skippable cut to 9 | decompress | Truncated: lz4 stream is truncated: unexpected end of input
skippable cut to 9 | capacity | Truncated: lz4 stream is truncated: unexpected end of input
skippable cut to 9 | flush | Truncated: lz4 stream is truncated: unexpected end of input
skippable cut to 9 | finish | Truncated: lz4 stream is truncated: unexpected end of input
skippable cut to 15 | decompress | Truncated: lz4 stream is truncated: unexpected end of input
skippable cut to 15 | capacity | Truncated: lz4 stream is truncated: unexpected end of input
skippable cut to 15 | flush | Truncated: lz4 stream is truncated: unexpected end of input
skippable cut to 15 | finish | Truncated: lz4 stream is truncated: unexpected end of input
small then small cut to 1 | decompress | Truncated: lz4 stream is truncated: unexpected end of input
small then small cut to 1 | capacity | Truncated: lz4 stream is truncated: unexpected end of input
small then small cut to 1 | flush | Truncated: lz4 stream is truncated: unexpected end of input
small then small cut to 1 | finish | Truncated: lz4 stream is truncated: unexpected end of input
small then small cut to 4 | decompress | Truncated: lz4 stream is truncated: unexpected end of input
small then small cut to 4 | capacity | Truncated: lz4 stream is truncated: unexpected end of input
small then small cut to 4 | flush | Truncated: lz4 stream is truncated: unexpected end of input
small then small cut to 4 | finish | Truncated: lz4 stream is truncated: unexpected end of input
small then small cut to 8 | decompress | Truncated: lz4 stream is truncated: unexpected end of input
small then small cut to 8 | capacity | Truncated: lz4 stream is truncated: unexpected end of input
small then small cut to 8 | flush | Truncated: lz4 stream is truncated: unexpected end of input
small then small cut to 8 | finish | Truncated: lz4 stream is truncated: unexpected end of input
small then small cut to 229 | decompress | Truncated: lz4 stream is truncated: unexpected end of input
small then small cut to 229 | capacity | Truncated: lz4 stream is truncated: unexpected end of input
small then small cut to 229 | flush | Truncated: lz4 stream is truncated: unexpected end of input
small then small cut to 229 | finish | Truncated: lz4 stream is truncated: unexpected end of input
small then small cut to 457 | decompress | Truncated: lz4 stream is truncated: unexpected end of input
small then small cut to 457 | capacity | Truncated: lz4 stream is truncated: unexpected end of input
small then small cut to 457 | flush | Truncated: lz4 stream is truncated: unexpected end of input
small then small cut to 457 | finish | Truncated: lz4 stream is truncated: unexpected end of input
legacy then frame cut | decompress | Truncated: lz4 stream is truncated: unexpected end of input
legacy then frame cut | capacity | Truncated: lz4 stream is truncated: unexpected end of input
legacy then frame cut | flush | Truncated: lz4 stream is truncated: unexpected end of input
legacy then frame cut | finish | Truncated: lz4 stream is truncated: unexpected end of input
small with a flipped literal | decompress | Corrupt: lz4 decompress failed: ContentChecksumError
small with a flipped literal | capacity | Corrupt: lz4 decompress failed: ContentChecksumError
small with a flipped literal | flush | Corrupt: lz4 stream decompress failed: ContentChecksumError
small with a flipped literal | finish | Corrupt: lz4 stream decompress failed: ContentChecksumError
linked with a flipped block byte | decompress | Corrupt: lz4 decompress failed: BlockChecksumError
linked with a flipped block byte | capacity | Corrupt: lz4 decompress failed: BlockChecksumError
linked with a flipped block byte | flush | Corrupt: lz4 stream decompress failed: BlockChecksumError
linked with a flipped block byte | finish | Corrupt: lz4 stream decompress failed: BlockChecksumError
large with a flipped block byte | decompress | Corrupt: lz4 decompress failed: ContentChecksumError
large with a flipped block byte | capacity | SizeLimit: lz4 decompress exceeded maximum size of 50000 bytes
large with a flipped block byte | flush | Corrupt: lz4 stream decompress failed: ContentChecksumError
large with a flipped block byte | finish | Corrupt: lz4 stream decompress failed: ContentChecksumError
match before the frame | decompress | Corrupt: lz4 decompress failed: DecompressionError(OffsetOutOfBounds)
match before the frame | capacity | Corrupt: lz4 decompress failed: DecompressionError(OffsetOutOfBounds)
match before the frame | flush | Corrupt: lz4 stream decompress failed: DecompressionError(OffsetOutOfBounds)
match before the frame | finish | Corrupt: lz4 stream decompress failed: DecompressionError(OffsetOutOfBounds)
match into the previous frame | decompress | Corrupt: lz4 decompress failed: DecompressionError(OffsetOutOfBounds)
match into the previous frame | capacity | Corrupt: lz4 decompress failed: DecompressionError(OffsetOutOfBounds)
match into the previous frame | flush | Corrupt: lz4 stream decompress failed: DecompressionError(OffsetOutOfBounds)
match into the previous frame | finish | Corrupt: lz4 stream decompress failed: DecompressionError(OffsetOutOfBounds)
block of a truncated sequence | decompress | Corrupt: lz4 decompress failed: DecompressionError(ExpectedAnotherByte)
block of a truncated sequence | capacity | Corrupt: lz4 decompress failed: DecompressionError(ExpectedAnotherByte)
block of a truncated sequence | flush | Corrupt: lz4 stream decompress failed: DecompressionError(ExpectedAnotherByte)
block of a truncated sequence | finish | Corrupt: lz4 stream decompress failed: DecompressionError(ExpectedAnotherByte)
bad header checksum | decompress | Corrupt: lz4 decompress failed: HeaderChecksumError
bad header checksum | capacity | Corrupt: lz4 decompress failed: HeaderChecksumError
bad header checksum | flush | Corrupt: lz4 stream decompress failed: HeaderChecksumError
bad header checksum | finish | Corrupt: lz4 stream decompress failed: HeaderChecksumError
bad block checksum | decompress | Corrupt: lz4 decompress failed: BlockChecksumError
bad block checksum | capacity | Corrupt: lz4 decompress failed: BlockChecksumError
bad block checksum | flush | Corrupt: lz4 stream decompress failed: BlockChecksumError
bad block checksum | finish | Corrupt: lz4 stream decompress failed: BlockChecksumError
bad content checksum | decompress | Corrupt: lz4 decompress failed: ContentChecksumError
bad content checksum | capacity | Corrupt: lz4 decompress failed: ContentChecksumError
bad content checksum | flush | Corrupt: lz4 stream decompress failed: ContentChecksumError
bad content checksum | finish | Corrupt: lz4 stream decompress failed: ContentChecksumError
good checksums | decompress | Ok: 3 bytes
good checksums | capacity | Ok: 3 bytes
good checksums | flush | Ok: 3 bytes
good checksums | finish | Ok: 3 bytes
linked with a bad content checksum | decompress | Corrupt: lz4 decompress failed: ContentChecksumError
linked with a bad content checksum | capacity | SizeLimit: lz4 decompress exceeded maximum size of 50000 bytes
linked with a bad content checksum | flush | Corrupt: lz4 stream decompress failed: ContentChecksumError
linked with a bad content checksum | finish | Corrupt: lz4 stream decompress failed: ContentChecksumError
content size too large | decompress | Corrupt: lz4 decompress failed: ContentLengthError { expected: 4, actual: 3 }
content size too large | capacity | Corrupt: lz4 decompress failed: ContentLengthError { expected: 4, actual: 3 }
content size too large | flush | Corrupt: lz4 stream decompress failed: ContentLengthError { expected: 4, actual: 3 }
content size too large | finish | Corrupt: lz4 stream decompress failed: ContentLengthError { expected: 4, actual: 3 }
content size too small | decompress | Corrupt: lz4 decompress failed: ContentLengthError { expected: 2, actual: 3 }
content size too small | capacity | Corrupt: lz4 decompress failed: ContentLengthError { expected: 2, actual: 3 }
content size too small | flush | Corrupt: lz4 stream decompress failed: ContentLengthError { expected: 2, actual: 3 }
content size too small | finish | Corrupt: lz4 stream decompress failed: ContentLengthError { expected: 2, actual: 3 }
content size too small, checksum cut | decompress | Corrupt: lz4 decompress failed: ContentLengthError { expected: 2, actual: 3 }
content size too small, checksum cut | capacity | Corrupt: lz4 decompress failed: ContentLengthError { expected: 2, actual: 3 }
content size too small, checksum cut | flush | Corrupt: lz4 stream decompress failed: ContentLengthError { expected: 2, actual: 3 }
content size too small, checksum cut | finish | Corrupt: lz4 stream decompress failed: ContentLengthError { expected: 2, actual: 3 }
version 00 | decompress | Corrupt: lz4 decompress failed: UnsupportedVersion(0)
version 00 | capacity | Corrupt: lz4 decompress failed: UnsupportedVersion(0)
version 00 | flush | Corrupt: lz4 stream decompress failed: UnsupportedVersion(0)
version 00 | finish | Corrupt: lz4 stream decompress failed: UnsupportedVersion(0)
version 10 | decompress | Corrupt: lz4 decompress failed: UnsupportedVersion(128)
version 10 | capacity | Corrupt: lz4 decompress failed: UnsupportedVersion(128)
version 10 | flush | Corrupt: lz4 stream decompress failed: UnsupportedVersion(128)
version 10 | finish | Corrupt: lz4 stream decompress failed: UnsupportedVersion(128)
reserved FLG bit | decompress | Corrupt: lz4 decompress failed: ReservedBitsSet
reserved FLG bit | capacity | Corrupt: lz4 decompress failed: ReservedBitsSet
reserved FLG bit | flush | Corrupt: lz4 stream decompress failed: ReservedBitsSet
reserved FLG bit | finish | Corrupt: lz4 stream decompress failed: ReservedBitsSet
reserved BD bits | decompress | Corrupt: lz4 decompress failed: ReservedBitsSet
reserved BD bits | capacity | Corrupt: lz4 decompress failed: ReservedBitsSet
reserved BD bits | flush | Corrupt: lz4 stream decompress failed: ReservedBitsSet
reserved BD bits | finish | Corrupt: lz4 stream decompress failed: ReservedBitsSet
reserved BD low bits | decompress | Corrupt: lz4 decompress failed: ReservedBitsSet
reserved BD low bits | capacity | Corrupt: lz4 decompress failed: ReservedBitsSet
reserved BD low bits | flush | Corrupt: lz4 stream decompress failed: ReservedBitsSet
reserved BD low bits | finish | Corrupt: lz4 stream decompress failed: ReservedBitsSet
block size 3 | decompress | Corrupt: lz4 decompress failed: UnsupportedBlocksize(3)
block size 3 | capacity | Corrupt: lz4 decompress failed: UnsupportedBlocksize(3)
block size 3 | flush | Corrupt: lz4 stream decompress failed: UnsupportedBlocksize(3)
block size 3 | finish | Corrupt: lz4 stream decompress failed: UnsupportedBlocksize(3)
dictionary id | decompress | Corrupt: lz4 decompress failed: DictionaryNotSupported
dictionary id | capacity | Corrupt: lz4 decompress failed: DictionaryNotSupported
dictionary id | flush | Corrupt: lz4 stream decompress failed: DictionaryNotSupported
dictionary id | finish | Corrupt: lz4 stream decompress failed: DictionaryNotSupported
bad version, cut descriptor | decompress | Truncated: lz4 stream is truncated: unexpected end of input
bad version, cut descriptor | capacity | Truncated: lz4 stream is truncated: unexpected end of input
bad version, cut descriptor | flush | Truncated: lz4 stream is truncated: unexpected end of input
bad version, cut descriptor | finish | Truncated: lz4 stream is truncated: unexpected end of input
block too big | decompress | Corrupt: lz4 decompress failed: BlockTooBig
block too big | capacity | Corrupt: lz4 decompress failed: BlockTooBig
block too big | flush | Corrupt: lz4 stream decompress failed: BlockTooBig
block too big | finish | Corrupt: lz4 stream decompress failed: BlockTooBig
block too big, linked | decompress | Corrupt: lz4 decompress failed: BlockTooBig
block too big, linked | capacity | Corrupt: lz4 decompress failed: BlockTooBig
block too big, linked | flush | Corrupt: lz4 stream decompress failed: BlockTooBig
block too big, linked | finish | Corrupt: lz4 stream decompress failed: BlockTooBig
small then garbage | decompress | Corrupt: lz4 decompress failed: unexpected data after the end of a frame
small then garbage | capacity | Corrupt: lz4 decompress failed: unexpected data after the end of a frame
small then garbage | flush | Corrupt: lz4 stream decompress failed: unexpected data after the end of a frame
small then garbage | finish | Corrupt: lz4 stream decompress failed: unexpected data after the end of a frame
legacy then garbage | decompress | Corrupt: lz4 decompress failed: unexpected data after the end of a frame
legacy then garbage | capacity | Corrupt: lz4 decompress failed: unexpected data after the end of a frame
legacy then garbage | flush | Corrupt: lz4 stream decompress failed: unexpected data after the end of a frame
legacy then garbage | finish | Corrupt: lz4 stream decompress failed: unexpected data after the end of a frame
garbage alone | decompress | Corrupt: lz4 decompress failed: WrongMagicNumber
garbage alone | capacity | Corrupt: lz4 decompress failed: WrongMagicNumber
garbage alone | flush | Corrupt: lz4 stream decompress failed: WrongMagicNumber
garbage alone | finish | Corrupt: lz4 stream decompress failed: WrongMagicNumber
small then a newline | decompress | Corrupt: lz4 decompress failed: unexpected data after the end of a frame
small then a newline | capacity | Corrupt: lz4 decompress failed: unexpected data after the end of a frame
small then a newline | flush | Corrupt: lz4 stream decompress failed: unexpected data after the end of a frame
small then a newline | finish | Corrupt: lz4 stream decompress failed: unexpected data after the end of a frame
legacy then a newline | decompress | Truncated: lz4 stream is truncated: unexpected end of input
legacy then a newline | capacity | Truncated: lz4 stream is truncated: unexpected end of input
legacy then a newline | flush | Truncated: lz4 stream is truncated: unexpected end of input
legacy then a newline | finish | Truncated: lz4 stream is truncated: unexpected end of input
a newline alone | decompress | Corrupt: lz4 decompress failed: WrongMagicNumber
a newline alone | capacity | Corrupt: lz4 decompress failed: WrongMagicNumber
a newline alone | flush | Corrupt: lz4 stream decompress failed: WrongMagicNumber
a newline alone | finish | Corrupt: lz4 stream decompress failed: WrongMagicNumber
small then zeros | decompress | Corrupt: lz4 decompress failed: unexpected data after the end of a frame
small then zeros | capacity | Corrupt: lz4 decompress failed: unexpected data after the end of a frame
small then zeros | flush | Corrupt: lz4 stream decompress failed: unexpected data after the end of a frame
small then zeros | finish | Corrupt: lz4 stream decompress failed: unexpected data after the end of a frame
legacy then zeros | decompress | Corrupt: lz4 decompress failed: DecompressionError(ExpectedAnotherByte)
legacy then zeros | capacity | Corrupt: lz4 decompress failed: DecompressionError(ExpectedAnotherByte)
legacy then zeros | flush | Corrupt: lz4 stream decompress failed: DecompressionError(ExpectedAnotherByte)
legacy then zeros | finish | Corrupt: lz4 stream decompress failed: DecompressionError(ExpectedAnotherByte)
zeros alone | decompress | Corrupt: lz4 decompress failed: WrongMagicNumber
zeros alone | capacity | Corrupt: lz4 decompress failed: WrongMagicNumber
zeros alone | flush | Corrupt: lz4 stream decompress failed: WrongMagicNumber
zeros alone | finish | Corrupt: lz4 stream decompress failed: WrongMagicNumber
small then a magic prefix | decompress | Truncated: lz4 stream is truncated: unexpected end of input
small then a magic prefix | capacity | Truncated: lz4 stream is truncated: unexpected end of input
small then a magic prefix | flush | Truncated: lz4 stream is truncated: unexpected end of input
small then a magic prefix | finish | Truncated: lz4 stream is truncated: unexpected end of input
legacy then a magic prefix | decompress | Truncated: lz4 stream is truncated: unexpected end of input
legacy then a magic prefix | capacity | Truncated: lz4 stream is truncated: unexpected end of input
legacy then a magic prefix | flush | Truncated: lz4 stream is truncated: unexpected end of input
legacy then a magic prefix | finish | Truncated: lz4 stream is truncated: unexpected end of input
a magic prefix alone | decompress | Truncated: lz4 stream is truncated: unexpected end of input
a magic prefix alone | capacity | Truncated: lz4 stream is truncated: unexpected end of input
a magic prefix alone | flush | Truncated: lz4 stream is truncated: unexpected end of input
a magic prefix alone | finish | Truncated: lz4 stream is truncated: unexpected end of input
small then a magic number | decompress | Truncated: lz4 stream is truncated: unexpected end of input
small then a magic number | capacity | Truncated: lz4 stream is truncated: unexpected end of input
small then a magic number | flush | Truncated: lz4 stream is truncated: unexpected end of input
small then a magic number | finish | Truncated: lz4 stream is truncated: unexpected end of input
legacy then a magic number | decompress | Truncated: lz4 stream is truncated: unexpected end of input
legacy then a magic number | capacity | Truncated: lz4 stream is truncated: unexpected end of input
legacy then a magic number | flush | Truncated: lz4 stream is truncated: unexpected end of input
legacy then a magic number | finish | Truncated: lz4 stream is truncated: unexpected end of input
a magic number alone | decompress | Truncated: lz4 stream is truncated: unexpected end of input
a magic number alone | capacity | Truncated: lz4 stream is truncated: unexpected end of input
a magic number alone | flush | Truncated: lz4 stream is truncated: unexpected end of input
a magic number alone | finish | Truncated: lz4 stream is truncated: unexpected end of input
small then a skippable magic number | decompress | Truncated: lz4 stream is truncated: unexpected end of input
small then a skippable magic number | capacity | Truncated: lz4 stream is truncated: unexpected end of input
small then a skippable magic number | flush | Truncated: lz4 stream is truncated: unexpected end of input
small then a skippable magic number | finish | Truncated: lz4 stream is truncated: unexpected end of input
legacy then a skippable magic number | decompress | Truncated: lz4 stream is truncated: unexpected end of input
legacy then a skippable magic number | capacity | Truncated: lz4 stream is truncated: unexpected end of input
legacy then a skippable magic number | flush | Truncated: lz4 stream is truncated: unexpected end of input
legacy then a skippable magic number | finish | Truncated: lz4 stream is truncated: unexpected end of input
a skippable magic number alone | decompress | Truncated: lz4 stream is truncated: unexpected end of input
a skippable magic number alone | capacity | Truncated: lz4 stream is truncated: unexpected end of input
a skippable magic number alone | flush | Truncated: lz4 stream is truncated: unexpected end of input
a skippable magic number alone | finish | Truncated: lz4 stream is truncated: unexpected end of input
not lz4 | decompress | Corrupt: lz4 decompress failed: WrongMagicNumber
not lz4 | capacity | Corrupt: lz4 decompress failed: WrongMagicNumber
not lz4 | flush | Corrupt: lz4 stream decompress failed: WrongMagicNumber
not lz4 | finish | Corrupt: lz4 stream decompress failed: WrongMagicNumber
";
