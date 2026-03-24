use std::io::{Read, Write};

use comprs_bench::{patterned_1mb, patterned_10kb, random_1mb, random_10kb};
use criterion::{Criterion, criterion_group, criterion_main};
use flate2::Compression;
use flate2::read::DeflateDecoder;
use flate2::write::DeflateEncoder;

fn compress(data: &[u8], level: u32) -> Vec<u8> {
    let mut encoder = DeflateEncoder::new(Vec::with_capacity(data.len()), Compression::new(level));
    encoder.write_all(data).unwrap();
    encoder.finish().unwrap()
}

fn decompress(data: &[u8]) -> Vec<u8> {
    let mut decoder = DeflateDecoder::new(data);
    let mut output = Vec::new();
    decoder.read_to_end(&mut output).unwrap();
    output
}

fn bench_deflate(c: &mut Criterion) {
    let p10k = patterned_10kb();
    let p1m = patterned_1mb();
    let r10k = random_10kb();
    let r1m = random_1mb();

    let p10k_c = compress(&p10k, 6);
    let p1m_c = compress(&p1m, 6);
    let r10k_c = compress(&r10k, 6);
    let r1m_c = compress(&r1m, 6);

    c.bench_function("deflate compress patterned 10KB", |b| {
        b.iter(|| compress(&p10k, 6))
    });
    c.bench_function("deflate compress patterned 1MB", |b| {
        b.iter(|| compress(&p1m, 6))
    });
    c.bench_function("deflate compress random 10KB", |b| {
        b.iter(|| compress(&r10k, 6))
    });
    c.bench_function("deflate compress random 1MB", |b| {
        b.iter(|| compress(&r1m, 6))
    });

    c.bench_function("deflate decompress patterned 10KB", |b| {
        b.iter(|| decompress(&p10k_c))
    });
    c.bench_function("deflate decompress patterned 1MB", |b| {
        b.iter(|| decompress(&p1m_c))
    });
    c.bench_function("deflate decompress random 10KB", |b| {
        b.iter(|| decompress(&r10k_c))
    });
    c.bench_function("deflate decompress random 1MB", |b| {
        b.iter(|| decompress(&r1m_c))
    });
}

criterion_group!(benches, bench_deflate);
criterion_main!(benches);
