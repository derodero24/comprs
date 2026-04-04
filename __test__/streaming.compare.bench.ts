import { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip, createGzip } from 'node:zlib';
import { bench, describe } from 'vitest';
import {
  createGzipCompressTransform,
  createGzipDecompressTransform,
  createZstdCompressTransform,
  createZstdDecompressTransform,
} from '../node.js';

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

/** Collect pipeline output into a Buffer, discarding results. */
async function collectPipeline(
  ...streams: Array<Readable | NodeJS.ReadWriteStream | Writable>
): Promise<void> {
  const sink = new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
  await pipeline(...streams, sink);
}

// --- Pre-compressed data for decompression benchmarks ---
async function compressWithComprs(data: Buffer): Promise<Buffer> {
  const chunks: Buffer[] = [];
  const sink = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(chunk);
      callback();
    },
  });
  await pipeline(toChunkedReadable(data, CHUNK_SIZE), createGzipCompressTransform(), sink);
  return Buffer.concat(chunks);
}

async function compressWithNode(data: Buffer): Promise<Buffer> {
  const chunks: Buffer[] = [];
  const sink = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(chunk);
      callback();
    },
  });
  await pipeline(toChunkedReadable(data, CHUNK_SIZE), createGzip(), sink);
  return Buffer.concat(chunks);
}

async function compressZstdWithComprs(data: Buffer): Promise<Buffer> {
  const chunks: Buffer[] = [];
  const sink = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(chunk);
      callback();
    },
  });
  await pipeline(toChunkedReadable(data, CHUNK_SIZE), createZstdCompressTransform(), sink);
  return Buffer.concat(chunks);
}

let GZIP_COMPRESSED_COMPRS: Buffer;
let GZIP_COMPRESSED_NODE: Buffer;
let ZSTD_COMPRESSED_COMPRS: Buffer;

// Initialize pre-compressed data synchronously via top-level await
// (vitest supports top-level await in bench files)
GZIP_COMPRESSED_COMPRS = await compressWithComprs(DATA);
GZIP_COMPRESSED_NODE = await compressWithNode(DATA);
ZSTD_COMPRESSED_COMPRS = await compressZstdWithComprs(DATA);

// =====================================================
// Gzip streaming compression benchmarks
// =====================================================

describe('gzip stream compress - 1MB (16KB chunks)', () => {
  bench('comprs', async () => {
    await collectPipeline(toChunkedReadable(DATA, CHUNK_SIZE), createGzipCompressTransform());
  });
  bench('node:zlib', async () => {
    await collectPipeline(toChunkedReadable(DATA, CHUNK_SIZE), createGzip());
  });
});

// =====================================================
// Gzip streaming decompression benchmarks
// =====================================================

describe('gzip stream decompress - 1MB (16KB chunks)', () => {
  bench('comprs', async () => {
    await collectPipeline(
      toChunkedReadable(GZIP_COMPRESSED_COMPRS, CHUNK_SIZE),
      createGzipDecompressTransform(),
    );
  });
  bench('node:zlib', async () => {
    await collectPipeline(toChunkedReadable(GZIP_COMPRESSED_NODE, CHUNK_SIZE), createGunzip());
  });
});

// =====================================================
// Gzip streaming round-trip benchmarks
// =====================================================

describe('gzip stream round-trip - 1MB (16KB chunks)', () => {
  bench('comprs', async () => {
    await collectPipeline(
      toChunkedReadable(DATA, CHUNK_SIZE),
      createGzipCompressTransform(),
      createGzipDecompressTransform(),
    );
  });
  bench('node:zlib', async () => {
    await collectPipeline(toChunkedReadable(DATA, CHUNK_SIZE), createGzip(), createGunzip());
  });
});

// =====================================================
// Zstd streaming compression benchmarks
// =====================================================

describe('zstd stream compress - 1MB (16KB chunks)', () => {
  bench('comprs', async () => {
    await collectPipeline(toChunkedReadable(DATA, CHUNK_SIZE), createZstdCompressTransform());
  });
});

// =====================================================
// Zstd streaming decompression benchmarks
// =====================================================

describe('zstd stream decompress - 1MB (16KB chunks)', () => {
  bench('comprs', async () => {
    await collectPipeline(
      toChunkedReadable(ZSTD_COMPRESSED_COMPRS, CHUNK_SIZE),
      createZstdDecompressTransform(),
    );
  });
});

// =====================================================
// Zstd streaming round-trip benchmarks
// =====================================================

describe('zstd stream round-trip - 1MB (16KB chunks)', () => {
  bench('comprs', async () => {
    await collectPipeline(
      toChunkedReadable(DATA, CHUNK_SIZE),
      createZstdCompressTransform(),
      createZstdDecompressTransform(),
    );
  });
});
