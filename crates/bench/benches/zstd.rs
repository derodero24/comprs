use criterion::{Criterion, criterion_group, criterion_main};
use zflate_bench::{patterned_1mb, patterned_10kb, random_1mb, random_10kb};

fn compress(data: &[u8], level: i32) -> Vec<u8> {
    zstd::bulk::compress(data, level).unwrap()
}

fn decompress(data: &[u8]) -> Vec<u8> {
    zstd::bulk::decompress(data, 1_000_000).unwrap()
}

fn bench_zstd(c: &mut Criterion) {
    let p10k = patterned_10kb();
    let p1m = patterned_1mb();
    let r10k = random_10kb();
    let r1m = random_1mb();

    let p10k_c = compress(&p10k, 3);
    let p1m_c = compress(&p1m, 3);
    let r10k_c = compress(&r10k, 3);
    let r1m_c = compress(&r1m, 3);

    c.bench_function("zstd compress patterned 10KB", |b| {
        b.iter(|| compress(&p10k, 3))
    });
    c.bench_function("zstd compress patterned 1MB", |b| {
        b.iter(|| compress(&p1m, 3))
    });
    c.bench_function("zstd compress random 10KB", |b| {
        b.iter(|| compress(&r10k, 3))
    });
    c.bench_function("zstd compress random 1MB", |b| b.iter(|| compress(&r1m, 3)));

    c.bench_function("zstd decompress patterned 10KB", |b| {
        b.iter(|| decompress(&p10k_c))
    });
    c.bench_function("zstd decompress patterned 1MB", |b| {
        b.iter(|| decompress(&p1m_c))
    });
    c.bench_function("zstd decompress random 10KB", |b| {
        b.iter(|| decompress(&r10k_c))
    });
    c.bench_function("zstd decompress random 1MB", |b| {
        b.iter(|| decompress(&r1m_c))
    });
}

criterion_group!(benches, bench_zstd);
criterion_main!(benches);
