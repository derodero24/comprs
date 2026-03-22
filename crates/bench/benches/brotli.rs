use std::io::{Read, Write};

use criterion::{Criterion, criterion_group, criterion_main};
use zflate_bench::{patterned_1mb, patterned_10kb, random_1mb, random_10kb};

const BUFFER_SIZE: usize = 4096;
const LG_WINDOW_SIZE: u32 = 22;

fn compress(data: &[u8], quality: u32) -> Vec<u8> {
    let mut output = Vec::with_capacity(data.len());
    {
        let mut compressor =
            brotli::CompressorWriter::new(&mut output, BUFFER_SIZE, quality, LG_WINDOW_SIZE);
        compressor.write_all(data).unwrap();
    }
    output
}

fn decompress(data: &[u8]) -> Vec<u8> {
    let mut decompressor = brotli::Decompressor::new(data, BUFFER_SIZE);
    let mut output = Vec::new();
    decompressor.read_to_end(&mut output).unwrap();
    output
}

fn bench_brotli(c: &mut Criterion) {
    let p10k = patterned_10kb();
    let p1m = patterned_1mb();
    let r10k = random_10kb();
    let r1m = random_1mb();

    let p10k_c = compress(&p10k, 6);
    let p1m_c = compress(&p1m, 6);
    let r10k_c = compress(&r10k, 6);
    let r1m_c = compress(&r1m, 6);

    c.bench_function("brotli compress patterned 10KB", |b| {
        b.iter(|| compress(&p10k, 6))
    });
    c.bench_function("brotli compress patterned 1MB", |b| {
        b.iter(|| compress(&p1m, 6))
    });
    c.bench_function("brotli compress random 10KB", |b| {
        b.iter(|| compress(&r10k, 6))
    });
    c.bench_function("brotli compress random 1MB", |b| {
        b.iter(|| compress(&r1m, 6))
    });

    c.bench_function("brotli decompress patterned 10KB", |b| {
        b.iter(|| decompress(&p10k_c))
    });
    c.bench_function("brotli decompress patterned 1MB", |b| {
        b.iter(|| decompress(&p1m_c))
    });
    c.bench_function("brotli decompress random 10KB", |b| {
        b.iter(|| decompress(&r10k_c))
    });
    c.bench_function("brotli decompress random 1MB", |b| {
        b.iter(|| decompress(&r1m_c))
    });
}

criterion_group!(benches, bench_brotli);
criterion_main!(benches);
