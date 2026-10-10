import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { types } from 'node:util';
import { createContext, runInContext } from 'node:vm';
import * as zlib from 'node:zlib';
import {
  type BrotliOptions,
  brotliCompressSync,
  brotliDecompressSync,
  constants,
  deflateRawSync,
  deflateSync,
  gunzipSync,
  gzipSync,
  inflateRawSync,
  inflateSync,
} from 'node:zlib';
import { describe, expect, it } from 'vitest';
import {
  brotliCompress,
  brotliCompressWithDict,
  CompressionFormat,
  deflateCompress,
  gzipCompress,
  gzipCompressWithHeader,
  lz4Compress,
  decompress as rootDecompress,
  detectFormat as rootDetectFormat,
  zstdCompress,
  zstdCompressWithDict,
  zstdTrainDictionary,
} from '../index.js';
import type * as BackendModule from '../next/backend.js';
import type { Backend } from '../next/backend.js';
import type { Bytes, CompressOptions, Format, Input } from '../next/index.js';
import * as next from '../next/index.js';

// The unified API, @derodero24/comprs/next (#577), as the native build
// compiles it from src/next: the functions of api.ts over the hidden binding
// of the native addon. The tests import the outputs by path;
// export-parity.mjs and esm-bundle.spec.ts load them by the package name.

const require = createRequire(__filename);

/** The formats of the unified API. */
const FORMATS: readonly Format[] = ['zstd', 'gzip', 'deflate', 'deflate-raw', 'brotli', 'lz4'];

/** The formats that decompression detects: all but raw deflate. */
const DETECTED: readonly Format[] = FORMATS.filter((format) => format !== 'deflate-raw');

/** Levels of each format, `undefined` for the default. lz4 takes none. */
const LEVELS: Record<Format, readonly (number | undefined)[]> = {
  zstd: [undefined, -5, 0, 1, 19],
  gzip: [undefined, 0, 1, 9],
  deflate: [undefined, 0, 1, 5, 9],
  'deflate-raw': [undefined, 0, 1, 9],
  brotli: [undefined, 0, 11],
  lz4: [undefined],
};

/** `bytes`, a Buffer of the root entry, as a plain Uint8Array to compare. */
function plain(bytes: Uint8Array): Uint8Array {
  return new Uint8Array(bytes);
}

/**
 * The output of the root entry's function for `format` at `level`, as a
 * plain Uint8Array.
 */
function rootCompress(data: Uint8Array, format: Format, level: number | undefined): Uint8Array {
  return plain(rootOutput(data, format, level));
}

/**
 * The zlib header (RFC 1950) that comprs writes at `level`, as zlib does:
 * CMF 0x78, deflate with a 32 KiB window, then FLG, whose FLEVEL is 0 below
 * level 2, 1 below level 6, 2 at level 6, the default, and 3 above, and
 * whose FCHECK makes the two bytes a multiple of 31. Its encoder, zlib-rs,
 * sets FLEVEL as zlib's deflate.c does; the node:zlib tests check that the
 * headers are those of zlib.
 */
function zlibHeader(level: number | undefined): Uint8Array {
  const effective = level ?? 6;
  if (effective < 2) return Uint8Array.of(0x78, 0x01);
  if (effective < 6) return Uint8Array.of(0x78, 0x5e);
  return effective === 6 ? Uint8Array.of(0x78, 0x9c) : Uint8Array.of(0x78, 0xda);
}

/**
 * The output of the root entry's function for `format` at `level`. The root
 * entry writes no zlib: for 'deflate', its raw deflate, deflateCompress(),
 * is put between the zlib header for the level and the Adler-32 checksum of
 * the data, which the zlib output of node:zlib ends with at any level.
 */
function rootOutput(data: Uint8Array, format: Format, level: number | undefined): Uint8Array {
  switch (format) {
    case 'zstd':
      return zstdCompress(data, level);
    case 'gzip':
      return gzipCompress(data, level);
    case 'deflate':
      return Buffer.concat([
        zlibHeader(level),
        deflateCompress(data, level),
        deflateSync(data).subarray(-4),
      ]);
    case 'deflate-raw':
      return deflateCompress(data, level);
    case 'brotli':
      return brotliCompress(data, level);
    case 'lz4':
      return lz4Compress(data);
  }
}

/** The options of compressSync() for `format` at `level`. */
function compressOptions(format: Format, level: number | undefined): CompressOptions {
  return level === undefined ? { format } : { format, level };
}

const encoder = new TextEncoder();
const text = encoder.encode('comprs unifies its codecs behind one API. '.repeat(400));
const dictionary = encoder.encode('unifies its codecs behind one API comprs '.repeat(8));
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

/**
 * The Promise that `call` returns, which it must return rather than throw.
 */
function promiseOf(call: () => Promise<unknown>): Promise<unknown> {
  let promise: Promise<unknown> | undefined;
  expect(() => {
    promise = call();
  }).not.toThrow();
  expect(promise).toBeInstanceOf(Promise);
  return promise ?? Promise.resolve();
}

/** Check that `error` carries `code`, and is a TypeError exactly for ERR_COMPRS_INVALID_ARG. */
function expectCoded(error: unknown, code: string, message?: string | RegExp): void {
  expect(error).toMatchObject(message === undefined ? { code } : { code, message });
  const prototype = code === 'ERR_COMPRS_INVALID_ARG' ? TypeError : Error;
  expect(Object.getPrototypeOf(error)).toBe(prototype.prototype);
}

function expectPlainUint8Array(result: Bytes): void {
  expect(Object.getPrototypeOf(result)).toBe(Uint8Array.prototype);
}

describe.each(FORMATS)('%s', (format) => {
  it.each(LEVELS[format])('compresses as the root entry does at level %s', async (level) => {
    const expected = rootCompress(text, format, level);
    const options = compressOptions(format, level);
    const compressed = next.compressSync(text, options);
    expect(compressed).toEqual(expected);
    expect(await next.compress(text, options)).toEqual(expected);
    expect(next.decompressSync(compressed, { format })).toEqual(text);
    expect(await next.decompress(compressed, { format })).toEqual(text);
  });

  it('round-trips empty data', async () => {
    const compressed = next.compressSync(new Uint8Array(0), { format });
    expect(next.decompressSync(compressed, { format })).toEqual(new Uint8Array(0));
    expect(
      await next.decompress(await next.compress(new Uint8Array(0), { format }), { format }),
    ).toEqual(new Uint8Array(0));
  });

  it('limits the output to maxOutputSize', async () => {
    const compressed = next.compressSync(text, { format });
    const exact = { format, maxOutputSize: text.byteLength };
    expect(next.decompressSync(compressed, exact)).toEqual(text);
    expect(await next.decompress(compressed, exact)).toEqual(text);
    const below = { format, maxOutputSize: text.byteLength - 1 };
    expectCoded(
      thrown(() => next.decompressSync(compressed, below)),
      'ERR_COMPRS_SIZE_LIMIT',
    );
    expectCoded(await rejection(next.decompress(compressed, below)), 'ERR_COMPRS_SIZE_LIMIT');
  });

  it('returns plain Uint8Arrays', async () => {
    const compressed = next.compressSync(text, { format });
    for (const result of [
      compressed,
      await next.compress(text, { format }),
      next.decompressSync(compressed, { format }),
      await next.decompress(compressed, { format }),
      next.compressSync(new Uint8Array(0), { format }),
    ]) {
      expectPlainUint8Array(result);
    }
  });
});

describe('detection', () => {
  it.each(DETECTED)('finds %s', async (format) => {
    const compressed = next.compressSync(text, { format });
    expect(next.detectFormat(compressed)).toBe(format);
    expect(next.decompressSync(compressed)).toEqual(text);
    expect(next.decompressSync(compressed, { format: 'auto' })).toEqual(text);
    expect(await next.decompress(compressed)).toEqual(text);
    expect(await next.decompress(compressed, {})).toEqual(text);
  });

  it('finds zlib written by node:zlib', () => {
    const zlib = deflateSync(text);
    expect(next.detectFormat(zlib)).toBe('deflate');
    expect(next.decompressSync(zlib)).toEqual(text);
  });

  it('never finds raw deflate, which has no header', () => {
    const raw = next.compressSync(text, { format: 'deflate-raw' });
    expect(next.detectFormat(raw)).toBeUndefined();
    expectCoded(
      thrown(() => next.decompressSync(raw)),
      'ERR_COMPRS_UNKNOWN_FORMAT',
    );
  });

  it('finds nothing in empty data or text', () => {
    expect(next.detectFormat(new Uint8Array(0))).toBeUndefined();
    expect(next.detectFormat(text)).toBeUndefined();
  });

  it('throws TypeErrors for data of the wrong type', () => {
    expectCoded(
      thrown(() => Reflect.apply(next.detectFormat, undefined, ['data'])),
      'ERR_COMPRS_INVALID_ARG',
      'data must be an ArrayBuffer, SharedArrayBuffer or ArrayBufferView',
    );
    expectCoded(
      thrown(() => next.detectFormat(detachedView())),
      'ERR_COMPRS_INVALID_ARG',
      'data is backed by a detached ArrayBuffer',
    );
    expectCoded(
      thrown(() => next.detectFormat(shrunk((buffer) => new Uint8Array(buffer, 4, 4), 2))),
      'ERR_COMPRS_INVALID_ARG',
      'data is out of bounds of its ArrayBuffer',
    );
    expectCoded(
      thrown(() => next.detectFormat(new Proxy(new ArrayBuffer(8), {}))),
      'ERR_COMPRS_INVALID_ARG',
      'data must be an ArrayBuffer, SharedArrayBuffer or ArrayBufferView',
    );
  });
});

/** Whether node:zlib has zstd, which Node.js has had since 22.15 and 23.8. */
const zstdAvailable = 'zstdCompressSync' in zlib;

/** Options of node:zlib's brotliCompressSync(), by what they set. */
const BROTLI_OPTIONS: [string, BrotliOptions][] = [
  ['the default settings', {}],
  ['a 64 KiB window', { params: { [constants.BROTLI_PARAM_LGWIN]: 16 } }],
];

describe('node:zlib interoperability', () => {
  it.each(LEVELS.deflate)("writes zlib with zlib's header at level %s", (level) => {
    const compressed = next.compressSync(text, compressOptions('deflate', level));
    expect(inflateSync(compressed)).toEqual(Buffer.from(text));
    const zlibOutput = deflateSync(text, level === undefined ? {} : { level });
    expect(compressed.subarray(0, 2)).toEqual(plain(zlibOutput.subarray(0, 2)));
    expect(zlibHeader(level)).toEqual(plain(zlibOutput.subarray(0, 2)));
  });

  it("writes zlib as 'deflate' and raw deflate as 'deflate-raw'", async () => {
    expect(inflateSync(next.compressSync(text, { format: 'deflate' }))).toEqual(Buffer.from(text));
    expect(inflateSync(await next.compress(text, { format: 'deflate', level: 9 }))).toEqual(
      Buffer.from(text),
    );
    expect(inflateRawSync(next.compressSync(text, { format: 'deflate-raw' }))).toEqual(
      Buffer.from(text),
    );
    expect(gunzipSync(next.compressSync(text, { format: 'gzip' }))).toEqual(Buffer.from(text));
  });

  it("reads zlib as 'deflate' and raw deflate as 'deflate-raw'", async () => {
    expect(next.decompressSync(deflateSync(text), { format: 'deflate' })).toEqual(text);
    expect(await next.decompress(deflateSync(text, { level: 1 }), { format: 'deflate' })).toEqual(
      text,
    );
    expect(next.decompressSync(deflateRawSync(text), { format: 'deflate-raw' })).toEqual(text);
    expect(next.decompressSync(gzipSync(text), { format: 'gzip' })).toEqual(text);
  });

  it.each(BROTLI_OPTIONS)('reads brotli that node:zlib writes with %s', async (_, options) => {
    // Brotli has no magic number: detection recognizes it as a whole
    // stream that ends where the data ends, which this one is.
    const compressed = brotliCompressSync(text, options);
    expect(next.detectFormat(compressed)).toBe('brotli');
    expect(next.decompressSync(compressed, { format: 'brotli' })).toEqual(text);
    expect(next.decompressSync(compressed)).toEqual(text);
    expect(await next.decompress(compressed)).toEqual(text);
  });

  it('writes brotli that node:zlib reads', async () => {
    expect(brotliDecompressSync(next.compressSync(text, { format: 'brotli' }))).toEqual(
      Buffer.from(text),
    );
    expect(
      brotliDecompressSync(await next.compress(text, { format: 'brotli', level: 11 })),
    ).toEqual(Buffer.from(text));
  });

  it.skipIf(!zstdAvailable)('reads zstd that node:zlib writes', async () => {
    const compressed = zlib.zstdCompressSync(text);
    expect(next.detectFormat(compressed)).toBe('zstd');
    expect(next.decompressSync(compressed, { format: 'zstd' })).toEqual(text);
    expect(next.decompressSync(compressed)).toEqual(text);
    expect(await next.decompress(compressed)).toEqual(text);
  });

  it.skipIf(!zstdAvailable)('writes zstd that node:zlib reads', async () => {
    expect(zlib.zstdDecompressSync(next.compressSync(text, { format: 'zstd' }))).toEqual(
      Buffer.from(text),
    );
    expect(
      zlib.zstdDecompressSync(await next.compress(text, { format: 'zstd', level: 19 })),
    ).toEqual(Buffer.from(text));
  });

  it('reads concatenated gzip members', () => {
    const members = Buffer.concat([gzipSync(text), gzipSync(dictionary)]);
    expect(next.decompressSync(members)).toEqual(plain(Buffer.concat([text, dictionary])));
  });

  it("does not mix up 'deflate' and 'deflate-raw'", () => {
    expectCoded(
      thrown(() => next.decompressSync(deflateRawSync(text), { format: 'deflate' })),
      'ERR_COMPRS_CORRUPT_DATA',
    );
    expectCoded(
      thrown(() => next.decompressSync(deflateSync(text), { format: 'deflate-raw' })),
      'ERR_COMPRS_CORRUPT_DATA',
    );
  });
});

describe('dictionaries', () => {
  it.each([
    ['zstd', zstdCompressWithDict],
    ['brotli', brotliCompressWithDict],
  ] as const)('compress %s as the root entry does', async (format, rootWithDict) => {
    for (const level of [undefined, 1]) {
      const expected = plain(rootWithDict(text, dictionary, level));
      const options = { ...compressOptions(format, level), dictionary };
      expect(next.compressSync(text, options)).toEqual(expected);
      expect(await next.compress(text, options)).toEqual(expected);
      expect(next.decompressSync(expected, { format, dictionary })).toEqual(text);
      expect(await next.decompress(expected, { format, dictionary })).toEqual(text);
    }
  });

  it('are trained for zstd', async () => {
    const trained = next.trainDictionarySync(samples, { maxSize: 4096 });
    expectPlainUint8Array(trained);
    expect(trained.byteLength).toBeGreaterThan(0);
    expect(trained.byteLength).toBeLessThanOrEqual(4096);
    expect(trained).toEqual(plain(zstdTrainDictionary(samples, 4096)));
    const fromAsync = await next.trainDictionary(samples, { maxSize: 4096 });
    expectPlainUint8Array(fromAsync);
    expect(fromAsync).toEqual(trained);

    const message = encoder.encode(JSON.stringify({ id: 1000, name: 'item 1000', tags: ['a'] }));
    const compressed = next.compressSync(message, { format: 'zstd', dictionary: trained });
    expect(next.decompressSync(compressed, { format: 'zstd', dictionary: trained })).toEqual(
      message,
    );
  });

  it('are trained from any iterable, at the default size', () => {
    function* generate(): Generator<Uint8Array> {
      yield* samples;
    }
    const expected = plain(zstdTrainDictionary(samples));
    expect(next.trainDictionarySync(generate())).toEqual(expected);
    expect(next.trainDictionarySync(new Set(samples))).toEqual(expected);
  });
});

describe('the gzip header', () => {
  it('holds the filename and the modification time', async () => {
    const header = { filename: 'data.txt', mtime: 1_700_000_000 };
    const options = { format: 'gzip', level: 9, gzipHeader: header } as const;
    const expected = plain(gzipCompressWithHeader(text, header, 9));
    expect(next.compressSync(text, options)).toEqual(expected);
    expect(await next.compress(text, options)).toEqual(expected);
    expect(next.decompressSync(expected)).toEqual(text);
  });

  it('is the default one without fields', async () => {
    const expected = plain(gzipCompress(text));
    expect(next.compressSync(text, { format: 'gzip', gzipHeader: {} })).toEqual(expected);
    expect(await next.compress(text, { format: 'gzip', gzipHeader: {} })).toEqual(expected);
  });
});

describe('zstd workers', () => {
  // More than the 512 KiB that zstd compresses without its workers.
  const large = encoder.encode('zstd compresses this input with worker threads. '.repeat(24_000));

  it('compress with 2 workers', async () => {
    const options = { format: 'zstd', workers: 2 } as const;
    const compressed = next.compressSync(large, options);
    expect(next.decompressSync(compressed, { format: 'zstd' })).toEqual(large);
    expect(next.decompressSync(await next.compress(large, options))).toEqual(large);
  });

  it('compress with 0 workers as without them', async () => {
    const expected = plain(zstdCompress(large));
    expect(next.compressSync(large, { format: 'zstd', workers: 0 })).toEqual(expected);
    expect(await next.compress(large, { format: 'zstd', workers: 0 })).toEqual(expected);
  });
});

describe('inputs', () => {
  /**
   * `bytes` as each kind of input. The views see them at an offset of 2
   * bytes, which a Uint16Array allows, with a length of their own, in
   * buffers that hold two 0xff bytes on each side of them: a view read from
   * the start of its buffer, or up to its end, would read those too. A
   * Uint16Array holds whole elements, so it is left out for an odd number of
   * bytes.
   */
  function inputs(bytes: Uint8Array): [string, Input][] {
    const length = bytes.byteLength;
    const buffer = new ArrayBuffer(length + 4);
    new Uint8Array(buffer).fill(0xff).set(bytes, 2);
    const shared = new SharedArrayBuffer(length + 4);
    new Uint8Array(shared).fill(0xff).set(bytes, 2);
    const larger = Buffer.alloc(length + 4, 0xff);
    larger.set(bytes, 2);
    const kinds: [string, Input][] = [
      ['an ArrayBuffer', buffer.slice(2, 2 + length)],
      ['a SharedArrayBuffer', shared.slice(2, 2 + length)],
      ['a Uint8Array at an offset', new Uint8Array(buffer, 2, length)],
      ['a view of a SharedArrayBuffer', new Uint8Array(shared, 2, length)],
      ['a DataView', new DataView(buffer, 2, length)],
      ['a DataView of a SharedArrayBuffer', new DataView(shared, 2, length)],
      ['a Buffer', Buffer.from(bytes)],
      ['a Buffer within a larger one', larger.subarray(2, 2 + length)],
    ];
    if (length % 2 === 0) {
      kinds.push(['a Uint16Array at an offset', new Uint16Array(buffer, 2, length / 2)]);
    }
    return kinds;
  }

  it.each(inputs(text))('reads data from %s byte for byte', async (_, input) => {
    const expected = next.compressSync(text, { format: 'zstd' });
    expect(next.compressSync(input, { format: 'zstd' })).toEqual(expected);
    expect(await next.compress(input, { format: 'zstd' })).toEqual(expected);
    expect(next.detectFormat(input)).toBeUndefined();
  });

  it.each(inputs(next.compressSync(text, { format: 'gzip' })))(
    'reads compressed data from %s',
    async (_, input) => {
      expect(next.detectFormat(input)).toBe('gzip');
      expect(next.decompressSync(input)).toEqual(text);
      expect(await next.decompress(input, { format: 'gzip' })).toEqual(text);
    },
  );

  it.each(inputs(dictionary))('reads a dictionary from %s', async (_, input) => {
    const compressed = next.compressSync(text, { format: 'zstd', dictionary });
    expect(next.compressSync(text, { format: 'zstd', dictionary: input })).toEqual(compressed);
    expect(next.decompressSync(compressed, { format: 'zstd', dictionary: input })).toEqual(text);
    expect(await next.decompress(compressed, { format: 'zstd', dictionary: input })).toEqual(text);
  });

  it('reads samples of every kind', async () => {
    const expected = next.trainDictionarySync(samples, { maxSize: 4096 });
    const mixed = samples.map((sample, i) => {
      const kinds = inputs(sample);
      const kind = kinds[i % kinds.length];
      if (kind === undefined) throw new Error('expected an input');
      return kind[1];
    });
    expect(next.trainDictionarySync(mixed, { maxSize: 4096 })).toEqual(expected);
    expect(await next.trainDictionary(mixed, { maxSize: 4096 })).toEqual(expected);
  });

  it('are copied when the async functions are called', async () => {
    const data = Uint8Array.from(text);
    const compressing = next.compress(data, { format: 'zstd' });
    data.fill(0);
    const compressed = await compressing;
    expect(next.decompressSync(compressed)).toEqual(text);
    const decompressing = next.decompress(compressed);
    compressed.fill(0);
    expect(await decompressing).toEqual(text);
  });

  it('are read as they are when the functions are called, from a resizable buffer', async () => {
    const length = text.byteLength;
    const { buffer, resize } = resizable(length + 4, length + 8);
    new Uint8Array(buffer).fill(0xff).set(text, 2);
    const fixed = new DataView(buffer, 2, length);
    const tracking = new Uint8Array(buffer, 2);
    const trackingView = new DataView(buffer, 2);
    // Shrunk to the end of the text, which every view still holds.
    resize(length + 2);
    const expected = next.compressSync(text, { format: 'zstd' });
    for (const input of [fixed, tracking, trackingView]) {
      expect(next.compressSync(input, { format: 'zstd' })).toEqual(expected);
      expect(await next.compress(input, { format: 'zstd' })).toEqual(expected);
    }
    // Grown again: the views that track the length of the buffer see the
    // zeros that it grew by.
    resize(length + 6);
    const grown = plain(Buffer.concat([text, new Uint8Array(4)]));
    expect(next.compressSync(fixed, { format: 'zstd' })).toEqual(expected);
    for (const input of [tracking, trackingView]) {
      expect(next.decompressSync(next.compressSync(input, { format: 'zstd' }))).toEqual(grown);
    }
    // The buffer itself, shrunk to the text.
    const whole = resizable(length + 8, length + 8);
    new Uint8Array(whole.buffer).set(text);
    whole.resize(length);
    expect(next.compressSync(whole.buffer, { format: 'zstd' })).toEqual(expected);
  });

  it('are read by their internal slots, not by properties that shadow them', () => {
    const payload = text.subarray(0, 1000);
    const buffer = new ArrayBuffer(payload.byteLength + 4);
    new Uint8Array(buffer).fill(0xff).set(payload, 2);
    const expected = next.compressSync(payload, { format: 'zstd' });
    for (const view of [
      new Uint8Array(buffer, 2, payload.byteLength),
      new Uint16Array(buffer, 2, payload.byteLength / 2),
      new DataView(buffer, 2, payload.byteLength),
    ]) {
      Object.defineProperties(view, {
        buffer: { value: new ArrayBuffer(8) },
        byteOffset: { value: 0 },
        byteLength: { value: 1 },
        [Symbol.toStringTag]: { value: 'Uint8Array' },
      });
      expect(next.compressSync(view, { format: 'zstd' })).toEqual(expected);
    }
  });

  it('may be of another realm', async () => {
    const payload = text.subarray(0, 1000);
    const context = createContext({ bytes: Array.from(payload) });
    const expected = next.compressSync(payload, { format: 'zstd' });
    for (const code of [
      'new Uint8Array(bytes).buffer',
      'const shared = new SharedArrayBuffer(bytes.length); new Uint8Array(shared).set(bytes); shared',
      'new Uint8Array(bytes)',
      'new Uint16Array(new Uint8Array(bytes).buffer)',
      'new DataView(new Uint8Array(bytes).buffer)',
    ]) {
      const value: unknown = runInContext(code, context);
      expect(value).not.toBeInstanceOf(Object);
      if (!ArrayBuffer.isView(value) && !types.isAnyArrayBuffer(value)) {
        throw new Error(`${code} gave no input`);
      }
      expect(next.compressSync(value, { format: 'zstd' })).toEqual(expected);
      expect(await next.compress(value, { format: 'zstd' })).toEqual(expected);
      expect(next.compressSync(text, { format: 'zstd', dictionary: value })).toEqual(
        plain(zstdCompressWithDict(text, payload)),
      );
    }
  });

  it('ignore unknown options', () => {
    // Names of the root entry's arguments, which the options do not take.
    const options = { format: 'zstd', quality: 9, capacity: 1 } as const;
    expect(next.compressSync(text, options)).toEqual(plain(zstdCompress(text)));
  });
});

/** Whether `value` is next/backend.js, as its declarations describe it. */
function isBackendModule(value: unknown): value is typeof BackendModule {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof Reflect.get(value, 'backend') === 'function' &&
    typeof Reflect.get(value, 'setBackend') === 'function'
  );
}

/**
 * next/backend.js, whose backend a test wraps, as the modules of next/
 * share it. They load each other with the require() of Node.js, and so does
 * this file, but Vitest would load an import of next/backend.js as a module
 * of its own, without a backend.
 */
function backendModule(): typeof BackendModule {
  const loaded: unknown = require('../next/backend.js');
  if (!isBackendModule(loaded)) throw new Error('next/backend.js exports no backend');
  return loaded;
}

describe('bytes in a SharedArrayBuffer', () => {
  /** A SharedArrayBuffer that holds `bytes`. */
  function shared(bytes: Uint8Array): SharedArrayBuffer {
    const buffer = new SharedArrayBuffer(bytes.byteLength);
    new Uint8Array(buffer).set(bytes);
    return buffer;
  }

  /**
   * `inner`, recording in `received` every input that its functions get:
   * the data, the dictionary and the samples.
   */
  function recording(inner: Backend, received: Uint8Array[]): Backend {
    function record(...inputs: (Uint8Array | undefined)[]): void {
      for (const input of inputs) {
        if (input !== undefined) received.push(input);
      }
    }
    return {
      compress: (...args) => {
        record(args[0], args[3]);
        return inner.compress(...args);
      },
      compressAsync: (...args) => {
        record(args[0], args[3]);
        return inner.compressAsync(...args);
      },
      decompress: (...args) => {
        record(args[0], args[3]);
        return inner.decompress(...args);
      },
      decompressAsync: (...args) => {
        record(args[0], args[3]);
        return inner.decompressAsync(...args);
      },
      detectFormat: (data) => {
        record(data);
        return inner.detectFormat(data);
      },
      trainDictionary: (samples, maxSize) => {
        record(...samples);
        return inner.trainDictionary(samples, maxSize);
      },
      trainDictionaryAsync: (samples, maxSize) => {
        record(...samples);
        return inner.trainDictionaryAsync(samples, maxSize);
      },
      createDictionary: (bytes, format, level) => {
        record(bytes);
        return inner.createDictionary(bytes, format, level);
      },
      dictionaryToBytes: (handle) => inner.dictionaryToBytes(handle),
      closeDictionary: (handle) => inner.closeDictionary(handle),
    };
  }

  it('reach the backend as copies in ArrayBuffers', async () => {
    // Another thread could write the bytes of a SharedArrayBuffer while
    // Rust reads them, so api.ts copies them before the backend gets them.
    const { backend, setBackend } = backendModule();
    const original = backend();
    const received: Uint8Array[] = [];
    setBackend(recording(original, received));
    try {
      const zstdOptions = { format: 'zstd', dictionary: shared(dictionary) } as const;
      const withDictionary = plain(zstdCompressWithDict(text, dictionary));
      expect(next.compressSync(shared(text), { format: 'zstd' })).toEqual(zstdText);
      expect(await next.compress(new Uint8Array(shared(text)), { format: 'zstd' })).toEqual(
        zstdText,
      );
      expect(next.compressSync(new DataView(shared(text)), zstdOptions)).toEqual(withDictionary);
      expect(next.decompressSync(shared(zstdText))).toEqual(text);
      expect(await next.decompress(new Uint8Array(shared(withDictionary)), zstdOptions)).toEqual(
        text,
      );
      expect(next.detectFormat(new DataView(shared(zstdText)))).toBe('zstd');
      const trained = plain(zstdTrainDictionary(samples, 4096));
      expect(next.trainDictionarySync(samples.map(shared), { maxSize: 4096 })).toEqual(trained);
      const sharedViews = samples.map((sample) => new Uint8Array(shared(sample)));
      expect(await next.trainDictionary(sharedViews, { maxSize: 4096 })).toEqual(trained);
      const prepared = next.Dictionary.from(new DataView(shared(dictionary)), { format: 'zstd' });
      expect(prepared.toBytes()).toEqual(dictionary);
      prepared.close();
    } finally {
      setBackend(original);
    }
    // The data of each call, the dictionaries of two, the samples, and the
    // bytes of the prepared dictionary.
    expect(received).toHaveLength(6 + 2 + 2 * samples.length + 1);
    for (const input of received) {
      expect(Object.prototype.toString.call(input.buffer)).toBe('[object ArrayBuffer]');
    }
  });
});

/** A case of every code that the functions can give. */
interface ErrorCase {
  name: string;
  code: next.ErrorCode;
  message: string | RegExp;
  sync(): unknown;
  async(): Promise<unknown>;
}

const zstdText = next.compressSync(text, { format: 'zstd' });
const gzipText = next.compressSync(text, { format: 'gzip' });

const ERROR_CASES: ErrorCase[] = [
  {
    name: 'a level out of range, which the backend checks',
    code: 'ERR_COMPRS_INVALID_ARG',
    message: 'zstd compression level must be an integer between -131072 and 22',
    sync: () => next.compressSync(text, { format: 'zstd', level: 23 }),
    async: () => next.compress(text, { format: 'zstd', level: 23 }),
  },
  {
    name: 'a level for lz4',
    code: 'ERR_COMPRS_INVALID_ARG',
    message: 'lz4 does not take a compression level',
    sync: () => next.compressSync(text, { format: 'lz4', level: 1 }),
    async: () => next.compress(text, { format: 'lz4', level: 1 }),
  },
  {
    name: 'a dictionary for gzip',
    code: 'ERR_COMPRS_INVALID_ARG',
    message: 'gzip does not support dictionaries',
    sync: () => next.compressSync(text, { format: 'gzip', dictionary }),
    async: () => next.compress(text, { format: 'gzip', dictionary }),
  },
  {
    name: 'a gzip header for zstd',
    code: 'ERR_COMPRS_INVALID_ARG',
    message: 'gzipHeader applies to gzip compression only',
    sync: () => next.compressSync(text, { format: 'zstd', gzipHeader: {} }),
    async: () => next.compress(text, { format: 'zstd', gzipHeader: {} }),
  },
  {
    name: 'workers for gzip',
    code: 'ERR_COMPRS_INVALID_ARG',
    message: 'workers applies to zstd compression only',
    sync: () => next.compressSync(text, { format: 'gzip', workers: 2 }),
    async: () => next.compress(text, { format: 'gzip', workers: 2 }),
  },
  {
    name: "a dictionary with 'auto'",
    code: 'ERR_COMPRS_INVALID_ARG',
    message: 'pass `format` to decompress with a dictionary',
    sync: () => next.decompressSync(zstdText, { dictionary }),
    async: () => next.decompress(zstdText, { format: 'auto', dictionary }),
  },
  {
    name: 'data of unknown format',
    code: 'ERR_COMPRS_UNKNOWN_FORMAT',
    message: 'unable to detect the compression format; pass `format`',
    sync: () => next.decompressSync(text),
    async: () => next.decompress(text),
  },
  {
    name: 'empty data without a format',
    code: 'ERR_COMPRS_UNKNOWN_FORMAT',
    message: 'unable to detect the compression format; pass `format`',
    sync: () => next.decompressSync(new Uint8Array(0)),
    async: () => next.decompress(new Uint8Array(0), { format: 'auto' }),
  },
  {
    name: 'data after the end of the stream',
    code: 'ERR_COMPRS_CORRUPT_DATA',
    message: 'gzip decompress failed: unexpected data after the end of the compressed stream',
    sync: () => next.decompressSync(Buffer.concat([gzipText, Buffer.from([0])])),
    async: () => next.decompress(Buffer.concat([gzipText, Buffer.from([0])]), { format: 'gzip' }),
  },
  {
    name: 'a cut stream',
    code: 'ERR_COMPRS_TRUNCATED',
    message: 'zstd stream is truncated: unexpected end of input',
    sync: () => next.decompressSync(zstdText.subarray(0, 8)),
    async: () => next.decompress(zstdText.subarray(0, 8)),
  },
  {
    name: 'empty data in a format',
    code: 'ERR_COMPRS_TRUNCATED',
    message: /truncated/,
    sync: () => next.decompressSync(new Uint8Array(0), { format: 'gzip' }),
    async: () => next.decompress(new Uint8Array(0), { format: 'gzip' }),
  },
  {
    name: 'output above maxOutputSize',
    code: 'ERR_COMPRS_SIZE_LIMIT',
    message: 'zstd decompress exceeded maximum size of 10 bytes',
    sync: () => next.decompressSync(zstdText, { maxOutputSize: 10 }),
    async: () => next.decompress(zstdText, { maxOutputSize: 10 }),
  },
  {
    name: 'training without samples',
    code: 'ERR_COMPRS_OPERATION_FAILED',
    message: /^zstd dictionary training failed: /,
    sync: () => next.trainDictionarySync([]),
    async: () => next.trainDictionary([]),
  },
];

/** The string literals of `export type ErrorCode = …` in next/api.d.ts. */
function declaredErrorCodes(): string[] {
  const source = readFileSync(resolve(__dirname, '../next/api.d.ts'), 'utf8');
  const declaration = /^export type ErrorCode =([^;]*);/m.exec(source)?.[1];
  if (declaration === undefined) throw new Error('next/api.d.ts declares no ErrorCode');
  return [...declaration.matchAll(/'([^']*)'/g)].flatMap((match) => match[1] ?? []);
}

/** The hidden binding's errorCodes(): comprs-core's ERROR_CODES. */
function bindingErrorCodes(): unknown {
  const binding: unknown = Reflect.get(
    require('../index.js'),
    Symbol.for('@derodero24/comprs/internal'),
  );
  if (typeof binding !== 'object' || binding === null) {
    throw new Error('the native addon has no hidden binding');
  }
  const errorCodes: unknown = Reflect.get(binding, 'errorCodes');
  if (typeof errorCodes !== 'function') throw new Error('the binding has no errorCodes()');
  return Reflect.apply(errorCodes, binding, []);
}

/** The codes that the table of the README's section on ./next lists. */
function documentedErrorCodes(): string[] {
  const readme = readFileSync(resolve(__dirname, '../README.md'), 'utf8');
  const section = readme.split(/^## /m).find((part) => part.startsWith('Unified API'));
  if (section === undefined) throw new Error('the README has no section on the unified API');
  return [...section.matchAll(/^\| `(ERR_COMPRS_\w+)` \|/gm)].flatMap((match) => match[1] ?? []);
}

describe('errors', () => {
  it('ErrorCode holds the codes of the backend', () => {
    expect(declaredErrorCodes()).toEqual(bindingErrorCodes());
  });

  it('are those that the README lists', () => {
    expect(documentedErrorCodes()).toEqual(bindingErrorCodes());
  });

  it('cover every code that the functions can give', () => {
    const reached = new Set(ERROR_CASES.map((errorCase) => errorCase.code));
    // Errors of streams, which the API does not have yet.
    const unreachable = ['ERR_COMPRS_STREAM_FINISHED', 'ERR_COMPRS_STREAM_CLOSED'];
    expect([...reached, ...unreachable].sort()).toEqual(declaredErrorCodes().sort());
  });

  it.each(ERROR_CASES)('are thrown with their code and class for $name', (errorCase) => {
    expectCoded(thrown(errorCase.sync), errorCase.code, errorCase.message);
  });

  it.each(ERROR_CASES)('reject with their code and class for $name', async (errorCase) => {
    expectCoded(await rejection(promiseOf(errorCase.async)), errorCase.code, errorCase.message);
  });
});

/** A synchronous function of the API and its asynchronous variant. */
type Pair = readonly [(...args: never[]) => unknown, (...args: never[]) => Promise<unknown>];

const PAIRS = {
  compress: [next.compressSync, next.compress],
  decompress: [next.decompressSync, next.decompress],
  trainDictionary: [next.trainDictionarySync, next.trainDictionary],
} as const satisfies Record<string, Pair>;

/** Arguments that the API rejects as of the wrong type, with their message. */
interface BadArguments {
  name: string;
  pair: keyof typeof PAIRS;
  /** The arguments, which make a fresh detached buffer for each call. */
  args(): unknown[];
  message: string;
}

/** `view`, after its buffer is detached. */
function detached<T extends ArrayBufferView<ArrayBuffer>>(view: T): T {
  structuredClone(view.buffer, { transfer: [view.buffer] });
  return view;
}

/** A Uint8Array of the bytes of `text`, whose buffer is detached. */
function detachedView(): Uint8Array {
  return detached(Uint8Array.from(text));
}

/** A resizable ArrayBuffer and the function that resizes it. */
interface Resizable {
  buffer: ArrayBuffer;
  resize(byteLength: number): void;
}

/**
 * A resizable ArrayBuffer of `byteLength` bytes, which can grow to
 * `maxByteLength`. Resizable buffers are of ES2024, which the lib of the
 * tests predates, so they are made and resized by reflection.
 */
function resizable(byteLength: number, maxByteLength: number): Resizable {
  const buffer: unknown = Reflect.construct(ArrayBuffer, [byteLength, { maxByteLength }]);
  if (!(buffer instanceof ArrayBuffer)) throw new Error('expected an ArrayBuffer');
  const resize: unknown = Reflect.get(buffer, 'resize');
  if (typeof resize !== 'function') throw new Error('the runtime cannot resize ArrayBuffers');
  return {
    buffer,
    resize(length) {
      Reflect.apply(resize, buffer, [length]);
    },
  };
}

/**
 * The view that `view` makes of a resizable buffer of 8 bytes, which then
 * shrinks to `byteLength`, below the end of the view.
 */
function shrunk(
  view: (buffer: ArrayBuffer) => ArrayBufferView,
  byteLength: number,
): ArrayBufferView {
  const { buffer, resize } = resizable(8, 8);
  const result = view(buffer);
  resize(byteLength);
  return result;
}

const BAD_ARGUMENTS: BadArguments[] = [
  {
    name: 'a missing format',
    pair: 'compress',
    args: () => [text, {}],
    message: 'format must be one of zstd, gzip, deflate, deflate-raw, brotli, lz4',
  },
  {
    name: 'missing options',
    pair: 'compress',
    args: () => [text],
    message: 'options must be an object',
  },
  {
    name: 'an unknown format',
    pair: 'compress',
    args: () => [text, { format: 'zip' }],
    message: 'format must be one of zstd, gzip, deflate, deflate-raw, brotli, lz4',
  },
  {
    name: "'auto' for compression",
    pair: 'compress',
    args: () => [text, { format: 'auto' }],
    message: 'format must be one of zstd, gzip, deflate, deflate-raw, brotli, lz4',
  },
  {
    name: 'an unknown format for decompression',
    pair: 'decompress',
    args: () => [zstdText, { format: 'ZSTD' }],
    message: 'format must be one of auto, zstd, gzip, deflate, deflate-raw, brotli, lz4',
  },
  {
    name: 'a level as a string',
    pair: 'compress',
    args: () => [text, { format: 'zstd', level: '3' }],
    message: 'level must be a number',
  },
  {
    name: 'a NaN level',
    pair: 'compress',
    args: () => [text, { format: 'gzip', level: Number.NaN }],
    message: 'gzip compression level must be an integer between 0 and 9',
  },
  {
    name: 'a level of 2 ** 53',
    pair: 'compress',
    args: () => [text, { format: 'brotli', level: 2 ** 53 }],
    message: 'brotli compression level must be an integer between 0 and 11',
  },
  {
    name: 'null options',
    pair: 'decompress',
    args: () => [zstdText, null],
    message: 'options must be an object',
  },
  {
    name: 'a dictionary of the wrong type',
    pair: 'compress',
    args: () => [text, { format: 'zstd', dictionary: 'dictionary' }],
    message:
      'dictionary must be a Dictionary or an ArrayBuffer, SharedArrayBuffer or ArrayBufferView',
  },
  {
    name: 'a dictionary of the wrong type for decompression',
    pair: 'decompress',
    args: () => [zstdText, { format: 'zstd', dictionary: [1, 2, 3] }],
    message:
      'dictionary must be a Dictionary or an ArrayBuffer, SharedArrayBuffer or ArrayBufferView',
  },
  {
    name: 'a gzip header that is no object',
    pair: 'compress',
    args: () => [text, { format: 'gzip', gzipHeader: 'data.txt' }],
    message: 'gzipHeader must be an object',
  },
  {
    name: 'a gzip filename that is no string',
    pair: 'compress',
    args: () => [text, { format: 'gzip', gzipHeader: { filename: 1 } }],
    message: 'gzipHeader.filename must be a string',
  },
  {
    name: 'a gzip mtime that is no number',
    pair: 'compress',
    args: () => [text, { format: 'gzip', gzipHeader: { mtime: new Date(0) } }],
    message: 'gzipHeader.mtime must be a number',
  },
  {
    name: 'workers as a string',
    pair: 'compress',
    args: () => [text, { format: 'zstd', workers: '2' }],
    message: 'workers must be a number',
  },
  {
    name: 'a maxOutputSize of -1',
    pair: 'decompress',
    args: () => [zstdText, { maxOutputSize: -1 }],
    message: 'maxOutputSize must be an integer between 0 and 9007199254740991',
  },
  {
    name: 'a maxOutputSize as a bigint',
    pair: 'decompress',
    args: () => [zstdText, { maxOutputSize: 10n }],
    message: 'maxOutputSize must be a number',
  },
  {
    name: 'data of the wrong type',
    pair: 'decompress',
    args: () => ['data'],
    message: 'data must be an ArrayBuffer, SharedArrayBuffer or ArrayBufferView',
  },
  {
    name: 'data as an array of numbers',
    pair: 'compress',
    args: () => [[1, 2, 3], { format: 'zstd' }],
    message: 'data must be an ArrayBuffer, SharedArrayBuffer or ArrayBufferView',
  },
  {
    name: 'a view of a detached buffer',
    pair: 'compress',
    args: () => [detachedView(), { format: 'zstd' }],
    message: 'data is backed by a detached ArrayBuffer',
  },
  {
    name: 'a DataView of a detached buffer',
    pair: 'decompress',
    args: () => [detached(new DataView(new ArrayBuffer(8)))],
    message: 'data is backed by a detached ArrayBuffer',
  },
  {
    name: 'a detached ArrayBuffer',
    pair: 'decompress',
    args: () => [detachedView().buffer],
    message: 'data is a detached ArrayBuffer',
  },
  {
    name: 'a dictionary of a detached buffer',
    pair: 'decompress',
    args: () => [zstdText, { format: 'zstd', dictionary: detachedView() }],
    message: 'dictionary is backed by a detached ArrayBuffer',
  },
  {
    name: 'a DataView out of the bounds of its shrunk buffer',
    pair: 'compress',
    args: () => [shrunk((buffer) => new DataView(buffer, 1, 1), 0), { format: 'zstd' }],
    message: 'data is out of bounds of its ArrayBuffer',
  },
  {
    // The getters of a typed array read it as empty, which is no error.
    name: 'a Uint8Array out of the bounds of its shrunk buffer',
    pair: 'compress',
    args: () => [shrunk((buffer) => new Uint8Array(buffer, 4, 4), 2), { format: 'zstd' }],
    message: 'data is out of bounds of its ArrayBuffer',
  },
  {
    name: 'a Uint16Array that tracks a buffer shrunk below its offset',
    pair: 'decompress',
    args: () => [shrunk((buffer) => new Uint16Array(buffer, 4), 2)],
    message: 'data is out of bounds of its ArrayBuffer',
  },
  {
    name: 'a DataView that tracks a buffer shrunk below its offset',
    pair: 'decompress',
    args: () => [shrunk((buffer) => new DataView(buffer, 4), 2), { format: 'gzip' }],
    message: 'data is out of bounds of its ArrayBuffer',
  },
  {
    name: 'a dictionary out of the bounds of its shrunk buffer',
    pair: 'compress',
    args: () => [
      text,
      { format: 'zstd', dictionary: shrunk((buffer) => new Uint8Array(buffer, 4, 4), 2) },
    ],
    message: 'dictionary is out of bounds of its ArrayBuffer',
  },
  {
    name: 'a dictionary out of the bounds of its shrunk buffer for decompression',
    pair: 'decompress',
    args: () => [
      zstdText,
      { format: 'zstd', dictionary: shrunk((buffer) => new DataView(buffer, 1, 1), 0) },
    ],
    message: 'dictionary is out of bounds of its ArrayBuffer',
  },
  {
    name: 'a Proxy of an ArrayBuffer',
    pair: 'compress',
    args: () => [new Proxy(new ArrayBuffer(8), {}), { format: 'zstd' }],
    message: 'data must be an ArrayBuffer, SharedArrayBuffer or ArrayBufferView',
  },
  {
    // The checks read the internal slots of the value, not its properties.
    name: 'a Proxy of an ArrayBuffer whose traps throw',
    pair: 'compress',
    args: () => [
      new Proxy(new ArrayBuffer(8), {
        get: () => {
          throw new Error('get');
        },
        getPrototypeOf: () => {
          throw new Error('getPrototypeOf');
        },
      }),
      { format: 'zstd' },
    ],
    message: 'data must be an ArrayBuffer, SharedArrayBuffer or ArrayBufferView',
  },
  {
    name: 'a Proxy of a SharedArrayBuffer',
    pair: 'decompress',
    args: () => [new Proxy(new SharedArrayBuffer(8), {})],
    message: 'data must be an ArrayBuffer, SharedArrayBuffer or ArrayBufferView',
  },
  {
    name: 'a Proxy of a Uint8Array',
    pair: 'decompress',
    args: () => [new Proxy(Uint8Array.from(zstdText), {})],
    message: 'data must be an ArrayBuffer, SharedArrayBuffer or ArrayBufferView',
  },
  {
    name: 'an object tagged as an ArrayBuffer',
    pair: 'decompress',
    args: () => [{ [Symbol.toStringTag]: 'ArrayBuffer' }, { format: 'zstd' }],
    message: 'data must be an ArrayBuffer, SharedArrayBuffer or ArrayBufferView',
  },
  {
    name: 'an object tagged as a SharedArrayBuffer',
    pair: 'compress',
    args: () => [{ [Symbol.toStringTag]: 'SharedArrayBuffer' }, { format: 'zstd' }],
    message: 'data must be an ArrayBuffer, SharedArrayBuffer or ArrayBufferView',
  },
  {
    name: 'a Proxy of an ArrayBuffer as the dictionary',
    pair: 'compress',
    args: () => [text, { format: 'zstd', dictionary: new Proxy(new ArrayBuffer(8), {}) }],
    message:
      'dictionary must be a Dictionary or an ArrayBuffer, SharedArrayBuffer or ArrayBufferView',
  },
  {
    name: 'an object tagged as an ArrayBuffer as the dictionary',
    pair: 'decompress',
    args: () => [zstdText, { format: 'zstd', dictionary: { [Symbol.toStringTag]: 'ArrayBuffer' } }],
    message:
      'dictionary must be a Dictionary or an ArrayBuffer, SharedArrayBuffer or ArrayBufferView',
  },
  {
    name: 'non-iterable samples',
    pair: 'trainDictionary',
    args: () => [{ length: 1, 0: text }],
    message: 'samples must be an iterable of ArrayBuffers, SharedArrayBuffers or ArrayBufferViews',
  },
  {
    name: 'samples that yield a string',
    pair: 'trainDictionary',
    args: () => [[...samples.slice(0, 3), 'sample']],
    message: 'samples[3] must be an ArrayBuffer, SharedArrayBuffer or ArrayBufferView',
  },
  {
    name: 'a sample of a detached buffer',
    pair: 'trainDictionary',
    args: () => [[text, detachedView()]],
    message: 'samples[1] is backed by a detached ArrayBuffer',
  },
  {
    name: 'a sample out of the bounds of its shrunk buffer',
    pair: 'trainDictionary',
    args: () => [[text, shrunk((buffer) => new Uint8Array(buffer, 4, 4), 2)]],
    message: 'samples[1] is out of bounds of its ArrayBuffer',
  },
  {
    name: 'a Proxy of an ArrayBuffer among the samples',
    pair: 'trainDictionary',
    args: () => [[text, text, new Proxy(new ArrayBuffer(8), {})]],
    message: 'samples[2] must be an ArrayBuffer, SharedArrayBuffer or ArrayBufferView',
  },
  {
    name: 'an object tagged as an ArrayBuffer among the samples',
    pair: 'trainDictionary',
    args: () => [[{ [Symbol.toStringTag]: 'ArrayBuffer' }]],
    message: 'samples[0] must be an ArrayBuffer, SharedArrayBuffer or ArrayBufferView',
  },
  {
    // The second argument of the root entry's zstdTrainDictionary().
    name: 'a maxSize in place of the options',
    pair: 'trainDictionary',
    args: () => [samples, 4096],
    message: 'options must be an object',
  },
  {
    name: 'a maxSize as a string',
    pair: 'trainDictionary',
    args: () => [samples, { maxSize: '4096' }],
    message: 'maxSize must be a number',
  },
];

describe('arguments of the wrong type', () => {
  it.each(BAD_ARGUMENTS)('are thrown as TypeErrors for $name', ({ pair, args, message }) => {
    const [sync] = PAIRS[pair];
    expectCoded(
      thrown(() => Reflect.apply(sync, undefined, args())),
      'ERR_COMPRS_INVALID_ARG',
      message,
    );
  });

  it.each(BAD_ARGUMENTS)('reject with TypeErrors for $name', async ({ pair, args, message }) => {
    const [, async] = PAIRS[pair];
    const promise = promiseOf(() => Reflect.apply(async, undefined, args()));
    expectCoded(await rejection(promise), 'ERR_COMPRS_INVALID_ARG', message);
  });
});

describe('errors of the caller', () => {
  class CallerError extends Error {}

  /** Options whose `format` getter throws `error`. */
  function throwingOptions(error: Error): CompressOptions {
    return {
      get format(): Format {
        throw error;
      },
    };
  }

  /** Samples whose iterator throws `error` after a sample. */
  function* throwingSamples(error: Error): Generator<Uint8Array> {
    yield text;
    throw error;
  }

  it('pass through unchanged from a getter of the options', async () => {
    const error = new CallerError('getter');
    expect(thrown(() => next.compressSync(text, throwingOptions(error)))).toBe(error);
    expect(await rejection(promiseOf(() => next.compress(text, throwingOptions(error))))).toBe(
      error,
    );
    expect(error).not.toHaveProperty('code');
  });

  it('pass through unchanged from the iterator of the samples', async () => {
    const error = new CallerError('iterator');
    expect(thrown(() => next.trainDictionarySync(throwingSamples(error)))).toBe(error);
    expect(await rejection(promiseOf(() => next.trainDictionary(throwingSamples(error))))).toBe(
      error,
    );
    expect(error).not.toHaveProperty('code');
  });

  it('fail the call with a code when a getter detaches the data', () => {
    // The options are read before the data, so a getter that detaches the
    // buffer of the data makes the call fail rather than compress nothing.
    const data = Uint8Array.from(text);
    const options = {
      get format(): Format {
        structuredClone(data.buffer, { transfer: [data.buffer] });
        return 'zstd';
      },
    };
    expectCoded(
      thrown(() => next.compressSync(data, options)),
      'ERR_COMPRS_INVALID_ARG',
      'data is backed by a detached ArrayBuffer',
    );
  });
});

/**
 * Names that a module namespace of a CommonJS module has besides its exports:
 * `default`, and from Node.js 23 also `module.exports`.
 */
const CJS_NAMESPACE_KEYS = new Set(['default', 'module.exports']);

/** The names that a module namespace exports, sorted. */
function exportedNames(namespace: object): string[] {
  return Object.keys(namespace)
    .filter((key) => !CJS_NAMESPACE_KEYS.has(key))
    .sort();
}

describe('the ES module entry', () => {
  /** The functions and the class of the API. */
  const NAMES = [
    'Dictionary',
    'compress',
    'compressSync',
    'decompress',
    'decompressSync',
    'detectFormat',
    'trainDictionary',
    'trainDictionarySync',
  ];
  // How long the Node.js process may run. Vitest fails a test that outlasts
  // its own timeout (5 s by default) even while it waits in execFileSync, so
  // the test gets twice this.
  const PROCESS_TIMEOUT = 30_000;

  it('exports the functions of the CommonJS entry', async () => {
    const namespace: Record<string, unknown> = await import('../next/index.mjs');
    expect(exportedNames(next)).toEqual(NAMES);
    expect(exportedNames(namespace)).toEqual(NAMES);
    for (const name of NAMES) {
      expect(namespace[name]).toBe(Reflect.get(next, name));
    }
  });

  // Node.js finds the names of a CommonJS module that an ES module imports
  // with its lexer, without running the module, and only in the forms that
  // the lexer recognizes. Vitest's module runner does not use it.
  it('exports them in Node.js', { timeout: 2 * PROCESS_TIMEOUT }, () => {
    const entry = pathToFileURL(resolve(__dirname, '../next/index.mjs')).href;
    const output = execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '--eval',
        [
          `const next = await import(${JSON.stringify(entry)});`,
          `const skipped = new Set(${JSON.stringify([...CJS_NAMESPACE_KEYS])});`,
          "const data = next.compressSync(new Uint8Array(8), { format: 'zstd' });",
          'process.stdout.write(JSON.stringify({',
          '  names: Object.keys(next).filter((key) => !skipped.has(key)).sort(),',
          '  restored: next.decompressSync(data).byteLength,',
          '}));',
        ].join('\n'),
      ],
      { encoding: 'utf8', timeout: PROCESS_TIMEOUT },
    );
    expect(JSON.parse(output)).toEqual({ names: NAMES, restored: 8 });
  });
});

describe('the root entry', () => {
  const DECLARED_VALUE = /^export declare (?:function|class|(?:const )?enum|const) (\w+)/gm;

  it('is unchanged', () => {
    const source = readFileSync(resolve(__dirname, '../index.d.ts'), 'utf8');
    const declared = [...source.matchAll(DECLARED_VALUE)].flatMap((match) => match[1] ?? []);
    const exports: object = require('../index.js');
    expect(Object.keys(exports).sort()).toEqual(declared.sort());
    // Its decompress() and detectFormat() keep their 2.x signatures.
    expect(rootDecompress).not.toBe(next.decompress);
    const restored = rootDecompress(zstdText);
    expect(Buffer.isBuffer(restored)).toBe(true);
    expect(plain(restored)).toEqual(text);
    expect(rootDetectFormat(new Uint8Array(0))).toBe(CompressionFormat.Unknown);
  });
});
