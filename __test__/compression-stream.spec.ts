import { createRequire } from 'node:module';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CodecStream } from '../next/backend.js';
import {
  type Bytes,
  CompressionStream,
  type CompressionStreamOptions,
  compressSync,
  DecompressionStream,
  type DecompressionStreamOptions,
  Dictionary,
  decompressSync,
  type ErrorCode,
  type Format,
} from '../next/index.js';
import { CHUNK_KINDS, streamOf, toChunks } from './chunk-fixtures.js';
import { MISLEADING_VIEWS } from './misleading-length.js';
import { backendModule } from './next-backend.js';

// CompressionStream and DecompressionStream of the unified API,
// @derodero24/comprs/next (#344), over the native addon: ponyfills of the
// classes of the Compression Streams standard, in every format of the API.
// In Node.js, a ChunkScheduler sends their expensive calls to the libuv
// thread pool, as for the stream helpers of the package root (#554).
// next-parity.spec.ts compares the browser build. Local runs use the debug
// build, in which brotli is about ten times slower than in the release
// build, so the inputs are sized for it, and the tests that compress
// megabytes get explicit timeouts.

const require = createRequire(__filename);

const KiB = 1024;
const MiB = 1024 * KiB;

/** Timeout of the tests that compress or decompress megabytes. */
const CODEC_TIMEOUT = 60_000;

/** The formats of the unified API. */
const FORMATS: readonly Format[] = ['zstd', 'gzip', 'deflate', 'deflate-raw', 'brotli', 'lz4'];

/** The formats that decompression detects: all but raw deflate. */
const DETECTED: readonly Format[] = FORMATS.filter((format) => format !== 'deflate-raw');

/**
 * `size` bytes of text that compresses about as well as prose: words from a
 * small vocabulary, picked by a fixed pseudo-random sequence.
 */
function text(size: number): Uint8Array {
  const words = ['comprs', 'zstd', 'gzip', 'deflate', 'brotli', 'lz4', 'stream', 'chunk'];
  const data = Buffer.alloc(size);
  let seed = 1;
  let offset = 0;
  while (offset < size) {
    // The high bits of a linear congruential generator are the random ones.
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
    offset += data.write(`${words[seed >>> 29]}${(seed >>> 13) % 512} `, offset);
  }
  return new Uint8Array(data);
}

/** `data` in chunks of `size` bytes, each a Uint8Array of its own. */
function chunked(data: Uint8Array, size: number): Uint8Array[] {
  const chunks: Uint8Array[] = [];
  for (let offset = 0; offset < data.byteLength; offset += size) {
    chunks.push(data.slice(offset, offset + size));
  }
  return chunks;
}

/** The bytes of the chunks of `stream`, joined. */
async function bytesOf(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Pass `chunks` through `pair`, and return the bytes that come out. */
function through(
  chunks: readonly unknown[],
  pair: { readable: ReadableStream<Uint8Array>; writable: WritableStream<never> },
): Promise<Uint8Array> {
  return bytesOf(streamOf(chunks).pipeThrough(pair));
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

/** The error that `call` throws. */
function thrown(call: () => unknown): unknown {
  try {
    call();
  } catch (error) {
    return error;
  }
  throw new Error('expected the call to throw');
}

/** An error with `code`, of the class of that code, with `message` if given. */
function coded(code: ErrorCode, message?: string | RegExp): unknown {
  const Class = code === 'ERR_COMPRS_INVALID_ARG' ? TypeError : Error;
  return expect.objectContaining({
    constructor: Class,
    code,
    ...(message === undefined ? {} : { message: expect.stringMatching(message) }),
  });
}

/** The options of compressSync() for `format`, with a level. */
function levelled(format: Format): CompressionStreamOptions {
  return format === 'lz4' ? {} : { level: format === 'brotli' ? 5 : 3 };
}

const input = text(256 * KiB);
const small = text(2 * KiB);

/**
 * The stream functions of the hidden binding of the native addon, which
 * next-binding.spec.ts tests further.
 */
interface StreamBinding {
  createCompressContext(format: string, level?: number): object;
  contextTransform(context: object, chunk: Uint8Array): Uint8Array;
  contextTransformAsync(context: object, chunk: Uint8Array): Promise<Uint8Array>;
  contextFinish(context: object): Uint8Array;
  contextClose(context: object): void;
}

function isStreamBinding(value: unknown): value is StreamBinding {
  const names = [
    'createCompressContext',
    'contextTransform',
    'contextTransformAsync',
    'contextFinish',
    'contextClose',
  ];
  return (
    typeof value === 'object' &&
    value !== null &&
    names.every((name) => typeof Reflect.get(value, name) === 'function')
  );
}

/** The stream functions of the hidden binding. */
function binding(): StreamBinding {
  const value: unknown = Reflect.get(
    require('../index.js'),
    Symbol.for('@derodero24/comprs/internal'),
  );
  if (!isStreamBinding(value)) throw new Error('the native addon has no stream binding');
  return value;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('CompressionStream and DecompressionStream', () => {
  it.each(FORMATS)('round-trip %s data in chunks of any size', async (format) => {
    for (const [data, size] of [
      [small, 1],
      [small, 7],
      [input, 64 * KiB],
    ] as const) {
      const compressed = await through(
        chunked(data, size),
        new CompressionStream(format, levelled(format)),
      );
      expect(decompressSync(compressed, { format })).toStrictEqual(data);
      const decompressed = await through(
        chunked(compressed, size),
        new DecompressionStream(format),
      );
      expect(decompressed).toStrictEqual(data);
    }
  });

  it.each(DETECTED)(
    'detect %s data with auto',
    async (format) => {
      const compressed = compressSync(input, { format });
      // Detection decides by 64 KiB of input at the latest: byte by byte up
      // to 70 KiB, and then the rest at once.
      const byteByByte = [
        ...chunked(compressed.subarray(0, 70 * KiB), 1),
        compressed.slice(70 * KiB),
      ];
      for (const chunks of [byteByByte, chunked(compressed, 7), chunked(compressed, 64 * KiB)]) {
        expect(await through(chunks, new DecompressionStream('auto'))).toStrictEqual(input);
      }
    },
    CODEC_TIMEOUT,
  );

  it(
    'write the bytes of their contexts called on the calling thread alone',
    async () => {
      // The scheduler makes each call synchronously or on the thread pool,
      // as its predicted time decides, which changes nothing in the output.
      const next = binding();
      for (const format of FORMATS) {
        const { level } = levelled(format);
        for (const size of [1, 16 * KiB, MiB]) {
          const data = size === 1 ? small : size === MiB ? text(2 * MiB) : input;
          const context = next.createCompressContext(format, level);
          const parts = chunked(data, size).map((chunk) => next.contextTransform(context, chunk));
          parts.push(next.contextFinish(context));
          const actual = await through(
            chunked(data, size),
            new CompressionStream(format, { level }),
          );
          expect(actual, `${format} in chunks of ${size} bytes`).toStrictEqual(
            new Uint8Array(Buffer.concat(parts)),
          );
        }
      }
    },
    CODEC_TIMEOUT,
  );

  it('emit plain Uint8Arrays, and no empty chunks', async () => {
    const stream = streamOf(chunked(input, 4 * KiB)).pipeThrough(new CompressionStream('zstd'));
    const chunks: Uint8Array[] = [];
    for await (const chunk of stream) chunks.push(chunk);
    expect(chunks.length).toBeGreaterThan(0);
    for (const chunk of chunks) {
      expect(Object.getPrototypeOf(chunk)).toBe(Uint8Array.prototype);
      expect(chunk.byteLength).toBeGreaterThan(0);
    }
  });

  it.each(CHUNK_KINDS)('read %s chunks byte for byte', async (kind) => {
    // Chunks of an even size, which a Uint16Array holds whole, so that the
    // chunks of every kind start at the same offsets.
    const compressed = compressSync(input, { format: 'gzip' });
    const fromKind = await through(toChunks(input, 3000, kind), new CompressionStream('gzip'));
    const plain = await through(chunked(input, 3000), new CompressionStream('gzip'));
    expect(fromKind).toStrictEqual(plain);
    const decompressed = await through(
      toChunks(compressed, 3000, kind),
      new DecompressionStream('gzip'),
    );
    expect(decompressed).toStrictEqual(input);
  });

  it.each(MISLEADING_VIEWS)('read the bytes of %s', async (_, view) => {
    // A view's own byteLength, byteOffset or buffer, or those of its
    // subclass, do not change the bytes that the stream reads.
    const plain = await through([small], new CompressionStream('zstd'));
    expect(await through([view(small)], new CompressionStream('zstd'))).toStrictEqual(plain);
  });

  it(
    'copy each chunk before the write settles, so the writer may reuse it',
    async () => {
      // The writer refills one buffer with the next part of the input once
      // each write settles.
      for (const format of ['zstd', 'brotli'] as const) {
        const stream = new CompressionStream(format, { level: 9 });
        const output = bytesOf(stream.readable);
        const writer = stream.writable.getWriter();
        const buffer = new Uint8Array(64 * KiB);
        for (let offset = 0; offset < input.byteLength; offset += buffer.byteLength) {
          buffer.set(input.subarray(offset, offset + buffer.byteLength));
          await writer.write(buffer);
        }
        await writer.close();
        expect(decompressSync(await output, { format })).toStrictEqual(input);
      }
    },
    CODEC_TIMEOUT,
  );

  it.each(['gzip', 'deflate', 'deflate-raw'] as const)(
    'interoperate with the global streams of Node.js for %s',
    async (format) => {
      const ours = await through(chunked(input, 10 * KiB), new CompressionStream(format));
      expect(await through([ours], new globalThis.DecompressionStream(format))).toStrictEqual(
        input,
      );
      const theirs = await through(
        chunked(input, 10 * KiB),
        new globalThis.CompressionStream(format),
      );
      expect(await through([theirs], new DecompressionStream(format))).toStrictEqual(input);
    },
  );

  it('compress with a Dictionary or the bytes of one', async () => {
    const bytes = text(4 * KiB);
    for (const format of ['zstd', 'brotli'] as const) {
      const dictionary = Dictionary.from(bytes, { format });
      const withPrepared = await through(
        chunked(small, 100),
        new CompressionStream(format, { dictionary }),
      );
      const withBytes = await through(
        chunked(small, 100),
        new CompressionStream(format, { dictionary: bytes }),
      );
      expect(withPrepared).toStrictEqual(withBytes);
      expect(decompressSync(withPrepared, { format, dictionary: bytes })).toStrictEqual(small);
      // 'auto' stands for the format of a Dictionary, which raw bytes need.
      for (const stream of [
        new DecompressionStream('auto', { dictionary }),
        new DecompressionStream(format, { dictionary }),
        new DecompressionStream(format, { dictionary: bytes }),
      ]) {
        expect(await through(chunked(withBytes, 50), stream)).toStrictEqual(small);
      }
      dictionary.close();
    }
  });

  it(
    'keep using a Dictionary that is closed after they are created',
    async () => {
      const bytes = text(4 * KiB);
      for (const format of ['zstd', 'brotli'] as const) {
        const dictionary = Dictionary.from(bytes, { format });
        const compression = new CompressionStream(format, { dictionary, level: 9 });
        const decompression = new DecompressionStream('auto', { dictionary });
        dictionary.close();
        const compressed = await through(chunked(input, 64 * KiB), compression);
        expect(decompressSync(compressed, { format, dictionary: bytes })).toStrictEqual(input);
        expect(await through(chunked(compressed, 999), decompression)).toStrictEqual(input);
      }
    },
    CODEC_TIMEOUT,
  );

  it('have the tags of the standard classes', () => {
    expect(Object.prototype.toString.call(new CompressionStream('zstd'))).toBe(
      '[object CompressionStream]',
    );
    expect(Object.prototype.toString.call(new DecompressionStream('auto'))).toBe(
      '[object DecompressionStream]',
    );
    const stream = new CompressionStream('lz4');
    expect(stream.readable).toBeInstanceOf(ReadableStream);
    expect(stream.writable).toBeInstanceOf(WritableStream);
    expect(stream.readable).toBe(stream.readable);
  });
});

describe('the constructors', () => {
  it.each([
    ['an unknown format', () => new CompressionStream('nope' as Format)],
    ['a missing format', () => Reflect.construct(CompressionStream, [])],
    ['auto for compression', () => new CompressionStream('auto' as Format)],
    ['options that are no object', () => Reflect.construct(CompressionStream, ['zstd', 3])],
    [
      'a level that is no number',
      () => Reflect.construct(CompressionStream, ['zstd', { level: '3' }]),
    ],
    ['a level out of range', () => new CompressionStream('gzip', { level: 10 })],
    ['a level for lz4', () => new CompressionStream('lz4', { level: 1 })],
    ['a dictionary for gzip', () => new CompressionStream('gzip', { dictionary: small })],
    ['an empty dictionary', () => new CompressionStream('zstd', { dictionary: new Uint8Array() })],
    ['a gzip header for zstd', () => new CompressionStream('zstd', { gzipHeader: {} })],
    [
      'a filename with a NUL',
      () => new CompressionStream('gzip', { gzipHeader: { filename: 'a\0b' } }),
    ],
    ['workers for gzip', () => new CompressionStream('gzip', { workers: 1 })],
    ['a format for decompression', () => new DecompressionStream('nope' as Format)],
    ['a missing format for decompression', () => Reflect.construct(DecompressionStream, [])],
    ['a negative limit', () => new DecompressionStream('zstd', { maxOutputSize: -1 })],
    ['dictionary bytes with auto', () => new DecompressionStream('auto', { dictionary: small })],
  ])('throw a TypeError with ERR_COMPRS_INVALID_ARG for %s', (_, create) => {
    expect(thrown(create)).toEqual(coded('ERR_COMPRS_INVALID_ARG'));
  });

  it('check the format before the options, as compressSync() checks its options', () => {
    expect(thrown(() => Reflect.construct(CompressionStream, ['nope', 3]))).toEqual(
      coded('ERR_COMPRS_INVALID_ARG', /^format must be one of zstd, gzip/),
    );
    const message = (call: () => unknown): string => {
      const error = thrown(call);
      return error instanceof Error ? error.message : String(error);
    };
    expect(message(() => new CompressionStream('gzip', { level: 10 }))).toBe(
      message(() => compressSync(small, { format: 'gzip', level: 10 })),
    );
    expect(message(() => new DecompressionStream('auto', { dictionary: small }))).toBe(
      message(() => decompressSync(small, { dictionary: small })),
    );
  });

  it('refuse a closed Dictionary', () => {
    const dictionary = Dictionary.from(small, { format: 'zstd' });
    dictionary.close();
    expect(thrown(() => new CompressionStream('zstd', { dictionary }))).toEqual(
      coded('ERR_COMPRS_INVALID_ARG', /^this Dictionary is closed$/),
    );
    expect(thrown(() => new DecompressionStream('auto', { dictionary }))).toEqual(
      coded('ERR_COMPRS_INVALID_ARG', /^this Dictionary is closed$/),
    );
  });

  it('take the gzip header and the workers', async () => {
    const header = { filename: 'data.txt', mtime: 1_700_000_000 };
    const withHeader = await through(
      [small],
      new CompressionStream('gzip', { gzipHeader: header }),
    );
    expect(withHeader).toStrictEqual(compressSync(small, { format: 'gzip', gzipHeader: header }));
    const withWorkers = await through(
      chunked(input, 64 * KiB),
      new CompressionStream('zstd', { workers: 2 }),
    );
    expect(decompressSync(withWorkers)).toStrictEqual(input);
  });
});

describe('errors', () => {
  it('error the stream with the code of the codec', async () => {
    const zstd = compressSync(input, { format: 'zstd' });
    const cases: [DecompressionStream, Uint8Array[], unknown][] = [
      [
        new DecompressionStream('zstd', { maxOutputSize: 1000 }),
        [zstd],
        coded('ERR_COMPRS_SIZE_LIMIT'),
      ],
      [new DecompressionStream('zstd'), [zstd.slice(0, 100)], coded('ERR_COMPRS_TRUNCATED')],
      [new DecompressionStream('gzip'), [], coded('ERR_COMPRS_TRUNCATED')],
      [
        new DecompressionStream('zstd'),
        [zstd, Uint8Array.of(1, 2, 3)],
        coded('ERR_COMPRS_CORRUPT_DATA'),
      ],
      [
        new DecompressionStream('auto'),
        [new TextEncoder().encode('not compressed by any format, as far as anyone can tell')],
        coded('ERR_COMPRS_UNKNOWN_FORMAT'),
      ],
      [new DecompressionStream('auto'), [], coded('ERR_COMPRS_UNKNOWN_FORMAT')],
    ];
    for (const [stream, chunks, error] of cases) {
      expect(await rejection(through(chunks, stream))).toEqual(error);
    }
  });

  it.each([
    ['a string', 'text'],
    ['a number', 42],
    ['null', null],
    ['an array of bytes', [1, 2, 3]],
  ])('error the stream with ERR_COMPRS_INVALID_ARG for %s', async (_, chunk) => {
    expect(await rejection(through([chunk], new CompressionStream('zstd')))).toEqual(
      coded(
        'ERR_COMPRS_INVALID_ARG',
        /^chunk must be an ArrayBuffer, SharedArrayBuffer or ArrayBufferView$/,
      ),
    );
  });

  it('error the stream with ERR_COMPRS_INVALID_ARG for a detached buffer', async () => {
    const buffer = new ArrayBuffer(8);
    structuredClone(buffer, { transfer: [buffer] });
    expect(await rejection(through([buffer], new CompressionStream('zstd')))).toEqual(
      coded('ERR_COMPRS_INVALID_ARG', /^chunk is a detached ArrayBuffer$/),
    );
  });
});

/**
 * The reader and the writer of `stream`, which has transformed `chunk` and
 * waits for more. A pending read lets the stream take input, which it does
 * not while no one reads its output.
 */
async function started(
  stream: CompressionStream | DecompressionStream,
  chunk: Uint8Array,
): Promise<{
  reader: ReadableStreamDefaultReader<Uint8Array>;
  writer: WritableStreamDefaultWriter<Uint8Array>;
}> {
  const reader = stream.readable.getReader();
  const writer = stream.writable.getWriter();
  reader.read().catch(() => {});
  await writer.write(chunk);
  return { reader, writer };
}

/** The calls that the codec of a stream got. */
interface Recorded {
  calls: string[];
  /** The most calls that were in flight at once. */
  overlap: number;
}

/**
 * Run `body` with a backend whose streams record their calls, and return
 * the records of the streams that it created.
 */
async function withRecordedStreams(
  body: () => Promise<void>,
  wrap: (inner: CodecStream, record: Recorded) => CodecStream = (inner) => inner,
): Promise<Recorded[]> {
  const { backend, setBackend } = backendModule();
  const original = backend();
  const records: Recorded[] = [];
  const recorded = (inner: CodecStream): CodecStream => {
    const record: Recorded = { calls: [], overlap: 0 };
    records.push(record);
    const codec = wrap(inner, record);
    let inFlight = 0;
    const call = (name: string, run: () => Bytes | Promise<Bytes>): Bytes | Promise<Bytes> => {
      record.calls.push(name);
      inFlight++;
      record.overlap = Math.max(record.overlap, inFlight);
      let result: Bytes | Promise<Bytes>;
      try {
        result = run();
      } catch (error) {
        inFlight--;
        throw error;
      }
      if (ArrayBuffer.isView(result)) {
        inFlight--;
        return result;
      }
      return result.finally(() => {
        inFlight--;
      });
    };
    return {
      transform: (chunk) => call('transform', () => codec.transform(chunk)),
      finish: () => call('finish', () => codec.finish()),
      close: () => {
        record.calls.push('close');
        codec.close();
      },
    };
  };
  setBackend({
    ...original,
    createCompressStream: (...args) => recorded(original.createCompressStream(...args)),
    createDecompressStream: (...args) => recorded(original.createDecompressStream(...args)),
  });
  try {
    await body();
  } finally {
    setBackend(original);
  }
  return records;
}

describe('the codec of a stream', () => {
  it('is closed once the stream ends', async () => {
    const records = await withRecordedStreams(async () => {
      const compressed = await through(chunked(small, 500), new CompressionStream('zstd'));
      await through([compressed], new DecompressionStream('auto'));
    });
    expect(records.map((record) => record.calls)).toEqual([
      ['transform', 'transform', 'transform', 'transform', 'transform', 'finish', 'close'],
      ['transform', 'finish', 'close'],
    ]);
  });

  it('is closed once when decompression fails', async () => {
    const records = await withRecordedStreams(async () => {
      await rejection(through([Uint8Array.of(1, 2, 3)], new DecompressionStream('zstd')));
      await rejection(through([], new DecompressionStream('gzip')));
      await rejection(through(['text'], new DecompressionStream('gzip')));
    });
    expect(records.map((record) => record.calls)).toEqual([
      ['transform', 'close'],
      ['finish', 'close'],
      ['close'],
    ]);
  });

  it('is closed once the readable side is cancelled or the writable side aborted', async () => {
    const records = await withRecordedStreams(async () => {
      const cancelled = await started(new CompressionStream('zstd'), small);
      await cancelled.reader.cancel();
      const aborted = await started(new DecompressionStream('auto'), small.subarray(0, 2));
      await aborted.writer.abort(new Error('aborted'));
    });
    expect(records.map((record) => record.calls)).toEqual([
      ['transform', 'close'],
      ['transform', 'close'],
    ]);
  });

  it(
    'is never called again while a call is in flight',
    async () => {
      // Brotli at quality 9 sends its blocks to the thread pool, where a
      // second call would fail with "is busy".
      const records = await withRecordedStreams(async () => {
        const compressed = await through(
          chunked(input, 16 * KiB),
          new CompressionStream('brotli', { level: 9 }),
        );
        expect(decompressSync(compressed, { format: 'brotli' })).toStrictEqual(input);
      });
      expect(records).toHaveLength(1);
      expect(records[0]?.overlap).toBe(1);
    },
    CODEC_TIMEOUT,
  );

  it('drops a late error of a call that was in flight when the stream was cancelled', async () => {
    // A call that rejects after the cancel is no unhandled rejection, which
    // Vitest would report, and its result reaches no reader.
    const pending: { reject?: (error: Error) => void } = {};
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      const records = await withRecordedStreams(
        async () => {
          const stream = new DecompressionStream('zstd');
          const reader = stream.readable.getReader();
          const writer = stream.writable.getWriter();
          const read = reader.read();
          const write = writer.write(small);
          await vi.waitFor(() => expect(pending.reject).toBeTypeOf('function'));
          await reader.cancel(new Error('cancelled'));
          pending.reject?.(new Error('the codec failed after the cancel'));
          await expect(read).resolves.toEqual({ done: true, value: undefined });
          await expect(write).rejects.toThrow();
          await new Promise((resolve) => setTimeout(resolve, 10));
        },
        (inner) => ({
          transform: () =>
            new Promise<Bytes>((_, fail) => {
              pending.reject = fail;
            }),
          finish: () => inner.finish(),
          close: () => inner.close(),
        }),
      );
      expect(records.map((record) => record.calls)).toEqual([['transform', 'close']]);
    } finally {
      process.off('unhandledRejection', unhandled);
    }
    expect(unhandled).not.toHaveBeenCalled();
  });

  it(
    'releases its native memory when the garbage collector collects an abandoned stream',
    async () => {
      // A zstd stream holds about 3.5 MiB once it compresses data, which its
      // state reports to V8: abandoned streams do not pile up.
      let collected = 0;
      const registry = new FinalizationRegistry(() => {
        collected++;
      });
      for (let i = 0; i < 200 && collected === 0; i++) {
        const stream = new CompressionStream('zstd');
        await started(stream, small);
        registry.register(stream, i);
        if (i % 10 === 9) await new Promise(setImmediate);
      }
      expect(collected).toBeGreaterThan(0);
    },
    CODEC_TIMEOUT,
  );
});

describe('the hidden binding of the streams', () => {
  it(
    'fails a call while an asynchronous call is in flight, as no stream class does',
    async () => {
      const next = binding();
      const context = next.createCompressContext('brotli', 9);
      const pending = next.contextTransformAsync(context, input);
      expect(thrown(() => next.contextTransform(context, small))).toEqual(
        coded('ERR_COMPRS_OPERATION_FAILED', /^compression stream is busy/),
      );
      await pending;
      next.contextClose(context);
      expect(thrown(() => next.contextFinish(context))).toEqual(
        coded('ERR_COMPRS_STREAM_CLOSED', /^compression stream already closed$/),
      );
    },
    CODEC_TIMEOUT,
  );
});

describe('the event loop', { timeout: CODEC_TIMEOUT }, () => {
  /**
   * Run `run` while a 1 ms interval timer counts how often the event loop
   * gets to it: the number of ticks, and the median and the longest gap
   * between them, in milliseconds.
   */
  async function timerTicks(
    run: () => Promise<void>,
  ): Promise<{ ticks: number; median: number; longest: number }> {
    const gaps: number[] = [];
    let last = performance.now();
    const timer = setInterval(() => {
      const now = performance.now();
      gaps.push(now - last);
      last = now;
    }, 1);
    try {
      await run();
    } finally {
      clearInterval(timer);
    }
    const ticks = gaps.length;
    gaps.push(performance.now() - last);
    gaps.sort((a, b) => a - b);
    return { ticks, median: gaps[gaps.length >> 1] ?? 0, longest: gaps.at(-1) ?? 0 };
  }

  /**
   * The largest median gap between the ticks of the timer that a test
   * accepts: 10 ms, or twice the median gap of the timer on an idle event
   * loop where timers are coarser than that.
   */
  async function medianGapBound(): Promise<number> {
    const idle = await timerTicks(() => new Promise((done) => setTimeout(done, 100)));
    return Math.max(10, 2 * idle.median);
  }

  // The longest gap is only reported, as shared CI runners stall now and
  // then.
  it('turns while a CompressionStream compresses with brotli at quality 9', async ({
    annotate,
  }) => {
    const data = text(MiB);
    const bound = await medianGapBound();
    let output: Uint8Array = new Uint8Array();
    const result = await timerTicks(async () => {
      output = await through(
        chunked(data, 64 * KiB),
        new CompressionStream('brotli', { level: 9 }),
      );
    });
    await annotate(`${result.ticks} ticks, longest gap ${result.longest.toFixed(1)} ms`);
    expect(result.ticks).toBeGreaterThanOrEqual(10);
    expect(result.median).toBeLessThanOrEqual(bound);
    expect(decompressSync(output, { format: 'brotli' })).toStrictEqual(data);
  });

  it('turns while a DecompressionStream detects and decompresses brotli data', async ({
    annotate,
  }) => {
    // Brotli decompresses about 10 times as fast as it compresses at
    // quality 9, so the release build needs this much data for the timer to
    // tick 10 times. Quality 1 keeps the compression of the data quick in
    // the debug build.
    const data = text(32 * MiB);
    const compressed = compressSync(data, { format: 'brotli', level: 1 });
    const bound = await medianGapBound();
    let output: Uint8Array = new Uint8Array();
    const options: DecompressionStreamOptions = { maxOutputSize: 64 * MiB };
    const result = await timerTicks(async () => {
      output = await through(
        chunked(compressed, 64 * KiB),
        new DecompressionStream('auto', options),
      );
    });
    await annotate(`${result.ticks} ticks, longest gap ${result.longest.toFixed(1)} ms`);
    expect(result.ticks).toBeGreaterThanOrEqual(10);
    expect(result.median).toBeLessThanOrEqual(bound);
    expect(output).toStrictEqual(data);
  });
});
