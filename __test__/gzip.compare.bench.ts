import { randomBytes } from 'node:crypto';
import { gunzipSync as nodeGunzip, gzipSync as nodeGzip } from 'node:zlib';
import { decompressSync, gzipSync } from 'fflate';
import pako from 'pako';
import { bench, describe } from 'vitest';
import { gzipCompress, gzipDecompress } from '../index.js';

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
const SMALL_ZFLATE = gzipCompress(SMALL);
const SMALL_PAKO = Buffer.from(pako.gzip(SMALL));
const SMALL_FFLATE = Buffer.from(gzipSync(SMALL));
const SMALL_NODE = nodeGzip(SMALL);

const MEDIUM_ZFLATE = gzipCompress(MEDIUM);
const MEDIUM_PAKO = Buffer.from(pako.gzip(MEDIUM));
const MEDIUM_FFLATE = Buffer.from(gzipSync(MEDIUM));
const MEDIUM_NODE = nodeGzip(MEDIUM);

const LARGE_ZFLATE = gzipCompress(LARGE);
const LARGE_PAKO = Buffer.from(pako.gzip(LARGE));
const LARGE_FFLATE = Buffer.from(gzipSync(LARGE));
const LARGE_NODE = nodeGzip(LARGE);

const RANDOM_SMALL_ZFLATE = gzipCompress(RANDOM_SMALL);
const RANDOM_SMALL_PAKO = Buffer.from(pako.gzip(RANDOM_SMALL));
const RANDOM_SMALL_FFLATE = Buffer.from(gzipSync(RANDOM_SMALL));
const RANDOM_SMALL_NODE = nodeGzip(RANDOM_SMALL);

const RANDOM_MEDIUM_ZFLATE = gzipCompress(RANDOM_MEDIUM);
const RANDOM_MEDIUM_PAKO = Buffer.from(pako.gzip(RANDOM_MEDIUM));
const RANDOM_MEDIUM_FFLATE = Buffer.from(gzipSync(RANDOM_MEDIUM));
const RANDOM_MEDIUM_NODE = nodeGzip(RANDOM_MEDIUM);

const RANDOM_LARGE_ZFLATE = gzipCompress(RANDOM_LARGE);
const RANDOM_LARGE_PAKO = Buffer.from(pako.gzip(RANDOM_LARGE));
const RANDOM_LARGE_FFLATE = Buffer.from(gzipSync(RANDOM_LARGE));
const RANDOM_LARGE_NODE = nodeGzip(RANDOM_LARGE);

// =====================================================
// Compression benchmarks
// =====================================================

describe('gzip compress - 150B patterned', () => {
  bench('comprs', () => {
    gzipCompress(SMALL);
  });
  bench('pako', () => {
    pako.gzip(SMALL);
  });
  bench('fflate', () => {
    gzipSync(SMALL);
  });
  bench('node:zlib', () => {
    nodeGzip(SMALL);
  });
});

describe('gzip compress - 10KB patterned', () => {
  bench('comprs', () => {
    gzipCompress(MEDIUM);
  });
  bench('pako', () => {
    pako.gzip(MEDIUM);
  });
  bench('fflate', () => {
    gzipSync(MEDIUM);
  });
  bench('node:zlib', () => {
    nodeGzip(MEDIUM);
  });
});

describe('gzip compress - 1MB patterned', () => {
  bench('comprs', () => {
    gzipCompress(LARGE);
  });
  bench('pako', () => {
    pako.gzip(LARGE);
  });
  bench('fflate', () => {
    gzipSync(LARGE);
  });
  bench('node:zlib', () => {
    nodeGzip(LARGE);
  });
});

describe('gzip compress - 150B random', () => {
  bench('comprs', () => {
    gzipCompress(RANDOM_SMALL);
  });
  bench('pako', () => {
    pako.gzip(RANDOM_SMALL);
  });
  bench('fflate', () => {
    gzipSync(RANDOM_SMALL);
  });
  bench('node:zlib', () => {
    nodeGzip(RANDOM_SMALL);
  });
});

describe('gzip compress - 10KB random', () => {
  bench('comprs', () => {
    gzipCompress(RANDOM_MEDIUM);
  });
  bench('pako', () => {
    pako.gzip(RANDOM_MEDIUM);
  });
  bench('fflate', () => {
    gzipSync(RANDOM_MEDIUM);
  });
  bench('node:zlib', () => {
    nodeGzip(RANDOM_MEDIUM);
  });
});

describe('gzip compress - 1MB random', () => {
  bench('comprs', () => {
    gzipCompress(RANDOM_LARGE);
  });
  bench('pako', () => {
    pako.gzip(RANDOM_LARGE);
  });
  bench('fflate', () => {
    gzipSync(RANDOM_LARGE);
  });
  bench('node:zlib', () => {
    nodeGzip(RANDOM_LARGE);
  });
});

// =====================================================
// Decompression benchmarks
// =====================================================

describe('gzip decompress - 150B patterned', () => {
  bench('comprs', () => {
    gzipDecompress(SMALL_ZFLATE);
  });
  bench('pako', () => {
    pako.ungzip(SMALL_PAKO);
  });
  bench('fflate', () => {
    decompressSync(SMALL_FFLATE);
  });
  bench('node:zlib', () => {
    nodeGunzip(SMALL_NODE);
  });
});

describe('gzip decompress - 10KB patterned', () => {
  bench('comprs', () => {
    gzipDecompress(MEDIUM_ZFLATE);
  });
  bench('pako', () => {
    pako.ungzip(MEDIUM_PAKO);
  });
  bench('fflate', () => {
    decompressSync(MEDIUM_FFLATE);
  });
  bench('node:zlib', () => {
    nodeGunzip(MEDIUM_NODE);
  });
});

describe('gzip decompress - 1MB patterned', () => {
  bench('comprs', () => {
    gzipDecompress(LARGE_ZFLATE);
  });
  bench('pako', () => {
    pako.ungzip(LARGE_PAKO);
  });
  bench('fflate', () => {
    decompressSync(LARGE_FFLATE);
  });
  bench('node:zlib', () => {
    nodeGunzip(LARGE_NODE);
  });
});

describe('gzip decompress - 150B random', () => {
  bench('comprs', () => {
    gzipDecompress(RANDOM_SMALL_ZFLATE);
  });
  bench('pako', () => {
    pako.ungzip(RANDOM_SMALL_PAKO);
  });
  bench('fflate', () => {
    decompressSync(RANDOM_SMALL_FFLATE);
  });
  bench('node:zlib', () => {
    nodeGunzip(RANDOM_SMALL_NODE);
  });
});

describe('gzip decompress - 10KB random', () => {
  bench('comprs', () => {
    gzipDecompress(RANDOM_MEDIUM_ZFLATE);
  });
  bench('pako', () => {
    pako.ungzip(RANDOM_MEDIUM_PAKO);
  });
  bench('fflate', () => {
    decompressSync(RANDOM_MEDIUM_FFLATE);
  });
  bench('node:zlib', () => {
    nodeGunzip(RANDOM_MEDIUM_NODE);
  });
});

describe('gzip decompress - 1MB random', () => {
  bench('comprs', () => {
    gzipDecompress(RANDOM_LARGE_ZFLATE);
  });
  bench('pako', () => {
    pako.ungzip(RANDOM_LARGE_PAKO);
  });
  bench('fflate', () => {
    decompressSync(RANDOM_LARGE_FFLATE);
  });
  bench('node:zlib', () => {
    nodeGunzip(RANDOM_LARGE_NODE);
  });
});
