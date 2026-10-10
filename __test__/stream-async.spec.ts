import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { Readable, type Transform, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BrotliCompressContext,
  BrotliCompressDictContext,
  BrotliDecompressContext,
  BrotliDecompressDictContext,
  brotliCompress,
  brotliCompressWithDict,
  brotliDecompress,
  DeflateCompressContext,
  DeflateDecompressContext,
  deflateCompress,
  GzipCompressContext,
  GzipDecompressContext,
  gzipCompress,
  Lz4CompressContext,
  Lz4DecompressContext,
  lz4Compress,
  ZstdCompressContext,
  ZstdCompressDictContext,
  ZstdDecompressContext,
  ZstdDecompressDictContext,
  zstdCompress,
  zstdCompressWithDict,
} from '../index.js';
import {
  createBrotliCompressDictTransform,
  createBrotliCompressTransform,
  createBrotliDecompressDictTransform,
  createBrotliDecompressTransform,
  createDecompressTransform,
  createDeflateCompressTransform,
  createDeflateDecompressTransform,
  createGzipCompressTransform,
  createGzipDecompressTransform,
  createLz4CompressTransform,
  createLz4DecompressTransform,
  createZstdCompressDictTransform,
  createZstdCompressTransform,
  createZstdDecompressDictTransform,
  createZstdDecompressTransform,
} from '../node.js';
import {
  type AsyncCapableContext,
  BROTLI_DICT_REACH,
  blockBytes,
  ChunkScheduler,
  type CodecOp,
  msPerBytePrior,
  zstdSetupMs,
} from '../stream-schedule.js';
import {
  createBrotliCompressDictStream,
  createBrotliCompressStream,
  createBrotliDecompressDictStream,
  createBrotliDecompressStream,
  createDecompressStream,
  createDeflateCompressStream,
  createDeflateDecompressStream,
  createGzipCompressStream,
  createGzipDecompressStream,
  createLz4CompressStream,
  createLz4DecompressStream,
  createZstdCompressDictStream,
  createZstdCompressStream,
  createZstdDecompressDictStream,
  createZstdDecompressStream,
} from '../streams.js';
import { describeTicks, eventLoopTicks } from './event-loop.js';

// The asynchronous methods of the stream contexts, and the stream helpers,
// which call them for expensive chunks so that the event loop keeps turning
// (#554). Local runs use the debug build, in which brotli is about ten times
// slower than in the release build, so the inputs are sized for it, and the
// tests that compress megabytes get explicit timeouts.

const ROOT = resolve(__dirname, '..');
const KiB = 1024;
const MiB = 1024 * KiB;

/** Timeout of the tests that compress or decompress megabytes. */
const CODEC_TIMEOUT = 60_000;

// How long a Node.js process that a test starts may run. Vitest fails a test
// that outlasts its own timeout (5 s by default) even while it waits in
// execFileSync, so such a test gets twice this.
const PROCESS_TIMEOUT = 30_000;

/**
 * `size` bytes of text that compresses about as well as prose: words from a
 * vocabulary of 4,096, picked by a fixed pseudo-random sequence.
 */
function text(size: number): Buffer {
  const words = ['comprs', 'zstd', 'gzip', 'deflate', 'brotli', 'lz4', 'stream', 'chunk'];
  const data = Buffer.alloc(size);
  let seed = 1;
  let offset = 0;
  while (offset < size) {
    // The high bits of a linear congruential generator are the random ones.
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
    offset += data.write(`${words[seed >>> 29]}${(seed >>> 13) % 512} `, offset);
  }
  return data;
}

/** `data` in chunks of `size` bytes. */
function chunked(data: Uint8Array, size: number): Uint8Array[] {
  const chunks: Uint8Array[] = [];
  for (let offset = 0; offset < data.byteLength; offset += size) {
    chunks.push(data.subarray(offset, offset + size));
  }
  return chunks;
}

/** The message of what `fn` throws. */
function thrownMessage(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return undefined;
}

/** The message of what `promise` rejects with. */
async function rejectionMessage(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return undefined;
}

const dict = Buffer.from('a dictionary for the asynchronous stream contexts '.repeat(40));

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// ChunkScheduler
// ---------------------------------------------------------------------------

/**
 * The time that performance.now() returns in the tests of ChunkScheduler,
 * which only FakeContext advances.
 */
let clock = 0;

/**
 * A stream context whose synchronous transform() takes `syncMs`
 * milliseconds by the clock, and whose transformAsync() takes `asyncMs`,
 * whose methods return their input or nothing, and which records the
 * methods called.
 */
class FakeContext implements AsyncCapableContext {
  readonly calls: string[] = [];
  syncMs: number;
  asyncMs = 0;

  constructor(syncMs = 0) {
    this.syncMs = syncMs;
    vi.spyOn(performance, 'now').mockImplementation(() => clock);
  }

  transform(chunk: Uint8Array): Uint8Array {
    this.calls.push('transform');
    clock += this.syncMs;
    return chunk;
  }

  transformAsync(chunk: Uint8Array): Promise<Uint8Array> {
    this.calls.push('transformAsync');
    clock += this.asyncMs;
    return Promise.resolve(chunk);
  }

  flush(): Uint8Array {
    this.calls.push('flush');
    return new Uint8Array(0);
  }

  flushAsync(): Promise<Uint8Array> {
    this.calls.push('flushAsync');
    return Promise.resolve(new Uint8Array(0));
  }

  finish(): Uint8Array {
    this.calls.push('finish');
    return new Uint8Array(0);
  }

  finishAsync(): Promise<Uint8Array> {
    this.calls.push('finishAsync');
    return Promise.resolve(new Uint8Array(0));
  }
}

/** A Promise that resolves once the event loop has turned. */
function turn(): Promise<void> {
  return new Promise((done) => setImmediate(done));
}

describe('ChunkScheduler', () => {
  // The schedulers share the budget of synchronous work until the event
  // loop turns.
  afterEach(turn);

  it('calls a context synchronously for cheap chunks', () => {
    const ctx = new FakeContext();
    const scheduler = new ChunkScheduler(ctx, 1e-6);
    const chunk = new Uint8Array(64 * KiB);
    expect(scheduler.transform(chunk)).toBe(chunk);
    expect(scheduler.flush()).toBeInstanceOf(Uint8Array);
    expect(scheduler.finish()).toBeInstanceOf(Uint8Array);
    expect(ctx.calls).toStrictEqual(['transform', 'flush', 'finish']);
  });

  it('sends a chunk predicted to take 2 ms to the thread pool, and then the end', async () => {
    const ctx = new FakeContext();
    // 2 ms for 64 KiB.
    const scheduler = new ChunkScheduler(ctx, 2 / (64 * KiB));
    const small = new Uint8Array(64 * KiB - 1);
    expect(scheduler.transform(small)).toBe(small);
    const chunk = new Uint8Array(64 * KiB);
    const result = scheduler.transform(chunk);
    expect(result).toBeInstanceOf(Promise);
    expect(await result).toBe(chunk);
    // Once the stream went to the pool, its end does too.
    expect(scheduler.flush()).toBeInstanceOf(Promise);
    expect(scheduler.finish()).toBeInstanceOf(Promise);
    expect(ctx.calls).toStrictEqual(['transform', 'transformAsync', 'flushAsync', 'finishAsync']);
  });

  it('learns from slow synchronous calls on chunks of 4 KiB or more', async () => {
    // The prior predicts 0.004 ms for 4 KiB, but the call takes 3 ms.
    const ctx = new FakeContext(3);
    const scheduler = new ChunkScheduler(ctx, 1e-6);
    await scheduler.transform(new Uint8Array(4 * KiB));
    await scheduler.transform(new Uint8Array(4 * KiB));
    expect(ctx.calls).toStrictEqual(['transform', 'transformAsync']);
  });

  it('does not learn from smaller chunks, whose time is mostly that of the call', async () => {
    const ctx = new FakeContext(3);
    const scheduler = new ChunkScheduler(ctx, 1e-6);
    for (let i = 0; i < 3; i++) {
      await scheduler.transform(new Uint8Array(4 * KiB - 1));
      await turn();
    }
    expect(ctx.calls).toStrictEqual(['transform', 'transform', 'transform']);
  });

  it('comes back from the thread pool once calls there show that they are cheap', async () => {
    // A first call that took 3 ms, as one that allocates the state of the
    // codec can, sends the stream to the pool, where calls take 0.1 ms.
    const ctx = new FakeContext(3);
    ctx.asyncMs = 0.1;
    const scheduler = new ChunkScheduler(ctx, 1e-6);
    const chunk = new Uint8Array(4 * KiB);
    await scheduler.transform(chunk);
    ctx.syncMs = 0;
    for (let i = 0; i < 3; i++) await scheduler.transform(chunk);
    // The moving average: 3, then 2.275 and 1.73 ms for 4 KiB.
    expect(ctx.calls).toStrictEqual(['transform', 'transformAsync', 'transformAsync', 'transform']);
  });

  it('waits for the event loop to turn once synchronous calls have taken 4 ms', async () => {
    let turned = false;
    setImmediate(() => {
      turned = true;
    });
    const ctx = new FakeContext(1.5);
    const scheduler = new ChunkScheduler(ctx, 1e-6);
    const chunk = new Uint8Array(KiB);
    for (let i = 0; i < 3; i++) expect(scheduler.transform(chunk)).toBe(chunk);
    // 4.5 ms in all: the next call waits.
    const result = scheduler.transform(chunk);
    expect(result).toBeInstanceOf(Promise);
    expect(ctx.calls).toHaveLength(3);
    expect(await result).toBe(chunk);
    expect(turned).toBe(true);
    // The budget starts again.
    expect(scheduler.transform(chunk)).toBe(chunk);
    expect(ctx.calls).toHaveLength(5);
  });

  it('shares the budget among schedulers, which then take turns', async () => {
    const chunk = new Uint8Array(KiB);
    const contexts = [new FakeContext(4), new FakeContext(4), new FakeContext(4)];
    const order: number[] = [];
    // Each stream makes three calls, one after the other.
    const streams = contexts.map(async (ctx, index) => {
      const scheduler = new ChunkScheduler(ctx, 1e-6);
      for (let i = 0; i < 3; i++) {
        await scheduler.transform(chunk);
        order.push(index);
      }
    });
    await Promise.all(streams);
    // The first call spent the budget of the first turn, so the other
    // streams waited, and then one call ran per turn, in turn.
    expect(order).toStrictEqual([0, 1, 2, 0, 1, 2, 0, 1, 2]);
  });

  it('makes flush() and finish() wait for the event loop too', async () => {
    const ctx = new FakeContext(4);
    const scheduler = new ChunkScheduler(ctx, 1e-6);
    const chunk = new Uint8Array(KiB);
    expect(scheduler.transform(chunk)).toBe(chunk);
    const flushed = scheduler.flush();
    expect(flushed).toBeInstanceOf(Promise);
    expect(await flushed).toBeInstanceOf(Uint8Array);
    expect(scheduler.transform(chunk)).toBe(chunk);
    const finished = scheduler.finish();
    expect(finished).toBeInstanceOf(Promise);
    expect(await finished).toBeInstanceOf(Uint8Array);
    expect(ctx.calls).toStrictEqual(['transform', 'flush', 'transform', 'finish']);
  });

  it('sends flush() to the thread pool when the input since the last one predicts 2 ms', async () => {
    const ctx = new FakeContext();
    // 1 ms for 64 KiB.
    const scheduler = new ChunkScheduler(ctx, 1 / (64 * KiB));
    const chunk = new Uint8Array(64 * KiB);
    expect(scheduler.transform(chunk)).toBe(chunk);
    expect(scheduler.flush()).toBeInstanceOf(Uint8Array);
    expect(scheduler.transform(chunk)).toBe(chunk);
    expect(scheduler.transform(chunk)).toBe(chunk);
    expect(scheduler.flush()).toBeInstanceOf(Promise);
    await scheduler.finish();
    expect(ctx.calls).toStrictEqual([
      'transform',
      'flush',
      'transform',
      'transform',
      'flushAsync',
      'finishAsync',
    ]);
  });
});

describe('ChunkScheduler of a context that holds the start of its input', () => {
  afterEach(turn);

  it('predicts the call that passes what the context holds from all of that input', async () => {
    const ctx = new FakeContext();
    // 0.75 ms for 64 KiB, and the context holds 192 KiB.
    const scheduler = new ChunkScheduler(ctx, 0.75 / (64 * KiB), { holds: 3 * 64 * KiB });
    const chunk = new Uint8Array(64 * KiB);
    for (let i = 0; i < 3; i++) expect(scheduler.transform(chunk)).toBe(chunk);
    // This call processes 256 KiB: 3 ms.
    const result = scheduler.transform(chunk);
    expect(result).toBeInstanceOf(Promise);
    expect(await result).toBe(chunk);
    // The calls after it process their chunk.
    expect(scheduler.transform(chunk)).toBe(chunk);
    expect(ctx.calls).toStrictEqual([
      'transform',
      'transform',
      'transform',
      'transformAsync',
      'transform',
    ]);
  });

  it('predicts flush() from the input it holds', () => {
    const ctx = new FakeContext();
    const scheduler = new ChunkScheduler(ctx, 0.75 / (64 * KiB), { holds: 3 * 64 * KiB });
    const chunk = new Uint8Array(64 * KiB);
    for (let i = 0; i < 3; i++) expect(scheduler.transform(chunk)).toBe(chunk);
    expect(scheduler.flush()).toBeInstanceOf(Promise);
  });
});

describe('ChunkScheduler of a codec that compresses in blocks', () => {
  afterEach(turn);

  // 0.25 ms for a chunk of 16 KiB, and 2 ms for a block of 128 KiB.
  const msPerByte = 2 / (128 * KiB);
  const block = 128 * KiB;
  const chunk = new Uint8Array(16 * KiB);

  /** `count` synchronous transform() calls. */
  const inline = (count: number): string[] => Array<string>(count).fill('transform');

  it('sends the chunk that completes a block to the thread pool', async () => {
    const ctx = new FakeContext();
    const scheduler = new ChunkScheduler(ctx, msPerByte, { block });
    for (let i = 0; i < 16; i++) await scheduler.transform(chunk);
    expect(ctx.calls).toStrictEqual([
      ...inline(7),
      'transformAsync',
      ...inline(7),
      'transformAsync',
    ]);
  });

  it('starts the blocks again after flush()', async () => {
    const ctx = new FakeContext();
    const scheduler = new ChunkScheduler(ctx, msPerByte, { block });
    for (let i = 0; i < 4; i++) await scheduler.transform(chunk);
    await scheduler.flush();
    for (let i = 0; i < 8; i++) await scheduler.transform(chunk);
    expect(ctx.calls).toStrictEqual([...inline(4), 'flush', ...inline(7), 'transformAsync']);
  });

  it('starts the blocks after the input that the context holds', async () => {
    const ctx = new FakeContext();
    const scheduler = new ChunkScheduler(ctx, msPerByte, { block, holds: 64 * KiB });
    // The fifth call processes the 80 KiB so far, in 1.25 ms, and the
    // first block takes the last 16 KiB of them.
    for (let i = 0; i < 12; i++) await scheduler.transform(chunk);
    expect(ctx.calls).toStrictEqual([...inline(11), 'transformAsync']);
  });
});

describe('ChunkScheduler of a codec that sets itself up in the first call', () => {
  afterEach(turn);

  it('predicts the first call from that time too, and learns without it', async () => {
    const ctx = new FakeContext();
    ctx.asyncMs = 3;
    const scheduler = new ChunkScheduler(ctx, 1e-6, { setupMs: 3 });
    const chunk = new Uint8Array(16 * KiB);
    for (let i = 0; i < 3; i++) await scheduler.transform(chunk);
    expect(ctx.calls).toStrictEqual(['transformAsync', 'transform', 'transform']);
  });
});

describe('zstdSetupMs()', () => {
  it('sends the first call to the thread pool from level 10 on', () => {
    for (const level of [undefined, -5, 0, 3, 9]) expect(zstdSetupMs(level)).toBe(0);
    for (let level = 10; level <= 22; level++) {
      expect(zstdSetupMs(level)).toBeGreaterThanOrEqual(2);
    }
    expect(zstdSetupMs(99)).toBe(zstdSetupMs(22));
  });
});

describe('blockBytes()', () => {
  it('gives the blocks of the zstd and brotli encoders', () => {
    for (const level of [undefined, -5, 1, 3, 19, 22]) {
      expect(blockBytes('zstd-compress', level)).toBe(128 * KiB);
    }
    expect(
      [0, 1, 2, 3, 4, 8, 9, 11].map((quality) => blockBytes('brotli-compress', quality)),
    ).toStrictEqual([0, 0, 16 * KiB, 16 * KiB, 64 * KiB, 64 * KiB, 256 * KiB, 256 * KiB]);
    expect(blockBytes('brotli-compress', undefined)).toBe(64 * KiB);
  });

  it('gives none for the codecs that compress their input as it comes', () => {
    expect(blockBytes('gzip-compress', 9)).toBe(0);
    expect(blockBytes('lz4-compress', undefined)).toBe(0);
    expect(blockBytes('zstd-decompress', undefined)).toBe(0);
    expect(blockBytes('brotli-decompress', undefined)).toBe(0);
  });

  it('sends the blocks of slow encoders to the thread pool, and of fast ones not', () => {
    const blockMs = (op: CodecOp, level: number) =>
      blockBytes(op, level) * msPerBytePrior(op, level);
    expect(blockMs('brotli-compress', 9)).toBeGreaterThanOrEqual(2);
    expect(blockMs('zstd-compress', 19)).toBeGreaterThanOrEqual(2);
    expect(blockMs('zstd-compress', 3)).toBeLessThan(2);
    expect(blockMs('brotli-compress', 3)).toBeLessThan(2);
  });
});

describe('msPerBytePrior()', () => {
  it('takes the default level without a level', () => {
    expect(msPerBytePrior('zstd-compress', undefined)).toBe(msPerBytePrior('zstd-compress', 3));
    expect(msPerBytePrior('zstd-compress', 0)).toBe(msPerBytePrior('zstd-compress', 3));
    expect(msPerBytePrior('gzip-compress', undefined)).toBe(msPerBytePrior('gzip-compress', 6));
    expect(msPerBytePrior('brotli-compress', undefined)).toBe(msPerBytePrior('brotli-compress', 6));
  });

  it('takes the nearest level for one outside its table', () => {
    expect(msPerBytePrior('zstd-compress', -5)).toBe(msPerBytePrior('zstd-compress', 1));
    expect(msPerBytePrior('zstd-compress', 99)).toBe(msPerBytePrior('zstd-compress', 22));
    expect(msPerBytePrior('brotli-compress', 12)).toBe(msPerBytePrior('brotli-compress', 11));
  });

  it('sends 64 KiB chunks of slow codecs to the thread pool, and of fast ones not', () => {
    const chunk = 64 * KiB;
    expect(chunk * msPerBytePrior('brotli-compress', 9)).toBeGreaterThanOrEqual(2);
    expect(chunk * msPerBytePrior('zstd-compress', 19)).toBeGreaterThanOrEqual(2);
    expect(chunk * msPerBytePrior('zstd-compress', 3)).toBeLessThan(2);
    expect(chunk * msPerBytePrior('gzip-compress', 6)).toBeLessThan(2);
    expect(chunk * msPerBytePrior('lz4-compress', undefined)).toBeLessThan(2);
    expect(chunk * msPerBytePrior('lz4-decompress', undefined)).toBeLessThan(2);
  });
});

/**
 * Run `run`, and return what it resolves to and the names of the methods
 * transform() and transformAsync() of `prototype` that it called, in order.
 */
async function transformCalls<T>(
  prototype: Context,
  run: () => Promise<T>,
): Promise<[T, string[]]> {
  const spies = [
    vi.spyOn(prototype, 'transform').mockName('transform'),
    vi.spyOn(prototype, 'transformAsync').mockName('transformAsync'),
  ];
  const result = await run();
  const order = spies
    .flatMap((spy) => spy.mock.invocationCallOrder.map((at) => ({ at, name: spy.getMockName() })))
    .sort((a, b) => a.at - b.at)
    .map(({ name }) => name);
  return [result, order];
}

// An incremental BrotliCompressDictContext holds the first
// BROTLI_DICT_REACH bytes of its input, and the transform() that passes them
// compresses all of them: 4 MiB, which at quality 1 takes about 45 ms in the
// release build, although a chunk of 64 KiB takes less than 1 ms.
describe('brotli compression with a dictionary', { timeout: CODEC_TIMEOUT }, () => {
  it('holds BROTLI_DICT_REACH bytes before it compresses', () => {
    const ctx = new BrotliCompressDictContext(dict, 0, { incremental: true });
    expect(ctx.transform(new Uint8Array(BROTLI_DICT_REACH)).byteLength).toBe(0);
    expect(ctx.transform(new Uint8Array(1)).byteLength).toBeGreaterThan(0);
    ctx.close();
  });

  const chunks = chunked(text(BROTLI_DICT_REACH + 64 * KiB), 64 * KiB);
  // The chunks before this one fit in what the context holds.
  const passing = Math.floor(BROTLI_DICT_REACH / (64 * KiB));

  it.each([
    ['a Web stream', () => streamOutput(createBrotliCompressDictStream(dict, 1), chunks)],
    [
      'a Node.js Transform',
      () => transformOutput(createBrotliCompressDictTransform(dict, 1), chunks),
    ],
  ])('sends the chunk that passes them to the thread pool, through %s', async (_label, run) => {
    const expected = syncOutput(
      new BrotliCompressDictContext(dict, 1, { incremental: true }),
      chunks,
    );
    const [output, order] = await transformCalls(BrotliCompressDictContext.prototype, run);
    expect(output).toStrictEqual(expected);
    expect(order.slice(0, passing + 1)).toStrictEqual([
      ...Array<string>(passing).fill('transform'),
      'transformAsync',
    ]);
  });
});

// zstd compresses blocks of 128 KiB, which at level 19 take about 100 ms in
// the release build. A chunk of 256 bytes is predicted far below 2 ms, but
// the chunk that completes a block compresses all of it, and the first one
// sets up the tables of the encoder.
describe('zstd compression in small chunks', { timeout: CODEC_TIMEOUT }, () => {
  const chunks = chunked(text(256 * KiB), 256);

  it.each([
    ['a Web stream', () => streamOutput(createZstdCompressStream(19), chunks)],
    ['a Node.js Transform', () => transformOutput(createZstdCompressTransform(19), chunks)],
  ])(
    'sends the chunks that complete a block to the thread pool, through %s',
    async (_label, run) => {
      const expected = syncOutput(new ZstdCompressContext(19), chunks);
      const [output, order] = await transformCalls(ZstdCompressContext.prototype, run);
      expect(output).toStrictEqual(expected);
      const pooled = order.flatMap((name, index) => (name === 'transformAsync' ? [index] : []));
      // The first call also sets up the encoder, which takes about 50 ms.
      expect(pooled).toStrictEqual([0, 511, 1023]);
    },
  );
});

// ---------------------------------------------------------------------------
// The event loop
// ---------------------------------------------------------------------------

// Brotli at quality 9 takes about 17 ms per 64 KiB chunk in the release
// build. Called synchronously on input from memory, a stream of such chunks
// blocked the event loop until it ended: the timer did not tick once.
describe('the event loop', { timeout: CODEC_TIMEOUT }, () => {
  const input = text(MiB);

  it('turns while a Web stream compresses with brotli at quality 9', async ({ annotate }) => {
    let output = new Uint8Array();
    const result = await eventLoopTicks(async () => {
      const stream = ReadableStream.from(chunked(input, 64 * KiB)).pipeThrough(
        createBrotliCompressStream(9),
      );
      output = new Uint8Array(await new Response(stream).arrayBuffer());
    });
    await annotate(describeTicks(result));
    expect(result.ticks).toBeGreaterThanOrEqual(10);
    expect(result.median).toBeLessThanOrEqual(result.bound);
    expect(brotliDecompress(output)).toStrictEqual(input);
  });

  it('turns while a Node.js Transform compresses with brotli at quality 9', async ({
    annotate,
  }) => {
    const chunks: Buffer[] = [];
    const result = await eventLoopTicks(() =>
      pipeline(
        Readable.from(chunked(input, 64 * KiB)),
        createBrotliCompressTransform(9),
        new Writable({
          write(chunk: Buffer, _encoding, callback): void {
            chunks.push(chunk);
            callback();
          },
        }),
      ),
    );
    await annotate(describeTicks(result));
    expect(result.ticks).toBeGreaterThanOrEqual(10);
    expect(result.median).toBeLessThanOrEqual(result.bound);
    expect(brotliDecompress(Buffer.concat(chunks))).toStrictEqual(input);
  });
});

// ---------------------------------------------------------------------------
// The output of the stream helpers
// ---------------------------------------------------------------------------

/** The methods of every stream context class. */
interface Context extends AsyncCapableContext {
  close(): void;
}

/** A pair of stream helpers, the context that they call, and their input. */
interface HelperCase {
  name: string;
  /** Creates the context as the helpers create it. */
  context: () => Context;
  stream: () => TransformStream<ArrayBufferLike | ArrayBufferView, Uint8Array>;
  transform: () => Transform;
  /** Makes the input of the helpers from `data`, which is text. */
  input: (data: Buffer) => Buffer;
}

/** The auto-detecting helpers, given the output of each format. */
const AUTO_DETECTING: HelperCase[] = (
  [
    ['zstd', zstdCompress, () => new ZstdDecompressContext()],
    ['gzip', gzipCompress, () => new GzipDecompressContext()],
    ['brotli', brotliCompress, () => new BrotliDecompressContext()],
    ['lz4', lz4Compress, () => new Lz4DecompressContext(undefined, { incremental: true })],
  ] as const
).map(([format, compress, context]) => ({
  name: `auto-detecting decompression of ${format}`,
  context,
  stream: () => createDecompressStream(),
  transform: () => createDecompressTransform(),
  input: (data) => compress(data),
}));

const HELPER_CASES: HelperCase[] = [
  {
    name: 'zstd compression',
    context: () => new ZstdCompressContext(),
    stream: () => createZstdCompressStream(),
    transform: () => createZstdCompressTransform(),
    input: (data) => data,
  },
  {
    name: 'zstd decompression',
    context: () => new ZstdDecompressContext(),
    stream: () => createZstdDecompressStream(),
    transform: () => createZstdDecompressTransform(),
    input: (data) => zstdCompress(data),
  },
  {
    name: 'zstd compression with a dictionary',
    context: () => new ZstdCompressDictContext(dict),
    stream: () => createZstdCompressDictStream(dict),
    transform: () => createZstdCompressDictTransform(dict),
    input: (data) => data,
  },
  {
    name: 'zstd decompression with a dictionary',
    context: () => new ZstdDecompressDictContext(dict),
    stream: () => createZstdDecompressDictStream(dict),
    transform: () => createZstdDecompressDictTransform(dict),
    input: (data) => zstdCompressWithDict(data, dict),
  },
  {
    name: 'gzip compression',
    context: () => new GzipCompressContext(),
    stream: () => createGzipCompressStream(),
    transform: () => createGzipCompressTransform(),
    input: (data) => data,
  },
  {
    name: 'gzip decompression',
    context: () => new GzipDecompressContext(),
    stream: () => createGzipDecompressStream(),
    transform: () => createGzipDecompressTransform(),
    input: (data) => gzipCompress(data),
  },
  {
    name: 'deflate compression',
    context: () => new DeflateCompressContext(),
    stream: () => createDeflateCompressStream(),
    transform: () => createDeflateCompressTransform(),
    input: (data) => data,
  },
  {
    name: 'deflate decompression',
    context: () => new DeflateDecompressContext(),
    stream: () => createDeflateDecompressStream(),
    transform: () => createDeflateDecompressTransform(),
    input: (data) => deflateCompress(data),
  },
  {
    name: 'brotli compression',
    context: () => new BrotliCompressContext(),
    stream: () => createBrotliCompressStream(),
    transform: () => createBrotliCompressTransform(),
    input: (data) => data,
  },
  {
    name: 'brotli decompression',
    context: () => new BrotliDecompressContext(),
    stream: () => createBrotliDecompressStream(),
    transform: () => createBrotliDecompressTransform(),
    input: (data) => brotliCompress(data),
  },
  {
    name: 'brotli compression with a dictionary',
    context: () => new BrotliCompressDictContext(dict, undefined, { incremental: true }),
    stream: () => createBrotliCompressDictStream(dict),
    transform: () => createBrotliCompressDictTransform(dict),
    input: (data) => data,
  },
  {
    name: 'brotli decompression with a dictionary',
    context: () => new BrotliDecompressDictContext(dict),
    stream: () => createBrotliDecompressDictStream(dict),
    transform: () => createBrotliDecompressDictTransform(dict),
    input: (data) => brotliCompressWithDict(data, dict),
  },
  {
    name: 'lz4 compression',
    context: () => new Lz4CompressContext(),
    stream: () => createLz4CompressStream(),
    transform: () => createLz4CompressTransform(),
    input: (data) => data,
  },
  {
    name: 'lz4 decompression',
    context: () => new Lz4DecompressContext(undefined, { incremental: true }),
    stream: () => createLz4DecompressStream(),
    transform: () => createLz4DecompressTransform(),
    input: (data) => lz4Compress(data),
  },
  ...AUTO_DETECTING,
];

/** What `ctx` returns for `chunks`, called synchronously, as in 2.0. */
function syncOutput(ctx: Context, chunks: Uint8Array[]): Buffer {
  const output = chunks.map((chunk) => ctx.transform(chunk));
  output.push(ctx.flush(), ctx.finish());
  return Buffer.concat(output);
}

async function streamOutput(
  stream: TransformStream<ArrayBufferLike | ArrayBufferView, Uint8Array>,
  chunks: Uint8Array[],
): Promise<Buffer> {
  const output = ReadableStream.from(chunks).pipeThrough(stream);
  return Buffer.from(await new Response(output).arrayBuffer());
}

async function transformOutput(transform: Transform, chunks: Uint8Array[]): Promise<Buffer> {
  const output: Buffer[] = [];
  await pipeline(
    Readable.from(chunks),
    transform,
    new Writable({
      write(chunk: Buffer, _encoding, callback): void {
        output.push(chunk);
        callback();
      },
    }),
  );
  return Buffer.concat(output);
}

// The helpers make some calls on the thread pool, as the speed of the codec
// and the size of the chunks decide, and that does not change the output.
describe.each(HELPER_CASES)('$name', ({ context, stream, transform, input }) => {
  // The input made from each length of text, made once.
  const inputs = new Map<number, Buffer>();
  const inputOf = (length: number): Buffer => {
    const made = inputs.get(length) ?? input(text(length));
    inputs.set(length, made);
    return made;
  };

  it.each([
    ['1 B', 1, 2 * KiB],
    ['16 KiB', 16 * KiB, MiB + 64 * KiB],
    ['1 MiB', MiB, MiB + 64 * KiB],
  ])(
    'gives the bytes of the synchronous calls, in chunks of %s',
    { timeout: CODEC_TIMEOUT },
    async (_label, size, length) => {
      const chunks = chunked(inputOf(length), size);
      const expected = syncOutput(context(), chunks);
      expect(await streamOutput(stream(), chunks)).toStrictEqual(expected);
      expect(await transformOutput(transform(), chunks)).toStrictEqual(expected);
    },
  );
});

// ---------------------------------------------------------------------------
// The asynchronous methods of the stream contexts
// ---------------------------------------------------------------------------

/** A stream context class, with the stream name in its errors. */
interface ContextCase {
  name: string;
  stream: string;
  create: () => Context;
  /** Input that the context accepts. */
  input: Buffer;
}

const data = text(64 * KiB);

const CONTEXT_CASES: ContextCase[] = [
  {
    name: 'ZstdCompressContext',
    stream: 'zstd stream',
    create: () => new ZstdCompressContext(),
    input: data,
  },
  {
    name: 'ZstdDecompressContext',
    stream: 'zstd stream',
    create: () => new ZstdDecompressContext(),
    input: zstdCompress(data),
  },
  {
    name: 'ZstdCompressDictContext',
    stream: 'zstd stream',
    create: () => new ZstdCompressDictContext(dict),
    input: data,
  },
  {
    name: 'ZstdDecompressDictContext',
    stream: 'zstd stream',
    create: () => new ZstdDecompressDictContext(dict),
    input: zstdCompressWithDict(data, dict),
  },
  {
    name: 'GzipCompressContext',
    stream: 'gzip stream',
    create: () => new GzipCompressContext(),
    input: data,
  },
  {
    name: 'GzipDecompressContext',
    stream: 'gzip stream',
    create: () => new GzipDecompressContext(),
    input: gzipCompress(data),
  },
  {
    name: 'DeflateCompressContext',
    stream: 'deflate stream',
    create: () => new DeflateCompressContext(),
    input: data,
  },
  {
    name: 'DeflateDecompressContext',
    stream: 'deflate stream',
    create: () => new DeflateDecompressContext(),
    input: deflateCompress(data),
  },
  {
    name: 'BrotliCompressContext',
    stream: 'brotli stream',
    create: () => new BrotliCompressContext(),
    input: data,
  },
  {
    name: 'BrotliDecompressContext',
    stream: 'brotli stream',
    create: () => new BrotliDecompressContext(),
    input: brotliCompress(data),
  },
  {
    name: 'BrotliCompressDictContext',
    stream: 'brotli dict stream',
    create: () => new BrotliCompressDictContext(dict),
    input: data,
  },
  {
    name: 'BrotliDecompressDictContext',
    stream: 'brotli dict stream',
    create: () => new BrotliDecompressDictContext(dict),
    input: brotliCompressWithDict(data, dict),
  },
  {
    name: 'Lz4CompressContext',
    stream: 'lz4 stream',
    create: () => new Lz4CompressContext(),
    input: data,
  },
  {
    name: 'Lz4DecompressContext',
    stream: 'lz4 stream',
    create: () => new Lz4DecompressContext(),
    input: lz4Compress(data),
  },
];

describe.each(CONTEXT_CASES)('$name', ({ stream, create, input }) => {
  const busy = `${stream} is busy: an asynchronous call has not finished`;
  const closed = `${stream} already closed`;
  const finished = `${stream} already finished`;

  it('resolves to what the synchronous methods return', async () => {
    const ctx = create();
    const output = [
      await ctx.transformAsync(input),
      await ctx.flushAsync(),
      await ctx.finishAsync(),
    ];
    expect(Buffer.concat(output)).toStrictEqual(syncOutput(create(), [input]));
  });

  it('fails every other call while one is in flight', async () => {
    const ctx = create();
    const pending = ctx.transformAsync(input);
    expect(thrownMessage(() => ctx.transform(input))).toBe(busy);
    expect(thrownMessage(() => ctx.flush())).toBe(busy);
    expect(thrownMessage(() => ctx.finish())).toBe(busy);
    const overlapping = [ctx.transformAsync(input), ctx.flushAsync(), ctx.finishAsync()];
    expect(await Promise.all(overlapping.map(rejectionMessage))).toStrictEqual([busy, busy, busy]);
    // The refused calls left the stream as it was.
    const output = [await pending, await ctx.flushAsync(), await ctx.finishAsync()];
    expect(Buffer.concat(output)).toStrictEqual(syncOutput(create(), [input]));
  });

  it('closes once the call in flight settles, and fails later calls as closed', async () => {
    const ctx = create();
    const pending = ctx.transformAsync(input);
    ctx.close();
    expect(thrownMessage(() => ctx.transform(input))).toBe(closed);
    expect(await rejectionMessage(ctx.transformAsync(input))).toBe(closed);
    await expect(pending).resolves.toBeInstanceOf(Uint8Array);
    expect(thrownMessage(() => ctx.flush())).toBe(closed);
    expect(thrownMessage(() => ctx.finish())).toBe(closed);
    expect(await rejectionMessage(ctx.flushAsync())).toBe(closed);
    expect(await rejectionMessage(ctx.finishAsync())).toBe(closed);
    expect(() => ctx.close()).not.toThrow();
  });

  it('ends the stream with finishAsync()', async () => {
    const ctx = create();
    await ctx.transformAsync(input);
    await ctx.finishAsync();
    expect(thrownMessage(() => ctx.transform(input))).toBe(finished);
    expect(await rejectionMessage(ctx.transformAsync(input))).toBe(finished);
    expect(await rejectionMessage(ctx.finishAsync())).toBe(finished);
  });

  it('rejects a chunk that is not a byte array instead of throwing', async () => {
    const ctx = create();
    let promise: unknown;
    expect(() => {
      promise = Reflect.apply(ctx.transformAsync, ctx, ['not bytes']);
    }).not.toThrow();
    await expect(promise).rejects.toThrow();
  });

  it('copies the chunk before it returns', async () => {
    const ctx = create();
    const chunk = Buffer.from(input);
    const pending = ctx.transformAsync(chunk);
    chunk.fill(0);
    const output = [await pending, await ctx.flushAsync(), await ctx.finishAsync()];
    expect(Buffer.concat(output)).toStrictEqual(syncOutput(create(), [input]));
  });
});

// The call holds the state that the context shares with it, so the
// finalizer of a context leaves it to the call, which drops it when it
// settles. In a process of its own, which can collect garbage at will: zstd
// at level 19 on 200 KB runs long enough for a collection in the call.
describe('a context collected while a call is in flight', () => {
  it('settles the call', { timeout: 2 * PROCESS_TIMEOUT }, () => {
    const script = [
      "const comprs = require('./index.js');",
      "const data = Buffer.from(Array.from({ length: 40000 }, (_, i) => (i * 2654435761 >>> 13).toString(36)).join(' '));",
      'let collectedInFlight = false;',
      'let settled = false;',
      'const registry = new FinalizationRegistry(() => { collectedInFlight = !settled; });',
      '(async () => {',
      '  let ctx = new comprs.ZstdCompressContext(19);',
      '  registry.register(ctx, 0);',
      '  const pending = ctx.transformAsync(data).finally(() => { settled = true; });',
      '  ctx = null;',
      '  for (let i = 0; i < 20 && !collectedInFlight && !settled; i++) {',
      '    globalThis.gc();',
      '    await new Promise(setImmediate);',
      '  }',
      '  const output = await pending;',
      '  process.stdout.write(JSON.stringify({ collectedInFlight, output: output.length }));',
      '})();',
    ].join('\n');
    const result: unknown = JSON.parse(
      execFileSync(process.execPath, ['--expose-gc', '-e', script], {
        cwd: ROOT,
        encoding: 'utf8',
        timeout: PROCESS_TIMEOUT,
      }),
    );
    expect(result).toMatchObject({ collectedInFlight: true });
  });
});

// ---------------------------------------------------------------------------
// Helpers that end while a call is in flight
// ---------------------------------------------------------------------------

/** A pair of decompression helpers, and the context class that they call. */
interface FailingCase {
  name: string;
  prototype: Context;
  stream: () => TransformStream<ArrayBufferLike | ArrayBufferView, Uint8Array>;
  transform: () => Transform;
}

const FAILING_CASES: FailingCase[] = [
  {
    name: 'zstd',
    prototype: ZstdDecompressContext.prototype,
    stream: () => createZstdDecompressStream(),
    transform: () => createZstdDecompressTransform(),
  },
  {
    name: 'zstd with a dictionary',
    prototype: ZstdDecompressDictContext.prototype,
    stream: () => createZstdDecompressDictStream(dict),
    transform: () => createZstdDecompressDictTransform(dict),
  },
  {
    name: 'gzip',
    prototype: GzipDecompressContext.prototype,
    stream: () => createGzipDecompressStream(),
    transform: () => createGzipDecompressTransform(),
  },
  {
    name: 'deflate',
    prototype: DeflateDecompressContext.prototype,
    stream: () => createDeflateDecompressStream(),
    transform: () => createDeflateDecompressTransform(),
  },
  {
    name: 'brotli',
    prototype: BrotliDecompressContext.prototype,
    stream: () => createBrotliDecompressStream(),
    transform: () => createBrotliDecompressTransform(),
  },
  {
    name: 'brotli with a dictionary',
    prototype: BrotliDecompressDictContext.prototype,
    stream: () => createBrotliDecompressDictStream(dict),
    transform: () => createBrotliDecompressDictTransform(dict),
  },
  {
    name: 'lz4',
    prototype: Lz4DecompressContext.prototype,
    stream: () => createLz4DecompressStream(),
    transform: () => createLz4DecompressTransform(),
  },
  {
    name: 'auto-detected zstd',
    prototype: ZstdDecompressContext.prototype,
    stream: () => createDecompressStream(),
    transform: () => createDecompressTransform(),
  },
];

/**
 * 4 MiB that no decoder accepts, which every helper sends to the thread
 * pool. The auto-detecting helpers take it for zstd, from its magic number.
 */
const invalid = Buffer.alloc(4 * MiB, 0xa5);
invalid.set([0x28, 0xb5, 0x2f, 0xfd, 0xff]);

/**
 * Run `end`, which starts a call of `prototype.transformAsync()` that fails,
 * and ends the stream while the call is in flight. Return the rejections
 * that went unhandled once the call settled. Without a handler, which the
 * helpers attach, Node.js would crash on them by default.
 */
async function unhandledRejections(
  prototype: Context,
  end: (calls: () => number) => Promise<void> | undefined,
): Promise<unknown[]> {
  const rejections: unknown[] = [];
  const listener = (reason: unknown): void => {
    rejections.push(reason);
  };
  process.on('unhandledRejection', listener);
  try {
    const transformAsync = vi.spyOn(prototype, 'transformAsync');
    await end(() => transformAsync.mock.calls.length);
    expect(transformAsync).toHaveBeenCalledOnce();
    await Promise.allSettled(transformAsync.mock.results.map(({ value }) => value));
    // Node.js reports unhandled rejections once the microtasks have run.
    await new Promise(setImmediate);
    await new Promise(setImmediate);
  } finally {
    process.off('unhandledRejection', listener);
  }
  return rejections;
}

describe.each(FAILING_CASES)(
  '$name decompression ended while a failing call is in flight',
  ({ prototype, stream, transform }) => {
    // Without the helpers ending meanwhile, the error of the call fails the
    // stream, as the error that a synchronous call throws does.
    it('fails a Node.js Transform with the error of the call', async () => {
      const transformAsync = vi.spyOn(prototype, 'transformAsync');
      const failure = await rejectionMessage(transformOutput(transform(), [invalid]));
      expect(transformAsync).toHaveBeenCalledOnce();
      expect(failure).toBeDefined();
      expect(failure).toBe(await rejectionMessage(transformAsync.mock.results[0]?.value));
    });

    it('fails a Web stream with the error of the call', async () => {
      const transformAsync = vi.spyOn(prototype, 'transformAsync');
      const failure = await rejectionMessage(streamOutput(stream(), [invalid]));
      expect(transformAsync).toHaveBeenCalledOnce();
      expect(failure).toBeDefined();
      expect(failure).toBe(await rejectionMessage(transformAsync.mock.results[0]?.value));
    });

    it('leaves no unhandled rejection after a Node.js Transform is destroyed', async () => {
      const rejections = await unhandledRejections(prototype, () => {
        const t = transform();
        t.on('error', () => {});
        // The first write calls transform() at once.
        t.write(invalid);
        t.destroy();
        return undefined;
      });
      expect(rejections).toStrictEqual([]);
    });

    it('leaves no unhandled rejection after a Web stream is cancelled', async () => {
      const rejections = await unhandledRejections(prototype, async (calls) => {
        const { readable, writable } = stream();
        const reader = readable.getReader();
        const writer = writable.getWriter();
        reader.read().catch(() => {});
        writer.write(invalid).catch(() => {});
        // The stream calls transform() in a microtask. A call on the thread
        // pool settles only once the event loop turns, which microtasks do
        // not let it do, so the call is in flight when the stream is
        // cancelled.
        for (let i = 0; i < 100 && calls() === 0; i++) await Promise.resolve();
        await reader.cancel();
      });
      expect(rejections).toStrictEqual([]);
    });
  },
);

// A reader can cancel a Web stream while its flush() waits for a call on the
// thread pool. The stream then waits for flush() instead of calling the
// cancel() hook of the transformer, and the readable side takes no more
// chunks: the output of the call is dropped rather than fail the stream's
// close() and the reader's cancel() with an error of enqueue().
describe('a Web stream cancelled while flush() is in flight', () => {
  it('drops the rest of the output', async () => {
    const { prototype } = BrotliCompressContext;
    const { flushAsync } = prototype;
    const { readable, writable } = createBrotliCompressStream(9);
    const reader = readable.getReader();
    const writer = writable.getWriter();
    const cancels: Promise<void>[] = [];
    vi.spyOn(prototype, 'flushAsync').mockImplementation(function (this: BrotliCompressContext) {
      const pending = flushAsync.call(this);
      // The call settles only once the event loop turns.
      cancels.push(reader.cancel());
      return pending;
    });
    const reading = (async () => {
      while (!(await reader.read()).done);
    })();
    // 16 KiB at quality 9 goes to the thread pool, and so does the end.
    await writer.write(text(16 * KiB));
    await writer.close();
    await reading;
    expect(cancels).toHaveLength(1);
    await expect(cancels[0]).resolves.toBeUndefined();
  });
});
