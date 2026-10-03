use std::io::Read;

use comprs_bench::{inputs, json_84kb, run_stream, stream_inputs};
use comprs_core::gzip;
use comprs_core::gzip_stream::{GzipCompressContext, GzipDecompressContext};
use criterion::{Criterion, criterion_group, criterion_main};
use flate2::read::MultiGzDecoder;

fn bench_gzip(c: &mut Criterion) {
    for (name, data) in inputs() {
        let compressed = gzip::compress(&data, None).unwrap();
        c.bench_function(&format!("gzip compress {name}"), |b| {
            b.iter(|| gzip::compress(&data, None).unwrap())
        });
        c.bench_function(&format!("gzip decompress {name}"), |b| {
            b.iter(|| gzip::decompress(&compressed).unwrap())
        });
    }

    for (name, data) in stream_inputs() {
        let compressed = gzip::compress(&data, None).unwrap();
        c.bench_function(&format!("gzip stream compress {name}"), |b| {
            b.iter(|| {
                run_stream(
                    GzipCompressContext::new(None).unwrap(),
                    &data,
                    GzipCompressContext::transform,
                    GzipCompressContext::finish,
                )
            })
        });
        c.bench_function(&format!("gzip stream decompress {name}"), |b| {
            b.iter(|| {
                run_stream(
                    GzipDecompressContext::new(None).unwrap(),
                    &compressed,
                    GzipDecompressContext::transform,
                    GzipDecompressContext::finish,
                )
            })
        });
    }

    // Baseline: flate2 alone. The difference is what comprs adds to
    // decompression: sizing the output from the gzip trailer and enforcing
    // the output limit.
    let compressed = gzip::compress(&json_84kb(), None).unwrap();
    c.bench_function("gzip decompress json 84KB (upstream)", |b| {
        b.iter(|| {
            let mut output = Vec::new();
            MultiGzDecoder::new(compressed.as_slice())
                .read_to_end(&mut output)
                .unwrap();
            output
        })
    });
}

criterion_group!(benches, bench_gzip);
criterion_main!(benches);
