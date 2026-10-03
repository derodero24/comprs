import { beforeAll, describe, expect, it, vi } from 'vitest';
import * as native from '../index.js';
import * as nativeStreams from '../streams.js';
import {
  type BrowserEntry,
  type BrowserStreams,
  HAS_WASM_BUILD,
  importBrowserEntry,
  importBrowserStreams,
} from './load-browser-entry.js';

// The browser module of `@derodero24/comprs/streams` (#476) against
// streams.js on the native addon: each helper must turn the same input into
// the same output, or error with the same message.

// The native helpers, typed with the browser declarations. This assignment
// type-checks only while each browser declaration accepts no argument that
// the native one rejects, and declares results that the native ones
// satisfy, so that browser/streams.d.ts cannot drift from streams.d.ts.
const nativeHelpers: BrowserStreams = nativeStreams;

type Helpers = BrowserStreams;
type Stream = TransformStream<Uint8Array, Uint8Array>;

/** What a stream emitted, or the message it failed with. */
type Outcome = { emitted: Uint8Array } | { failed: string };

const encoder = new TextEncoder();
const text = encoder.encode(
  'The native addon and the WebAssembly build stream alike. '.repeat(200),
);
const dict = text.subarray(0, 1024);

/** `data` in chunks of `size` bytes. */
function chunks(data: Uint8Array, size: number): Uint8Array[] {
  const result: Uint8Array[] = [];
  for (let offset = 0; offset < data.length; offset += size) {
    result.push(data.subarray(offset, offset + size));
  }
  return result;
}

/** Read a stream to its end, and concatenate what it emits. */
async function collect(readable: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const output: Uint8Array[] = [];
  for await (const chunk of readable) {
    output.push(chunk);
  }
  return Buffer.concat(output);
}

/** Pipe `input` through a stream, and collect what it emits. */
function pipe(stream: Stream, input: Uint8Array[]): Promise<Uint8Array> {
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of input) {
        controller.enqueue(chunk);
      }
      controller.close();
    },
  });
  return collect(source.pipeThrough(stream));
}

/**
 * Write `data` to a stream in pieces of `size` bytes, each copied into the
 * same buffer once the write of the previous one has finished, as a read
 * loop that reuses its buffer writes them, and collect what it emits.
 */
async function writeThroughOneBuffer(stream: Stream, data: Uint8Array, size: number) {
  const output = collect(stream.readable);
  const writer = stream.writable.getWriter();
  const buffer = new Uint8Array(size);
  for (let offset = 0; offset < data.length; offset += size) {
    const piece = data.subarray(offset, offset + size);
    buffer.set(piece);
    await writer.write(buffer.subarray(0, piece.length));
  }
  await writer.close();
  return output;
}

/**
 * A helper call, its input, and how to read its output: compressed output
 * is decompressed, as the builds need not compress to the same bytes.
 */
type Case = [
  label: string,
  create: (helpers: Helpers) => Stream,
  input: Uint8Array[],
  read?: (output: Uint8Array) => Uint8Array,
];

async function run([, create, input, read]: Case, helpers: Helpers): Promise<Outcome> {
  try {
    const output = await pipe(create(helpers), input);
    return { emitted: read === undefined ? output : read(output) };
  } catch (error) {
    return { failed: error instanceof Error ? error.message : String(error) };
  }
}

const compressed = {
  zstd: native.zstdCompress(text),
  zstdWithDict: native.zstdCompressWithDict(text, dict),
  gzip: native.gzipCompress(text),
  deflate: native.deflateCompress(text),
  brotli: native.brotliCompress(text),
  brotliWithDict: native.brotliCompressWithDict(text, dict),
  lz4: native.lz4Compress(text),
};

/** `data` with its middle byte flipped. */
function corrupt(data: Uint8Array): Uint8Array {
  const copy = Uint8Array.from(data);
  const middle = copy.length >> 1;
  copy[middle] = (copy[middle] ?? 0) ^ 0xff;
  return copy;
}

// Compression in chunks of 100 bytes, and decompression in chunks of 3,
// fewer bytes than createDecompressStream() needs to detect the format.
const CASES: Case[] = [
  [
    'createZstdCompressStream()',
    (h) => h.createZstdCompressStream(),
    chunks(text, 100),
    native.zstdDecompress,
  ],
  [
    'createZstdCompressStream(19)',
    (h) => h.createZstdCompressStream(19),
    chunks(text, 100),
    native.zstdDecompress,
  ],
  ['createZstdCompressStream(23)', (h) => h.createZstdCompressStream(23), chunks(text, 100)],
  [
    'createZstdCompressDictStream(dict)',
    (h) => h.createZstdCompressDictStream(dict),
    chunks(text, 100),
    (output) => native.zstdDecompressWithDict(output, dict),
  ],
  [
    'createGzipCompressStream(9)',
    (h) => h.createGzipCompressStream(9),
    chunks(text, 100),
    native.gzipDecompress,
  ],
  [
    'createDeflateCompressStream()',
    (h) => h.createDeflateCompressStream(),
    chunks(text, 100),
    native.deflateDecompress,
  ],
  [
    'createBrotliCompressStream(4)',
    (h) => h.createBrotliCompressStream(4),
    chunks(text, 100),
    native.brotliDecompress,
  ],
  [
    'createBrotliCompressDictStream(dict)',
    (h) => h.createBrotliCompressDictStream(dict),
    chunks(text, 100),
    (output) => native.brotliDecompressWithDict(output, dict),
  ],
  [
    'createLz4CompressStream()',
    (h) => h.createLz4CompressStream(),
    chunks(text, 100),
    native.lz4Decompress,
  ],
  [
    'createZstdDecompressStream()',
    (h) => h.createZstdDecompressStream(),
    chunks(compressed.zstd, 3),
  ],
  [
    'createZstdDecompressDictStream(dict)',
    (h) => h.createZstdDecompressDictStream(dict),
    chunks(compressed.zstdWithDict, 3),
  ],
  [
    'createGzipDecompressStream()',
    (h) => h.createGzipDecompressStream(),
    chunks(compressed.gzip, 3),
  ],
  [
    'createGzipDecompressStream(100)',
    (h) => h.createGzipDecompressStream(100),
    chunks(compressed.gzip, 3),
  ],
  [
    'createGzipDecompressStream(), corrupt input',
    (h) => h.createGzipDecompressStream(),
    chunks(corrupt(compressed.gzip), 3),
  ],
  [
    'createDeflateDecompressStream()',
    (h) => h.createDeflateDecompressStream(),
    chunks(compressed.deflate, 3),
  ],
  [
    'createBrotliDecompressStream()',
    (h) => h.createBrotliDecompressStream(),
    chunks(compressed.brotli, 3),
  ],
  [
    'createBrotliDecompressDictStream(dict)',
    (h) => h.createBrotliDecompressDictStream(dict),
    chunks(compressed.brotliWithDict, 3),
  ],
  ['createLz4DecompressStream()', (h) => h.createLz4DecompressStream(), chunks(compressed.lz4, 3)],
  [
    'createZstdDecompressStream(), input cut short',
    (h) => h.createZstdDecompressStream(),
    chunks(compressed.zstd.subarray(0, -4), 3),
  ],
  ...Object.entries(compressed).map(
    ([format, data]): Case => [
      `createDecompressStream(), ${format}`,
      (h) => h.createDecompressStream(),
      chunks(data, 3),
    ],
  ),
  ['createDecompressStream(), empty input', (h) => h.createDecompressStream(), []],
  [
    'createDecompressStream(), 3 bytes',
    (h) => h.createDecompressStream(),
    [compressed.zstd.subarray(0, 3)],
  ],
  ['createDecompressStream(), not compressed', (h) => h.createDecompressStream(), chunks(text, 3)],
  [
    'createDecompressStream(100), lz4',
    (h) => h.createDecompressStream(100),
    chunks(compressed.lz4, 3),
  ],
];

describe.skipIf(!HAS_WASM_BUILD)('browser streams module', () => {
  let entry: BrowserEntry;
  let browser: BrowserStreams;

  beforeAll(async () => {
    entry = await importBrowserEntry();
    browser = await importBrowserStreams();
  });

  it('exports the helpers of streams.js', () => {
    const helperNames = (module: object) =>
      Object.keys(module)
        .filter((name) => name.startsWith('create'))
        .sort();
    expect(Object.keys(browser).sort()).toStrictEqual(helperNames(nativeStreams));
  });

  it.each(CASES)('%s', async (...testCase) => {
    expect(await run(testCase, browser)).toStrictEqual(await run(testCase, nativeHelpers));
  });

  // A caller may reuse its buffer once a write has finished (#573).
  it.each([
    [
      'createGzipCompressStream()',
      (h: Helpers) => h.createGzipCompressStream(),
      text,
      native.gzipDecompress,
    ],
    [
      'createGzipDecompressStream()',
      (h: Helpers) => h.createGzipDecompressStream(),
      compressed.gzip,
      (output: Uint8Array) => output,
    ],
    [
      'createDecompressStream()',
      (h: Helpers) => h.createDecompressStream(),
      compressed.zstd,
      (output: Uint8Array) => output,
    ],
  ])('%s copies each chunk before its write finishes', async (_label, create, input, read) => {
    const output = await writeThroughOneBuffer(create(browser), input, 3);
    expect(Buffer.from(read(output))).toEqual(Buffer.from(text));
  });

  /** Run `use`, and return how many times it freed a context of a class. */
  async function countFrees(
    context: { prototype: { free(): void } },
    use: () => Promise<unknown>,
  ): Promise<number> {
    const free = vi.spyOn(context.prototype, 'free');
    try {
      await use();
      return free.mock.calls.length;
    } finally {
      free.mockRestore();
    }
  }

  // A stream frees the WebAssembly memory of its context once, as soon as it
  // ends, fails or is cancelled.
  describe.each([
    [
      'createGzipCompressStream()',
      () => entry.GzipCompressContext,
      () => browser.createGzipCompressStream(),
      text,
    ],
    [
      'createGzipDecompressStream()',
      () => entry.GzipDecompressContext,
      () => browser.createGzipDecompressStream(),
      compressed.gzip,
    ],
    [
      'createDecompressStream()',
      () => entry.GzipDecompressContext,
      () => browser.createDecompressStream(),
      compressed.gzip,
    ],
  ])('%s frees its context', (_label, context, create, input) => {
    it('when its input ends', async () => {
      expect(await countFrees(context(), () => pipe(create(), chunks(input, 100)))).toBe(1);
    });

    it('when it is cancelled', async () => {
      const cancelMidStream = async () => {
        const stream = create();
        const reader = stream.readable.getReader();
        const read = reader.read();
        await stream.writable.getWriter().write(input.subarray(0, 100));
        await reader.cancel();
        await read;
      };
      expect(await countFrees(context(), cancelMidStream)).toBe(1);
    });
  });

  it.each([
    ['createGzipDecompressStream(100)', () => browser.createGzipDecompressStream(100)],
    ['createDecompressStream(100)', () => browser.createDecompressStream(100)],
  ])('%s frees its context when transform() fails', async (_label, create) => {
    const exceedLimit = () =>
      expect(pipe(create(), chunks(compressed.gzip, 100))).rejects.toThrow(/exceeded maximum size/);
    expect(await countFrees(entry.GzipDecompressContext, exceedLimit)).toBe(1);
  });
});
