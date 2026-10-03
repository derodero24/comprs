import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import * as native from '../index.js';
import { ROWS, skippableFrame } from './detect-fixtures.js';

// Tests the wasm-bindgen build that the browser entry loads. `pnpm test` does
// not build it, so this suite is skipped unless `pnpm run build:wasm-bindgen`
// ran first, as in the WASM Test CI job.
const WASM_FILE = resolve(__dirname, '../comprs-wasm_bg.wasm');
const GLUE_MODULE = '../comprs-wasm_bg.js';

// The part of the WebAssembly JS API that this file uses. The project is
// type-checked without the DOM library, which declares it.
declare const WebAssembly: {
  instantiate(
    bytes: Uint8Array,
    imports: Record<string, Record<string, unknown>>,
  ): Promise<{ instance: { exports: Record<string, unknown> } }>;
};

const CODECS = [
  'zstdCompress',
  'zstdDecompress',
  'gzipCompress',
  'gzipDecompress',
  'deflateCompress',
  'deflateDecompress',
  'brotliCompress',
  'brotliDecompress',
  'lz4Compress',
  'lz4Decompress',
  'decompress',
] as const;

type WasmBindgen = Record<(typeof CODECS)[number], (data: Uint8Array) => Uint8Array> & {
  detectFormat(data: Uint8Array): string;
  crc32(data: Uint8Array, initialValue?: number): number;
  gzipCompressWithHeader(
    data: Uint8Array,
    level?: number,
    filename?: string,
    mtime?: number,
  ): Uint8Array;
  gzipReadHeader(data: Uint8Array): { filename: string | null; mtime: number };
  version(): string;
};

function isWasmBindgen(glue: Record<string, unknown>): glue is WasmBindgen {
  return [
    ...CODECS,
    'detectFormat',
    'crc32',
    'gzipCompressWithHeader',
    'gzipReadHeader',
    'version',
  ].every((name) => typeof glue[name] === 'function');
}

/**
 * Load the wasm-bindgen build. Its entry, comprs-wasm.js, imports the .wasm
 * file as an ES module (wasm-bindgen's bundler target), which Vitest cannot
 * load, so instantiate the module with its JS glue by hand, as
 * e2e/index.html does.
 */
async function loadWasmBindgen(): Promise<Record<string, unknown> & WasmBindgen> {
  const glue: Record<string, unknown> = await import(GLUE_MODULE);
  const { instance } = await WebAssembly.instantiate(readFileSync(WASM_FILE), {
    './comprs-wasm_bg.js': glue,
  });
  const setWasm = glue.__wbg_set_wasm;
  if (typeof setWasm !== 'function' || !isWasmBindgen(glue)) {
    throw new Error(`${GLUE_MODULE} does not export the wasm-bindgen API`);
  }
  setWasm(instance.exports);
  return glue;
}

let wasm: Record<string, unknown> & WasmBindgen;

/** Call a function of the wasm-bindgen build that `WasmBindgen` does not declare. */
function callWasm(name: string, ...args: unknown[]): unknown {
  const fn = wasm[name];
  if (typeof fn !== 'function') throw new Error(`${name} is not a function`);
  return Reflect.apply(fn, undefined, args);
}

/** The output of a wasm-bindgen function, checked to be bytes. */
function bytes(output: unknown): Uint8Array {
  if (!(output instanceof Uint8Array)) throw new Error('expected a Uint8Array');
  return output;
}

/** Construct an instance of a class of the wasm-bindgen build. */
function constructWasm(name: string, ...args: unknown[]): unknown {
  const Class = wasm[name];
  if (typeof Class !== 'function') throw new Error(`${name} is not a class`);
  return Reflect.construct(Class, args);
}

describe.skipIf(!existsSync(WASM_FILE))('wasm-bindgen build', () => {
  beforeAll(async () => {
    wasm = await loadWasmBindgen();
  });

  describe('one-shot compression', () => {
    const testData = Buffer.from('Hello, WASM comprs! '.repeat(100));

    it.each([
      ['zstd', 'zstdCompress', 'zstdDecompress'],
      ['gzip', 'gzipCompress', 'gzipDecompress'],
      ['deflate', 'deflateCompress', 'deflateDecompress'],
      ['brotli', 'brotliCompress', 'brotliDecompress'],
      ['lz4', 'lz4Compress', 'lz4Decompress'],
    ] as const)('should round-trip with %s', (_name, compress, decompress) => {
      const decompressed = wasm[decompress](wasm[compress](testData));
      expect(Buffer.from(decompressed)).toEqual(testData);
    });
  });

  describe('auto-detect decompression', () => {
    const testData = Buffer.from('Auto-detect test data '.repeat(50));

    it('should auto-detect zstd', () => {
      const compressed = wasm.zstdCompress(testData);
      expect(wasm.detectFormat(compressed)).toBe('zstd');
      expect(Buffer.from(wasm.decompress(compressed))).toEqual(testData);
    });

    it('should auto-detect gzip', () => {
      const compressed = wasm.gzipCompress(testData);
      expect(wasm.detectFormat(compressed)).toBe('gzip');
      expect(Buffer.from(wasm.decompress(compressed))).toEqual(testData);
    });

    it('should auto-detect brotli', () => {
      const compressed = wasm.brotliCompress(testData);
      expect(wasm.detectFormat(compressed)).toBe('brotli');
      expect(Buffer.from(wasm.decompress(compressed))).toEqual(testData);
    });

    it('should auto-detect lz4 after a skippable frame', () => {
      const compressed = Buffer.concat([
        skippableFrame(Buffer.from('metadata')),
        native.lz4Compress(testData),
      ]);
      expect(wasm.detectFormat(compressed)).toBe('lz4');
      expect(Buffer.from(wasm.decompress(compressed))).toEqual(testData);
    });

    it('should report raw deflate as unknown format', () => {
      const compressed = wasm.deflateCompress(ROWS);
      expect(wasm.detectFormat(compressed)).toBe('unknown');
      expect(() => wasm.decompress(compressed)).toThrow(/unable to detect compression format/);
    });
  });

  describe('gzipCompressWithHeader', () => {
    const data = Buffer.from('gzip header test');

    it('should store the filename', () => {
      const compressed = wasm.gzipCompressWithHeader(data, undefined, 'hello.txt');
      expect(wasm.gzipReadHeader(compressed).filename).toBe('hello.txt');
      expect(Buffer.from(wasm.gzipDecompress(compressed))).toEqual(data);
    });

    // Used to trap with `RuntimeError: unreachable`.
    it('should throw an Error for a filename with a NUL character', () => {
      expect(() => wasm.gzipCompressWithHeader(data, undefined, 'a\u0000b')).toThrow(
        'gzip filename must not contain NUL characters',
      );
      // The module still works afterwards.
      expect(wasm.gzipReadHeader(wasm.gzipCompressWithHeader(data, 6, 'ok')).filename).toBe('ok');
    });

    it('should limit the filename to 65535 bytes', () => {
      const longest = 'f'.repeat(65535);
      expect(wasm.gzipReadHeader(wasm.gzipCompressWithHeader(data, 6, longest)).filename).toBe(
        longest,
      );
      expect(() => wasm.gzipCompressWithHeader(data, 6, `${longest}f`)).toThrow(
        'gzip filename must be at most 65535 bytes long',
      );
    });
  });

  describe('numeric arguments', () => {
    const data = Buffer.from('WASM numeric argument validation. '.repeat(50));
    const dict = Buffer.from('WASM numeric argument validation. ');

    // wasm-bindgen used to pass levels and CRCs as `value >>> 0` or
    // `value >> 0`, which wraps and truncates, and converts strings and
    // objects to 0 when they are not numbers. Now they convert to NaN.
    const NOT_INTEGERS = [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      1.5,
      2 ** 64,
      'abc',
      {},
    ];
    const INVALID_U32 = [...NOT_INTEGERS, -1, 2 ** 32];
    const INVALID_LEVELS = [...NOT_INTEGERS, -1, 2 ** 32 + 1];
    const INVALID_ZSTD_LEVELS = [...NOT_INTEGERS, -131073, 23, 2 ** 32 + 3];
    const INVALID_SIZES = [...NOT_INTEGERS, -1, 2 ** 53];

    // The same messages as the native addon's.
    const level = (format: string, max: number) =>
      `${format} compression level must be an integer between 0 and ${max}`;
    const ZSTD_LEVEL = 'zstd compression level must be an integer between -131072 and 22';
    const BROTLI_QUALITY = 'brotli quality must be an integer between 0 and 11';
    const size = (name: string) => `${name} must be an integer between 0 and 9007199254740991`;

    const CASES: [string, string, unknown[], (value: unknown) => unknown][] = [
      ['zstdCompress', ZSTD_LEVEL, INVALID_ZSTD_LEVELS, (v) => callWasm('zstdCompress', data, v)],
      [
        'zstdCompressWithDict',
        ZSTD_LEVEL,
        INVALID_ZSTD_LEVELS,
        (v) => callWasm('zstdCompressWithDict', data, dict, v),
      ],
      [
        'ZstdCompressContext',
        ZSTD_LEVEL,
        INVALID_ZSTD_LEVELS,
        (v) => constructWasm('ZstdCompressContext', v),
      ],
      [
        'ZstdCompressDictContext',
        ZSTD_LEVEL,
        INVALID_ZSTD_LEVELS,
        (v) => constructWasm('ZstdCompressDictContext', dict, v),
      ],
      ['gzipCompress', level('gzip', 9), INVALID_LEVELS, (v) => callWasm('gzipCompress', data, v)],
      [
        'gzipCompressWithHeader',
        level('gzip', 9),
        INVALID_LEVELS,
        (v) => callWasm('gzipCompressWithHeader', data, v),
      ],
      [
        'GzipCompressContext',
        level('gzip', 9),
        INVALID_LEVELS,
        (v) => constructWasm('GzipCompressContext', v),
      ],
      [
        'deflateCompress',
        level('deflate', 9),
        INVALID_LEVELS,
        (v) => callWasm('deflateCompress', data, v),
      ],
      [
        'DeflateCompressContext',
        level('deflate', 9),
        INVALID_LEVELS,
        (v) => constructWasm('DeflateCompressContext', v),
      ],
      [
        'brotliCompress',
        BROTLI_QUALITY,
        INVALID_LEVELS,
        (v) => callWasm('brotliCompress', data, v),
      ],
      [
        'brotliCompressWithDict',
        BROTLI_QUALITY,
        INVALID_LEVELS,
        (v) => callWasm('brotliCompressWithDict', data, dict, v),
      ],
      [
        'BrotliCompressContext',
        BROTLI_QUALITY,
        INVALID_LEVELS,
        (v) => constructWasm('BrotliCompressContext', v),
      ],
      [
        'BrotliCompressDictContext',
        BROTLI_QUALITY,
        INVALID_LEVELS,
        (v) => constructWasm('BrotliCompressDictContext', dict, v),
      ],
      [
        'crc32',
        'crc32 initial value must be an integer between 0 and 4294967295',
        INVALID_U32,
        (v) => callWasm('crc32', data, v),
      ],
      [
        'gzipCompressWithHeader (mtime)',
        'mtime must be an integer between 0 and 4294967295',
        INVALID_U32,
        (v) => callWasm('gzipCompressWithHeader', data, undefined, undefined, v),
      ],
      [
        'zstdTrainDictionary',
        'maxDictSize must be an integer between 0 and 16777216',
        [...INVALID_SIZES, 2 ** 24 + 1],
        (v) => callWasm('zstdTrainDictionary', [data], v),
      ],
      ...[
        'zstdDecompressWithCapacity',
        'gzipDecompressWithCapacity',
        'deflateDecompressWithCapacity',
        'brotliDecompressWithCapacity',
        'lz4DecompressWithCapacity',
      ].map((name): [string, string, unknown[], (value: unknown) => unknown] => [
        name,
        size('capacity'),
        INVALID_SIZES,
        (v) => callWasm(name, data, v),
      ]),
      ...['zstdDecompressWithDictWithCapacity', 'brotliDecompressWithDictWithCapacity'].map(
        (name): [string, string, unknown[], (value: unknown) => unknown] => [
          name,
          size('capacity'),
          INVALID_SIZES,
          (v) => callWasm(name, data, dict, v),
        ],
      ),
      ...[
        'ZstdDecompressContext',
        'GzipDecompressContext',
        'DeflateDecompressContext',
        'BrotliDecompressContext',
        'Lz4DecompressContext',
      ].map((name): [string, string, unknown[], (value: unknown) => unknown] => [
        name,
        size('maxOutputSize'),
        INVALID_SIZES,
        (v) => constructWasm(name, v),
      ]),
      ...['ZstdDecompressDictContext', 'BrotliDecompressDictContext'].map(
        (name): [string, string, unknown[], (value: unknown) => unknown] => [
          name,
          size('maxOutputSize'),
          INVALID_SIZES,
          (v) => constructWasm(name, dict, v),
        ],
      ),
    ];

    it.each(CASES)(
      '%s: should reject invalid values like the native addon',
      (_, message, invalid, call) => {
        for (const value of invalid) {
          expect(() => call(value), String(value)).toThrow(message);
        }
      },
    );

    it('should accept the values that the native addon accepts', () => {
      expect(wasm.crc32(data, 0xffffffff)).toBe(native.crc32(data, 0xffffffff));
      expect(wasm.crc32(data, -0)).toBe(native.crc32(data, 0));
      const header = wasm.gzipReadHeader(wasm.gzipCompressWithHeader(data, 9, 'f', 0xffffffff));
      expect(header.mtime).toBe(0xffffffff);
      for (const level of [-131072, 22]) {
        const compressed = bytes(callWasm('zstdCompress', data, level));
        expect(Buffer.from(wasm.zstdDecompress(compressed))).toEqual(data);
      }
      const gzipped = native.gzipCompress(data);
      // Sizes above 2 ** 32 - 1 are no limit on wasm32, as on 64-bit targets.
      for (const capacity of [data.length, 2 ** 40, Number.MAX_SAFE_INTEGER]) {
        const output = bytes(callWasm('gzipDecompressWithCapacity', gzipped, capacity));
        expect(Buffer.from(output)).toEqual(data);
      }
      expect(() => constructWasm('GzipDecompressContext', Number.MAX_SAFE_INTEGER)).not.toThrow();
    });
  });

  describe('native parity', () => {
    const testData = Buffer.from('Native parity verification data '.repeat(100));

    it('version: should match the native addon', () => {
      expect(wasm.version()).toBe(native.version());
    });

    it('crc32: should match the native addon', () => {
      expect(wasm.crc32(testData)).toBe(native.crc32(testData));
    });

    it('zstd: WASM output should match native output', () => {
      expect(Buffer.from(wasm.zstdCompress(testData))).toEqual(native.zstdCompress(testData));
    });

    it('deflate: WASM output should match native output', () => {
      expect(Buffer.from(wasm.deflateCompress(testData))).toEqual(native.deflateCompress(testData));
    });

    // The compressed bytes of these may differ, so check that each side
    // decompresses the other's output.
    it('gzip: WASM and native should decompress each other', () => {
      expect(Buffer.from(wasm.gzipDecompress(native.gzipCompress(testData)))).toEqual(testData);
      expect(native.gzipDecompress(wasm.gzipCompress(testData))).toEqual(testData);
    });

    it('brotli: WASM and native should decompress each other', () => {
      expect(Buffer.from(wasm.brotliDecompress(native.brotliCompress(testData)))).toEqual(testData);
      expect(native.brotliDecompress(wasm.brotliCompress(testData))).toEqual(testData);
    });

    it('lz4: WASM and native should decompress each other', () => {
      expect(Buffer.from(wasm.lz4Decompress(native.lz4Compress(testData)))).toEqual(testData);
      expect(native.lz4Decompress(wasm.lz4Compress(testData))).toEqual(testData);
    });
  });
});
