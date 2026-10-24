use std::io::Read;

use comprs_bench::{inputs, json_84kb, run_stream, stream_inputs};
use comprs_core::gzip::{deflate_compress, deflate_decompress};
use comprs_core::gzip_stream::{DeflateCompressContext, DeflateDecompressContext};
use criterion::{Criterion, criterion_group, criterion_main};
use flate2::read::DeflateDecoder;

fn bench_deflate(c: &mut Criterion) {
    for (name, data) in inputs() {
        let compressed = deflate_compress(&data, None).unwrap();
        c.bench_function(&format!("deflate compress {name}"), |b| {
            b.iter(|| deflate_compress(&data, None).unwrap())
        });
        c.bench_function(&format!("deflate decompress {name}"), |b| {
            b.iter(|| deflate_decompress(&compressed).unwrap())
        });
    }

    for (name, data) in stream_inputs() {
        let compressed = deflate_compress(&data, None).unwrap();
        c.bench_function(&format!("deflate stream compress {name}"), |b| {
            b.iter(|| {
                run_stream(
                    DeflateCompressContext::new(None).unwrap(),
                    &data,
                    DeflateCompressContext::transform,
                    DeflateCompressContext::finish,
                )
            })
        });
        c.bench_function(&format!("deflate stream decompress {name}"), |b| {
            b.iter(|| {
                run_stream(
                    DeflateDecompressContext::new(None).unwrap(),
                    &compressed,
                    DeflateDecompressContext::transform,
                    DeflateDecompressContext::finish,
                )
            })
        });
    }

    // Baseline: flate2 alone. The difference is what comprs adds to
    // decompression: its own inflate loop, which detects truncated input
    // and enforces the output limit.
    let compressed = deflate_compress(&json_84kb(), None).unwrap();
    c.bench_function("deflate decompress json 84KB (upstream)", |b| {
        b.iter(|| {
            let mut output = Vec::new();
            DeflateDecoder::new(compressed.as_slice())
                .read_to_end(&mut output)
                .unwrap();
            output
        })
    });
}

criterion_group!(benches, bench_deflate);
criterion_main!(benches);
