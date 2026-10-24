import { beforeAll, describe, expect, it } from 'vitest';
import * as native from '../index.js';
import { pseudoRandomBytes } from './detect-fixtures.js';
import { type BrowserEntry, HAS_WASM_BUILD, importBrowserEntry } from './load-browser-entry.js';

// The root API keeps the `code` and the message of every error that comprs
// 2.x throws, although comprs-core sorts its errors into categories with
// stable codes (#555): the native addon's `code` stays a napi status,
// "InvalidArg" or "GenericFailure", and the errors of the wasm-bindgen build
// have no `code`.

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

// The native addon, typed with the browser declarations, as in
// wasm-parity.spec.ts.
const nativeApi: Api = native;

type Call = (api: Api) => unknown;

/**
 * The error of a call today: its native `code`, and its message, or for a
 * message that ends with the text of a decoder library, such as flate2's,
 * the start of the message that comprs writes.
 */
type Legacy =
  | { code: 'InvalidArg' | 'GenericFailure'; message: string }
  | { code: 'InvalidArg' | 'GenericFailure'; prefix: string };

const invalidArg = (message: string): Legacy => ({ code: 'InvalidArg', message });
const failure = (message: string): Legacy => ({ code: 'GenericFailure', message });
const failurePrefix = (prefix: string): Legacy => ({ code: 'GenericFailure', prefix });

const encoder = new TextEncoder();
const text = encoder.encode('comprs keeps the codes and the messages of its errors. '.repeat(400));
const dict = text.subarray(0, 1024);

const compressed = {
  zstd: native.zstdCompress(text),
  gzip: native.gzipCompress(text),
  deflate: native.deflateCompress(text),
  brotli: native.brotliCompress(text),
  lz4: native.lz4Compress(text),
};

/** `data` with the byte at `index` set to 0xff. */
function withFF(data: Uint8Array, index: number): Uint8Array {
  const copy = Uint8Array.from(data);
  copy[index] = 0xff;
  return copy;
}

/** The first half of `data`. */
function half(data: Uint8Array): Uint8Array {
  return data.subarray(0, data.length >> 1);
}

/** `data` followed by bytes that are not compressed data. */
function withGarbage(data: Uint8Array): Uint8Array {
  return Uint8Array.from([...data, ...encoder.encode('trailing garbage')]);
}

/** Input whose compressed data the decoders reject. */
const corrupt = {
  // A frame whose only block has the reserved block type.
  zstd: Uint8Array.from([0x28, 0xb5, 0x2f, 0xfd, 0, 0, 0x07, 0, 0]),
  // A deflate block of the reserved type, after the 10-byte gzip header.
  gzip: withFF(compressed.gzip, 10),
  deflate: withFF(compressed.deflate, 0),
  brotli: new Uint8Array(16).fill(0xff),
  // The last literal changed, which the content checksum covers.
  lz4: withFF(compressed.lz4, compressed.lz4.length - 9),
};

/** The start of a Large Window Brotli stream, with a window of 2^22 bytes. */
const largeWindowBrotli = Uint8Array.from([0x11, 0x16]);

const unknownFormat = invalidArg(
  'unable to detect compression format; use algorithm-specific functions (zstdDecompress, gzipDecompress, brotliDecompress, lz4Decompress, or deflateDecompress for raw deflate) instead',
);

/** Random bytes that the brotli probe of format detection accepts. */
const probedAsBrotli = pseudoRandomBytes(0, 64 * 1024);

/**
 * The first half of a brotli stream, which the brotli probe of format
 * detection accepts, but which does not decode.
 */
const cutBrotli = half(
  native.brotliCompress(
    encoder.encode(
      Array.from({ length: 5000 }, (_, i) => `line ${i}: comprs keeps its errors\n`).join(''),
    ),
  ),
);

const truncated = (format: string) =>
  failure(`${format} stream is truncated: unexpected end of input`);
const exceeded = (context: string) =>
  failure(`${context} exceeded maximum size of ${text.length - 1} bytes`);
const maxSafeInteger = Number.MAX_SAFE_INTEGER;

const ONE_SHOT: [string, Call, Legacy][] = [
  // Corrupt data.
  [
    'zstd corrupt',
    (api) => api.zstdDecompress(corrupt.zstd),
    failurePrefix('zstd decompress failed: '),
  ],
  [
    'gzip corrupt',
    (api) => api.gzipDecompress(corrupt.gzip),
    failurePrefix('gzip decompress failed: '),
  ],
  [
    'deflate corrupt',
    (api) => api.deflateDecompress(corrupt.deflate),
    failure('deflate decompress failed: corrupt deflate stream'),
  ],
  [
    'brotli corrupt',
    (api) => api.brotliDecompress(corrupt.brotli),
    failure('brotli decompress failed: Invalid Data'),
  ],
  [
    'lz4 corrupt',
    (api) => api.lz4Decompress(corrupt.lz4),
    failurePrefix('lz4 decompress failed: '),
  ],
  [
    'zstd data after the frame',
    (api) => api.zstdDecompress(withGarbage(compressed.zstd)),
    failurePrefix('zstd decompress failed: '),
  ],
  [
    'gzip data after the member',
    (api) => api.gzipDecompress(withGarbage(compressed.gzip)),
    failurePrefix('gzip decompress failed: '),
  ],
  [
    'lz4 data after the frame',
    (api) => api.lz4Decompress(withGarbage(compressed.lz4)),
    failure('lz4 decompress failed: unexpected data after the end of a frame'),
  ],
  [
    'lz4 data that is not a frame',
    (api) => api.lz4Decompress(encoder.encode('hello world')),
    failurePrefix('lz4 decompress failed: '),
  ],
  [
    'brotli large-window stream',
    (api) => api.brotliDecompress(largeWindowBrotli),
    failure('brotli decompress failed: large-window brotli streams are not supported'),
  ],
  [
    'zstd dict corrupt',
    (api) => api.zstdDecompressWithDict(corrupt.zstd, dict),
    failurePrefix('zstd decompress with dict failed: '),
  ],
  [
    'brotli dict corrupt',
    (api) => api.brotliDecompressWithDict(corrupt.brotli, dict),
    failure('brotli decompress with dict failed: Invalid Data'),
  ],

  // Truncated data.
  ['zstd truncated', (api) => api.zstdDecompress(half(compressed.zstd)), truncated('zstd')],
  [
    'gzip truncated',
    (api) => api.gzipDecompress(half(compressed.gzip)),
    failurePrefix('gzip decompress failed: '),
  ],
  [
    'deflate truncated',
    (api) => api.deflateDecompress(half(compressed.deflate)),
    truncated('deflate'),
  ],
  [
    'brotli truncated',
    (api) => api.brotliDecompress(half(compressed.brotli)),
    failure('brotli decompress failed: Invalid Data'),
  ],
  ['lz4 truncated', (api) => api.lz4Decompress(half(compressed.lz4)), truncated('lz4')],
  ['gzip empty', (api) => api.gzipDecompress(new Uint8Array()), truncated('gzip')],

  // The output limit.
  [
    'zstd size limit',
    (api) => api.zstdDecompressWithCapacity(compressed.zstd, text.length - 1),
    exceeded('zstd decompress'),
  ],
  [
    'gzip size limit',
    (api) => api.gzipDecompressWithCapacity(compressed.gzip, text.length - 1),
    exceeded('gzip decompress'),
  ],
  [
    'deflate size limit',
    (api) => api.deflateDecompressWithCapacity(compressed.deflate, text.length - 1),
    exceeded('deflate decompress'),
  ],
  [
    'brotli size limit',
    (api) => api.brotliDecompressWithCapacity(compressed.brotli, text.length - 1),
    exceeded('brotli decompress'),
  ],
  [
    'lz4 size limit',
    (api) => api.lz4DecompressWithCapacity(compressed.lz4, text.length - 1),
    exceeded('lz4 decompress'),
  ],

  // Invalid arguments.
  [
    'zstd invalid level',
    (api) => api.zstdCompress(text, 23),
    invalidArg('zstd compression level must be an integer between -131072 and 22'),
  ],
  [
    'gzip invalid level',
    (api) => api.gzipCompress(text, 10),
    invalidArg('gzip compression level must be an integer between 0 and 9'),
  ],
  [
    'deflate invalid level',
    (api) => api.deflateCompress(text, 10),
    invalidArg('deflate compression level must be an integer between 0 and 9'),
  ],
  [
    'brotli invalid level',
    (api) => api.brotliCompress(text, 12),
    invalidArg('brotli quality must be an integer between 0 and 11'),
  ],
  // lz4 takes no level.
  [
    'lz4 invalid capacity',
    (api) => api.lz4DecompressWithCapacity(compressed.lz4, -1),
    invalidArg(`capacity must be an integer between 0 and ${maxSafeInteger}`),
  ],
  [
    'gzipReadHeader of data without a gzip header',
    (api) => api.gzipReadHeader(encoder.encode('hello world')),
    invalidArg('invalid gzip data: unable to parse header'),
  ],

  // Unknown formats.
  ['unknown format', (api) => api.decompress(encoder.encode('hello world')), unknownFormat],
  ['unknown format of empty input', (api) => api.decompress(new Uint8Array()), unknownFormat],
  ['unknown format of raw deflate', (api) => api.decompress(compressed.deflate), unknownFormat],
  ['unknown format of a cut brotli stream', (api) => api.decompress(cutBrotli), unknownFormat],
  [
    'unknown format of random data that the brotli probe accepts',
    (api) => api.decompress(probedAsBrotli),
    unknownFormat,
  ],

  // The *Async functions reject with the same errors.
  [
    'zstdDecompressAsync corrupt',
    (api) => api.zstdDecompressAsync(corrupt.zstd),
    failurePrefix('zstd decompress failed: '),
  ],
  [
    'deflateDecompressAsync truncated',
    (api) => api.deflateDecompressAsync(half(compressed.deflate)),
    truncated('deflate'),
  ],
  [
    'brotliDecompressWithCapacityAsync size limit',
    (api) => api.brotliDecompressWithCapacityAsync(compressed.brotli, text.length - 1),
    exceeded('brotli decompress'),
  ],
  [
    'gzipCompressAsync invalid level',
    (api) => api.gzipCompressAsync(text, 10),
    invalidArg('gzip compression level must be an integer between 0 and 9'),
  ],
  ['decompressAsync unknown format', (api) => api.decompressAsync(probedAsBrotli), unknownFormat],
];

interface StreamContext {
  transform(chunk: Uint8Array): Uint8Array;
  flush(): Uint8Array;
  finish(): Uint8Array;
  close(): void;
}

/** The stream contexts of one format. */
interface Contexts {
  label: string;
  /** The name of the stream in the errors of the contexts. */
  stream: string;
  /** Input for the decompression context. */
  input: Uint8Array;
  /** The error of the decompression context for the first half of `input`. */
  cut: Legacy;
  compressor: (api: Api) => StreamContext;
  decompressor: (api: Api, maxOutputSize?: number) => StreamContext;
}

const CONTEXTS: Contexts[] = [
  {
    label: 'zstd',
    stream: 'zstd stream',
    input: compressed.zstd,
    cut: truncated('zstd'),
    compressor: (api) => new api.ZstdCompressContext(),
    decompressor: (api, maxOutputSize) => new api.ZstdDecompressContext(maxOutputSize),
  },
  {
    label: 'zstd dict',
    stream: 'zstd stream',
    input: native.zstdCompressWithDict(text, dict),
    cut: truncated('zstd'),
    compressor: (api) => new api.ZstdCompressDictContext(dict),
    decompressor: (api, maxOutputSize) => new api.ZstdDecompressDictContext(dict, maxOutputSize),
  },
  {
    label: 'gzip',
    stream: 'gzip stream',
    input: compressed.gzip,
    // flate2's checksum error, for a member without its trailer.
    cut: failurePrefix('gzip stream finish failed: '),
    compressor: (api) => new api.GzipCompressContext(),
    decompressor: (api, maxOutputSize) => new api.GzipDecompressContext(maxOutputSize),
  },
  {
    label: 'deflate',
    stream: 'deflate stream',
    input: compressed.deflate,
    cut: truncated('deflate'),
    compressor: (api) => new api.DeflateCompressContext(),
    decompressor: (api, maxOutputSize) => new api.DeflateDecompressContext(maxOutputSize),
  },
  {
    label: 'brotli',
    stream: 'brotli stream',
    input: compressed.brotli,
    cut: truncated('brotli'),
    compressor: (api) => new api.BrotliCompressContext(),
    decompressor: (api, maxOutputSize) => new api.BrotliDecompressContext(maxOutputSize),
  },
  {
    label: 'brotli dict',
    stream: 'brotli dict stream',
    input: native.brotliCompressWithDict(text, dict),
    cut: truncated('brotli'),
    compressor: (api) => new api.BrotliCompressDictContext(dict),
    decompressor: (api, maxOutputSize) => new api.BrotliDecompressDictContext(dict, maxOutputSize),
  },
  {
    label: 'lz4',
    stream: 'lz4 stream',
    input: compressed.lz4,
    cut: truncated('lz4'),
    compressor: (api) => new api.Lz4CompressContext(),
    decompressor: (api, maxOutputSize) => new api.Lz4DecompressContext(maxOutputSize),
  },
];

/** Decompress `input` in one chunk with `ctx` and finish the stream. */
function decode(ctx: StreamContext, input: Uint8Array): void {
  ctx.transform(input);
  ctx.finish();
}

const STREAM: [string, Call, Legacy][] = CONTEXTS.flatMap(
  ({ label, stream, input, cut, compressor, decompressor }): [string, Call, Legacy][] => [
    [`${label} stream truncated`, (api) => decode(decompressor(api), half(input)), cut],
    [
      `${label} stream size limit`,
      (api) => decode(decompressor(api, text.length - 1), input),
      exceeded(`${stream} decompress`),
    ],
    [
      `${label} stream invalid maxOutputSize`,
      (api) => decompressor(api, -1),
      invalidArg(`maxOutputSize must be an integer between 0 and ${maxSafeInteger}`),
    ],
    [
      `${label} compression finished twice`,
      (api) => {
        const ctx = compressor(api);
        ctx.finish();
        ctx.finish();
      },
      failure(`${stream} already finished`),
    ],
    [
      `${label} decompression finished twice`,
      (api) => {
        const ctx = decompressor(api);
        decode(ctx, input);
        ctx.finish();
      },
      failure(`${stream} already finished`),
    ],
    [
      `${label} compression closed`,
      (api) => {
        const ctx = compressor(api);
        ctx.close();
        ctx.transform(text);
      },
      failure(`${stream} already closed`),
    ],
    [
      `${label} decompression closed`,
      (api) => {
        const ctx = decompressor(api);
        ctx.close();
        ctx.finish();
      },
      failure(`${stream} already closed`),
    ],
  ],
);

const STREAM_DATA: [string, Call, Legacy][] = [
  [
    'zstd stream corrupt',
    (api) => decode(new api.ZstdDecompressContext(), corrupt.zstd),
    failurePrefix('zstd stream decompress failed: '),
  ],
  [
    'gzip stream corrupt',
    (api) => decode(new api.GzipDecompressContext(), corrupt.gzip),
    failurePrefix('gzip stream decompress failed: '),
  ],
  [
    'deflate stream corrupt',
    (api) => decode(new api.DeflateDecompressContext(), corrupt.deflate),
    failure('deflate stream decompress failed: corrupt deflate stream'),
  ],
  [
    'deflate stream data after the end',
    (api) => decode(new api.DeflateDecompressContext(), withGarbage(compressed.deflate)),
    failure('deflate stream decompress failed: unexpected data after the end of the stream'),
  ],
  [
    'brotli stream corrupt',
    (api) => decode(new api.BrotliDecompressContext(), corrupt.brotli),
    failure('brotli stream decompress failed: Invalid Data'),
  ],
  [
    'brotli stream data after the end',
    (api) => decode(new api.BrotliDecompressContext(), withGarbage(compressed.brotli)),
    failure('brotli stream decompress failed: unexpected data after the end of the stream'),
  ],
  [
    'lz4 stream corrupt',
    (api) => decode(new api.Lz4DecompressContext(), corrupt.lz4),
    failurePrefix('lz4 stream decompress failed: '),
  ],
];

const CASES = [...ONE_SHOT, ...STREAM, ...STREAM_DATA];

/** What `call` threw, or the reason of the Promise it returned. */
async function errorOf(call: Call, api: Api): Promise<unknown> {
  try {
    await call(api);
  } catch (error) {
    return error;
  }
  throw new Error('the call succeeded');
}

/** Check the message of `error` against `legacy`. */
function expectMessage(error: unknown, legacy: Legacy): void {
  expect(error).toBeInstanceOf(Error);
  const message = error instanceof Error ? error.message : '';
  if ('message' in legacy) {
    expect(message).toBe(legacy.message);
  } else {
    expect(message.slice(0, legacy.prefix.length)).toBe(legacy.prefix);
    expect(message.length).toBeGreaterThan(legacy.prefix.length);
  }
}

describe('legacy error codes and messages', () => {
  it('cover data that the brotli probe accepts but that does not decode', () => {
    expect(native.detectFormat(probedAsBrotli)).toBe('brotli');
    expect(native.detectFormat(cutBrotli)).toBe('brotli');
  });

  describe('of the native addon', () => {
    it.each(CASES)('%s', async (_label, call, legacy) => {
      const error = await errorOf(call, nativeApi);
      expectMessage(error, legacy);
      expect(error).toHaveProperty('code', legacy.code);
    });
  });

  describe.skipIf(!HAS_WASM_BUILD)('of the wasm-bindgen build', () => {
    let wasm: BrowserEntry;

    beforeAll(async () => {
      wasm = await importBrowserEntry();
    });

    it.each(CASES)('%s', async (_label, call, legacy) => {
      const error = await errorOf(call, wasm);
      expectMessage(error, legacy);
      expect(error).not.toHaveProperty('code');
    });
  });
});
