import { beforeAll, describe, expect, it } from 'vitest';
import * as native from '../index.js';
import { type BrowserEntry, HAS_WASM_BUILD, importBrowserEntry } from './load-browser-entry.js';

// Runs one table of calls against the native addon and the wasm-bindgen
// build, which must give the same result for each (#570): equal bytes and
// header objects, or errors of the same class. The wasm-bindgen build is
// loaded through the browser entry. Its stream contexts are JS adapters that
// call the one-shot functions, which in Vitest are the native ones (see
// vitest.config.mts), so for them this checks the adapters only.

// The native addon, typed with the browser declarations. This assignment
// type-checks only while each browser declaration accepts no argument that
// the native declaration rejects, and declares results that the native ones
// satisfy, so that browser/index.d.ts cannot drift from the native API.
const nativeApi: BrowserEntry = native;

type Call = (api: BrowserEntry) => unknown;
type CallWith = (api: BrowserEntry, value: unknown) => unknown;

/** What a call returned or threw, in a form that compares across the builds. */
type Outcome = { returned: unknown } | { threw: string; message: string };

function run(call: Call, api: BrowserEntry): Outcome {
  try {
    return { returned: comparable(call(api)) };
  } catch (error) {
    return error instanceof Error
      ? { threw: error.constructor.name, message: error.message }
      : { threw: typeof error, message: String(error) };
  }
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
function halves(data: Uint8Array): Uint8Array[] {
  return [data.subarray(0, data.length >> 1), data.subarray(data.length >> 1)];
}

interface StreamContext {
  transform(chunk: Uint8Array): Uint8Array;
  flush(): Uint8Array;
  finish?: () => Uint8Array;
}

/** Feed `chunks` to a stream context, and concatenate what it returns. */
function drain(context: StreamContext, chunks: Uint8Array[]): Uint8Array {
  const output = chunks.map((chunk) => context.transform(chunk));
  output.push(context.finish === undefined ? context.flush() : context.finish());
  return Buffer.concat(output);
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
    'BrotliDecompressDictContext',
    (api) => drain(new api.BrotliDecompressDictContext(dict), halves(fixtures.brotliWithDict)),
  ],
  [
    'Lz4CompressContext',
    (api) => api.lz4Decompress(drain(new api.Lz4CompressContext(), halves(text))),
  ],
  ['Lz4DecompressContext', (api) => drain(new api.Lz4DecompressContext(), halves(fixtures.lz4))],
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

const CONTEXTS: [string, (api: BrowserEntry) => StreamContext][] = [
  ['ZstdCompressContext', (api) => new api.ZstdCompressContext()],
  ['ZstdDecompressContext', (api) => new api.ZstdDecompressContext()],
  ['ZstdCompressDictContext', (api) => new api.ZstdCompressDictContext(dict)],
  ['ZstdDecompressDictContext', (api) => new api.ZstdDecompressDictContext(dict)],
  ['GzipCompressContext', (api) => new api.GzipCompressContext()],
  ['GzipDecompressContext', (api) => new api.GzipDecompressContext()],
  ['DeflateCompressContext', (api) => new api.DeflateCompressContext()],
  ['DeflateDecompressContext', (api) => new api.DeflateDecompressContext()],
  ['BrotliCompressContext', (api) => new api.BrotliCompressContext()],
  ['BrotliDecompressContext', (api) => new api.BrotliDecompressContext()],
  ['BrotliCompressDictContext', (api) => new api.BrotliCompressDictContext(dict)],
  ['BrotliDecompressDictContext', (api) => new api.BrotliDecompressDictContext(dict)],
  ['Lz4CompressContext', (api) => new api.Lz4CompressContext()],
  ['Lz4DecompressContext', (api) => new api.Lz4DecompressContext()],
];

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

describe.skipIf(!HAS_WASM_BUILD)('wasm-bindgen build parity with the native addon', () => {
  let wasm: BrowserEntry;

  beforeAll(async () => {
    wasm = await importBrowserEntry();
  });

  it.each(CALLS)('%s', (_label, call) => {
    expect(run(call, wasm)).toStrictEqual(run(call, nativeApi));
  });

  it.each(BYTES_PARAMETERS)('%s rejects what is not a byte array', (_label, callWith) => {
    const thrown = (api: BrowserEntry) =>
      NOT_BYTES.map(([description, value]) => [
        description,
        thrownClass(() => callWith(api, value)),
      ]);
    const expected = thrown(nativeApi);
    expect(expected.every(([, errorClass]) => errorClass !== undefined)).toBe(true);
    expect(thrown(wasm)).toStrictEqual(expected);
  });

  it.each(WRONG_TYPES)('%s', (_label, call) => {
    const expected = thrownClass(() => call(nativeApi));
    expect(expected).toBeDefined();
    expect(thrownClass(() => call(wasm))).toBe(expected);
  });
});
