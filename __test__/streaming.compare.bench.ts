import { Readable, type Transform, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip, createGzip } from 'node:zlib';
import { test } from 'vitest';
import {
  createGzipCompressTransform,
  createGzipDecompressTransform,
  createZstdCompressTransform,
  createZstdDecompressTransform,
} from '../node.js';
import { BENCH_OPTIONS } from './bench-fixtures.js';

// --- 1MB patterned data (compressible) ---
const CHUNK_SIZE = 16_384; // 16KB chunks
const DATA = Buffer.alloc(1_000_000);
for (let i = 0; i < DATA.length; i++) DATA[i] = i % 256;

/** Create a Readable from data, split into chunks of the given size. */
function toChunkedReadable(data: Buffer, chunkSize: number): Readable {
  let offset = 0;
  return new Readable({
    read() {
      if (offset >= data.length) {
        this.push(null);
        return;
      }
      const end = Math.min(offset + chunkSize, data.length);
      this.push(data.subarray(offset, end));
      offset = end;
    },
  });
}

/** Run a pipeline from source through the transforms, discarding the output. */
async function collectPipeline(source: Readable, ...transforms: Transform[]): Promise<void> {
  const sink = new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
  await pipeline([source, ...transforms, sink]);
}

/** Compress DATA in 16KB chunks with the given transform. */
async function compressData(transform: Transform): Promise<Buffer> {
  const chunks: Buffer[] = [];
  const sink = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      chunks.push(chunk);
      callback();
    },
  });
  await pipeline(toChunkedReadable(DATA, CHUNK_SIZE), transform, sink);
  return Buffer.concat(chunks);
}

// =====================================================
// Gzip streaming compression benchmarks
// =====================================================

test('gzip stream compress - 1MB (16KB chunks)', async ({ bench }) => {
  await bench.compare(
    bench('comprs', async () => {
      await collectPipeline(toChunkedReadable(DATA, CHUNK_SIZE), createGzipCompressTransform());
    }),
    bench('node:zlib', async () => {
      await collectPipeline(toChunkedReadable(DATA, CHUNK_SIZE), createGzip());
    }),
    BENCH_OPTIONS,
  );
});

// =====================================================
// Gzip streaming decompression benchmarks
// =====================================================

test('gzip stream decompress - 1MB (16KB chunks)', async ({ bench }) => {
  const compressedComprs = await compressData(createGzipCompressTransform());
  const compressedNode = await compressData(createGzip());
  await bench.compare(
    bench('comprs', async () => {
      await collectPipeline(
        toChunkedReadable(compressedComprs, CHUNK_SIZE),
        createGzipDecompressTransform(),
      );
    }),
    bench('node:zlib', async () => {
      await collectPipeline(toChunkedReadable(compressedNode, CHUNK_SIZE), createGunzip());
    }),
    BENCH_OPTIONS,
  );
});

// =====================================================
// Gzip streaming round-trip benchmarks
// =====================================================

test('gzip stream round-trip - 1MB (16KB chunks)', async ({ bench }) => {
  await bench.compare(
    bench('comprs', async () => {
      await collectPipeline(
        toChunkedReadable(DATA, CHUNK_SIZE),
        createGzipCompressTransform(),
        createGzipDecompressTransform(),
      );
    }),
    bench('node:zlib', async () => {
      await collectPipeline(toChunkedReadable(DATA, CHUNK_SIZE), createGzip(), createGunzip());
    }),
    BENCH_OPTIONS,
  );
});

// =====================================================
// Zstd streaming compression benchmarks
// =====================================================

test('zstd stream compress - 1MB (16KB chunks)', async ({ bench }) => {
  await bench('comprs', async () => {
    await collectPipeline(toChunkedReadable(DATA, CHUNK_SIZE), createZstdCompressTransform());
  }).run(BENCH_OPTIONS);
});

// =====================================================
// Zstd streaming decompression benchmarks
// =====================================================

test('zstd stream decompress - 1MB (16KB chunks)', async ({ bench }) => {
  const compressed = await compressData(createZstdCompressTransform());
  await bench('comprs', async () => {
    await collectPipeline(
      toChunkedReadable(compressed, CHUNK_SIZE),
      createZstdDecompressTransform(),
    );
  }).run(BENCH_OPTIONS);
});

// =====================================================
// Zstd streaming round-trip benchmarks
// =====================================================

test('zstd stream round-trip - 1MB (16KB chunks)', async ({ bench }) => {
  await bench('comprs', async () => {
    await collectPipeline(
      toChunkedReadable(DATA, CHUNK_SIZE),
      createZstdCompressTransform(),
      createZstdDecompressTransform(),
    );
  }).run(BENCH_OPTIONS);
});
