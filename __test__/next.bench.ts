import { test } from 'vitest';
import {
  brotliCompress,
  brotliDecompress,
  deflateCompress,
  deflateDecompress,
  gzipCompress,
  gzipDecompress,
  lz4Compress,
  lz4Decompress,
  zstdCompress,
  zstdCompressAsync,
  zstdDecompress,
} from '../index.js';
import { compress, compressSync, decompressSync, type Format } from '../next/index.js';
import { BENCH_OPTIONS, JSON_DATA } from './bench-fixtures.js';

// The overhead of the unified API (@derodero24/comprs/next) over the root
// entry's functions, which compress at the same settings: the options
// object, the checks of the TypeScript layer, and the plain Uint8Array
// results. Short inputs show it best. The root entry writes no zlib, so
// 'deflate' is compared with its raw deflate, deflateCompress(), which skips
// the zlib header and the Adler-32 checksum. The unified API decodes gzip
// and brotli with strict decoders, which also check what follows the
// compressed stream. Both sides are comprs, so `pnpm run bench:ci` runs
// these with the other benchmarks of comprs alone; the comparisons with
// other libraries are the *.compare.bench.ts files.

/** The root entry's functions for each format. */
const ROOT: Record<
  Format,
  { compress(data: Uint8Array): Uint8Array; decompress(data: Uint8Array): Uint8Array }
> = {
  zstd: { compress: zstdCompress, decompress: zstdDecompress },
  gzip: { compress: gzipCompress, decompress: gzipDecompress },
  deflate: { compress: deflateCompress, decompress: deflateDecompress },
  'deflate-raw': { compress: deflateCompress, decompress: deflateDecompress },
  brotli: { compress: brotliCompress, decompress: brotliDecompress },
  lz4: { compress: lz4Compress, decompress: lz4Decompress },
};

const FORMATS: readonly Format[] = ['zstd', 'gzip', 'deflate', 'deflate-raw', 'brotli', 'lz4'];

const SIZES = [
  ['1KB', JSON_DATA.subarray(0, 1024)],
  ['64KB', JSON_DATA.subarray(0, 64 * 1024)],
] as const;

for (const format of FORMATS) {
  const root = ROOT[format];
  for (const [size, data] of SIZES) {
    test(`${format} compress - ${size} JSON`, async ({ bench }) => {
      await bench.compare(
        bench('root', () => {
          root.compress(data);
        }),
        bench('next', () => {
          compressSync(data, { format });
        }),
        BENCH_OPTIONS,
      );
    });

    const fromRoot = root.compress(data);
    const fromNext = compressSync(data, { format });
    test(`${format} decompress - ${size} JSON`, async ({ bench }) => {
      await bench.compare(
        bench('root', () => {
          root.decompress(fromRoot);
        }),
        bench('next', () => {
          decompressSync(fromNext, { format });
        }),
        BENCH_OPTIONS,
      );
    });
  }
}

test('zstd compress async - 1KB JSON', async ({ bench }) => {
  const data = JSON_DATA.subarray(0, 1024);
  await bench.compare(
    bench('root', async () => {
      await zstdCompressAsync(data);
    }),
    bench('next', async () => {
      await compress(data, { format: 'zstd' });
    }),
    BENCH_OPTIONS,
  );
});
