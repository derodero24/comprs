import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import * as native from '../index.js';

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
  crc32(data: Uint8Array): number;
  version(): string;
};

function isWasmBindgen(glue: Record<string, unknown>): glue is WasmBindgen {
  return [...CODECS, 'detectFormat', 'crc32', 'version'].every(
    (name) => typeof glue[name] === 'function',
  );
}

/**
 * Load the wasm-bindgen build. Its entry, comprs-wasm.js, imports the .wasm
 * file as an ES module (wasm-bindgen's bundler target), which Vitest cannot
 * load, so instantiate the module with its JS glue by hand, as
 * e2e/index.html does.
 */
async function loadWasmBindgen(): Promise<WasmBindgen> {
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

let wasm: WasmBindgen;

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
});
