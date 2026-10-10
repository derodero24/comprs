import { spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { resolve } from 'node:path';
import { finished } from 'node:stream/promises';
import { describe, expect, it } from 'vitest';
import {
  BrotliCompressDictContext,
  BrotliDecompressDictContext,
  brotliCompressWithDict,
  brotliCompressWithDictAsync,
  brotliDecompress,
  brotliDecompressWithDict,
  brotliDecompressWithDictAsync,
  brotliDecompressWithDictWithCapacity,
  brotliDecompressWithDictWithCapacityAsync,
  type StreamContextOptions,
} from '../index.js';
import { createBrotliCompressDictTransform } from '../node.js';
import { createBrotliCompressDictStream, createBrotliDecompressDictStream } from '../streams.js';
import {
  HAS_WASM_BUILD,
  importBrowserEntry,
  importBrowserNext,
  importBrowserStreams,
} from './load-browser-entry.js';

/** Collect all chunks from a ReadableStream into a single Buffer. */
async function collectStream(stream: ReadableStream<Uint8Array>): Promise<Buffer> {
  const chunks: Uint8Array[] = [];
  const reader = stream.getReader();
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

/** Create a ReadableStream from data, split into chunks of the given size. */
function toChunkedStream(data: Uint8Array, chunkSize: number): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (let i = 0; i < data.length; i += chunkSize) {
        controller.enqueue(data.slice(i, i + chunkSize));
      }
      controller.close();
    },
  });
}

/** Build a raw byte dictionary for brotli (no training step). */
function buildDict(): Buffer {
  return Buffer.from(
    Array.from({ length: 20 }, (_, i) =>
      JSON.stringify({
        id: i,
        name: `user_${i}`,
        email: `user${i}@example.com`,
        active: i % 2 === 0,
      }),
    ).join(''),
  );
}

/**
 * The input that an incremental context holds at most: 4 MiB less 16 bytes,
 * as far back as brotli's encoder reaches into the dictionary.
 */
const DICT_REACH = 4 * 1024 * 1024 - 16;

describe('brotli dictionary compression', () => {
  const dict = buildDict();

  it('should round-trip with dictionary', () => {
    const original = Buffer.from(
      JSON.stringify({
        id: 999,
        name: 'test_user',
        email: 'test@example.com',
        active: true,
      }),
    );
    const compressed = brotliCompressWithDict(original, dict);
    const decompressed = brotliDecompressWithDict(compressed, dict);
    expect(Buffer.compare(decompressed, original)).toBe(0);
  });

  it('should round-trip with various quality levels', () => {
    const original = Buffer.from(
      JSON.stringify({
        id: 42,
        name: 'quality_test',
        email: 'quality@test.com',
        active: true,
      }),
    );
    for (const quality of [0, 3, 6, 9, 11]) {
      const compressed = brotliCompressWithDict(original, dict, quality);
      const decompressed = brotliDecompressWithDict(compressed, dict);
      expect(Buffer.compare(decompressed, original)).toBe(0);
    }
  });

  it('should round-trip async with dictionary', async () => {
    const original = Buffer.from(
      JSON.stringify({
        id: 100,
        name: 'async_user',
        email: 'async@example.com',
        active: false,
      }),
    );
    const compressed = await brotliCompressWithDictAsync(original, dict);
    const decompressed = await brotliDecompressWithDictAsync(compressed, dict);
    expect(Buffer.compare(decompressed, original)).toBe(0);
  });
});

describe('brotliDecompressWithDictWithCapacity', () => {
  const dict = buildDict();

  it('should decompress with exact capacity', () => {
    const original = Buffer.from(
      JSON.stringify({
        id: 999,
        name: 'capacity_test',
        email: 'capacity@example.com',
        active: true,
      }),
    );
    const compressed = brotliCompressWithDict(original, dict);
    const decompressed = brotliDecompressWithDictWithCapacity(compressed, dict, original.length);
    expect(Buffer.compare(decompressed, original)).toBe(0);
  });

  it('should decompress with oversized capacity', () => {
    const original = Buffer.from(
      JSON.stringify({
        id: 888,
        name: 'oversized_test',
        email: 'oversized@example.com',
        active: false,
      }),
    );
    const compressed = brotliCompressWithDict(original, dict);
    const decompressed = brotliDecompressWithDictWithCapacity(
      compressed,
      dict,
      original.length * 10,
    );
    expect(Buffer.compare(decompressed, original)).toBe(0);
  });

  it('should throw with insufficient capacity', () => {
    const original = Buffer.from(
      JSON.stringify({
        id: 777,
        name: 'insufficient_test',
        email: 'insufficient@example.com',
        active: true,
      }),
    );
    const compressed = brotliCompressWithDict(original, dict);
    expect(() => brotliDecompressWithDictWithCapacity(compressed, dict, 1)).toThrow();
  });
});

describe('brotliDecompressWithDictWithCapacityAsync', () => {
  const dict = buildDict();

  it('should decompress async with exact capacity', async () => {
    const original = Buffer.from(
      JSON.stringify({
        id: 999,
        name: 'async_capacity_test',
        email: 'async_capacity@example.com',
        active: true,
      }),
    );
    const compressed = brotliCompressWithDict(original, dict);
    const decompressed = await brotliDecompressWithDictWithCapacityAsync(
      compressed,
      dict,
      original.length,
    );
    expect(Buffer.compare(decompressed, original)).toBe(0);
  });

  it('should decompress async with oversized capacity', async () => {
    const original = Buffer.from(
      JSON.stringify({
        id: 888,
        name: 'async_oversized_test',
        email: 'async_oversized@example.com',
        active: false,
      }),
    );
    const compressed = brotliCompressWithDict(original, dict);
    const decompressed = await brotliDecompressWithDictWithCapacityAsync(
      compressed,
      dict,
      original.length * 10,
    );
    expect(Buffer.compare(decompressed, original)).toBe(0);
  });

  it('should reject with insufficient capacity', async () => {
    const original = Buffer.from(
      JSON.stringify({
        id: 777,
        name: 'async_insufficient_test',
        email: 'async_insufficient@example.com',
        active: true,
      }),
    );
    const compressed = brotliCompressWithDict(original, dict);
    await expect(brotliDecompressWithDictWithCapacityAsync(compressed, dict, 1)).rejects.toThrow();
  });
});

describe('brotli streaming dictionary compression', () => {
  const dict = buildDict();

  it('should round-trip through stream with dictionary', async () => {
    const original = Buffer.from(
      JSON.stringify({
        id: 500,
        name: 'stream_user',
        email: 'stream@example.com',
        active: true,
      }),
    );

    const stream = toChunkedStream(original, 32);
    const compressed = await collectStream(
      stream.pipeThrough(createBrotliCompressDictStream(dict)),
    );
    const decompStream = toChunkedStream(compressed, 32);
    const decompressed = await collectStream(
      decompStream.pipeThrough(createBrotliDecompressDictStream(dict)),
    );
    expect(Buffer.compare(decompressed, original)).toBe(0);
  });

  it('should handle larger data through stream with dictionary', async () => {
    const original = Buffer.from(
      Array.from({ length: 50 }, (_, i) =>
        JSON.stringify({
          id: i,
          name: `bulk_user_${i}`,
          email: `bulk${i}@example.com`,
          active: i % 2 === 0,
        }),
      ).join('\n'),
    );

    const stream = toChunkedStream(original, 256);
    const compressed = await collectStream(
      stream.pipeThrough(createBrotliCompressDictStream(dict)),
    );
    const decompStream = toChunkedStream(compressed, 64);
    const decompressed = await collectStream(
      decompStream.pipeThrough(createBrotliDecompressDictStream(dict)),
    );
    expect(Buffer.compare(decompressed, original)).toBe(0);
  });

  it('should interop: one-shot compress -> stream decompress', async () => {
    const original = Buffer.from(
      JSON.stringify({
        id: 123,
        name: 'interop_user',
        email: 'interop@example.com',
        active: false,
      }),
    );

    const compressed = brotliCompressWithDict(original, dict);
    const decompStream = toChunkedStream(compressed, 16);
    const decompressed = await collectStream(
      decompStream.pipeThrough(createBrotliDecompressDictStream(dict)),
    );
    expect(Buffer.compare(decompressed, original)).toBe(0);
  });

  it('should interop: stream compress -> one-shot decompress', async () => {
    const original = Buffer.from(
      JSON.stringify({
        id: 456,
        name: 'interop_user_2',
        email: 'interop2@example.com',
        active: true,
      }),
    );

    const stream = toChunkedStream(original, 32);
    const compressed = await collectStream(
      stream.pipeThrough(createBrotliCompressDictStream(dict)),
    );
    const decompressed = brotliDecompressWithDict(compressed, dict);
    expect(Buffer.compare(decompressed, original)).toBe(0);
  });

  it('should accept quality parameter with dictionary', async () => {
    const original = Buffer.from(
      JSON.stringify({
        id: 789,
        name: 'quality_test',
        email: 'quality@example.com',
        active: true,
      }),
    );

    const stream = toChunkedStream(original, 32);
    const compressed = await collectStream(
      stream.pipeThrough(createBrotliCompressDictStream(dict, 9)),
    );
    const decompStream = toChunkedStream(compressed, 32);
    const decompressed = await collectStream(
      decompStream.pipeThrough(createBrotliDecompressDictStream(dict)),
    );
    expect(Buffer.compare(decompressed, original)).toBe(0);
  });
});

describe('brotli dict compress context finish guard', () => {
  const dict = buildDict();

  it('should throw when calling transform() after finish() on BrotliCompressDictContext', () => {
    const ctx = new BrotliCompressDictContext(dict);
    ctx.transform(Buffer.from('hello'));
    ctx.finish();
    expect(() => ctx.transform(Buffer.from('more data'))).toThrow(/already finished/);
  });

  it('should throw when calling finish() twice on BrotliCompressDictContext', () => {
    const ctx = new BrotliCompressDictContext(dict);
    ctx.transform(Buffer.from('hello'));
    ctx.finish();
    expect(() => ctx.finish()).toThrow(/already finished/);
  });

  it('should throw when calling flush() after finish() on BrotliCompressDictContext', () => {
    const ctx = new BrotliCompressDictContext(dict);
    ctx.transform(Buffer.from('hello'));
    ctx.finish();
    expect(() => ctx.flush()).toThrow(/already finished/);
  });
});

describe('brotli dictionary encoder defects (#623)', () => {
  // brotli 9.0.0 panics on this input at qualities 2-9, which aborted the
  // process, and encodes the second one at qualities 10 and 11 into a stream
  // that does not decode with the dictionary.
  const panicking = {
    data: Buffer.from([255, 164, 251, 255, 255, 240, 7, 0, 0, 0, 0, 0, 0, 0, 0, 41, 103, 0, 14]),
    dict: Buffer.from([254, 255]),
  };
  const spanning = { data: Buffer.from([2, 2, 3, 1, 2, 2, 3]), dict: Buffer.from([1, 0, 1, 1]) };

  it('should round-trip at every quality', () => {
    for (const { data, dict } of [panicking, spanning]) {
      for (let quality = 0; quality <= 11; quality++) {
        const compressed = brotliCompressWithDict(data, dict, quality);
        expect(brotliDecompressWithDict(compressed, dict), `quality ${quality}`).toEqual(data);
      }
    }
  });

  it('should round-trip through the async function and the context', async () => {
    const { data, dict } = panicking;
    const compressed = await brotliCompressWithDictAsync(data, dict);
    expect(brotliDecompressWithDict(compressed, dict)).toEqual(data);

    const ctx = new BrotliCompressDictContext(dict);
    const output = Buffer.concat([ctx.transform(data), ctx.finish()]);
    expect(brotliDecompressWithDict(output, dict)).toEqual(data);
  });

  // How long the process of the next test may run. Vitest fails a test that
  // outlasts its own timeout (5 s by default) even while it waits in
  // spawnSync, so the test gets twice this.
  const PROCESS_TIMEOUT = 30_000;

  // comprs catches the encoder's panic and compresses again, but the panic
  // hook runs first, and Rust's default hook prints the panic to stderr
  // (#650). The calls run in a Node.js process of their own, whose stderr
  // the test reads.
  it('should keep the panics it recovers from off stderr', {
    timeout: 2 * PROCESS_TIMEOUT,
  }, () => {
    const { data, dict } = panicking;
    const addon = JSON.stringify(resolve(__dirname, '../index.js'));
    const script = `
      const comprs = require(${addon});
      const data = Buffer.from(${JSON.stringify([...data])});
      const dict = Buffer.from(${JSON.stringify([...dict])});
      (async () => {
        const ctx = new comprs.BrotliCompressDictContext(dict, 5);
        const outputs = [
          comprs.brotliCompressWithDict(data, dict, 5),
          await comprs.brotliCompressWithDictAsync(data, dict, 5),
          Buffer.concat([ctx.transform(data), ctx.finish()]),
        ];
        for (const output of outputs) console.log(output.toString('base64'));
      })();
    `;
    const child = spawnSync(process.execPath, ['-e', script], {
      encoding: 'utf8',
      timeout: PROCESS_TIMEOUT,
    });
    expect(child.stderr).toBe('');
    expect(child.status).toBe(0);
    const outputs = child.stdout.trim().split('\n');
    expect(outputs).toHaveLength(3);
    for (const output of outputs) {
      expect(brotliDecompressWithDict(Buffer.from(output, 'base64'), dict)).toEqual(data);
    }
  });

  // Followed by text, the first input makes brotli 9.0.0 fail at qualities
  // 5-11, and comprs compresses it again without the dictionary. The text
  // uses words of brotli's built-in dictionary, which that stream must not
  // refer to: a decoder given the custom dictionary reads them as copies
  // from it (#642).
  const text =
    'The quick brown fox jumps over the lazy dog. However, the government and the people ' +
    'of the world have been working together in order to provide information about ' +
    'something important. ';
  const withText = Buffer.concat([panicking.data, Buffer.from(text.repeat(20))]);

  it.each([5, 9, 11])('should keep the fallback decodable at quality %i', (quality) => {
    const { dict } = panicking;
    const compressed = brotliCompressWithDict(withText, dict, quality);
    expect(brotliDecompressWithDict(compressed, dict)).toEqual(withText);

    const ctx = new BrotliCompressDictContext(dict, quality);
    const output = Buffer.concat([ctx.transform(withText), ctx.finish()]);
    expect(brotliDecompressWithDict(output, dict)).toEqual(withText);
  });
});

describe('brotli dictionary compression of inputs over 8 MiB (#703)', () => {
  // brotli 9.0.0's encoder panics with a dictionary on this input at quality
  // 2 (ring_buffer_input(4) in crates/core-lib/src/brotli_stream.rs), where
  // the input wraps around its ring buffer of 8 MiB: the WebAssembly build,
  // which cannot catch the panic, threw `RuntimeError: unreachable`.
  // comprs compresses inputs over 8 MiB without dictionaries instead, in
  // both builds.
  const dict = Buffer.from('a dictionary of a few words');
  const input = ringBufferInput();

  /** The calls that compress `input` with `dict` in one go, of `api`. */
  function calls(api: DictApi): [string, () => Uint8Array | Promise<Uint8Array>][] {
    return [
      ['brotliCompressWithDict()', () => api.brotliCompressWithDict(input, dict, 2)],
      ['brotliCompressWithDictAsync()', () => api.brotliCompressWithDictAsync(input, dict, 2)],
      [
        'BrotliCompressDictContext',
        () => {
          const ctx = new api.BrotliCompressDictContext(dict, 2);
          return Buffer.concat([ctx.transform(input), ctx.finish()]);
        },
      ],
    ];
  }

  /** Check what each call of `api` compresses `input` to. */
  async function check(api: DictApi): Promise<void> {
    const outputs: Uint8Array[] = [];
    for (const [label, call] of calls(api)) {
      const output = await call();
      expect(brotliDecompressWithDict(output, dict).equals(input), label).toBe(true);
      // The output does not refer to either dictionary.
      expect(brotliDecompress(output).equals(input), label).toBe(true);
      outputs.push(output);
    }
    for (const output of outputs.slice(1)) {
      expect(Buffer.from(output).equals(Buffer.from(outputs[0] ?? []))).toBe(true);
    }
  }

  it('should compress them without the dictionary in the native addon', { timeout: 60_000 }, () =>
    check({ BrotliCompressDictContext, brotliCompressWithDict, brotliCompressWithDictAsync }),
  );

  it.skipIf(!HAS_WASM_BUILD)(
    'should compress them in the WebAssembly build as in the native addon',
    { timeout: 60_000 },
    async () => {
      const wasm = await importBrowserEntry();
      await check(wasm);
      expect(Buffer.from(wasm.brotliCompressWithDict(input, dict, 2))).toEqual(
        brotliCompressWithDict(input, dict, 2),
      );
    },
  );

  it('should compress them in compress() of ./next with a brotli Dictionary', {
    timeout: 60_000,
  }, async () => {
    const expected = brotliCompressWithDict(input, dict, 2);
    const native = await import('../next/index.js');
    using prepared = native.Dictionary.from(dict, { format: 'brotli' });
    const output = native.compressSync(input, { format: 'brotli', level: 2, dictionary: prepared });
    expect(Buffer.from(output).equals(expected)).toBe(true);
    if (HAS_WASM_BUILD) {
      const wasm = await importBrowserNext();
      using wasmPrepared = wasm.Dictionary.from(dict, { format: 'brotli' });
      const wasmOutput = wasm.compressSync(input, {
        format: 'brotli',
        level: 2,
        dictionary: wasmPrepared,
      });
      expect(Buffer.from(wasmOutput).equals(expected)).toBe(true);
    }
  });
});

/** The dictionary compression functions of either build. */
interface DictApi {
  BrotliCompressDictContext: new (
    dict: Uint8Array,
    quality?: number,
  ) => { transform(chunk: Uint8Array): Uint8Array; finish(): Uint8Array };
  brotliCompressWithDict(data: Uint8Array, dict: Uint8Array, quality?: number): Uint8Array;
  brotliCompressWithDictAsync(
    data: Uint8Array,
    dict: Uint8Array,
    quality?: number,
  ): Promise<Uint8Array>;
}

/**
 * 8 MiB and 64 KiB that repeat 1,000 bytes of xorshift noise, with two bytes
 * changed: from 8 MiB - 1 + 1,000 on, the input repeats the bytes from
 * 8 MiB - 1 on, as ring_buffer_input(4) in brotli_stream.rs builds it.
 */
function ringBufferInput(): Buffer {
  const mask = (1n << 64n) - 1n;
  let state = 0x12345679n;
  const period = new Uint8Array(1000);
  for (let i = 0; i < period.length; i++) {
    state ^= (state << 13n) & mask;
    state ^= state >> 7n;
    state ^= (state << 17n) & mask;
    period[i] = Number((state >> 32n) & 0xffn);
  }
  const MiB = 1024 * 1024;
  const input = Buffer.alloc(8 * MiB + 64 * 1024);
  for (let i = 0; i < input.length; i += period.length) {
    input.set(period.subarray(0, Math.min(period.length, input.length - i)), i);
  }
  const start = 8 * MiB - 1 + 1000;
  input[start - 1] = (input[start - 1] ?? 0) ^ 0x55;
  input[start + 4] = (input[start + 4] ?? 0) ^ 0x33;
  return input;
}

/** About `length` bytes of JSON lines, like the records of the dictionary. */
function records(length: number): Buffer {
  const lines: string[] = [];
  let size = 0;
  for (let i = 0; size < length; i++) {
    const line = `${JSON.stringify({
      id: i,
      name: `user_${(i * 7919) % 10007}`,
      email: `user${i}@example.com`,
      active: i % 2 === 0,
    })}\n`;
    lines.push(line);
    size += line.length;
  }
  return Buffer.from(lines.join('')).subarray(0, length);
}

/** `data` in chunks of `size` bytes. */
function chunks(data: Uint8Array, size: number): Uint8Array[] {
  return Array.from({ length: Math.ceil(data.length / size) }, (_, i) =>
    data.subarray(i * size, (i + 1) * size),
  );
}

/** The error that `call` throws. */
function thrown(call: () => unknown): unknown {
  try {
    call();
  } catch (error) {
    return error;
  }
  throw new Error('did not throw');
}

/** What the start of a brotli stream, which goes on, decodes to with `dict`. */
function decodeSoFar(compressed: Uint8Array, dict: Uint8Array): Buffer {
  return new BrotliDecompressDictContext(dict).transform(compressed);
}

/** A brotli dictionary compression context of either build. */
interface DictContext {
  transform(chunk: Uint8Array): Uint8Array;
  flush(): Uint8Array;
  finish(): Uint8Array;
}

/** The BrotliCompressDictContext class of either build. */
type DictContextClass = new (
  dict: Uint8Array,
  quality?: number | null,
  options?: StreamContextOptions | null,
) => DictContext;

/**
 * Compress `data` in chunks of `size` bytes, and return what each
 * transform() returned, then what finish() did.
 */
function compress(ctx: DictContext, data: Uint8Array, size: number): Uint8Array[] {
  const outputs = chunks(data, size).map((chunk) => ctx.transform(chunk));
  outputs.push(ctx.finish());
  return outputs;
}

/** The tests of the incremental mode of the BrotliCompressDictContext of `load`. */
function incrementalTests(load: () => Promise<DictContextClass>): void {
  const dict = buildDict();
  // Two chunks of 256 KiB past DICT_REACH, at a quality that uses the
  // dictionary within them.
  const quality = 2;
  const data = records(DICT_REACH + 512 * 1024);

  it('should hold the first DICT_REACH bytes, then stream', async () => {
    const Context = await load();
    const ctx = new Context(dict, quality, { incremental: true });
    const outputs = compress(ctx, data, 256 * 1024);
    // The chunks within the first DICT_REACH bytes, and the one that passes them.
    const held = Math.ceil(DICT_REACH / (256 * 1024));
    for (const output of outputs.slice(0, held - 1)) {
      expect(output.length).toBe(0);
    }
    expect(outputs[held - 1]?.length).toBeGreaterThan(0);
    const all = Buffer.concat(outputs);
    expect(all.length - (outputs.at(-1)?.length ?? 0)).toBeGreaterThan(all.length / 2);
    expect(brotliDecompressWithDict(all, Buffer.from(dict)).equals(data)).toBe(true);
    // Past DICT_REACH bytes, the stream does not use the dictionary.
    expect(brotliDecompress(all).equals(data)).toBe(true);
  });

  it('should flush all the output of the input so far once it streams', async () => {
    const Context = await load();
    const ctx = new Context(dict, quality, { incremental: true });
    const start = data.subarray(0, DICT_REACH + 1);
    const next = data.subarray(start.length, start.length + 100_000);
    const outputs = [ctx.transform(start), ctx.transform(next), ctx.flush()];
    expect(
      decodeSoFar(Buffer.concat(outputs), dict).equals(
        data.subarray(0, start.length + next.length),
      ),
    ).toBe(true);
    outputs.push(ctx.transform(data.subarray(start.length + next.length)), ctx.finish());
    expect(brotliDecompressWithDict(Buffer.concat(outputs), dict).equals(data)).toBe(true);
  });

  it('should give the output of brotliCompressWithDict() up to DICT_REACH bytes', async () => {
    const Context = await load();
    for (const input of [data.subarray(0, 0), data.subarray(0, 100_000)]) {
      const ctx = new Context(dict, quality, { incremental: true });
      const outputs = compress(ctx, input, 30_000);
      expect(outputs.slice(0, -1).every((output) => output.length === 0)).toBe(true);
      expect(Buffer.concat(outputs).equals(brotliCompressWithDict(input, dict, quality))).toBe(
        true,
      );
    }
  });

  it('should hold exactly DICT_REACH bytes, and stream from the next one', async () => {
    const Context = await load();
    const input = data.subarray(0, DICT_REACH);
    const held = new Context(dict, quality, { incremental: true });
    expect(held.transform(input).length).toBe(0);
    expect(held.flush().length).toBe(0);
    expect(Buffer.from(held.finish()).equals(brotliCompressWithDict(input, dict, quality))).toBe(
      true,
    );

    const ctx = new Context(dict, quality, { incremental: true });
    expect(ctx.transform(input).length).toBe(0);
    const outputs = [ctx.transform(data.subarray(DICT_REACH, DICT_REACH + 1)), ctx.finish()];
    expect(outputs[0]?.length).toBeGreaterThan(0);
    // One byte past DICT_REACH, the stream does not use the dictionary.
    expect(brotliDecompress(Buffer.concat(outputs)).equals(data.subarray(0, DICT_REACH + 1))).toBe(
      true,
    );
  });

  it('should keep the input until finish() without the option', async () => {
    const Context = await load();
    const ctx = new Context(dict, 0);
    for (const chunk of chunks(data, 1024 * 1024)) {
      expect(ctx.transform(chunk).length).toBe(0);
      expect(ctx.flush().length).toBe(0);
    }
    expect(Buffer.from(ctx.finish()).equals(brotliCompressWithDict(data, dict, 0))).toBe(true);
  });

  // The modes that options select, by what transform() returns for more
  // than DICT_REACH bytes, and the errors for invalid options.
  it.each<[string, unknown, boolean | string]>([
    ['undefined', undefined, false],
    ['null', null, false],
    ['{}', {}, false],
    ['{ incremental: false }', { incremental: false }, false],
    ['{ incremental: null }', { incremental: null }, false],
    ['{ incremental: true }', { incremental: true }, true],
    ['true', true, 'options must be an object'],
    ["'x'", 'x', 'options must be an object'],
    ['a function', () => ({ incremental: true }), 'options must be an object'],
    ['{ incremental: 1 }', { incremental: 1 }, 'incremental must be a boolean'],
    ["{ incremental: 'true' }", { incremental: 'true' }, 'incremental must be a boolean'],
  ])('should take options %s', async (_label, options, expected) => {
    const Context = await load();
    const create = (): DictContext => Reflect.construct(Context, [dict, 0, options]);
    if (typeof expected === 'string') {
      expect(thrown(create)).toMatchObject({ message: expected });
      return;
    }
    const zeros = new Uint8Array(DICT_REACH + 1);
    expect(create().transform(zeros).length > 0).toBe(expected);
  });

  it('should check the quality before the options', async () => {
    const Context = await load();
    expect(thrown(() => Reflect.construct(Context, [dict, 12, 'x']))).toMatchObject({
      message: 'brotli quality must be an integer between 0 and 11',
    });
  });
}

describe('BrotliCompressDictContext with { incremental: true }', () => {
  describe('in the native addon', () => {
    incrementalTests(async () => BrotliCompressDictContext);

    it('should report the code of invalid options', () => {
      const error = thrown(() => Reflect.construct(BrotliCompressDictContext, [buildDict(), 0, 1]));
      expect(error).toMatchObject({ code: 'InvalidArg', message: 'options must be an object' });
    });
  });

  describe.skipIf(!HAS_WASM_BUILD)('in the WebAssembly build', () => {
    incrementalTests(async () => (await importBrowserEntry()).BrotliCompressDictContext);
  });
});

describe('brotli dictionary compression streams', () => {
  const dict = buildDict();
  const data = records(DICT_REACH + 512 * 1024);

  /** Write `data` to `stream`, and check that it emits output before the end. */
  async function checkWebStream(stream: TransformStream<Uint8Array, Uint8Array>): Promise<void> {
    const writer = stream.writable.getWriter();
    const reader = stream.readable.getReader();
    const written = writer.write(data);
    const first = await reader.read();
    await written;
    if (first.done) throw new Error('the stream ended early');
    expect(first.value.byteLength).toBeGreaterThan(0);

    const ended = writer.close();
    const output = [first.value];
    for (let result = await reader.read(); !result.done; result = await reader.read()) {
      output.push(result.value);
    }
    await ended;
    expect(brotliDecompressWithDict(Buffer.concat(output), dict).equals(data)).toBe(true);
  }

  // They emit the output of the first DICT_REACH bytes as soon as the
  // input passes them, without waiting for the end of the input.
  it('createBrotliCompressDictStream() should emit output before the input ends', async () => {
    await checkWebStream(createBrotliCompressDictStream(dict, 2));
  });

  it.skipIf(!HAS_WASM_BUILD)(
    'createBrotliCompressDictStream() of the WebAssembly build should too',
    async () => {
      const { createBrotliCompressDictStream: create } = await importBrowserStreams();
      await checkWebStream(create(dict, 2));
    },
  );

  it('createBrotliCompressDictTransform() should push output before the input ends', async () => {
    const transform = createBrotliCompressDictTransform(dict, 2);
    const output: Buffer[] = [];
    transform.on('data', (chunk: Buffer) => output.push(chunk));
    const pushed = once(transform, 'data');
    transform.write(data);
    await pushed;
    expect(Buffer.concat(output).length).toBeGreaterThan(0);

    transform.end();
    await finished(transform);
    expect(brotliDecompressWithDict(Buffer.concat(output), dict).equals(data)).toBe(true);
  });
});
