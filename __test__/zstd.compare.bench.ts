import { randomBytes } from 'node:crypto';
import * as zlib from 'node:zlib';
import { bench, describe } from 'vitest';
import { zstdCompress, zstdDecompress } from '../index.js';

const HAS_NODE_ZSTD = typeof zlib.zstdCompressSync === 'function';

const nodeZstdCompress = (data: Buffer): Buffer =>
  zlib.zstdCompressSync(data, {
    params: { [zlib.constants.ZSTD_c_compressionLevel]: 3 },
  });

const nodeZstdDecompress = (data: Buffer): Buffer => zlib.zstdDecompressSync(data);

// --- Patterned data (compressible) ---
const SMALL = Buffer.from('Hello, comprs! '.repeat(10));
const MEDIUM = Buffer.alloc(10_000);
for (let i = 0; i < MEDIUM.length; i++) MEDIUM[i] = i % 256;
const LARGE = Buffer.alloc(1_000_000);
for (let i = 0; i < LARGE.length; i++) LARGE[i] = i % 256;

// --- Random data (incompressible) ---
const RANDOM_SMALL = randomBytes(150);
const RANDOM_MEDIUM = randomBytes(10_000);
const RANDOM_LARGE = randomBytes(1_000_000);

// --- Pre-compressed data for decompression benchmarks ---
const SMALL_COMPRS = zstdCompress(SMALL);
const SMALL_NODE = HAS_NODE_ZSTD ? nodeZstdCompress(SMALL) : SMALL_COMPRS;

const MEDIUM_COMPRS = zstdCompress(MEDIUM);
const MEDIUM_NODE = HAS_NODE_ZSTD ? nodeZstdCompress(MEDIUM) : MEDIUM_COMPRS;

const LARGE_COMPRS = zstdCompress(LARGE);
const LARGE_NODE = HAS_NODE_ZSTD ? nodeZstdCompress(LARGE) : LARGE_COMPRS;

const RANDOM_SMALL_COMPRS = zstdCompress(RANDOM_SMALL);
const RANDOM_SMALL_NODE = HAS_NODE_ZSTD ? nodeZstdCompress(RANDOM_SMALL) : RANDOM_SMALL_COMPRS;

const RANDOM_MEDIUM_COMPRS = zstdCompress(RANDOM_MEDIUM);
const RANDOM_MEDIUM_NODE = HAS_NODE_ZSTD ? nodeZstdCompress(RANDOM_MEDIUM) : RANDOM_MEDIUM_COMPRS;

const RANDOM_LARGE_COMPRS = zstdCompress(RANDOM_LARGE);
const RANDOM_LARGE_NODE = HAS_NODE_ZSTD ? nodeZstdCompress(RANDOM_LARGE) : RANDOM_LARGE_COMPRS;

// =====================================================
// Compression benchmarks
// =====================================================

describe('zstd compress - 150B patterned', () => {
  bench('comprs', () => {
    zstdCompress(SMALL);
  });
  bench.skipIf(!HAS_NODE_ZSTD)('node:zlib', () => {
    nodeZstdCompress(SMALL);
  });
});

describe('zstd compress - 10KB patterned', () => {
  bench('comprs', () => {
    zstdCompress(MEDIUM);
  });
  bench.skipIf(!HAS_NODE_ZSTD)('node:zlib', () => {
    nodeZstdCompress(MEDIUM);
  });
});

describe('zstd compress - 1MB patterned', () => {
  bench('comprs', () => {
    zstdCompress(LARGE);
  });
  bench.skipIf(!HAS_NODE_ZSTD)('node:zlib', () => {
    nodeZstdCompress(LARGE);
  });
});

describe('zstd compress - 150B random', () => {
  bench('comprs', () => {
    zstdCompress(RANDOM_SMALL);
  });
  bench.skipIf(!HAS_NODE_ZSTD)('node:zlib', () => {
    nodeZstdCompress(RANDOM_SMALL);
  });
});

describe('zstd compress - 10KB random', () => {
  bench('comprs', () => {
    zstdCompress(RANDOM_MEDIUM);
  });
  bench.skipIf(!HAS_NODE_ZSTD)('node:zlib', () => {
    nodeZstdCompress(RANDOM_MEDIUM);
  });
});

describe('zstd compress - 1MB random', () => {
  bench('comprs', () => {
    zstdCompress(RANDOM_LARGE);
  });
  bench.skipIf(!HAS_NODE_ZSTD)('node:zlib', () => {
    nodeZstdCompress(RANDOM_LARGE);
  });
});

// =====================================================
// Decompression benchmarks
// =====================================================

describe('zstd decompress - 150B patterned', () => {
  bench('comprs', () => {
    zstdDecompress(SMALL_COMPRS);
  });
  bench.skipIf(!HAS_NODE_ZSTD)('node:zlib', () => {
    nodeZstdDecompress(SMALL_NODE);
  });
});

describe('zstd decompress - 10KB patterned', () => {
  bench('comprs', () => {
    zstdDecompress(MEDIUM_COMPRS);
  });
  bench.skipIf(!HAS_NODE_ZSTD)('node:zlib', () => {
    nodeZstdDecompress(MEDIUM_NODE);
  });
});

describe('zstd decompress - 1MB patterned', () => {
  bench('comprs', () => {
    zstdDecompress(LARGE_COMPRS);
  });
  bench.skipIf(!HAS_NODE_ZSTD)('node:zlib', () => {
    nodeZstdDecompress(LARGE_NODE);
  });
});

describe('zstd decompress - 150B random', () => {
  bench('comprs', () => {
    zstdDecompress(RANDOM_SMALL_COMPRS);
  });
  bench.skipIf(!HAS_NODE_ZSTD)('node:zlib', () => {
    nodeZstdDecompress(RANDOM_SMALL_NODE);
  });
});

describe('zstd decompress - 10KB random', () => {
  bench('comprs', () => {
    zstdDecompress(RANDOM_MEDIUM_COMPRS);
  });
  bench.skipIf(!HAS_NODE_ZSTD)('node:zlib', () => {
    nodeZstdDecompress(RANDOM_MEDIUM_NODE);
  });
});

describe('zstd decompress - 1MB random', () => {
  bench('comprs', () => {
    zstdDecompress(RANDOM_LARGE_COMPRS);
  });
  bench.skipIf(!HAS_NODE_ZSTD)('node:zlib', () => {
    nodeZstdDecompress(RANDOM_LARGE_NODE);
  });
});
