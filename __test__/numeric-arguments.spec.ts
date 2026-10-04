import { describe, expect, it } from 'vitest';
import {
  BrotliCompressContext,
  BrotliCompressDictContext,
  BrotliDecompressContext,
  BrotliDecompressDictContext,
  brotliCompress,
  brotliCompressAsync,
  brotliCompressWithDict,
  brotliCompressWithDictAsync,
  brotliDecompressWithCapacity,
  brotliDecompressWithCapacityAsync,
  brotliDecompressWithDictWithCapacity,
  brotliDecompressWithDictWithCapacityAsync,
  crc32,
  DeflateCompressContext,
  DeflateDecompressContext,
  decompress,
  decompressAsync,
  deflateCompress,
  deflateCompressAsync,
  deflateDecompressWithCapacity,
  deflateDecompressWithCapacityAsync,
  GzipCompressContext,
  GzipDecompressContext,
  gzipCompress,
  gzipCompressAsync,
  gzipCompressWithHeader,
  gzipDecompressWithCapacity,
  gzipDecompressWithCapacityAsync,
  gzipReadHeader,
  Lz4DecompressContext,
  lz4Compress,
  lz4DecompressWithCapacity,
  lz4DecompressWithCapacityAsync,
  ZstdCompressContext,
  ZstdCompressDictContext,
  ZstdDecompressContext,
  ZstdDecompressDictContext,
  zstdCompress,
  zstdCompressAsync,
  zstdCompressWithDict,
  zstdCompressWithDictAsync,
  zstdDecompressWithCapacity,
  zstdDecompressWithCapacityAsync,
  zstdDecompressWithDictWithCapacity,
  zstdDecompressWithDictWithCapacityAsync,
  zstdTrainDictionary,
  zstdTrainDictionaryAsync,
} from '../index.js';

// Numeric arguments used to be converted to Rust integers by napi, which
// wraps and truncates (NaN to 0, 1.9 to 1, 2 ** 32 + 1 to 1), so invalid
// numbers silently became valid ones. They must be rejected instead.

const data = Buffer.from('Numeric argument validation. '.repeat(100));
const samples = Array.from({ length: 100 }, (_, i) =>
  Buffer.from(`{"id":${i},"name":"user_${i}"}`),
);
const zstdDict = zstdTrainDictionary(samples, 4096);
const brotliDict = Buffer.from('Numeric argument validation. ');

/** Numbers that are not integers, or not finite. */
const NOT_INTEGERS = [
  Number.NaN,
  Number.POSITIVE_INFINITY,
  Number.NEGATIVE_INFINITY,
  0.5,
  1.9,
  -1.5,
];

/** A numeric argument and every public function that takes it. */
interface NumericArgument {
  message: string;
  /** Valid values, including both ends of the range. */
  valid: number[];
  /** Invalid numbers, including those that napi used to wrap to valid ones. */
  invalid: number[];
  /** Call each function with a value. */
  calls: Record<string, (value: number) => unknown>;
}

const gzipLevel: NumericArgument = {
  message: 'gzip compression level must be an integer between 0 and 9',
  valid: [0, 9, -0],
  invalid: [...NOT_INTEGERS, -1, 10, 2 ** 32, 2 ** 32 + 1, 2 ** 53, 2 ** 64],
  calls: {
    gzipCompress: (level) => gzipCompress(data, level),
    gzipCompressAsync: (level) => gzipCompressAsync(data, level),
    gzipCompressWithHeader: (level) => gzipCompressWithHeader(data, {}, level),
    GzipCompressContext: (level) => new GzipCompressContext(level),
  },
};

const deflateLevel: NumericArgument = {
  message: 'deflate compression level must be an integer between 0 and 9',
  valid: [0, 9],
  invalid: [...NOT_INTEGERS, -1, 10, 2 ** 32, 2 ** 32 + 1, 2 ** 64],
  calls: {
    deflateCompress: (level) => deflateCompress(data, level),
    deflateCompressAsync: (level) => deflateCompressAsync(data, level),
    DeflateCompressContext: (level) => new DeflateCompressContext(level),
  },
};

const brotliQuality: NumericArgument = {
  message: 'brotli quality must be an integer between 0 and 11',
  valid: [0, 11],
  invalid: [...NOT_INTEGERS, -1, 12, 2 ** 32, 2 ** 32 + 6, 2 ** 64],
  calls: {
    brotliCompress: (quality) => brotliCompress(data, quality),
    brotliCompressAsync: (quality) => brotliCompressAsync(data, quality),
    brotliCompressWithDict: (quality) => brotliCompressWithDict(data, brotliDict, quality),
    brotliCompressWithDictAsync: (quality) =>
      brotliCompressWithDictAsync(data, brotliDict, quality),
    BrotliCompressContext: (quality) => new BrotliCompressContext(quality),
    BrotliCompressDictContext: (quality) => new BrotliCompressDictContext(brotliDict, quality),
  },
};

const zstdLevel: NumericArgument = {
  message: 'zstd compression level must be an integer between -131072 and 22',
  valid: [-131072, 0, 22],
  // 2 ** 32 - 131072 used to wrap to -131072, and 2 ** 32 + 3 to 3.
  invalid: [...NOT_INTEGERS, -131073, 23, 2 ** 31, 2 ** 32 - 131072, 2 ** 32 + 3, 2 ** 64],
  calls: {
    zstdCompress: (level) => zstdCompress(data, level),
    zstdCompressAsync: (level) => zstdCompressAsync(data, level),
    zstdCompressWithDict: (level) => zstdCompressWithDict(data, zstdDict, level),
    zstdCompressWithDictAsync: (level) => zstdCompressWithDictAsync(data, zstdDict, level),
    ZstdCompressContext: (level) => new ZstdCompressContext(level),
    ZstdCompressDictContext: (level) => new ZstdCompressDictContext(zstdDict, level),
  },
};

/** Sizes: from 0 to Number.MAX_SAFE_INTEGER. */
const INVALID_SIZES = [...NOT_INTEGERS, -1, 2 ** 53, 2 ** 64, Number.MAX_VALUE];

const gzipped = gzipCompress(data);
const deflated = deflateCompress(data);
const brotlied = brotliCompress(data);
const brotliedWithDict = brotliCompressWithDict(data, brotliDict);
const zstded = zstdCompress(data);
const zstdedWithDict = zstdCompressWithDict(data, zstdDict);
const lz4ed = lz4Compress(data);
// Decompresses to nothing, within every limit.
const gzippedEmpty = gzipCompress(Buffer.alloc(0));

const capacity: NumericArgument = {
  message: 'capacity must be an integer between 0 and 9007199254740991',
  valid: [data.length, Number.MAX_SAFE_INTEGER],
  invalid: INVALID_SIZES,
  calls: {
    gzipDecompressWithCapacity: (cap) => gzipDecompressWithCapacity(gzipped, cap),
    gzipDecompressWithCapacityAsync: (cap) => gzipDecompressWithCapacityAsync(gzipped, cap),
    deflateDecompressWithCapacity: (cap) => deflateDecompressWithCapacity(deflated, cap),
    deflateDecompressWithCapacityAsync: (cap) => deflateDecompressWithCapacityAsync(deflated, cap),
    brotliDecompressWithCapacity: (cap) => brotliDecompressWithCapacity(brotlied, cap),
    brotliDecompressWithCapacityAsync: (cap) => brotliDecompressWithCapacityAsync(brotlied, cap),
    brotliDecompressWithDictWithCapacity: (cap) =>
      brotliDecompressWithDictWithCapacity(brotliedWithDict, brotliDict, cap),
    brotliDecompressWithDictWithCapacityAsync: (cap) =>
      brotliDecompressWithDictWithCapacityAsync(brotliedWithDict, brotliDict, cap),
    zstdDecompressWithCapacity: (cap) => zstdDecompressWithCapacity(zstded, cap),
    zstdDecompressWithCapacityAsync: (cap) => zstdDecompressWithCapacityAsync(zstded, cap),
    zstdDecompressWithDictWithCapacity: (cap) =>
      zstdDecompressWithDictWithCapacity(zstdedWithDict, zstdDict, cap),
    zstdDecompressWithDictWithCapacityAsync: (cap) =>
      zstdDecompressWithDictWithCapacityAsync(zstdedWithDict, zstdDict, cap),
    lz4DecompressWithCapacity: (cap) => lz4DecompressWithCapacity(lz4ed, cap),
    lz4DecompressWithCapacityAsync: (cap) => lz4DecompressWithCapacityAsync(lz4ed, cap),
  },
};

const maxOutputSize: NumericArgument = {
  message: 'maxOutputSize must be an integer between 0 and 9007199254740991',
  valid: [0, data.length, Number.MAX_SAFE_INTEGER],
  invalid: INVALID_SIZES,
  calls: {
    GzipDecompressContext: (size) => new GzipDecompressContext(size),
    DeflateDecompressContext: (size) => new DeflateDecompressContext(size),
    BrotliDecompressContext: (size) => new BrotliDecompressContext(size),
    BrotliDecompressDictContext: (size) => new BrotliDecompressDictContext(brotliDict, size),
    ZstdDecompressContext: (size) => new ZstdDecompressContext(size),
    ZstdDecompressDictContext: (size) => new ZstdDecompressDictContext(zstdDict, size),
    Lz4DecompressContext: (size) => new Lz4DecompressContext(size),
    decompress: (size) => decompress(gzippedEmpty, size),
    decompressAsync: (size) => decompressAsync(gzippedEmpty, size),
  },
};

const crc32InitialValue: NumericArgument = {
  message: 'crc32 initial value must be an integer between 0 and 4294967295',
  valid: [0, 0xffffffff],
  invalid: [...NOT_INTEGERS, -1, 2 ** 32, 2 ** 33, 2 ** 64],
  calls: { crc32: (initialValue) => crc32(data, initialValue) },
};

const gzipMtime: NumericArgument = {
  message: 'mtime must be an integer between 0 and 4294967295',
  valid: [0, 0xffffffff],
  invalid: [...NOT_INTEGERS, -1, 2 ** 32, 2 ** 64],
  calls: { gzipCompressWithHeader: (mtime) => gzipCompressWithHeader(data, { mtime }) },
};

const maxDictSize: NumericArgument = {
  message: 'maxDictSize must be an integer between 0 and 16777216',
  valid: [4096],
  invalid: [...INVALID_SIZES, 2 ** 24 + 1],
  calls: {
    zstdTrainDictionary: (size) => zstdTrainDictionary(samples, size),
    zstdTrainDictionaryAsync: (size) => zstdTrainDictionaryAsync(samples, size),
  },
};

const ARGUMENTS = {
  gzipLevel,
  deflateLevel,
  brotliQuality,
  zstdLevel,
  capacity,
  maxOutputSize,
  crc32InitialValue,
  gzipMtime,
  maxDictSize,
};

/** [function, argument, the argument's checks with that function] */
const CASES = Object.entries(ARGUMENTS).flatMap(([argument, { calls, ...checks }]) =>
  Object.entries(calls).map(([name, call]) => [name, argument, { call, ...checks }] as const),
);

describe('numeric argument validation', () => {
  it.each(CASES)('%s: should reject invalid %s values', async (name, _argument, check) => {
    const error = expect.objectContaining({ code: 'InvalidArg', message: check.message });
    for (const value of check.invalid) {
      if (name.endsWith('Async')) {
        await expect(check.call(value), String(value)).rejects.toThrow(error);
      } else {
        expect(() => check.call(value), String(value)).toThrow(error);
      }
    }
  });

  it.each(CASES)('%s: should accept valid %s values', async (_name, _argument, check) => {
    for (const value of check.valid) {
      await check.call(value);
    }
  });

  it('should still use the values it accepts', () => {
    const header = gzipReadHeader(gzipCompressWithHeader(data, { mtime: 0xffffffff }));
    expect(header.mtime).toBe(0xffffffff);
    expect(crc32(data.subarray(10), crc32(data.subarray(0, 10)))).toBe(crc32(data));
    expect(gzipCompress(data, -0)).toEqual(gzipCompress(data, 0));
  });

  it('should reject a value that is not a number', () => {
    const notANumber = expect.objectContaining({ code: 'NumberExpected' });
    // @ts-expect-error a level must be a number
    expect(() => gzipCompress(data, '6')).toThrow(notANumber);
    // @ts-expect-error an initial value must be a number
    expect(() => crc32(data, '1')).toThrow(notANumber);
    // @ts-expect-error a capacity must be a number
    expect(() => gzipDecompressWithCapacity(gzipped, null)).toThrow(notANumber);
  });
});
