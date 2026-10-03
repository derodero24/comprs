use std::io::Read;

use comprs_bench::{
    DICT_SIZE, dict_message, dict_samples, inputs, json_84kb, run_stream, stream_inputs,
};
use comprs_core::{brotli, brotli_stream};
use criterion::{Criterion, criterion_group, criterion_main};

fn bench_brotli(c: &mut Criterion) {
    for (name, data) in inputs() {
        let compressed = brotli::compress(&data, None).unwrap();
        c.bench_function(&format!("brotli compress {name}"), |b| {
            b.iter(|| brotli::compress(&data, None).unwrap())
        });
        c.bench_function(&format!("brotli decompress {name}"), |b| {
            b.iter(|| brotli::decompress(&compressed).unwrap())
        });
    }

    for (name, data) in stream_inputs() {
        let compressed = brotli::compress(&data, None).unwrap();
        c.bench_function(&format!("brotli stream compress {name}"), |b| {
            b.iter(|| {
                run_stream(
                    brotli_stream::CompressContext::new(None).unwrap(),
                    &data,
                    brotli_stream::CompressContext::transform,
                    brotli_stream::CompressContext::finish,
                )
            })
        });
        c.bench_function(&format!("brotli stream decompress {name}"), |b| {
            b.iter(|| {
                run_stream(
                    brotli_stream::DecompressContext::new(None).unwrap(),
                    &compressed,
                    brotli_stream::DecompressContext::transform,
                    brotli_stream::DecompressContext::finish,
                )
            })
        });
    }

    // brotli has no dictionary training: the dictionary is raw sample data.
    let dict = dict_samples().concat()[..DICT_SIZE].to_vec();
    let message = dict_message();
    let compressed = brotli::compress_with_dict(&message, &dict, None).unwrap();
    c.bench_function("brotli compress with dict json record", |b| {
        b.iter(|| brotli::compress_with_dict(&message, &dict, None).unwrap())
    });
    c.bench_function("brotli decompress with dict json record", |b| {
        b.iter(|| brotli::decompress_with_dict(&compressed, &dict).unwrap())
    });

    // Baseline: the brotli crate alone. The difference is what comprs adds
    // to decompression: sizing the output and enforcing the output limit.
    let compressed = brotli::compress(&json_84kb(), None).unwrap();
    c.bench_function("brotli decompress json 84KB (upstream)", |b| {
        b.iter(|| {
            let mut output = Vec::new();
            ::brotli::Decompressor::new(compressed.as_slice(), brotli::BUFFER_SIZE)
                .read_to_end(&mut output)
                .unwrap();
            output
        })
    });
}

criterion_group!(benches, bench_brotli);
criterion_main!(benches);
