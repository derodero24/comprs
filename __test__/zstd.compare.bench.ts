import { randomBytes } from 'node:crypto';
import * as zlib from 'node:zlib';
import { type Bench, type BenchFn, test } from 'vitest';
import { zstdCompress, zstdDecompress } from '../index.js';
import { BENCH_OPTIONS } from './bench-fixtures.js';

const HAS_NODE_ZSTD = typeof zlib.zstdCompressSync === 'function';

const nodeZstdCompress = (data: Buffer): Buffer =>
  zlib.zstdCompressSync(data, {
    params: { [zlib.constants.ZSTD_c_compressionLevel]: 3 },
  });

const nodeZstdDecompress = (data: Buffer): Buffer => zlib.zstdDecompressSync(data);

// Compares comprs with node:zlib, or measures comprs alone where node:zlib
// has no zstd (Node.js before 22.15).
async function compareWithNodeZlib(
  bench: Bench,
  comprs: BenchFn,
  nodeZlib: BenchFn,
): Promise<void> {
  const comprsBench = bench('comprs', comprs);
  if (HAS_NODE_ZSTD) {
    await bench.compare(comprsBench, bench('node:zlib', nodeZlib), BENCH_OPTIONS);
  } else {
    await comprsBench.run(BENCH_OPTIONS);
  }
}

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

test('zstd compress - 150B patterned', async ({ bench }) => {
  await compareWithNodeZlib(
    bench,
    () => {
      zstdCompress(SMALL);
    },
    () => {
      nodeZstdCompress(SMALL);
    },
  );
});

test('zstd compress - 10KB patterned', async ({ bench }) => {
  await compareWithNodeZlib(
    bench,
    () => {
      zstdCompress(MEDIUM);
    },
    () => {
      nodeZstdCompress(MEDIUM);
    },
  );
});

test('zstd compress - 1MB patterned', async ({ bench }) => {
  await compareWithNodeZlib(
    bench,
    () => {
      zstdCompress(LARGE);
    },
    () => {
      nodeZstdCompress(LARGE);
    },
  );
});

test('zstd compress - 150B random', async ({ bench }) => {
  await compareWithNodeZlib(
    bench,
    () => {
      zstdCompress(RANDOM_SMALL);
    },
    () => {
      nodeZstdCompress(RANDOM_SMALL);
    },
  );
});

test('zstd compress - 10KB random', async ({ bench }) => {
  await compareWithNodeZlib(
    bench,
    () => {
      zstdCompress(RANDOM_MEDIUM);
    },
    () => {
      nodeZstdCompress(RANDOM_MEDIUM);
    },
  );
});

test('zstd compress - 1MB random', async ({ bench }) => {
  await compareWithNodeZlib(
    bench,
    () => {
      zstdCompress(RANDOM_LARGE);
    },
    () => {
      nodeZstdCompress(RANDOM_LARGE);
    },
  );
});

// =====================================================
// Decompression benchmarks
// =====================================================

test('zstd decompress - 150B patterned', async ({ bench }) => {
  await compareWithNodeZlib(
    bench,
    () => {
      zstdDecompress(SMALL_COMPRS);
    },
    () => {
      nodeZstdDecompress(SMALL_NODE);
    },
  );
});

test('zstd decompress - 10KB patterned', async ({ bench }) => {
  await compareWithNodeZlib(
    bench,
    () => {
      zstdDecompress(MEDIUM_COMPRS);
    },
    () => {
      nodeZstdDecompress(MEDIUM_NODE);
    },
  );
});

test('zstd decompress - 1MB patterned', async ({ bench }) => {
  await compareWithNodeZlib(
    bench,
    () => {
      zstdDecompress(LARGE_COMPRS);
    },
    () => {
      nodeZstdDecompress(LARGE_NODE);
    },
  );
});

test('zstd decompress - 150B random', async ({ bench }) => {
  await compareWithNodeZlib(
    bench,
    () => {
      zstdDecompress(RANDOM_SMALL_COMPRS);
    },
    () => {
      nodeZstdDecompress(RANDOM_SMALL_NODE);
    },
  );
});

test('zstd decompress - 10KB random', async ({ bench }) => {
  await compareWithNodeZlib(
    bench,
    () => {
      zstdDecompress(RANDOM_MEDIUM_COMPRS);
    },
    () => {
      nodeZstdDecompress(RANDOM_MEDIUM_NODE);
    },
  );
});

test('zstd decompress - 1MB random', async ({ bench }) => {
  await compareWithNodeZlib(
    bench,
    () => {
      zstdDecompress(RANDOM_LARGE_COMPRS);
    },
    () => {
      nodeZstdDecompress(RANDOM_LARGE_NODE);
    },
  );
});
