use std::io::{Read, Write};

use criterion::{Criterion, criterion_group, criterion_main};
use lz4_flex::frame::{FrameDecoder, FrameEncoder};
use zflate_bench::{patterned_1mb, patterned_10kb, random_1mb, random_10kb};

fn compress(data: &[u8]) -> Vec<u8> {
    let mut output = Vec::with_capacity(data.len());
    let mut encoder = FrameEncoder::new(&mut output);
    encoder.write_all(data).unwrap();
    encoder.finish().unwrap();
    output
}

fn decompress(data: &[u8]) -> Vec<u8> {
    let mut decoder = FrameDecoder::new(data);
    let mut output = Vec::new();
    decoder.read_to_end(&mut output).unwrap();
    output
}

fn bench_lz4(c: &mut Criterion) {
    let p10k = patterned_10kb();
    let p1m = patterned_1mb();
    let r10k = random_10kb();
    let r1m = random_1mb();

    let p10k_c = compress(&p10k);
    let p1m_c = compress(&p1m);
    let r10k_c = compress(&r10k);
    let r1m_c = compress(&r1m);

    c.bench_function("lz4 compress patterned 10KB", |b| {
        b.iter(|| compress(&p10k))
    });
    c.bench_function("lz4 compress patterned 1MB", |b| b.iter(|| compress(&p1m)));
    c.bench_function("lz4 compress random 10KB", |b| b.iter(|| compress(&r10k)));
    c.bench_function("lz4 compress random 1MB", |b| b.iter(|| compress(&r1m)));

    c.bench_function("lz4 decompress patterned 10KB", |b| {
        b.iter(|| decompress(&p10k_c))
    });
    c.bench_function("lz4 decompress patterned 1MB", |b| {
        b.iter(|| decompress(&p1m_c))
    });
    c.bench_function("lz4 decompress random 10KB", |b| {
        b.iter(|| decompress(&r10k_c))
    });
    c.bench_function("lz4 decompress random 1MB", |b| {
        b.iter(|| decompress(&r1m_c))
    });
}

criterion_group!(benches, bench_lz4);
criterion_main!(benches);
