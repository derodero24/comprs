import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import ts from 'typescript-5';
import { beforeAll, describe, expect, it } from 'vitest';
import type { CompressOptions, ErrorCode, Format } from '../next/index.js';
import * as native from '../next/index.js';
import {
  type BrowserNext,
  HAS_WASM_BUILD,
  importBrowserNext,
  wasmMemory,
} from './load-browser-entry.js';

// The unified API, @derodero24/comprs/next (#577), in the browser build,
// against the native build: the functions of src/next/api.ts over the
// WebAssembly backend (src/next/wasm.ts and crates/wasm/src/next.rs) must
// give what they give over the native addon, the same bytes and errors of
// the same code, message and class (#555), but for zstd workers, which the
// browser build does not support. package.json does not export ./next yet,
// so the tests load browser/next/browser.js by path. The declarations of
// both builds are compared without the WebAssembly build.

const require = createRequire(__filename);

/** The API of either build, as next/index.d.ts declares it. */
type Api = typeof native;

/** The formats of the unified API. */
const FORMATS: readonly Format[] = ['zstd', 'gzip', 'deflate', 'deflate-raw', 'brotli', 'lz4'];

/** The formats that decompression detects: all but raw deflate. */
const DETECTED: readonly Format[] = FORMATS.filter((format) => format !== 'deflate-raw');

/** Levels of each format, `undefined` for the default. lz4 takes none. */
const LEVELS: Record<Format, readonly (number | undefined)[]> = {
  zstd: [undefined, -5, 1, 19],
  gzip: [undefined, 0, 1, 9],
  deflate: [undefined, 0, 1, 9],
  'deflate-raw': [undefined, 0, 1, 9],
  brotli: [undefined, 0, 5, 11],
  lz4: [undefined],
};

/** Every format at each of its levels. */
const FORMAT_LEVELS = FORMATS.flatMap((format) =>
  LEVELS[format].map((level): [Format, number | undefined] => [format, level]),
);

/** The options of compressSync() for `format` at `level`. */
function compressOptions(format: Format, level: number | undefined): CompressOptions {
  return level === undefined ? { format } : { format, level };
}

const encoder = new TextEncoder();
const text = encoder.encode(
  'The native addon and the WebAssembly build agree on ./next. '.repeat(300),
);
const dictionary = encoder.encode('agree on ./next The native addon WebAssembly build '.repeat(8));
const samples = Array.from({ length: 200 }, (_, i) =>
  encoder.encode(JSON.stringify({ id: i, name: `item ${i}`, tags: ['a', 'b'] })),
);

/** An error, by what the API promises of it: its class, code and message. */
interface ErrorOutcome {
  class: string;
  code: unknown;
  message: string;
  /** Its own enumerable properties: `code` alone. */
  keys: string[];
}

/** What a call returned or threw, in a form that compares across the builds. */
type Outcome =
  | { returned: unknown }
  | { threw: ErrorOutcome | { value: unknown } }
  | { threwBeforeThePromise: Outcome };

/** A result as a plain Uint8Array, so that a Buffer compares as one. */
function comparable(value: unknown): unknown {
  return value instanceof Uint8Array ? new Uint8Array(value) : value;
}

function thrown(error: unknown): Outcome {
  if (!(error instanceof Error)) {
    return { threw: { value: error } };
  }
  return {
    threw: {
      class: error.constructor.name,
      code: Reflect.get(error, 'code'),
      message: error.message,
      keys: Object.keys(error),
    },
  };
}

/** What `call` returned or threw. */
function run(call: () => unknown): Outcome {
  try {
    return { returned: comparable(call()) };
  } catch (error) {
    return thrown(error);
  }
}

/**
 * What the Promise that `call` returns settled with. The async functions
 * report every error by rejecting it: an error that `call` throws instead
 * is an outcome of its own.
 */
async function settle(call: () => Promise<unknown>): Promise<Outcome> {
  let promise: Promise<unknown>;
  try {
    promise = call();
  } catch (error) {
    return { threwBeforeThePromise: thrown(error) };
  }
  try {
    return { returned: comparable(await promise) };
  } catch (error) {
    return thrown(error);
  }
}

/** A copy of `data` with the byte at `index` set to 0xff. */
function withFF(data: Uint8Array, index: number): Uint8Array {
  const copy = Uint8Array.from(data);
  copy[index] = 0xff;
  return copy;
}

/** `data` and then `more`. */
function concat(data: Uint8Array, more: Uint8Array): Uint8Array {
  const joined = new Uint8Array(data.length + more.length);
  joined.set(data);
  joined.set(more, data.length);
  return joined;
}

/** The native output of each format, at its default level. */
const compressed: Record<Format, Uint8Array> = {
  zstd: native.compressSync(text, { format: 'zstd' }),
  gzip: native.compressSync(text, { format: 'gzip' }),
  deflate: native.compressSync(text, { format: 'deflate' }),
  'deflate-raw': native.compressSync(text, { format: 'deflate-raw' }),
  brotli: native.compressSync(text, { format: 'brotli' }),
  lz4: native.compressSync(text, { format: 'lz4' }),
};

/** Data that the decoder of each format rejects as corrupt. */
const corrupt: Record<Format, Uint8Array> = {
  // A frame whose only block has the reserved block type.
  zstd: Uint8Array.of(0x28, 0xb5, 0x2f, 0xfd, 0, 0, 0x07, 0, 0),
  // A deflate block of the reserved type, after the header.
  gzip: withFF(compressed.gzip, 10),
  deflate: withFF(compressed.deflate, 2),
  'deflate-raw': withFF(compressed['deflate-raw'], 0),
  brotli: new Uint8Array(16).fill(0xff),
  // The last literal changed, which the content checksum covers.
  lz4: withFF(compressed.lz4, compressed.lz4.length - 9),
};

/** A call that fails, in each of the two forms of the function it calls. */
interface ErrorCase {
  name: string;
  /** The code that the call fails with in both builds. */
  code: ErrorCode;
  sync(api: Api): unknown;
  async(api: Api): Promise<unknown>;
}

/** A compression call with `options` that fails with `code`. */
function compressCase(name: string, code: ErrorCode, options: CompressOptions): ErrorCase {
  return {
    name,
    code,
    sync: (api) => api.compressSync(text, options),
    async: (api) => api.compress(text, options),
  };
}

/** A decompression call of `data` with `options` that fails with `code`. */
function decompressCase(
  name: string,
  code: ErrorCode,
  data: Uint8Array,
  options?: native.DecompressOptions,
): ErrorCase {
  return {
    name,
    code,
    sync: (api) => api.decompressSync(data, options),
    async: (api) => api.decompress(data, options),
  };
}

// One or more calls for every code that the functions give, among them the
// checks of the options in comprs-core, whose messages the backends write.
const ERROR_CASES: ErrorCase[] = [
  compressCase('a zstd level out of range', 'ERR_COMPRS_INVALID_ARG', {
    format: 'zstd',
    level: 23,
  }),
  compressCase('a gzip level out of range', 'ERR_COMPRS_INVALID_ARG', {
    format: 'gzip',
    level: 10,
  }),
  compressCase('a fractional brotli level', 'ERR_COMPRS_INVALID_ARG', {
    format: 'brotli',
    level: 1.5,
  }),
  compressCase('a level for lz4', 'ERR_COMPRS_INVALID_ARG', { format: 'lz4', level: 1 }),
  compressCase('a dictionary for gzip', 'ERR_COMPRS_INVALID_ARG', { format: 'gzip', dictionary }),
  compressCase('an empty dictionary', 'ERR_COMPRS_INVALID_ARG', {
    format: 'zstd',
    dictionary: new Uint8Array(0),
  }),
  compressCase('a gzip header for zstd', 'ERR_COMPRS_INVALID_ARG', {
    format: 'zstd',
    gzipHeader: {},
  }),
  compressCase('an mtime out of range', 'ERR_COMPRS_INVALID_ARG', {
    format: 'gzip',
    gzipHeader: { mtime: -1 },
  }),
  compressCase('a filename with a NUL character', 'ERR_COMPRS_INVALID_ARG', {
    format: 'gzip',
    gzipHeader: { filename: 'a\0b' },
  }),
  compressCase('workers for gzip', 'ERR_COMPRS_INVALID_ARG', { format: 'gzip', workers: 2 }),
  compressCase('workers out of range', 'ERR_COMPRS_INVALID_ARG', { format: 'zstd', workers: -1 }),
  decompressCase("a dictionary with 'auto'", 'ERR_COMPRS_INVALID_ARG', compressed.zstd, {
    dictionary,
  }),
  decompressCase('a dictionary for lz4', 'ERR_COMPRS_INVALID_ARG', compressed.lz4, {
    format: 'lz4',
    dictionary,
  }),
  decompressCase('a negative maxOutputSize', 'ERR_COMPRS_INVALID_ARG', compressed.gzip, {
    maxOutputSize: -1,
  }),
  {
    name: 'a dictionary size out of range',
    code: 'ERR_COMPRS_INVALID_ARG',
    sync: (api) => api.trainDictionarySync(samples, { maxSize: 2 ** 24 + 1 }),
    async: (api) => api.trainDictionary(samples, { maxSize: 2 ** 24 + 1 }),
  },
  decompressCase('text without a format', 'ERR_COMPRS_UNKNOWN_FORMAT', text),
  decompressCase('empty data without a format', 'ERR_COMPRS_UNKNOWN_FORMAT', new Uint8Array(0)),
  decompressCase(
    'data after the end of the stream',
    'ERR_COMPRS_CORRUPT_DATA',
    concat(compressed.gzip, Uint8Array.of(0)),
  ),
  ...FORMATS.map((format) =>
    decompressCase(`corrupt ${format}`, 'ERR_COMPRS_CORRUPT_DATA', corrupt[format], { format }),
  ),
  ...FORMATS.map((format) =>
    decompressCase(
      `cut ${format}`,
      'ERR_COMPRS_TRUNCATED',
      compressed[format].subarray(0, compressed[format].length >> 1),
      { format },
    ),
  ),
  decompressCase('empty data in a format', 'ERR_COMPRS_TRUNCATED', new Uint8Array(0), {
    format: 'zstd',
  }),
  ...FORMATS.map((format) =>
    decompressCase(`${format} above maxOutputSize`, 'ERR_COMPRS_SIZE_LIMIT', compressed[format], {
      format,
      maxOutputSize: 10,
    }),
  ),
  {
    name: 'training without samples',
    code: 'ERR_COMPRS_OPERATION_FAILED',
    sync: (api) => api.trainDictionarySync([]),
    async: (api) => api.trainDictionary([]),
  },
];

/**
 * The wasm-bindgen glue, which browser/wasm.js initialises, for
 * nextErrorCodes(), which nothing re-exports. It has declarations only
 * after the build, so it is imported by a path that the type check does
 * not resolve.
 */
function importGlue(): Promise<unknown> {
  const glue: string = resolve(__dirname, '../browser/comprs-wasm.js');
  return import(glue);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

/** The codes of comprs-core's ERROR_CODES, from the hidden native binding. */
function nativeErrorCodes(): string[] {
  const binding: unknown = Reflect.get(
    require('../index.js'),
    Symbol.for('@derodero24/comprs/internal'),
  );
  if (typeof binding !== 'object' || binding === null) {
    throw new Error('the native addon has no hidden binding');
  }
  const errorCodes: unknown = Reflect.get(binding, 'errorCodes');
  if (typeof errorCodes !== 'function') throw new Error('the binding has no errorCodes()');
  const codes: unknown = Reflect.apply(errorCodes, binding, []);
  if (!isStringArray(codes)) throw new Error('errorCodes() returned no array of strings');
  return codes;
}

describe.skipIf(!HAS_WASM_BUILD)('the browser build of ./next', () => {
  let wasm: BrowserNext;
  beforeAll(async () => {
    wasm = await importBrowserNext();
  });

  /** The two builds, to call one function in each. */
  function both<T>(call: (api: Api) => T): [native: T, wasm: T] {
    return [call(native), call(wasm)];
  }

  describe('compression', () => {
    it.each(FORMAT_LEVELS)(
      'gives the bytes of the native build in %s at level %s',
      async (format, level) => {
        const options = compressOptions(format, level);
        const [expected, actual] = both((api) => run(() => api.compressSync(text, options)));
        expect(expected).toHaveProperty('returned');
        expect(actual).toEqual(expected);
        expect(await settle(() => wasm.compress(text, options))).toEqual(expected);
      },
    );

    it.each([
      ['zstd', 7],
      ['brotli', 5],
    ] as const)(
      'gives the bytes of the native build in %s with a dictionary',
      async (format, level) => {
        const options: CompressOptions = { format, level, dictionary };
        const [expected, actual] = both((api) => run(() => api.compressSync(text, options)));
        expect(expected).toHaveProperty('returned');
        expect(actual).toEqual(expected);
        expect(await settle(() => wasm.compress(text, options))).toEqual(expected);
      },
    );

    // Both builds write a lone surrogate in a file name as U+FFFD in UTF-8.
    it.each([
      [{}],
      [{ filename: 'notes.txt' }],
      [{ filename: 'résumé €.txt', mtime: 1_700_000_000 }],
      [{ filename: 'lone \ud800 surrogate.txt' }],
    ])('writes the gzip header %o as the native build does', (gzipHeader) => {
      const options: CompressOptions = { format: 'gzip', gzipHeader };
      const [expected, actual] = both((api) => run(() => api.compressSync(text, options)));
      expect(expected).toHaveProperty('returned');
      expect(actual).toEqual(expected);
    });

    it('takes 0 workers, as the native build does', () => {
      const options: CompressOptions = { format: 'zstd', workers: 0 };
      const [expected, actual] = both((api) => run(() => api.compressSync(text, options)));
      expect(expected).toHaveProperty('returned');
      expect(actual).toEqual(expected);
    });

    // The native build compresses with workers; comprs-core is built
    // without them for WebAssembly.
    it('rejects workers, which it does not support', async () => {
      const options: CompressOptions = { format: 'zstd', workers: 1 };
      const unsupported = thrown(
        Object.assign(new TypeError('zstd workers are not supported in this build'), {
          code: 'ERR_COMPRS_INVALID_ARG',
        }),
      );
      expect(run(() => wasm.compressSync(text, options))).toEqual(unsupported);
      expect(await settle(() => wasm.compress(text, options))).toEqual(unsupported);
      expect(run(() => native.compressSync(text, options))).toHaveProperty('returned');
    });

    // The async functions call the backend before they return, as those of
    // the native build copy their inputs.
    it('reads the data when compress() is called', async () => {
      const data = Uint8Array.from(text);
      const promise = wasm.compress(data, { format: 'zstd' });
      data.fill(0);
      expect(await promise).toEqual(native.compressSync(text, { format: 'zstd' }));
    });

    it('returns Uint8Arrays over ArrayBuffers of their own', () => {
      const output = wasm.compressSync(text, { format: 'zstd' });
      expect(output.constructor).toBe(Uint8Array);
      expect(output.buffer).not.toBe(wasmMemory().buffer);
      expect(output.byteOffset).toBe(0);
      expect(output.buffer.byteLength).toBe(output.byteLength);
    });
  });

  describe('decompression', () => {
    it.each(FORMATS)('reads %s that the native build wrote', async (format) => {
      expect(wasm.decompressSync(compressed[format], { format })).toEqual(text);
      expect(await wasm.decompress(compressed[format], { format })).toEqual(text);
    });

    it.each(DETECTED)('detects %s as the native build does', async (format) => {
      expect(wasm.decompressSync(compressed[format])).toEqual(text);
      expect(await wasm.decompress(compressed[format], { format: 'auto' })).toEqual(text);
    });

    it.each(['zstd', 'brotli'] as const)('reads %s with a dictionary', (format) => {
      const data = native.compressSync(text, { format, dictionary });
      expect(wasm.decompressSync(data, { format, dictionary })).toEqual(text);
    });

    it('reads up to maxOutputSize', () => {
      expect(wasm.decompressSync(compressed.zstd, { maxOutputSize: text.length })).toEqual(text);
    });
  });

  describe('detection', () => {
    it.each([
      ...FORMATS.map((format): [string, Uint8Array] => [format, compressed[format]]),
      ['empty data', new Uint8Array(0)],
      ['text', text],
    ])('finds in %s what the native build finds', (_, data) => {
      const [expected, actual] = both((api) => run(() => api.detectFormat(data)));
      expect(actual).toEqual(expected);
    });
  });

  describe('dictionary training', () => {
    it('trains the dictionary of the native build', async () => {
      const [expected, actual] = both((api) =>
        run(() => api.trainDictionarySync(samples, { maxSize: 2048 })),
      );
      expect(expected).toHaveProperty('returned');
      expect(actual).toEqual(expected);
      expect(await settle(() => wasm.trainDictionary(samples, { maxSize: 2048 }))).toEqual(
        expected,
      );
    });
  });

  describe('errors', () => {
    it('carry the codes of the native build', async () => {
      const glue = await importGlue();
      const errorCodes: unknown = Reflect.get(Object(glue), 'nextErrorCodes');
      if (typeof errorCodes !== 'function') throw new Error('the glue has no nextErrorCodes()');
      expect(Reflect.apply(errorCodes, undefined, [])).toEqual(nativeErrorCodes());
    });

    it('cover every code that the functions give', () => {
      const unreachable = ['ERR_COMPRS_STREAM_FINISHED', 'ERR_COMPRS_STREAM_CLOSED'];
      const reached = new Set(ERROR_CASES.map((errorCase) => errorCase.code));
      expect([...reached, ...unreachable].sort()).toEqual(nativeErrorCodes().sort());
    });

    it.each(ERROR_CASES)('are thrown as by the native build for $name', ({ code, sync }) => {
      const [expected, actual] = both((api) => run(() => sync(api)));
      expect(expected).toMatchObject({
        threw: { class: code === 'ERR_COMPRS_INVALID_ARG' ? 'TypeError' : 'Error', code },
      });
      expect(actual).toEqual(expected);
    });

    it.each(ERROR_CASES)('reject as in the native build for $name', async ({ code, async }) => {
      const expected = await settle(() => async(native));
      expect(expected).toMatchObject({
        threw: { class: code === 'ERR_COMPRS_INVALID_ARG' ? 'TypeError' : 'Error', code },
      });
      expect(await settle(() => async(wasm))).toEqual(expected);
    });
  });
});

/**
 * Whether `symbol`, an export of a module, exports a value: whether it
 * names one, and no import or export on the way makes it a type only.
 */
function exportsValue(checker: ts.TypeChecker, symbol: ts.Symbol): boolean {
  let current: ts.Symbol | undefined = symbol;
  while (current !== undefined && current.flags & ts.SymbolFlags.Alias) {
    if (current.declarations?.some(ts.isTypeOnlyImportOrExportDeclaration)) return false;
    current = checker.getImmediateAliasedSymbol(current);
  }
  return current !== undefined && (current.flags & ts.SymbolFlags.Value) !== 0;
}

/**
 * The names that a declaration file exports, each with whether it exports a
 * value or a type only, as TypeScript resolves them through the
 * re-exports.
 */
function exportsOf(file: string): string[] {
  const path = resolve(__dirname, '..', file);
  const program = ts.createProgram([path], { noLib: true, types: [], noEmit: true });
  const checker = program.getTypeChecker();
  const source = program.getSourceFile(path);
  const entry = source === undefined ? undefined : checker.getSymbolAtLocation(source);
  if (entry === undefined) throw new Error(`${file} is not a module`);
  return checker
    .getExportsOfModule(entry)
    .map((symbol) => `${exportsValue(checker, symbol) ? 'value' : 'type'} ${symbol.name}`)
    .sort();
}

// The browser build declares the API of the native build: tsc emits both
// api.d.ts files from src/next/api.ts, and each entry re-exports its
// names. If they ever differ for a reason, compare their public members
// instead, recursively, rather than less.
describe('the declarations of the browser build of ./next', () => {
  it('declare the functions and types of the native build, byte for byte', () => {
    const declarations = (dir: string) => readFileSync(resolve(__dirname, '..', dir, 'api.d.ts'));
    expect(declarations('browser/next').equals(declarations('next'))).toBe(true);
  });

  it('export the names of the native build', () => {
    const names = exportsOf('next/index.d.ts');
    expect(names).toContain('value compress');
    expect(names).toContain('type ErrorCode');
    expect(exportsOf('browser/next/browser.d.ts')).toEqual(names);
  });
});
