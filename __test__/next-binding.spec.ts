import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { deflateRawSync, deflateSync, inflateRawSync, inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { gzipCompressWithHeader } from '../index.js';

// The native addon has a hidden binding for the unified API
// (@derodero24/comprs/next, #577), whose TypeScript layer is its only
// caller: the functions of crates/core/src/next.rs, under
// Symbol.for('@derodero24/comprs/internal'). They take the fields of the
// options objects as positional arguments, and their errors carry the codes
// of comprs-core's error categories. Nothing of them may show among the
// exports of the root entry.

const require = createRequire(__filename);

const INTERNAL = Symbol.for('@derodero24/comprs/internal');

/** The formats of the unified API. */
const FORMATS = ['zstd', 'gzip', 'deflate', 'deflate-raw', 'brotli', 'lz4'] as const;
type Format = (typeof FORMATS)[number];

/** The functions of the hidden binding. */
interface NextBinding {
  compress(
    data: Uint8Array,
    format: string,
    level?: number,
    dictionary?: Uint8Array,
    gzipHeader?: boolean,
    gzipFilename?: string,
    gzipMtime?: number,
    workers?: number,
  ): Uint8Array;
  compressAsync(
    data: Uint8Array,
    format: string,
    level?: number,
    dictionary?: Uint8Array,
    gzipHeader?: boolean,
    gzipFilename?: string,
    gzipMtime?: number,
    workers?: number,
  ): Promise<Uint8Array>;
  decompress(
    data: Uint8Array,
    format?: string,
    maxOutputSize?: number,
    dictionary?: Uint8Array,
  ): Uint8Array;
  decompressAsync(
    data: Uint8Array,
    format?: string,
    maxOutputSize?: number,
    dictionary?: Uint8Array,
  ): Promise<Uint8Array>;
  detectFormat(data: Uint8Array): string | null;
  trainDictionary(samples: Uint8Array[], maxSize?: number): Uint8Array;
  trainDictionaryAsync(samples: Uint8Array[], maxSize?: number): Promise<Uint8Array>;
  errorCodes(): string[];
}

const FUNCTIONS = [
  'compress',
  'compressAsync',
  'decompress',
  'decompressAsync',
  'detectFormat',
  'trainDictionary',
  'trainDictionaryAsync',
  'errorCodes',
] as const satisfies readonly (keyof NextBinding)[];

function isNextBinding(value: unknown): value is NextBinding {
  return (
    typeof value === 'object' &&
    value !== null &&
    FUNCTIONS.every((name) => typeof Reflect.get(value, name) === 'function')
  );
}

/** The root entry, as require() returns it. */
function root(): object {
  return require('../index.js');
}

/** The hidden binding, which every test but those of hiding needs. */
function next(): NextBinding {
  const binding: unknown = Reflect.get(root(), INTERNAL);
  if (!isNextBinding(binding)) {
    throw new Error('the native addon has no hidden binding for the unified API');
  }
  return binding;
}

const DECLARED_VALUE = /^export declare (?:function|class|(?:const )?enum|const) (\w+)/gm;

/** The values that index.d.ts declares, as export-parity.mjs reads them. */
function declaredNames(): string[] {
  const source = readFileSync(resolve(__dirname, '../index.d.ts'), 'utf8');
  return [...source.matchAll(DECLARED_VALUE)].flatMap((match) => match[1] ?? []);
}

const encoder = new TextEncoder();
const text = encoder.encode('comprs exposes its unified codec layer to TypeScript. '.repeat(400));
const dictionary = encoder.encode('unified codec layer TypeScript comprs exposes its '.repeat(8));
const samples = Array.from({ length: 200 }, (_, i) =>
  encoder.encode(JSON.stringify({ id: i, name: `item ${i}`, tags: ['a', 'b'] })),
);

/** The error that `call` throws. */
function thrown(call: () => unknown): unknown {
  try {
    call();
  } catch (error) {
    return error;
  }
  throw new Error('expected the call to throw');
}

/** The error that `promise` rejects with. */
async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected the Promise to reject');
}

describe('hiding', () => {
  it('keeps the binding under Symbol.for("@derodero24/comprs/internal")', () => {
    const descriptor = Object.getOwnPropertyDescriptor(root(), INTERNAL);
    expect(descriptor).toMatchObject({ enumerable: false, writable: false, configurable: false });
    expect(isNextBinding(descriptor?.value)).toBe(true);
    expect(Object.keys(next()).sort()).toEqual([...FUNCTIONS].sort());
  });

  it('adds nothing to the names of require()', () => {
    const keys = Object.keys(root());
    expect(keys).not.toContain('next');
    expect(Object.getOwnPropertyNames(root())).not.toContain('next');
    expect(keys.sort()).toEqual(declaredNames().sort());
  });

  it('adds nothing to the ES module namespace', async () => {
    const namespace: object = await import('../index.mjs');
    expect(Object.keys(namespace)).not.toContain('next');
    expect(Object.getOwnPropertySymbols(namespace)).not.toContain(INTERNAL);
  });
});

describe.each(FORMATS)('%s', (format) => {
  /** The format that decompression detects in `format`: none for raw deflate. */
  const detected: Format | undefined = format === 'deflate-raw' ? undefined : format;

  it('round-trips synchronously', () => {
    const compressed = next().compress(text, format);
    expect(next().decompress(compressed, format)).toEqual(text);
    expect(next().detectFormat(compressed)).toBe(detected ?? null);
    if (detected !== undefined) {
      expect(next().decompress(compressed)).toEqual(text);
    }
  });

  it('round-trips asynchronously', async () => {
    const compressed = await next().compressAsync(text, format);
    expect(compressed).toEqual(next().compress(text, format));
    expect(await next().decompressAsync(compressed, format)).toEqual(text);
    if (detected !== undefined) {
      expect(await next().decompressAsync(compressed)).toEqual(text);
    }
  });

  it('returns plain Uint8Arrays', async () => {
    const compressed = next().compress(text, format);
    const results = [
      compressed,
      next().decompress(compressed, format),
      await next().compressAsync(text, format),
      await next().decompressAsync(compressed, format),
      next().decompress(next().compress(new Uint8Array(0), format), format),
    ];
    for (const result of results) {
      expect(Object.getPrototypeOf(result)).toBe(Uint8Array.prototype);
    }
  });
});

describe('dictionaries', () => {
  it.each(['zstd', 'brotli'] as const)('round-trip with raw %s dictionaries', async (format) => {
    const compressed = next().compress(text, format, undefined, dictionary);
    expect(compressed.byteLength).toBeLessThan(next().compress(text, format).byteLength);
    expect(next().decompress(compressed, format, undefined, dictionary)).toEqual(text);
    expect(await next().compressAsync(text, format, undefined, dictionary)).toEqual(compressed);
    expect(await next().decompressAsync(compressed, format, undefined, dictionary)).toEqual(text);
  });

  it('trains zstd dictionaries', async () => {
    const trained = next().trainDictionary(samples, 4096);
    expect(trained.byteLength).toBeGreaterThan(0);
    expect(trained.byteLength).toBeLessThanOrEqual(4096);
    expect(Object.getPrototypeOf(trained)).toBe(Uint8Array.prototype);
    const fromAsync = await next().trainDictionaryAsync(samples, 4096);
    expect(fromAsync).toEqual(trained);
    expect(Object.getPrototypeOf(fromAsync)).toBe(Uint8Array.prototype);
    const message = encoder.encode(JSON.stringify({ id: 1000, name: 'item 1000', tags: ['a'] }));
    const compressed = next().compress(message, 'zstd', undefined, trained);
    expect(next().decompress(compressed, 'zstd', undefined, trained)).toEqual(message);
  });
});

describe('zstd workers', () => {
  // More than the 512 KiB that zstd compresses without its workers.
  const large = encoder.encode('zstd compresses this input with worker threads. '.repeat(24_000));

  it.each([0, 2])('round-trip with %i workers', async (workers) => {
    const compressed = next().compress(
      large,
      'zstd',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      workers,
    );
    expect(next().decompress(compressed, 'zstd')).toEqual(large);
    const fromAsync = await next().compressAsync(
      large,
      'zstd',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      workers,
    );
    expect(next().decompress(fromAsync, 'zstd')).toEqual(large);
  });

  it('compress with 0 workers as without them', () => {
    const compressed = next().compress(
      large,
      'zstd',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      0,
    );
    expect(compressed).toEqual(next().compress(large, 'zstd'));
  });
});

describe('the gzip header', () => {
  it('holds the filename and the modification time', () => {
    const compressed = next().compress(
      text,
      'gzip',
      undefined,
      undefined,
      true,
      'data.txt',
      1_700_000_000,
    );
    // The same bytes as the root function's, which returns a Buffer.
    expect(Buffer.from(compressed)).toEqual(
      gzipCompressWithHeader(text, { filename: 'data.txt', mtime: 1_700_000_000 }),
    );
    expect(Buffer.from(compressed.subarray(4, 8)).readUInt32LE()).toBe(1_700_000_000);
    expect(Buffer.from(compressed).includes('data.txt\0')).toBe(true);
    expect(next().decompress(compressed)).toEqual(text);
  });

  it('is the default one without fields', async () => {
    const compressed = next().compress(text, 'gzip');
    expect(next().compress(text, 'gzip', undefined, undefined, true)).toEqual(compressed);
    expect(await next().compressAsync(text, 'gzip', undefined, undefined, true)).toEqual(
      compressed,
    );
  });
});

describe('node:zlib interoperability', () => {
  it("decodes 'deflate' as zlib and 'deflate-raw' as raw deflate", () => {
    expect(inflateSync(next().compress(text, 'deflate'))).toEqual(Buffer.from(text));
    expect(inflateRawSync(next().compress(text, 'deflate-raw'))).toEqual(Buffer.from(text));
  });

  it("decompresses zlib's output as 'deflate' and 'deflate-raw'", () => {
    const zlib = deflateSync(text);
    expect(next().decompress(zlib, 'deflate')).toEqual(text);
    expect(next().decompress(zlib)).toEqual(text);
    expect(next().detectFormat(zlib)).toBe('deflate');
    expect(next().decompress(deflateRawSync(text), 'deflate-raw')).toEqual(text);
  });
});

describe('results', () => {
  // Up to 2 MiB, results are copied into memory that V8 allocates; larger
  // ones keep the memory of the addon. Both are plain Uint8Arrays.
  it('are plain Uint8Arrays above the copy limit too', async () => {
    const large = new Uint8Array(2 * 1024 * 1024 + 1).fill(7);
    const compressed = next().compress(large, 'zstd');
    for (const result of [
      next().decompress(compressed, 'zstd'),
      await next().decompressAsync(compressed, 'zstd'),
    ]) {
      expect(Object.getPrototypeOf(result)).toBe(Uint8Array.prototype);
      expect(result).toEqual(large);
    }
  });
});

describe('the *Async functions', () => {
  // They copy their inputs when they are called (#548), so changing the
  // inputs afterwards does not change the result.
  it('copy the data and the dictionary when they are called', async () => {
    const data = Uint8Array.from(text);
    const dict = Uint8Array.from(dictionary);
    const compressing = next().compressAsync(data, 'zstd', undefined, dict);
    data.fill(0);
    dict.fill(0);
    const compressed = await compressing;
    expect(next().decompress(compressed, 'zstd', undefined, dictionary)).toEqual(text);

    dict.set(dictionary);
    const decompressing = next().decompressAsync(compressed, 'zstd', undefined, dict);
    compressed.fill(0);
    dict.fill(0);
    expect(await decompressing).toEqual(text);
  });

  it('copy the samples when they are called', async () => {
    const copies = samples.map((sample) => Uint8Array.from(sample));
    const training = next().trainDictionaryAsync(copies, 4096);
    for (const copy of copies) copy.fill(0);
    expect(await training).toEqual(next().trainDictionary(samples, 4096));
  });
});

describe('samples', () => {
  // napi-rs reads the elements of the array one by one, and a getter of a
  // later element may detach the buffer of an earlier one. The binding
  // copies each sample as it reads it, so it never reads detached memory.
  it('are copied as they are read', async () => {
    const expected = next().trainDictionary(samples, 4096);
    for (const train of [
      (input: Uint8Array[]) => next().trainDictionary(input, 4096),
      (input: Uint8Array[]) => next().trainDictionaryAsync(input, 4096),
    ]) {
      const copies = samples.map((sample) => Uint8Array.from(sample));
      const [first, second] = copies;
      if (first === undefined || second === undefined) throw new Error('expected samples');
      Object.defineProperty(copies, 1, {
        get(): Uint8Array {
          structuredClone(first.buffer, { transfer: [first.buffer] });
          return second;
        },
      });
      expect(await train(copies)).toEqual(expected);
      expect(first.byteLength).toBe(0);
    }
  });
});

/** An error that a call of the hidden binding must give. */
interface ErrorCase {
  name: string;
  code: string;
  /** The message, or for a message that ends with a library's text, its start. */
  message: string | RegExp;
  sync(binding: NextBinding): unknown;
  async(binding: NextBinding): Promise<unknown>;
}

const ERROR_CASES: ErrorCase[] = [
  {
    name: 'a level out of range',
    code: 'ERR_COMPRS_INVALID_ARG',
    message: 'zstd compression level must be an integer between -131072 and 22',
    sync: (n) => n.compress(text, 'zstd', 23),
    async: (n) => n.compressAsync(text, 'zstd', 23),
  },
  {
    name: 'an unknown format',
    code: 'ERR_COMPRS_INVALID_ARG',
    message: 'format must be one of zstd, gzip, deflate, deflate-raw, brotli, lz4',
    sync: (n) => n.decompress(n.compress(text, 'zstd'), 'zip'),
    async: (n) => n.decompressAsync(n.compress(text, 'zstd'), 'zip'),
  },
  {
    name: 'a dictionary for gzip',
    code: 'ERR_COMPRS_INVALID_ARG',
    message: 'gzip does not support dictionaries',
    sync: (n) => n.compress(text, 'gzip', undefined, dictionary),
    async: (n) => n.compressAsync(text, 'gzip', undefined, dictionary),
  },
  {
    name: 'a gzip header without fields for zstd',
    code: 'ERR_COMPRS_INVALID_ARG',
    message: 'gzipHeader applies to gzip compression only',
    sync: (n) => n.compress(text, 'zstd', undefined, undefined, true),
    async: (n) => n.compressAsync(text, 'zstd', undefined, undefined, true),
  },
  {
    // The format rules out the header before its fields are checked.
    name: 'a gzip header with an mtime out of range for zstd',
    code: 'ERR_COMPRS_INVALID_ARG',
    message: 'gzipHeader applies to gzip compression only',
    sync: (n) => n.compress(text, 'zstd', undefined, undefined, true, undefined, -1),
    async: (n) => n.compressAsync(text, 'zstd', undefined, undefined, true, undefined, -1),
  },
  {
    // A field of the header implies the header.
    name: 'a gzip filename for zstd',
    code: 'ERR_COMPRS_INVALID_ARG',
    message: 'gzipHeader applies to gzip compression only',
    sync: (n) => n.compress(text, 'zstd', undefined, undefined, undefined, 'data.txt'),
    async: (n) => n.compressAsync(text, 'zstd', undefined, undefined, undefined, 'data.txt'),
  },
  {
    name: 'an mtime out of range',
    code: 'ERR_COMPRS_INVALID_ARG',
    message: 'mtime must be an integer between 0 and 4294967295',
    sync: (n) => n.compress(text, 'gzip', undefined, undefined, true, undefined, -1),
    async: (n) => n.compressAsync(text, 'gzip', undefined, undefined, true, undefined, -1),
  },
  {
    name: 'workers for gzip',
    code: 'ERR_COMPRS_INVALID_ARG',
    message: 'workers applies to zstd compression only',
    sync: (n) => n.compress(text, 'gzip', undefined, undefined, undefined, undefined, undefined, 2),
    async: (n) =>
      n.compressAsync(text, 'gzip', undefined, undefined, undefined, undefined, undefined, 2),
  },
  {
    name: 'a dictionary without a format',
    code: 'ERR_COMPRS_INVALID_ARG',
    message: 'pass `format` to decompress with a dictionary',
    sync: (n) => n.decompress(n.compress(text, 'zstd'), undefined, undefined, dictionary),
    async: (n) => n.decompressAsync(n.compress(text, 'zstd'), undefined, undefined, dictionary),
  },
  {
    name: 'a maxOutputSize out of range',
    code: 'ERR_COMPRS_INVALID_ARG',
    message: 'maxOutputSize must be an integer between 0 and 9007199254740991',
    sync: (n) => n.decompress(n.compress(text, 'zstd'), 'zstd', -1),
    async: (n) => n.decompressAsync(n.compress(text, 'zstd'), 'zstd', -1),
  },
  {
    name: 'a maxSize out of range',
    code: 'ERR_COMPRS_INVALID_ARG',
    message: 'maxSize must be an integer between 0 and 16777216',
    sync: (n) => n.trainDictionary(samples, 2 ** 24 + 1),
    async: (n) => n.trainDictionaryAsync(samples, 2 ** 24 + 1),
  },
  {
    name: 'data of unknown format',
    code: 'ERR_COMPRS_UNKNOWN_FORMAT',
    message: 'unable to detect the compression format; pass `format`',
    sync: (n) => n.decompress(text),
    async: (n) => n.decompressAsync(text),
  },
  {
    name: 'data after the end of the stream',
    code: 'ERR_COMPRS_CORRUPT_DATA',
    message: 'gzip decompress failed: unexpected data after the end of the compressed stream',
    sync: (n) => n.decompress(Uint8Array.from([...n.compress(text, 'gzip'), 0]), 'gzip'),
    async: (n) => n.decompressAsync(Uint8Array.from([...n.compress(text, 'gzip'), 0]), 'gzip'),
  },
  {
    name: 'a cut stream',
    code: 'ERR_COMPRS_TRUNCATED',
    message: 'zstd stream is truncated: unexpected end of input',
    sync: (n) => n.decompress(n.compress(text, 'zstd').subarray(0, 8), 'zstd'),
    async: (n) => n.decompressAsync(n.compress(text, 'zstd').subarray(0, 8), 'zstd'),
  },
  {
    name: 'output above maxOutputSize',
    code: 'ERR_COMPRS_SIZE_LIMIT',
    message: 'zstd decompress exceeded maximum size of 10 bytes',
    sync: (n) => n.decompress(n.compress(text, 'zstd'), 'zstd', 10),
    async: (n) => n.decompressAsync(n.compress(text, 'zstd'), 'zstd', 10),
  },
  {
    name: 'training without samples',
    code: 'ERR_COMPRS_OPERATION_FAILED',
    message: /^zstd dictionary training failed: /,
    sync: (n) => n.trainDictionary([]),
    async: (n) => n.trainDictionaryAsync([]),
  },
];

/** Check that `error` has the code, the message and the class of `expected`. */
function expectCoded(error: unknown, expected: ErrorCase): void {
  expect(error).toMatchObject({ code: expected.code, message: expected.message });
  // ERR_COMPRS_INVALID_ARG is a TypeError, every other code a plain Error.
  const prototype = expected.code === 'ERR_COMPRS_INVALID_ARG' ? TypeError : Error;
  expect(Object.getPrototypeOf(error)).toBe(prototype.prototype);
}

describe('errors', () => {
  it('cover a case of every code that the functions can reach', () => {
    const reached = new Set(ERROR_CASES.map((errorCase) => errorCase.code));
    // Stream contexts are not part of the binding yet.
    const unreachable = ['ERR_COMPRS_STREAM_FINISHED', 'ERR_COMPRS_STREAM_CLOSED'];
    expect([...reached, ...unreachable].sort()).toEqual([...next().errorCodes()].sort());
  });

  it.each(ERROR_CASES)('are thrown with their code and class for $name', (errorCase) => {
    expectCoded(
      thrown(() => errorCase.sync(next())),
      errorCase,
    );
  });

  it.each(ERROR_CASES)(
    'reject the Promise with their code and class for $name',
    async (errorCase) => {
      // The call returns a Promise rather than throwing.
      const promise = errorCase.async(next());
      expectCoded(await rejection(promise), errorCase);
    },
  );
});

describe('errorCodes', () => {
  it("returns comprs-core's ERROR_CODES", () => {
    expect(next().errorCodes()).toEqual([
      'ERR_COMPRS_INVALID_ARG',
      'ERR_COMPRS_UNKNOWN_FORMAT',
      'ERR_COMPRS_CORRUPT_DATA',
      'ERR_COMPRS_TRUNCATED',
      'ERR_COMPRS_SIZE_LIMIT',
      'ERR_COMPRS_STREAM_FINISHED',
      'ERR_COMPRS_STREAM_CLOSED',
      'ERR_COMPRS_OPERATION_FAILED',
    ]);
  });
});
