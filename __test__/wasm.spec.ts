import { beforeAll, describe, expect, it, vi } from 'vitest';
import * as native from '../index.js';
import { ROWS, skippableFrame } from './detect-fixtures.js';
import {
  type BrowserEntry,
  HAS_WASM_BUILD,
  importBrowserEntry,
  wasmMemory,
} from './load-browser-entry.js';

// Tests the wasm-bindgen build through the browser entry, which loads it.
// wasm-parity.spec.ts compares it with the native addon call by call.

let wasm: BrowserEntry;
const encoder = new TextEncoder();

/** Call a function of the browser entry with arguments of any type. */
function callWasm(name: string, ...args: unknown[]): unknown {
  const fn: unknown = Reflect.get(wasm, name);
  if (typeof fn !== 'function') throw new Error(`${name} is not a function`);
  return Reflect.apply(fn, undefined, args);
}

/** The output of a wasm-bindgen function, checked to be bytes. */
function bytes(output: unknown): Uint8Array {
  if (!(output instanceof Uint8Array)) throw new Error('expected a Uint8Array');
  return output;
}

/** Construct a class of the browser entry with arguments of any type. */
function constructWasm(name: string, ...args: unknown[]): unknown {
  const Class: unknown = Reflect.get(wasm, name);
  if (typeof Class !== 'function') throw new Error(`${name} is not a class`);
  return Reflect.construct(Class, args);
}

describe.skipIf(!HAS_WASM_BUILD)('wasm-bindgen build', () => {
  beforeAll(async () => {
    wasm = await importBrowserEntry();
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

    it('should limit the output to maxOutputSize like the native addon', () => {
      for (const [format, compressed] of [
        ['zstd', wasm.zstdCompress(testData)],
        ['gzip', wasm.gzipCompress(testData)],
        ['brotli', wasm.brotliCompress(testData)],
        ['lz4', wasm.lz4Compress(testData)],
      ] as const) {
        for (const maxOutputSize of [testData.length, undefined]) {
          const output = bytes(callWasm('decompress', compressed, maxOutputSize));
          expect(Buffer.from(output)).toEqual(testData);
        }
        const limit = testData.length - 1;
        const message = `${format} decompress exceeded maximum size of ${limit} bytes`;
        expect(() => callWasm('decompress', compressed, limit)).toThrow(message);
        expect(() => native.decompress(compressed, limit)).toThrow(message);
      }
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
      const compressed = wasm.gzipCompressWithHeader(data, { filename: 'hello.txt' });
      expect(wasm.gzipReadHeader(compressed).filename).toBe('hello.txt');
      expect(Buffer.from(wasm.gzipDecompress(compressed))).toEqual(data);
    });

    // Used to trap with `RuntimeError: unreachable`.
    it('should throw an Error for a filename with a NUL character', () => {
      expect(() => wasm.gzipCompressWithHeader(data, { filename: 'a\u0000b' })).toThrow(
        'gzip filename must not contain NUL characters',
      );
      // The module still works afterwards.
      expect(
        wasm.gzipReadHeader(wasm.gzipCompressWithHeader(data, { filename: 'ok' }, 6)).filename,
      ).toBe('ok');
    });

    it('should limit the filename to 65535 bytes', () => {
      const longest = 'f'.repeat(65535);
      expect(
        wasm.gzipReadHeader(wasm.gzipCompressWithHeader(data, { filename: longest }, 6)).filename,
      ).toBe(longest);
      expect(() => wasm.gzipCompressWithHeader(data, { filename: `${longest}f` }, 6)).toThrow(
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
        (v) => callWasm('gzipCompressWithHeader', data, {}, v),
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
        INVALID_U32.filter((v) => typeof v === 'number'),
        (v) => callWasm('gzipCompressWithHeader', data, { mtime: v }),
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
      [
        'decompress',
        size('maxOutputSize'),
        INVALID_SIZES,
        (v) => callWasm('decompress', wasm.gzipCompress(data), v),
      ],
    ];

    it.each(CASES)(
      '%s: should reject invalid values like the native addon',
      (_, message, invalid, call) => {
        for (const value of invalid) {
          expect(() => call(value), String(value)).toThrow(message);
        }
      },
    );

    // The header is an object, whose fields the glue does not convert, so a
    // header mtime that is not a number throws, as in the native addon.
    it('should reject a header mtime that is not a number', () => {
      for (const mtime of ['abc', '1', {}]) {
        expect(() => callWasm('gzipCompressWithHeader', data, { mtime }), String(mtime)).toThrow(
          'header.mtime must be a number',
        );
      }
    });

    it('should accept the values that the native addon accepts', () => {
      expect(wasm.crc32(data, 0xffffffff)).toBe(native.crc32(data, 0xffffffff));
      expect(wasm.crc32(data, -0)).toBe(native.crc32(data, 0));
      const header = wasm.gzipReadHeader(
        wasm.gzipCompressWithHeader(data, { filename: 'f', mtime: 0xffffffff }, 9),
      );
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

  // The stream contexts are the wasm-bindgen classes, which keep their state
  // in WebAssembly memory (#573).
  describe('stream contexts', () => {
    const MiB = 1024 * 1024;

    interface StreamContext {
      transform(chunk: Uint8Array): Uint8Array;
      flush(): Uint8Array;
      finish(): Uint8Array;
    }

    const PAIRS: [string, () => StreamContext, () => StreamContext][] = [
      ['zstd', () => new wasm.ZstdCompressContext(), () => new wasm.ZstdDecompressContext()],
      ['gzip', () => new wasm.GzipCompressContext(), () => new wasm.GzipDecompressContext()],
      [
        'deflate',
        () => new wasm.DeflateCompressContext(),
        () => new wasm.DeflateDecompressContext(),
      ],
      ['brotli', () => new wasm.BrotliCompressContext(), () => new wasm.BrotliDecompressContext()],
      ['lz4', () => new wasm.Lz4CompressContext(), () => new wasm.Lz4DecompressContext()],
    ];

    // Growth detaches the ArrayBuffer of the memory, and with it every view
    // of it, which broke the stream contexts of the emnapi build (#106).
    // Growing it from JavaScript, between calls, detaches it the same way.
    it.each(PAIRS)('%s streams across growth of the WebAssembly memory', async (_name, ...pair) => {
      const memory = await wasmMemory();
      const [createCompressor, createDecompressor] = pair;
      const compressor = createCompressor();
      const decompressor = createDecompressor();
      const input = encoder.encode(
        Array.from({ length: 20_000 }, (_, i) => `line ${i}: ${(i * 7919) % 10_007}\n`).join(''),
      );
      const output: Uint8Array[] = [];
      let detached = 0;
      const grow = () => {
        const buffer = memory.buffer;
        memory.grow(1);
        detached += buffer.byteLength === 0 ? 1 : 0;
      };
      for (let offset = 0; offset < input.length; offset += 16 * 1024) {
        const compressed = compressor.transform(input.subarray(offset, offset + 16 * 1024));
        grow();
        output.push(decompressor.transform(compressed));
        grow();
      }
      const compressed = compressor.finish();
      grow();
      output.push(decompressor.transform(compressed), decompressor.finish());
      expect(detached).toBeGreaterThanOrEqual(20);
      expect(Buffer.concat(output)).toEqual(Buffer.from(input));
    });

    // A limit is not a size: the context grows its output as it goes.
    it.each([
      ['ZstdDecompressContext', (limit: number) => new wasm.ZstdDecompressContext(limit)],
      [
        'ZstdDecompressDictContext',
        (limit: number) => new wasm.ZstdDecompressDictContext(new Uint8Array(0), limit),
      ],
    ])('%s reserves no memory for its maxOutputSize', async (_name, create) => {
      const memory = await wasmMemory();
      const data = encoder.encode('a small payload with a large limit '.repeat(1000));
      const before = memory.buffer.byteLength;
      const context = create(2 * 1024 * MiB);
      const output = [context.transform(wasm.zstdCompress(data)), context.finish()];
      expect(Buffer.concat(output)).toEqual(Buffer.from(data));
      expect(memory.buffer.byteLength - before).toBeLessThan(16 * MiB);
    });

    type GzipCompressContext = InstanceType<BrowserEntry['GzipCompressContext']>;

    it('free their memory on free(), and throw when used afterwards', () => {
      const context = new wasm.GzipCompressContext();
      context.transform(encoder.encode('freed early'));
      context.free();
      expect(() => context.transform(encoder.encode('more'))).toThrow(Error);
      expect(() => context.finish()).toThrow(Error);
    });

    // As in the native addon, [Symbol.dispose]() is close() rather than the
    // glue's free(), so a `using` declaration closes the context (#616).
    it('close at the end of a using declaration', () => {
      let disposed: GzipCompressContext | undefined;
      {
        using context = new wasm.GzipCompressContext();
        context.transform(encoder.encode('closed early'));
        disposed = context;
      }
      expect(disposed[Symbol.dispose]).toBe(disposed.close);
      expect(() => disposed.finish()).toThrow('gzip stream already closed');
      // free() still frees the closed context.
      expect(() => disposed.free()).not.toThrow();
    });
  });

  // Last, as a trap leaves the instance in whatever state the panic left.
  describe('panics', () => {
    // A panic traps with a bare `RuntimeError: unreachable`, so the build
    // logs the panic message to the console first. A NUL byte in the file
    // name used to panic in flate2; comprs-core now rejects it with an error
    // (#546), so the reason is in the error message, and no input is known
    // to panic any more. Either way, the cause must be reported.
    it('reports why a call failed, also when the call panics', () => {
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      let thrown: unknown;
      try {
        wasm.gzipCompressWithHeader(new Uint8Array(4), { filename: 'a\0b' });
      } catch (error) {
        thrown = error;
      }
      const logged = consoleError.mock.calls.flat().map(String);
      consoleError.mockRestore();
      expect(thrown).toBeInstanceOf(Error);
      const message = thrown instanceof Error ? thrown.message : '';
      expect([message, ...logged].join('\n')).toMatch(/nul/i);
    });
  });
});
