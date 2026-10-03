import { beforeAll, describe, expect, it, vi } from 'vitest';
import * as native from '../index.js';
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

    it('should auto-detect brotli via decompress', () => {
      // Brotli has no magic bytes, so detectFormat cannot recognize it, but
      // decompress() still tries brotli as a fallback.
      const compressed = wasm.brotliCompress(testData);
      expect(Buffer.from(wasm.decompress(compressed))).toEqual(testData);
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
      finish?: () => Uint8Array;
    }

    /** End the input: finish(), or flush() for LZ4 decompression. */
    function end(context: StreamContext): Uint8Array {
      return context.finish === undefined ? context.flush() : context.finish();
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
    it.each(PAIRS)('%s streams across growth of the WebAssembly memory', (_name, ...pair) => {
      const memory = wasmMemory();
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
      const compressed = end(compressor);
      grow();
      output.push(decompressor.transform(compressed), end(decompressor));
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
    ])('%s reserves no memory for its maxOutputSize', (_name, create) => {
      const memory = wasmMemory();
      const data = encoder.encode('a small payload with a large limit '.repeat(1000));
      const before = memory.buffer.byteLength;
      const context = create(2 * 1024 * MiB);
      const output = [context.transform(wasm.zstdCompress(data)), context.finish()];
      expect(Buffer.concat(output)).toEqual(Buffer.from(data));
      expect(memory.buffer.byteLength - before).toBeLessThan(16 * MiB);
    });

    type GzipCompressContext = InstanceType<BrowserEntry['GzipCompressContext']>;

    it.each([
      ['free()', (context: GzipCompressContext) => context.free()],
      ['[Symbol.dispose]()', (context: GzipCompressContext) => context[Symbol.dispose]()],
    ])('free their memory on %s, and throw when used afterwards', (_name, free) => {
      const context = new wasm.GzipCompressContext();
      context.transform(encoder.encode('freed early'));
      free(context);
      expect(() => context.transform(encoder.encode('more'))).toThrow(Error);
      expect(() => context.finish()).toThrow(Error);
    });
  });

  // Last, as a trap leaves the instance in whatever state the panic left.
  describe('panics', () => {
    // A NUL byte in the file name panics in flate2 (#546). A panic traps
    // with a bare `RuntimeError: unreachable`, so the build logs the panic
    // message to the console first. Once #546 rejects the name with an error
    // instead, the reason is in the error message.
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
