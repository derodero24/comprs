import { beforeAll, describe, expect, it } from 'vitest';
import * as native from '../index.js';
import { type BrowserEntry, HAS_WASM_BUILD, importBrowserEntry } from './load-browser-entry.js';

// Runs one table of calls against the native addon and the wasm-bindgen
// build, which must give the same result for each (#570): equal bytes and
// header objects, or errors of the same class. The wasm-bindgen build is
// loaded through the browser entry, which exports its stream contexts (#573)
// and adds the *Async functions (#476).

/** The member that only the wasm-bindgen glue gives the stream contexts. */
type GlueMember = 'free';

/** The API of both builds: the browser entry, less the glue's members. */
type Api = {
  [Name in keyof BrowserEntry]: BrowserEntry[Name] extends new (
    ...args: infer Args
  ) => infer Context
    ? new (
        ...args: Args
      ) => Omit<Context, GlueMember>
    : BrowserEntry[Name];
};

// The native addon, typed with the browser declarations. This assignment
// type-checks only while each browser declaration accepts no argument that
// the native declaration rejects, and declares results that the native ones
// satisfy, so that browser/index.d.ts cannot drift from the native API.
const nativeApi: Api = native;

type Call = (api: Api) => unknown;
type CallWith = (api: Api, value: unknown) => unknown;

/** What a call returned or threw, in a form that compares across the builds. */
type Outcome = { returned: unknown } | { threw: string; message: string };

function run(call: Call, api: Api): Outcome {
  try {
    return { returned: comparable(call(api)) };
  } catch (error) {
    return thrown(error);
  }
}

/** What a Promise resolved to or was rejected with, in the form of an Outcome. */
async function settled(promise: unknown): Promise<Outcome> {
  try {
    return { returned: comparable(await promise) };
  } catch (error) {
    return thrown(error);
  }
}

function thrown(error: unknown): Outcome {
  return error instanceof Error
    ? { threw: error.constructor.name, message: error.message }
    : { threw: typeof error, message: String(error) };
}

/** A result with its Buffers turned into plain Uint8Arrays, recursively. */
function comparable(value: unknown): unknown {
  if (value instanceof Uint8Array) {
    return new Uint8Array(value);
  }
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, field]) => [key, comparable(field)]),
    );
  }
  return value;
}

/** Call `fn` with arguments that its declaration does not allow. */
function invoke(fn: (...args: never[]) => unknown, ...args: unknown[]): unknown {
  return Reflect.apply(fn, undefined, args);
}

const encoder = new TextEncoder();
const text = encoder.encode('The native addon and the WebAssembly build agree. '.repeat(40));
const dict = text.subarray(0, 1024);
const samples = Array.from({ length: 100 }, (_, i) =>
  encoder.encode(
    JSON.stringify({ id: i, name: `user-${i}`, active: i % 3 === 0, tags: ['a', 'b'] }),
  ),
);

const fixtures = {
  zstd: native.zstdCompress(text),
  zstdWithDict: native.zstdCompressWithDict(text, dict),
  gzip: native.gzipCompress(text),
  deflate: native.deflateCompress(text),
  brotli: native.brotliCompress(text),
  brotliWithDict: native.brotliCompressWithDict(text, dict),
  lz4: native.lz4Compress(text),
  gzipWithEveryHeaderField: gzipWithEveryHeaderField(text),
};

/**
 * A zstd frame without a content size that declares a window of 128 MiB and
 * holds "A", which a capacity of 1024 bytes rejects before the decoder
 * allocates the window.
 */
const largeWindowZstd = Uint8Array.from([0x28, 0xb5, 0x2f, 0xfd, 0, 0x88, 0x09, 0, 0, 0x41]);

/**
 * A gzip member with an extra field, a file name and a comment in its
 * header, which gzipCompressWithHeader() cannot write.
 */
function gzipWithEveryHeaderField(data: Uint8Array): Uint8Array {
  const extra = [0x63, 0x70, 2, 0, 0xca, 0xfe]; // Subfield "cp", 2 bytes long.
  const header = [
    ...[0x1f, 0x8b, 8, 0x04 | 0x08 | 0x10], // Magic, deflate, FEXTRA | FNAME | FCOMMENT
    ...[0x78, 0x56, 0x34, 0x12, 0, 3], // MTIME, XFL, OS (Unix)
    ...[extra.length, 0, ...extra],
    ...encoder.encode('notes.txt'),
    0,
    ...encoder.encode('a comment'),
    0,
  ];
  const trailer = Buffer.alloc(8);
  trailer.writeUInt32LE(native.crc32(data), 0);
  trailer.writeUInt32LE(data.length, 4);
  return Buffer.concat([Uint8Array.from(header), native.deflateCompress(data), trailer]);
}

/** A copy of `data` with its middle byte flipped. */
function corrupt(data: Uint8Array): Uint8Array {
  const copy = Uint8Array.from(data);
  const middle = copy.length >> 1;
  copy[middle] = (copy[middle] ?? 0) ^ 0xff;
  return copy;
}

/** `data` without its last 4 bytes. */
function truncate(data: Uint8Array): Uint8Array {
  return data.subarray(0, data.length - 4);
}

/** `data` in two chunks. */
function halves(data: Uint8Array): [Uint8Array, Uint8Array] {
  return [data.subarray(0, data.length >> 1), data.subarray(data.length >> 1)];
}

/** The options that make a stream context work incrementally. */
const INCREMENTAL = { incremental: true };

/**
 * Zeros, one byte more than the 4 MiB less 16 bytes that an incremental
 * brotli dictionary compression context holds before it streams.
 */
const PAST_THE_DICT_REACH = new Uint8Array(4 * 1024 * 1024 - 15);

/**
 * Options of the stream contexts, valid and not, by label. A function is an
 * object, but not to typeof: both builds reject it, even one with an
 * incremental property.
 */
const CONTEXT_OPTIONS: [string, unknown][] = [
  ['undefined', undefined],
  ['null', null],
  ['{}', {}],
  ['{ incremental: true }', { incremental: true }],
  ['{ incremental: false }', { incremental: false }],
  ['true', true],
  ["'x'", 'x'],
  ['{ incremental: 1 }', { incremental: 1 }],
  ["{ incremental: 'true' }", { incremental: 'true' }],
  ['() => ({ incremental: true })', () => ({ incremental: true })],
  [
    'a function whose incremental property is true',
    Object.assign(() => ({ incremental: true }), { incremental: true }),
  ],
];

interface StreamContext {
  transform(chunk: Uint8Array): Uint8Array;
  flush(): Uint8Array;
  finish(): Uint8Array;
  close(): void;
  [Symbol.dispose](): void;
}

/** Feed `chunks` to a stream context, and concatenate what it returns. */
function drain(context: StreamContext, chunks: Uint8Array[]): Uint8Array {
  const output = chunks.map((chunk) => context.transform(chunk));
  output.push(context.finish());
  return Buffer.concat(output);
}

/**
 * Feed `data` to a stream context in pieces of `size` bytes, each copied into
 * the same buffer, as a read loop that reuses its buffer passes them, and
 * concatenate what it returns.
 */
function drainThroughOneBuffer(context: StreamContext, data: Uint8Array, size: number) {
  const buffer = new Uint8Array(size);
  const output: Uint8Array[] = [];
  for (let offset = 0; offset < data.length; offset += size) {
    const piece = data.subarray(offset, offset + size);
    buffer.set(piece);
    output.push(context.transform(buffer.subarray(0, piece.length)));
  }
  output.push(context.finish());
  return Buffer.concat(output);
}

/**
 * Feed `data` to a stream context in two halves, with a flush() between
 * them. Return whether flush() returned any bytes, and everything the
 * context returned, read with `read`.
 */
function drainWithFlush(
  context: StreamContext,
  data: Uint8Array,
  read: (output: Uint8Array) => Uint8Array,
) {
  const [first, second] = halves(data);
  const output = [context.transform(first)];
  const flushed = context.flush();
  output.push(flushed, context.transform(second), context.finish());
  return { flushed: flushed.byteLength > 0, output: read(Buffer.concat(output)) };
}

// Calls with valid arguments, and with arguments that the core library
// rejects, whose messages are the same in both builds.
const CALLS: [string, Call][] = [
  ['version()', (api) => api.version()],

  // zstd
  ['zstdDecompress(native output)', (api) => api.zstdDecompress(fixtures.zstd)],
  ['zstdCompress(data), decompressed', (api) => api.zstdDecompress(api.zstdCompress(text))],
  ['zstdCompress(data, 19), decompressed', (api) => api.zstdDecompress(api.zstdCompress(text, 19))],
  ['zstdCompress(data, -5), by native', (api) => native.zstdDecompress(api.zstdCompress(text, -5))],
  ['zstdCompress(data, 23)', (api) => api.zstdCompress(text, 23)],
  ['zstdDecompress(corrupt)', (api) => api.zstdDecompress(corrupt(fixtures.zstd))],
  ['zstdDecompress(truncated)', (api) => api.zstdDecompress(truncate(fixtures.zstd))],
  ['zstdDecompress(empty)', (api) => api.zstdDecompress(new Uint8Array(0))],
  [
    'zstdDecompressWithCapacity(data, exact size)',
    (api) => api.zstdDecompressWithCapacity(fixtures.zstd, text.length),
  ],
  [
    'zstdDecompressWithCapacity(data, too small)',
    (api) => api.zstdDecompressWithCapacity(fixtures.zstd, text.length - 1),
  ],
  [
    'zstdDecompressWithCapacity(data, -1)',
    (api) => api.zstdDecompressWithCapacity(fixtures.zstd, -1),
  ],
  [
    'zstdDecompressWithCapacity(window of 128 MiB, 1024)',
    (api) => api.zstdDecompressWithCapacity(largeWindowZstd, 1024),
  ],
  ['zstdTrainDictionary(samples, 2048)', (api) => api.zstdTrainDictionary(samples, 2048)],
  ['zstdTrainDictionary([])', (api) => api.zstdTrainDictionary([])],
  [
    'zstdTrainDictionary(samples, 2 ** 24 + 1)',
    (api) => api.zstdTrainDictionary(samples, 2 ** 24 + 1),
  ],
  [
    'zstdCompressWithDict(data, dict, 7), decompressed',
    (api) => api.zstdDecompressWithDict(api.zstdCompressWithDict(text, dict, 7), dict),
  ],
  [
    'zstdDecompressWithDict(native output)',
    (api) => api.zstdDecompressWithDict(fixtures.zstdWithDict, dict),
  ],
  [
    'zstdDecompressWithDict(native output, other dict)',
    (api) => api.zstdDecompressWithDict(fixtures.zstdWithDict, text.subarray(1)),
  ],
  [
    'zstdDecompressWithDictWithCapacity(data, dict, too small)',
    (api) => api.zstdDecompressWithDictWithCapacity(fixtures.zstdWithDict, dict, 100),
  ],

  // gzip
  ['gzipDecompress(native output)', (api) => api.gzipDecompress(fixtures.gzip)],
  ['gzipCompress(data), decompressed', (api) => api.gzipDecompress(api.gzipCompress(text))],
  ['gzipCompress(data, 0), by native', (api) => native.gzipDecompress(api.gzipCompress(text, 0))],
  ['gzipCompress(data, 9), by native', (api) => native.gzipDecompress(api.gzipCompress(text, 9))],
  ['gzipCompress(data, 10)', (api) => api.gzipCompress(text, 10)],
  ['gzipDecompress(corrupt)', (api) => api.gzipDecompress(corrupt(fixtures.gzip))],
  ['gzipDecompress(truncated)', (api) => api.gzipDecompress(truncate(fixtures.gzip))],
  [
    'gzipDecompressWithCapacity(data, too small)',
    (api) => api.gzipDecompressWithCapacity(fixtures.gzip, 10),
  ],
  [
    'gzipDecompressWithCapacity(data, 1.5)',
    (api) => api.gzipDecompressWithCapacity(fixtures.gzip, 1.5),
  ],
  ['gzipReadHeader(native output)', (api) => api.gzipReadHeader(fixtures.gzip)],
  [
    'gzipReadHeader(every header field)',
    (api) => api.gzipReadHeader(fixtures.gzipWithEveryHeaderField),
  ],
  ['gzipReadHeader(not gzip)', (api) => api.gzipReadHeader(text)],
  [
    'gzipCompressWithHeader(data, { filename, mtime }, 9), header',
    (api) =>
      api.gzipReadHeader(
        api.gzipCompressWithHeader(text, { filename: 'notes.txt', mtime: 1_700_000_000 }, 9),
      ),
  ],
  [
    'gzipCompressWithHeader(data, { filename }), decompressed',
    (api) => api.gzipDecompress(api.gzipCompressWithHeader(text, { filename: 'notes.txt' })),
  ],
  [
    'gzipCompressWithHeader(data, {}), header',
    (api) => api.gzipReadHeader(api.gzipCompressWithHeader(text, {})),
  ],
  [
    'gzipCompressWithHeader(data, { filename: non-ASCII }), header',
    (api) => api.gzipReadHeader(api.gzipCompressWithHeader(text, { filename: 'résumé €.txt' })),
  ],
  // Both accept an mtime from 0 to 2 ** 32 - 1 and reject other numbers
  // with the same message.
  ...[0, 2 ** 32 - 1, -1, 2 ** 32 + 5, 1.9, Number.NaN].map((mtime): [string, Call] => [
    `gzipCompressWithHeader(data, { mtime: ${mtime} }), header`,
    (api) => api.gzipReadHeader(api.gzipCompressWithHeader(text, { mtime })),
  ]),
  ['gzipCompressWithHeader(data, {}, 10)', (api) => api.gzipCompressWithHeader(text, {}, 10)],

  // deflate
  ['deflateDecompress(native output)', (api) => api.deflateDecompress(fixtures.deflate)],
  [
    'deflateCompress(data, 1), by native',
    (api) => native.deflateDecompress(api.deflateCompress(text, 1)),
  ],
  ['deflateCompress(data, 10)', (api) => api.deflateCompress(text, 10)],
  ['deflateDecompress(corrupt)', (api) => api.deflateDecompress(corrupt(fixtures.deflate))],
  ['deflateDecompress(truncated)', (api) => api.deflateDecompress(truncate(fixtures.deflate))],
  [
    'deflateDecompressWithCapacity(data, too small)',
    (api) => api.deflateDecompressWithCapacity(fixtures.deflate, 10),
  ],

  // brotli
  ['brotliDecompress(native output)', (api) => api.brotliDecompress(fixtures.brotli)],
  [
    'brotliCompress(data, 0), by native',
    (api) => native.brotliDecompress(api.brotliCompress(text, 0)),
  ],
  [
    'brotliCompress(data, 11), decompressed',
    (api) => api.brotliDecompress(api.brotliCompress(text, 11)),
  ],
  ['brotliCompress(data, 12)', (api) => api.brotliCompress(text, 12)],
  ['brotliDecompress(truncated)', (api) => api.brotliDecompress(truncate(fixtures.brotli))],
  [
    'brotliDecompressWithCapacity(data, too small)',
    (api) => api.brotliDecompressWithCapacity(fixtures.brotli, 10),
  ],
  [
    'brotliCompressWithDict(data, dict, 5), decompressed',
    (api) => api.brotliDecompressWithDict(api.brotliCompressWithDict(text, dict, 5), dict),
  ],
  [
    'brotliDecompressWithDict(native output)',
    (api) => api.brotliDecompressWithDict(fixtures.brotliWithDict, dict),
  ],
  [
    'brotliDecompressWithDictWithCapacity(data, dict, too small)',
    (api) => api.brotliDecompressWithDictWithCapacity(fixtures.brotliWithDict, dict, 100),
  ],

  // lz4
  ['lz4Decompress(native output)', (api) => api.lz4Decompress(fixtures.lz4)],
  ['lz4Compress(data), by native', (api) => native.lz4Decompress(api.lz4Compress(text))],
  ['lz4Decompress(corrupt)', (api) => api.lz4Decompress(corrupt(fixtures.lz4))],
  ['lz4Decompress(truncated)', (api) => api.lz4Decompress(truncate(fixtures.lz4))],
  [
    'lz4DecompressWithCapacity(data, too small)',
    (api) => api.lz4DecompressWithCapacity(fixtures.lz4, 10),
  ],

  // Auto-detection and checksums
  ...Object.entries(fixtures).flatMap(([name, compressed]): [string, Call][] => [
    [`detectFormat(${name})`, (api) => api.detectFormat(compressed)],
    [`decompress(${name})`, (api) => api.decompress(compressed)],
  ]),
  ['detectFormat(text)', (api) => api.detectFormat(text)],
  ['decompress(text)', (api) => api.decompress(text)],
  ['crc32(data)', (api) => api.crc32(text)],
  ['crc32(data, 0x12345678)', (api) => api.crc32(text, 0x12345678)],
  ['crc32(data, -1)', (api) => api.crc32(text, -1)],
  ['crc32(data, 2 ** 32)', (api) => api.crc32(text, 2 ** 32)],
  ['crc32(empty)', (api) => api.crc32(new Uint8Array(0))],

  // Every kind of byte array that the native addon accepts.
  ['a pooled Buffer', (api) => api.gzipDecompress(api.gzipCompress(Buffer.from(text)))],
  [
    'a Uint8Array at an offset',
    (api) => api.zstdDecompress(api.zstdCompress(text.subarray(7, 777))),
  ],
  ['an empty Uint8Array', (api) => api.lz4Decompress(api.lz4Compress(new Uint8Array(0)))],
  ['a DataView', (api) => invoke(api.crc32, new DataView(text.buffer, 3, 100))],
  ['an Int8Array', (api) => invoke(api.brotliCompress, new Int8Array(text.buffer, 5, 50), 1)],

  // Stream contexts
  [
    'ZstdCompressContext',
    (api) => api.zstdDecompress(drain(new api.ZstdCompressContext(5), halves(text))),
  ],
  ['ZstdDecompressContext', (api) => drain(new api.ZstdDecompressContext(), halves(fixtures.zstd))],
  [
    'ZstdDecompressContext(1024), window of 128 MiB',
    (api) => drain(new api.ZstdDecompressContext(1024), [largeWindowZstd]),
  ],
  [
    'ZstdCompressDictContext',
    (api) =>
      api.zstdDecompressWithDict(drain(new api.ZstdCompressDictContext(dict), halves(text)), dict),
  ],
  [
    'ZstdDecompressDictContext',
    (api) => drain(new api.ZstdDecompressDictContext(dict), halves(fixtures.zstdWithDict)),
  ],
  [
    'GzipCompressContext',
    (api) => api.gzipDecompress(drain(new api.GzipCompressContext(9), halves(text))),
  ],
  ['GzipDecompressContext', (api) => drain(new api.GzipDecompressContext(), halves(fixtures.gzip))],
  [
    'DeflateCompressContext',
    (api) => api.deflateDecompress(drain(new api.DeflateCompressContext(1), halves(text))),
  ],
  [
    'DeflateDecompressContext',
    (api) => drain(new api.DeflateDecompressContext(), halves(fixtures.deflate)),
  ],
  [
    'BrotliCompressContext',
    (api) => api.brotliDecompress(drain(new api.BrotliCompressContext(4), halves(text))),
  ],
  [
    'BrotliDecompressContext',
    (api) => drain(new api.BrotliDecompressContext(), halves(fixtures.brotli)),
  ],
  [
    'BrotliCompressDictContext',
    (api) =>
      api.brotliDecompressWithDict(
        drain(new api.BrotliCompressDictContext(dict), halves(text)),
        dict,
      ),
  ],
  [
    'BrotliCompressDictContext({ incremental: true })',
    (api) => drain(new api.BrotliCompressDictContext(dict, undefined, INCREMENTAL), halves(text)),
  ],
  [
    'BrotliDecompressDictContext',
    (api) => drain(new api.BrotliDecompressDictContext(dict), halves(fixtures.brotliWithDict)),
  ],
  [
    'Lz4CompressContext',
    (api) => api.lz4Decompress(drain(new api.Lz4CompressContext(), halves(text))),
  ],
  ['Lz4DecompressContext', (api) => drain(new api.Lz4DecompressContext(), halves(fixtures.lz4))],
  [
    'Lz4DecompressContext({ incremental: true })',
    (api) => drain(new api.Lz4DecompressContext(undefined, INCREMENTAL), halves(fixtures.lz4)),
  ],
  // Both read the options of the stream contexts by hand, and reject the
  // same values with the same messages. What transform() returns for a whole
  // frame tells the mode that they select.
  ...CONTEXT_OPTIONS.map(([label, options]): [string, Call] => [
    `new Lz4DecompressContext(undefined, ${label})`,
    (api) => {
      const context: StreamContext = Reflect.construct(api.Lz4DecompressContext, [
        undefined,
        options,
      ]);
      return [context.transform(fixtures.lz4), context.finish()];
    },
  ]),
  // The brotli dictionary compression context too, which streams only past
  // the first 4 MiB less 16 bytes of input.
  ...CONTEXT_OPTIONS.map(([label, options]): [string, Call] => [
    `new BrotliCompressDictContext(dict, 0, ${label})`,
    (api) => {
      const context: StreamContext = Reflect.construct(api.BrotliCompressDictContext, [
        dict,
        0,
        options,
      ]);
      return [context.transform(PAST_THE_DICT_REACH), context.finish()];
    },
  ]),
];

// Values that are not byte arrays, which the native addon rejects wherever it
// takes one. The glue that wasm-bindgen generates for `&[u8]` read an
// ArrayBuffer as empty and a string as zeros.
const NOT_BYTES: [string, unknown][] = [
  ['an ArrayBuffer', new ArrayBuffer(8)],
  ['a string', 'hello'],
  ['a number', 42],
  ['an array of numbers', [1, 2, 3]],
  ['a plain object', {}],
  ['null', null],
  ['undefined', undefined],
];

/** A compression context of each class, and how to decompress its output. */
const COMPRESSION_CONTEXTS: [
  string,
  (api: Api) => StreamContext,
  (output: Uint8Array) => Buffer,
][] = [
  ['ZstdCompressContext', (api) => new api.ZstdCompressContext(), native.zstdDecompress],
  [
    'ZstdCompressDictContext',
    (api) => new api.ZstdCompressDictContext(dict),
    (output) => native.zstdDecompressWithDict(output, dict),
  ],
  ['GzipCompressContext', (api) => new api.GzipCompressContext(), native.gzipDecompress],
  ['DeflateCompressContext', (api) => new api.DeflateCompressContext(), native.deflateDecompress],
  ['BrotliCompressContext', (api) => new api.BrotliCompressContext(), native.brotliDecompress],
  [
    'BrotliCompressDictContext',
    (api) => new api.BrotliCompressDictContext(dict),
    (output) => native.brotliDecompressWithDict(output, dict),
  ],
  [
    'BrotliCompressDictContext({ incremental: true })',
    (api) => new api.BrotliCompressDictContext(dict, undefined, INCREMENTAL),
    (output) => native.brotliDecompressWithDict(output, dict),
  ],
  ['Lz4CompressContext', (api) => new api.Lz4CompressContext(), native.lz4Decompress],
];

/** A decompression context of each class, and compressed data for it. */
const DECOMPRESSION_CONTEXTS: [string, (api: Api) => StreamContext, Uint8Array][] = [
  ['ZstdDecompressContext', (api) => new api.ZstdDecompressContext(), fixtures.zstd],
  [
    'ZstdDecompressDictContext',
    (api) => new api.ZstdDecompressDictContext(dict),
    fixtures.zstdWithDict,
  ],
  ['GzipDecompressContext', (api) => new api.GzipDecompressContext(), fixtures.gzip],
  ['DeflateDecompressContext', (api) => new api.DeflateDecompressContext(), fixtures.deflate],
  ['BrotliDecompressContext', (api) => new api.BrotliDecompressContext(), fixtures.brotli],
  [
    'BrotliDecompressDictContext',
    (api) => new api.BrotliDecompressDictContext(dict),
    fixtures.brotliWithDict,
  ],
  ['Lz4DecompressContext', (api) => new api.Lz4DecompressContext(), fixtures.lz4],
  [
    'Lz4DecompressContext({ incremental: true })',
    (api) => new api.Lz4DecompressContext(undefined, INCREMENTAL),
    fixtures.lz4,
  ],
];

const CONTEXTS = [...COMPRESSION_CONTEXTS, ...DECOMPRESSION_CONTEXTS].map(
  ([name, create]): [string, (api: Api) => StreamContext] => [name, create],
);

/** Bytes that are no compressed stream of any format. */
const garbage = new Uint8Array(64).fill(0xa5);

/** Feed `input` to a stream context, end it, and end it again. */
function endTwice(context: StreamContext, input: Uint8Array): Uint8Array {
  drain(context, [input]);
  return context.finish();
}

// The stream contexts, used the way callers use them (#573). Each one copies
// its input before transform() returns, emits what flush() makes available,
// and reports invalid input when transform() reads it.
const STREAM_USES: [string, Call][] = [
  ...COMPRESSION_CONTEXTS.flatMap(([name, create, decompress]): [string, Call][] => [
    [
      `${name}: input passed in one reused buffer`,
      (api) => decompress(drainThroughOneBuffer(create(api), text, 64)),
    ],
    [`${name}: flush() mid-stream`, (api) => drainWithFlush(create(api), text, decompress)],
    [`${name}: ended twice`, (api) => endTwice(create(api), text)],
  ]),
  ...DECOMPRESSION_CONTEXTS.flatMap(([name, create, compressed]): [string, Call][] => [
    [
      `${name}: input passed in one reused buffer`,
      (api) => drainThroughOneBuffer(create(api), compressed, 4),
    ],
    [
      `${name}: flush() mid-stream`,
      (api) => drainWithFlush(create(api), compressed, (output) => output),
    ],
    [`${name}: transform(garbage)`, (api) => create(api).transform(garbage)],
    [`${name}: input cut short`, (api) => drain(create(api), halves(truncate(compressed)))],
    [
      `${name}: transform() after the end`,
      (api) => {
        const context = create(api);
        drain(context, [compressed]);
        return context.transform(compressed);
      },
    ],
    [`${name}: ended twice`, (api) => endTwice(create(api), compressed)],
  ]),
];

/** A context of each class, and input that it accepts. */
const CONTEXT_INPUTS: [string, (api: Api) => StreamContext, Uint8Array][] = [
  ...COMPRESSION_CONTEXTS.map(
    ([name, create]): [string, (api: Api) => StreamContext, Uint8Array] => [name, create, text],
  ),
  ...DECOMPRESSION_CONTEXTS,
];

/** A context that has transformed the start of `input`. */
function started(create: (api: Api) => StreamContext, api: Api, input: Uint8Array) {
  const context = create(api);
  context.transform(input.subarray(0, 10));
  return context;
}

// close() releases the state of a context that will not be finished (#616),
// and [Symbol.dispose]() is the same method: later calls throw the same
// errors in both builds.
const CLOSE_USES: [string, Call][] = CONTEXT_INPUTS.flatMap(
  ([name, create, input]): [string, Call][] => [
    [
      `${name}: transform() after close()`,
      (api) => {
        const context = started(create, api, input);
        context.close();
        return context.transform(input);
      },
    ],
    [
      `${name}: flush() after close()`,
      (api) => {
        const context = started(create, api, input);
        context.close();
        return context.flush();
      },
    ],
    [
      `${name}: finish() after close() twice`,
      (api) => {
        const context = started(create, api, input);
        context.close();
        context.close();
        return context.finish();
      },
    ],
    [
      `${name}: close() after finish()`,
      (api) => {
        const context = create(api);
        drain(context, [input]);
        context.close();
        return context.transform(input);
      },
    ],
    [
      `${name}: flush() after [Symbol.dispose]()`,
      (api) => {
        const context = started(create, api, input);
        context[Symbol.dispose]();
        return context.flush();
      },
    ],
  ],
);

// Every parameter that takes a byte array, called with `value` in its place.
const BYTES_PARAMETERS: [string, CallWith][] = [
  ['zstdCompress(data)', (api, value) => invoke(api.zstdCompress, value)],
  ['zstdDecompress(data)', (api, value) => invoke(api.zstdDecompress, value)],
  [
    'zstdDecompressWithCapacity(data)',
    (api, value) => invoke(api.zstdDecompressWithCapacity, value, 1024),
  ],
  [
    'zstdTrainDictionary(samples[1])',
    (api, value) => invoke(api.zstdTrainDictionary, [text, value]),
  ],
  ['zstdCompressWithDict(data)', (api, value) => invoke(api.zstdCompressWithDict, value, dict)],
  ['zstdCompressWithDict(dict)', (api, value) => invoke(api.zstdCompressWithDict, text, value)],
  ['zstdDecompressWithDict(data)', (api, value) => invoke(api.zstdDecompressWithDict, value, dict)],
  [
    'zstdDecompressWithDict(dict)',
    (api, value) => invoke(api.zstdDecompressWithDict, fixtures.zstdWithDict, value),
  ],
  [
    'zstdDecompressWithDictWithCapacity(data)',
    (api, value) => invoke(api.zstdDecompressWithDictWithCapacity, value, dict, 1024),
  ],
  [
    'zstdDecompressWithDictWithCapacity(dict)',
    (api, value) =>
      invoke(api.zstdDecompressWithDictWithCapacity, fixtures.zstdWithDict, value, 1024),
  ],
  ['gzipCompress(data)', (api, value) => invoke(api.gzipCompress, value)],
  ['gzipDecompress(data)', (api, value) => invoke(api.gzipDecompress, value)],
  [
    'gzipDecompressWithCapacity(data)',
    (api, value) => invoke(api.gzipDecompressWithCapacity, value, 1024),
  ],
  ['gzipCompressWithHeader(data)', (api, value) => invoke(api.gzipCompressWithHeader, value, {})],
  ['gzipReadHeader(data)', (api, value) => invoke(api.gzipReadHeader, value)],
  ['deflateCompress(data)', (api, value) => invoke(api.deflateCompress, value)],
  ['deflateDecompress(data)', (api, value) => invoke(api.deflateDecompress, value)],
  [
    'deflateDecompressWithCapacity(data)',
    (api, value) => invoke(api.deflateDecompressWithCapacity, value, 1024),
  ],
  ['brotliCompress(data)', (api, value) => invoke(api.brotliCompress, value)],
  ['brotliDecompress(data)', (api, value) => invoke(api.brotliDecompress, value)],
  [
    'brotliDecompressWithCapacity(data)',
    (api, value) => invoke(api.brotliDecompressWithCapacity, value, 1024),
  ],
  ['brotliCompressWithDict(data)', (api, value) => invoke(api.brotliCompressWithDict, value, dict)],
  ['brotliCompressWithDict(dict)', (api, value) => invoke(api.brotliCompressWithDict, text, value)],
  [
    'brotliDecompressWithDict(data)',
    (api, value) => invoke(api.brotliDecompressWithDict, value, dict),
  ],
  [
    'brotliDecompressWithDict(dict)',
    (api, value) => invoke(api.brotliDecompressWithDict, fixtures.brotliWithDict, value),
  ],
  [
    'brotliDecompressWithDictWithCapacity(data)',
    (api, value) => invoke(api.brotliDecompressWithDictWithCapacity, value, dict, 1024),
  ],
  [
    'brotliDecompressWithDictWithCapacity(dict)',
    (api, value) =>
      invoke(api.brotliDecompressWithDictWithCapacity, fixtures.brotliWithDict, value, 1024),
  ],
  ['lz4Compress(data)', (api, value) => invoke(api.lz4Compress, value)],
  ['lz4Decompress(data)', (api, value) => invoke(api.lz4Decompress, value)],
  [
    'lz4DecompressWithCapacity(data)',
    (api, value) => invoke(api.lz4DecompressWithCapacity, value, 1024),
  ],
  ['detectFormat(data)', (api, value) => invoke(api.detectFormat, value)],
  ['decompress(data)', (api, value) => invoke(api.decompress, value)],
  ['crc32(data)', (api, value) => invoke(api.crc32, value)],
  ...CONTEXTS.map(([name, create]): [string, CallWith] => [
    `${name}.transform(chunk)`,
    (api, value) => {
      const context = create(api);
      return Reflect.apply(context.transform, context, [value]);
    },
  ]),
  [
    'new ZstdCompressDictContext(dict)',
    (api, value) => Reflect.construct(api.ZstdCompressDictContext, [value]),
  ],
  [
    'new ZstdDecompressDictContext(dict)',
    (api, value) => Reflect.construct(api.ZstdDecompressDictContext, [value]),
  ],
  [
    'new BrotliCompressDictContext(dict)',
    (api, value) => Reflect.construct(api.BrotliCompressDictContext, [value]),
  ],
  [
    'new BrotliDecompressDictContext(dict)',
    (api, value) => Reflect.construct(api.BrotliDecompressDictContext, [value]),
  ],
];

// Other arguments of the wrong type. The native messages name Rust types, so
// only the error classes are compared.
const NOT_SAMPLES: [string, unknown][] = [...NOT_BYTES, ['a Uint8Array', text]];
const NOT_HEADERS: [string, unknown][] = [
  ['no header', undefined],
  ['null', null],
  ['{ filename: 42 }', { filename: 42 }],
  ['{ filename: null }', { filename: null }],
  ['{ mtime: "1" }', { mtime: '1' }],
  ['{ mtime: null }', { mtime: null }],
];
const WRONG_TYPES: [string, Call][] = [
  ...NOT_SAMPLES.map(([description, value]): [string, Call] => [
    `zstdTrainDictionary(${description})`,
    (api) => invoke(api.zstdTrainDictionary, value),
  ]),
  ...NOT_HEADERS.map(([description, header]): [string, Call] => [
    `gzipCompressWithHeader(data, ${description})`,
    (api) => invoke(api.gzipCompressWithHeader, text, header),
  ]),
];

/** The class of the error that `call` throws, or `undefined` if it returns. */
function thrownClass(call: () => unknown): string | undefined {
  try {
    call();
  } catch (error) {
    return error instanceof Error ? error.constructor.name : typeof error;
  }
  return undefined;
}

/** The *Async functions. */
type AsyncName = Extract<keyof BrowserEntry, `${string}Async`>;

// Valid arguments for each *Async function (#476).
const ASYNC_ARGUMENTS: Record<AsyncName, unknown[]> = {
  zstdCompressAsync: [text, 19],
  zstdDecompressAsync: [fixtures.zstd],
  zstdDecompressWithCapacityAsync: [fixtures.zstd, text.length],
  zstdCompressWithDictAsync: [text, dict, 7],
  zstdDecompressWithDictAsync: [fixtures.zstdWithDict, dict],
  zstdDecompressWithDictWithCapacityAsync: [fixtures.zstdWithDict, dict, text.length],
  zstdTrainDictionaryAsync: [samples, 2048],
  gzipCompressAsync: [text, 9],
  gzipDecompressAsync: [fixtures.gzip],
  gzipDecompressWithCapacityAsync: [fixtures.gzip, text.length],
  deflateCompressAsync: [text, 1],
  deflateDecompressAsync: [fixtures.deflate],
  deflateDecompressWithCapacityAsync: [fixtures.deflate, text.length],
  brotliCompressAsync: [text, 4],
  brotliDecompressAsync: [fixtures.brotli],
  brotliDecompressWithCapacityAsync: [fixtures.brotli, text.length],
  brotliCompressWithDictAsync: [text, dict, 5],
  brotliDecompressWithDictAsync: [fixtures.brotliWithDict, dict],
  brotliDecompressWithDictWithCapacityAsync: [fixtures.brotliWithDict, dict, text.length],
  lz4CompressAsync: [text],
  lz4DecompressAsync: [fixtures.lz4],
  lz4DecompressWithCapacityAsync: [fixtures.lz4, text.length],
  decompressAsync: [fixtures.gzip, text.length],
};

/** Call the function that `api` exports as `name`. */
function callByName(api: Api, name: string, args: unknown[]): unknown {
  const fn: unknown = Reflect.get(api, name);
  if (typeof fn !== 'function') {
    throw new Error(`${name} is not exported`);
  }
  return Reflect.apply(fn, undefined, args);
}

/** The names of the *Async functions that a module exports. */
function asyncNames(module: object): string[] {
  return Object.keys(module)
    .filter((name) => name.endsWith('Async'))
    .sort();
}

describe.skipIf(!HAS_WASM_BUILD)('wasm-bindgen build parity with the native addon', () => {
  let wasm: BrowserEntry;

  beforeAll(async () => {
    wasm = await importBrowserEntry();
  });

  // The browser entry defines the enum's members as napi-rs defines them
  // (#567): read-only and not enumerable, so that Object.keys() and
  // Object.values() give the same results in both builds.
  it('CompressionFormat', () => {
    expect(Object.getOwnPropertyDescriptors(wasm.CompressionFormat)).toStrictEqual(
      Object.getOwnPropertyDescriptors(native.CompressionFormat),
    );
  });

  it.each(CALLS)('%s', (_label, call) => {
    expect(run(call, wasm)).toStrictEqual(run(call, nativeApi));
  });

  it.each(STREAM_USES)('%s', (_label, call) => {
    expect(run(call, wasm)).toStrictEqual(run(call, nativeApi));
  });

  it.each(CLOSE_USES)('%s', (_label, call) => {
    expect(run(call, wasm)).toStrictEqual(run(call, nativeApi));
  });

  it.each(BYTES_PARAMETERS)('%s rejects what is not a byte array', (_label, callWith) => {
    const thrownBy = (api: Api) =>
      NOT_BYTES.map(([description, value]) => [
        description,
        thrownClass(() => callWith(api, value)),
      ]);
    const expected = thrownBy(nativeApi);
    expect(expected.every(([, errorClass]) => errorClass !== undefined)).toBe(true);
    expect(thrownBy(wasm)).toStrictEqual(expected);
  });

  it.each(WRONG_TYPES)('%s', (_label, call) => {
    const expected = thrownClass(() => call(nativeApi));
    expect(expected).toBeDefined();
    expect(thrownClass(() => call(wasm))).toBe(expected);
  });

  describe('*Async functions', () => {
    it('are those of the native addon', () => {
      expect(asyncNames(wasm)).toStrictEqual(asyncNames(native));
      expect(Object.keys(ASYNC_ARGUMENTS).sort()).toStrictEqual(asyncNames(native));
    });

    // The native addon copies the input before it returns the Promise.
    it('read their input before they return', async () => {
      const compressWhileOverwriting = async (api: Api) => {
        const data = Uint8Array.from(text);
        const compressed = api.gzipCompressAsync(data);
        data.fill(0);
        return native.gzipDecompress(await compressed);
      };
      expect(await compressWhileOverwriting(wasm)).toStrictEqual(
        await compressWhileOverwriting(nativeApi),
      );
    });

    describe.each(Object.entries(ASYNC_ARGUMENTS))('%s', (name, args) => {
      const syncName = name.slice(0, -'Async'.length);

      it('resolves to what the synchronous function returns', async () => {
        const promise = callByName(wasm, name, args);
        expect(promise).toBeInstanceOf(Promise);
        const expected = run((api) => callByName(api, syncName, args), wasm);
        expect(expected).toHaveProperty('returned');
        expect(await settled(promise)).toStrictEqual(expected);
      });

      // As the native functions do since #619.
      it('rejects with what the synchronous function throws, rather than throwing it', async () => {
        const invalid = ['not a byte array', ...args.slice(1)];
        let promise: unknown;
        expect(() => {
          promise = callByName(wasm, name, invalid);
        }).not.toThrow();
        expect(promise).toBeInstanceOf(Promise);
        const expected = run((api) => callByName(api, syncName, invalid), wasm);
        expect(expected).toHaveProperty('threw');
        expect(await settled(promise)).toStrictEqual(expected);
        // The native addon rejects too, with an error of the same class; the
        // messages for what is not a byte array differ between the builds.
        let nativePromise: unknown;
        expect(() => {
          nativePromise = callByName(nativeApi, name, invalid);
        }).not.toThrow();
        const threw = 'threw' in expected ? expected.threw : undefined;
        expect(await settled(nativePromise)).toMatchObject({ threw });
      });
    });
  });
});
