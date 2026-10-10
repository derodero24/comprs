import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import ts from 'typescript-5';
import { beforeAll, describe, expect, it } from 'vitest';
import type {
  Bytes,
  CompressOptions,
  DecompressOptions,
  ErrorCode,
  Format,
  Input,
  TrainDictionaryOptions,
} from '../next/index.js';
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
// give what they give over the native addon (#555): errors of the same
// code, message and class, and the same bytes in every format but lz4.
// They differ on purpose for zstd workers, which the browser build does
// not support, and for a maxOutputSize above 4 GiB - 1, which it caps. The
// lz4 encoder, lz4_flex, hashes 5 bytes at a time on 64-bit targets and 4
// on wasm32, so the builds write different lz4 frames for most inputs of
// more than a few hundred bytes: each build decodes those of the other.
// The data is text of words that a seeded generator draws, which, unlike a
// repeated phrase, makes the encoders choose as on real data.
// The tests load browser/next/browser.js by path; browser-entry.spec.ts and
// esm-bundle.spec.ts load it through the `browser` condition of the package
// exports. The declarations of both builds are compared without the
// WebAssembly build.

const require = createRequire(__filename);

/**
 * The functions of either build that the tests call, as next/index.d.ts
 * declares them. An interface of its own rather than `typeof native`, so
 * that the browser module still satisfies it once the API has members that
 * no two modules share, such as classes with private fields.
 */
interface Api {
  compress(data: Input, options: CompressOptions): Promise<Bytes>;
  compressSync(data: Input, options: CompressOptions): Bytes;
  decompress(data: Input, options?: DecompressOptions): Promise<Bytes>;
  decompressSync(data: Input, options?: DecompressOptions): Bytes;
  detectFormat(data: Input): Format | undefined;
  trainDictionary(samples: Iterable<Input>, options?: TrainDictionaryOptions): Promise<Bytes>;
  trainDictionarySync(samples: Iterable<Input>, options?: TrainDictionaryOptions): Bytes;
}

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

/**
 * Every format but lz4 at each of its levels, in which the builds write the
 * same bytes.
 */
const FORMAT_LEVELS = FORMATS.filter((format) => format !== 'lz4').flatMap((format) =>
  LEVELS[format].map((level): [Format, number | undefined] => [format, level]),
);

/** The options of compressSync() for `format` at `level`. */
function compressOptions(format: Format, level: number | undefined): CompressOptions {
  return level === undefined ? { format } : { format, level };
}

/**
 * A generator of pseudo-random numbers from 0 to 1, excluded, seeded with
 * `seed`: mulberry32.
 */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), state | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32;
  };
}

/** The words of {@link prose}, the more frequent first. */
const WORDS = (
  'the of and to a in is it that for on was with as be by this are at from or not ' +
  'have an they which one you were all we her she there been if more when will ' +
  'would who so no data stream format level frame block window buffer bytes ' +
  'output input dictionary header checksum encoder decoder build native browser ' +
  'memory module function option error value number string array thread worker ' +
  'promise result limit size length offset view copy read write first last next ' +
  'each other same new old small large fast slow open close time day year people ' +
  'way world life hand part place case week company system program question work ' +
  'government night point home water room mother area money story fact month lot'
).split(' ');

const encoder = new TextEncoder();

/**
 * Bytes of `text`, an ASCII string, with a line feed at the end if that
 * makes their length even, so that a Uint16Array can hold them.
 */
function evenBytes(text: string): Uint8Array {
  return encoder.encode(text.length % 2 === 0 ? text : `${text}\n`);
}

/**
 * `count` words of English-like text, which a generator seeded with `seed`
 * draws, the more frequent ones more often, in sentences and paragraphs of
 * varying length, with a number here and there.
 */
function prose(count: number, seed: number): string {
  const next = random(seed);
  const word = (): string => {
    if (next() < 0.03) return String(Math.floor(next() * 100_000));
    const found = WORDS[Math.floor(next() ** 2 * WORDS.length)];
    if (found === undefined) throw new Error('expected a word');
    return found;
  };
  let text = '';
  let left = 0;
  for (let i = 0; i < count; i++) {
    let current = word();
    if (left === 0) {
      left = 3 + Math.floor(next() * 16);
      current = current.charAt(0).toUpperCase() + current.slice(1);
    }
    left -= 1;
    text += current;
    if (left > 0) {
      text += next() < 0.08 ? ', ' : ' ';
    } else {
      text += next() < 0.85 ? '.' : '?';
      text += next() < 0.2 ? '\n\n' : ' ';
    }
  }
  return text;
}

// About 30 KB of text, a dictionary of about 3.5 KB of the same words, and 200
// samples of JSON records.
const text = evenBytes(prose(6000, 0x5eed));
const dictionary = evenBytes(prose(700, 0xd1c7));
const samples = Array.from({ length: 200 }, (_, i) =>
  evenBytes(JSON.stringify({ id: i, name: prose(2 + (i % 5), i), tags: ['a', 'b'] })),
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

/** Bytes of 0xff before the inputs of {@link INPUT_KINDS}, and after them. */
const PAD = 6;

/** An ArrayBuffer that holds `bytes` between PAD bytes of 0xff on each side. */
function padded(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.length + 2 * PAD);
  new Uint8Array(buffer).fill(0xff).set(bytes, PAD);
  return buffer;
}

/** A SharedArrayBuffer that holds `bytes` as {@link padded} does. */
function paddedShared(bytes: Uint8Array): SharedArrayBuffer {
  const buffer = new SharedArrayBuffer(bytes.length + 2 * PAD);
  new Uint8Array(buffer).fill(0xff).set(bytes, PAD);
  return buffer;
}

/**
 * A resizable ArrayBuffer that holds `bytes` after PAD bytes of 0xff, and
 * can grow to twice its size. Resizable buffers are of ES2024, which the
 * lib of the tests predates, so it is made by reflection.
 */
function resizableAfterPad(bytes: Uint8Array): ArrayBuffer {
  const byteLength = PAD + bytes.length;
  const buffer: unknown = Reflect.construct(ArrayBuffer, [
    byteLength,
    { maxByteLength: 2 * byteLength },
  ]);
  if (!(buffer instanceof ArrayBuffer)) throw new Error('expected an ArrayBuffer');
  new Uint8Array(buffer).fill(0xff).set(bytes, PAD);
  return buffer;
}

/** The number of 16-bit elements in `bytes`, whose length must be even. */
function halfLength(bytes: Uint8Array): number {
  if (bytes.length % 2 !== 0) throw new Error('expected an even number of bytes');
  return bytes.length / 2;
}

/** How many bytes more than it holds a Uint8Array below claims to hold. */
const EXTRA = 4096;

/**
 * A Uint8Array of `bytes`, of a subclass whose `length` is `claim` of the
 * number of bytes that it holds.
 */
function subclassClaiming(bytes: Uint8Array, claim: (byteLength: number) => number): Uint8Array {
  class Claiming extends Uint8Array {}
  Object.defineProperty(Claiming.prototype, 'length', {
    get(this: Uint8Array): number {
      return claim(this.byteLength);
    },
  });
  return new Claiming(bytes);
}

/** A Uint8Array of `bytes` with an own `length` of `length`. */
function ownLength(bytes: Uint8Array, length: number): Uint8Array {
  return Object.defineProperty(Uint8Array.from(bytes), 'length', { value: length });
}

/**
 * Kinds of input, each with the function that makes `bytes` an input of
 * that kind, from which the functions of both builds must read `bytes`, byte
 * for byte. The bytes must be of even length, for the Uint16Array.
 *
 * The last kinds are Uint8Arrays whose `length` property disagrees with the
 * bytes that they hold: the wasm-bindgen glue would copy as many bytes as
 * it says, leaving out bytes, or copying stale bytes of WebAssembly memory
 * after them, or throwing a RangeError without a code. api.ts passes the
 * backend a Uint8Array of its own over the bytes.
 */
const INPUT_KINDS: readonly [kind: string, as: (bytes: Uint8Array) => Input][] = [
  ['a Uint8Array at an offset', (bytes) => new Uint8Array(padded(bytes), PAD, bytes.length)],
  ['a Buffer within a larger one', (bytes) => Buffer.from(padded(bytes), PAD, bytes.length)],
  ['a DataView', (bytes) => new DataView(padded(bytes), PAD, bytes.length)],
  ['a Uint16Array', (bytes) => new Uint16Array(padded(bytes), PAD, halfLength(bytes))],
  ['an ArrayBuffer', (bytes) => padded(bytes).slice(PAD, PAD + bytes.length)],
  ['a SharedArrayBuffer', (bytes) => paddedShared(bytes).slice(PAD, PAD + bytes.length)],
  [
    'a Uint8Array of a SharedArrayBuffer',
    (bytes) => new Uint8Array(paddedShared(bytes), PAD, bytes.length),
  ],
  [
    'a DataView of a SharedArrayBuffer',
    (bytes) => new DataView(paddedShared(bytes), PAD, bytes.length),
  ],
  [
    'a Uint8Array that tracks the length of a resizable ArrayBuffer',
    (bytes) => new Uint8Array(resizableAfterPad(bytes), PAD),
  ],
  [
    'a DataView of a resizable ArrayBuffer',
    (bytes) => new DataView(resizableAfterPad(bytes), PAD, bytes.length),
  ],
  [
    'a Uint8Array whose subclass claims a longer length',
    (bytes) => subclassClaiming(bytes, (byteLength) => byteLength + EXTRA),
  ],
  [
    'a Uint8Array whose subclass claims a shorter length',
    (bytes) => subclassClaiming(bytes, () => 2),
  ],
  ['a Uint8Array with an own, longer length', (bytes) => ownLength(bytes, bytes.length + EXTRA)],
  ['a Uint8Array with an own, shorter length', (bytes) => ownLength(bytes, 2)],
];

/**
 * `data`, zstd frames, and after them a skippable frame that makes their
 * length even, if it is odd: decoders skip it.
 */
function evenZstd(data: Uint8Array): Uint8Array {
  if (data.length % 2 === 0) return data;
  return concat(data, Uint8Array.of(0x50, 0x2a, 0x4d, 0x18, 1, 0, 0, 0, 0));
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

/**
 * A zstd frame that declares `size` bytes of content, in a single segment,
 * and holds a raw block of one byte: the decoders fail on the declaration
 * before they read the block.
 */
function zstdFrameDeclaring(size: number): Uint8Array {
  const frame = new Uint8Array(17);
  // The magic number, then a frame header with an 8-byte content size.
  frame.set([0x28, 0xb5, 0x2f, 0xfd, 0xe0]);
  new DataView(frame.buffer).setBigUint64(5, BigInt(size), true);
  // The last block, raw, of one byte.
  frame.set([0x09, 0x00, 0x00, 0x41], 13);
  return frame;
}

/** A call, in each of the two forms of the function that it calls. */
interface Calls {
  sync(api: Api): unknown;
  async(api: Api): Promise<unknown>;
}

/** A call that fails, in each of the two forms of the function it calls. */
interface ErrorCase extends Calls {
  name: string;
  /** The code that the call fails with in both builds. */
  code: ErrorCode;
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
  options?: DecompressOptions,
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

  it('exports the values that its declarations declare', () => {
    const values = exportsOf('browser/next/browser.d.ts').flatMap((name) =>
      name.startsWith('value ') ? [name.slice('value '.length)] : [],
    );
    expect(Object.keys(wasm).sort()).toEqual(values);
  });

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

    // lz4_flex looks for matches by hashes of 5 bytes on 64-bit targets and
    // of 4 on wasm32, so the frames that the builds write differ. Each build
    // decodes those of the other: the same frames.
    it('writes lz4 frames that the native build reads, and reads its frames', async () => {
      const options: CompressOptions = { format: 'lz4' };
      const frame = wasm.compressSync(text, options);
      expect(await wasm.compress(text, options)).toEqual(frame);
      expect(frame).not.toEqual(compressed.lz4);
      expect(native.decompressSync(frame, options)).toEqual(text);
      expect(wasm.decompressSync(compressed.lz4, options)).toEqual(text);
      expect(wasm.decompressSync(frame)).toEqual(text);
    });

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

    // comprs-core saturates the limit at usize::MAX, which is 4 GiB - 1 on
    // wasm32, as DecompressOptions.maxOutputSize documents. A frame that
    // declares 5 GiB exceeds that limit, where the native decoder fails on
    // its window, which is as large.
    it('takes a maxOutputSize above 4 GiB - 1 as 4 GiB - 1', async () => {
      const frame = zstdFrameDeclaring(5 * 2 ** 30);
      const options: DecompressOptions = { format: 'zstd', maxOutputSize: 2 ** 33 };
      const capped = thrown(
        Object.assign(new Error('zstd decompress exceeded maximum size of 4294967295 bytes'), {
          code: 'ERR_COMPRS_SIZE_LIMIT',
        }),
      );
      expect(run(() => wasm.decompressSync(frame, options))).toEqual(capped);
      expect(await settle(() => wasm.decompress(frame, options))).toEqual(capped);
      expect(run(() => native.decompressSync(frame, options))).toMatchObject({
        threw: { class: 'Error', code: 'ERR_COMPRS_CORRUPT_DATA' },
      });
      // Under a limit of 4 GiB - 1, the builds agree.
      const [expected, actual] = both((api) =>
        run(() => api.decompressSync(frame, { format: 'zstd', maxOutputSize: 2 ** 32 - 1 })),
      );
      expect(expected).toEqual(capped);
      expect(actual).toEqual(expected);
      // So they do above it, for output that fits.
      for (const outcome of both((api) =>
        run(() => api.decompressSync(compressed.zstd, options)),
      )) {
        expect(outcome).toEqual({ returned: text });
      }
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

  describe.each(INPUT_KINDS)('with an input from %s', (_, as) => {
    /** The two builds, to call one function in each. */
    const builds = (): [build: string, api: Api][] => [
      ['native', native],
      ['wasm', wasm],
    ];

    /**
     * Check that `calls` give `expected`, what the native build gives for
     * the plain bytes, in both builds, in both forms.
     */
    async function expectEverywhere(calls: Calls, expected: Outcome): Promise<void> {
      expect(expected).toHaveProperty('returned');
      for (const [build, api] of builds()) {
        expect(
          run(() => calls.sync(api)),
          `${build}, sync`,
        ).toEqual(expected);
        expect(await settle(() => calls.async(api)), `${build}, async`).toEqual(expected);
      }
    }

    it('compresses the data that it holds', async () => {
      const options: CompressOptions = { format: 'zstd' };
      await expectEverywhere(
        {
          sync: (api) => api.compressSync(as(text), options),
          async: (api) => api.compress(as(text), options),
        },
        run(() => native.compressSync(text, options)),
      );
    });

    it.each([
      ['in its format', { format: 'zstd' }],
      ['by detection', undefined],
    ] as const)('decompresses the data that it holds %s', async (_, options) => {
      const data = evenZstd(compressed.zstd);
      await expectEverywhere(
        {
          sync: (api) => api.decompressSync(as(data), options),
          async: (api) => api.decompress(as(data), options),
        },
        { returned: text },
      );
    });

    it('detects the format of the data that it holds', () => {
      const data = evenZstd(compressed.zstd);
      for (const [build, api] of builds()) {
        expect(api.detectFormat(as(data)), build).toBe('zstd');
      }
    });

    it.each(['zstd', 'brotli'] as const)('holds a %s dictionary', async (format) => {
      const options = (input: Input): CompressOptions => ({ format, level: 5, dictionary: input });
      await expectEverywhere(
        {
          sync: (api) => api.compressSync(text, options(as(dictionary))),
          async: (api) => api.compress(text, options(as(dictionary))),
        },
        run(() => native.compressSync(text, options(dictionary))),
      );
      const data = native.compressSync(text, options(dictionary));
      await expectEverywhere(
        {
          sync: (api) => api.decompressSync(data, { format, dictionary: as(dictionary) }),
          async: (api) => api.decompress(data, { format, dictionary: as(dictionary) }),
        },
        { returned: text },
      );
    });

    it('holds the samples of a dictionary', async () => {
      const options: TrainDictionaryOptions = { maxSize: 2048 };
      await expectEverywhere(
        {
          sync: (api) => api.trainDictionarySync(samples.map(as), options),
          async: (api) => api.trainDictionary(samples.map(as), options),
        },
        run(() => native.trainDictionarySync(samples, options)),
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
