import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  BrotliCompressContext,
  BrotliCompressDictContext,
  BrotliDecompressContext,
  BrotliDecompressDictContext,
  brotliCompress,
  brotliCompressWithDict,
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

// The asynchronous methods of the stream contexts, which run the codec on
// the libuv thread pool (#554).

const ROOT = resolve(__dirname, '..');
const KiB = 1024;

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

/** The methods of every stream context class. */
interface Context {
  transform(chunk: Uint8Array): Uint8Array;
  transformAsync(chunk: Uint8Array): Promise<Uint8Array>;
  flush(): Uint8Array;
  flushAsync(): Promise<Uint8Array>;
  finish(): Uint8Array;
  finishAsync(): Promise<Uint8Array>;
  close(): void;
}

/** What `ctx` returns for `chunks`, called synchronously, as in 2.0. */
function syncOutput(ctx: Context, chunks: Uint8Array[]): Buffer {
  const output = chunks.map((chunk) => ctx.transform(chunk));
  output.push(ctx.flush(), ctx.finish());
  return Buffer.concat(output);
}

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
