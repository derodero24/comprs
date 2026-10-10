use std::io::{Read, Write};

use comprs_bench::{inputs, json_84kb, run_stream, stream_inputs};
use comprs_core::{lz4, lz4_stream};
use criterion::{Criterion, criterion_group, criterion_main};
use lz4_flex::frame::{BlockSize, FrameDecoder, FrameEncoder, FrameInfo};

fn bench_lz4(c: &mut Criterion) {
    for (name, data) in inputs() {
        let compressed = lz4::compress(&data).unwrap();
        c.bench_function(&format!("lz4 compress {name}"), |b| {
            b.iter(|| lz4::compress(&data).unwrap())
        });
        c.bench_function(&format!("lz4 decompress {name}"), |b| {
            b.iter(|| lz4::decompress(&compressed).unwrap())
        });
    }

    for (name, data) in stream_inputs() {
        let compressed = lz4::compress(&data).unwrap();
        c.bench_function(&format!("lz4 stream compress {name}"), |b| {
            b.iter(|| {
                run_stream(
                    lz4_stream::CompressContext::new(),
                    &data,
                    lz4_stream::CompressContext::transform,
                    lz4_stream::CompressContext::finish,
                )
            })
        });
        // The decompression context buffers its input and decodes it all in
        // flush(), which ends the stream.
        c.bench_function(&format!("lz4 stream decompress {name}"), |b| {
            b.iter(|| {
                run_stream(
                    lz4_stream::DecompressContext::new(None).unwrap(),
                    &compressed,
                    lz4_stream::DecompressContext::transform,
                    lz4_stream::DecompressContext::flush,
                )
            })
        });
    }

    // Frames from other encoders, with other block sizes than lz4::compress
    // writes: the `lz4` CLI declares 4 MB blocks by default, the reference
    // LZ4 frame library 64 KB.
    let json = json_84kb();
    for (name, block_size) in [("4 MB", BlockSize::Max4MB), ("64 KB", BlockSize::Max64KB)] {
        let frame_info = FrameInfo::new()
            .block_size(block_size)
            .content_checksum(true);
        let mut encoder = FrameEncoder::with_frame_info(frame_info, Vec::new());
        encoder.write_all(&json).unwrap();
        let compressed = encoder.finish().unwrap();
        c.bench_function(&format!("lz4 decompress json 84KB ({name} blocks)"), |b| {
            b.iter(|| lz4::decompress(&compressed).unwrap())
        });
    }

    // Baseline: lz4_flex alone. The difference is what comprs adds to
    // decompression: sizing the output and enforcing the output limit.
    let compressed = lz4::compress(&json_84kb()).unwrap();
    c.bench_function("lz4 decompress json 84KB (upstream)", |b| {
        b.iter(|| {
            let mut output = Vec::new();
            FrameDecoder::new(compressed.as_slice())
                .read_to_end(&mut output)
                .unwrap();
            output
        })
    });
}

criterion_group!(benches, bench_lz4);
criterion_main!(benches);
