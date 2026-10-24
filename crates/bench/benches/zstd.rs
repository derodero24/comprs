use comprs_bench::{
    DICT_SIZE, dict_message, dict_samples, inputs, json_84kb, run_stream, stream_inputs,
};
use comprs_core::dictionary::{Dictionary, DictionaryFormat};
use comprs_core::{MAX_DECOMPRESSED_SIZE, zstd, zstd_stream};
use criterion::{Criterion, criterion_group, criterion_main};

fn bench_zstd(c: &mut Criterion) {
    for (name, data) in inputs() {
        let compressed = zstd::compress(&data, None).unwrap();
        c.bench_function(&format!("zstd compress {name}"), |b| {
            b.iter(|| zstd::compress(&data, None).unwrap())
        });
        c.bench_function(&format!("zstd decompress {name}"), |b| {
            b.iter(|| zstd::decompress(&compressed).unwrap())
        });
    }

    for (name, data) in stream_inputs() {
        let compressed = zstd::compress(&data, None).unwrap();
        c.bench_function(&format!("zstd stream compress {name}"), |b| {
            b.iter(|| {
                run_stream(
                    zstd_stream::CompressContext::new(None).unwrap(),
                    &data,
                    zstd_stream::CompressContext::transform,
                    zstd_stream::CompressContext::finish,
                )
            })
        });
        c.bench_function(&format!("zstd stream decompress {name}"), |b| {
            b.iter(|| {
                run_stream(
                    zstd_stream::DecompressContext::new(None).unwrap(),
                    &compressed,
                    zstd_stream::DecompressContext::transform,
                    zstd_stream::DecompressContext::finish,
                )
            })
        });
    }

    let dict = zstd::train_dictionary(&dict_samples(), DICT_SIZE).unwrap();
    let message = dict_message();
    let compressed = zstd::compress_with_dict(&message, &dict, None).unwrap();
    c.bench_function("zstd compress with dict json record", |b| {
        b.iter(|| zstd::compress_with_dict(&message, &dict, None).unwrap())
    });
    c.bench_function("zstd decompress with dict json record", |b| {
        b.iter(|| zstd::decompress_with_dict(&compressed, &dict).unwrap())
    });
    // The same dictionary, digested once before the measurement instead of
    // in every call.
    let prepared = Dictionary::new(&dict, DictionaryFormat::Zstd, None).unwrap();
    c.bench_function("zstd compress prepared dict json record", |b| {
        b.iter(|| zstd::compress_prepared(&message, &prepared, None, 0).unwrap())
    });
    c.bench_function("zstd decompress prepared dict json record", |b| {
        b.iter(|| zstd::decompress_prepared(&compressed, &prepared, MAX_DECOMPRESSED_SIZE).unwrap())
    });

    // Baseline: the zstd crate alone, given the output size. The difference
    // is what comprs adds to decompression: finding the output size and
    // enforcing the output limit.
    let data = json_84kb();
    let compressed = zstd::compress(&data, None).unwrap();
    c.bench_function("zstd decompress json 84KB (upstream)", |b| {
        b.iter(|| ::zstd::bulk::decompress(&compressed, data.len()).unwrap())
    });
}

criterion_group!(benches, bench_zstd);
criterion_main!(benches);
