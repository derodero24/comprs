import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  decompress,
  decompressAsync,
  ZstdCompressContext,
  ZstdCompressDictContext,
  ZstdDecompressContext,
  ZstdDecompressDictContext,
  zstdCompress,
  zstdCompressWithDict,
  zstdDecompress,
  zstdDecompressAsync,
  zstdDecompressWithCapacity,
  zstdDecompressWithCapacityAsync,
  zstdDecompressWithDict,
  zstdDecompressWithDictAsync,
  zstdDecompressWithDictWithCapacity,
  zstdDecompressWithDictWithCapacityAsync,
  zstdTrainDictionary,
  zstdTrainDictionaryAsync,
} from '../index.js';

const dict = Buffer.from('zstd dictionary content, '.repeat(20));

/** Text that compresses well but is not a single repeated byte. */
function text(length: number): Buffer {
  return Buffer.from(
    'comprs sizes zstd output from the data. '.repeat(Math.ceil(length / 40)),
  ).subarray(0, length);
}

/** Compress `data` like a streaming encoder: the frame has no content size. */
function compressWithoutContentSize(data: Buffer): Buffer {
  const ctx = new ZstdCompressContext();
  return Buffer.concat([ctx.transform(data), ctx.finish()]);
}

/** Like {@link compressWithoutContentSize}, with {@link dict}. */
function compressWithDictWithoutContentSize(data: Buffer): Buffer {
  const ctx = new ZstdCompressDictContext(dict);
  return Buffer.concat([ctx.transform(data), ctx.finish()]);
}

/** A skippable frame (RFC 8878, section 3.1.2) carrying `payload`. */
function skippableFrame(payload: Buffer): Buffer {
  const header = Buffer.alloc(8);
  header.writeUInt32LE(0x184d2a50, 0);
  header.writeUInt32LE(payload.length, 4);
  return Buffer.concat([header, payload]);
}

// How long runIsolated() lets the process run. Vitest fails a test that
// outlasts its own timeout (5 s by default) even while it waits in
// spawnSync, so the tests that call it get twice this.
const PROCESS_TIMEOUT = 60_000;

/**
 * Run `script` in a separate Node.js process, with `comprs` bound to the
 * native addon, and return the JSON it prints. Calls that used to abort the
 * process run this way, so a regression cannot take down the test worker.
 */
function runIsolated(script: string): unknown {
  const addon = JSON.stringify(resolve(__dirname, '../index.js'));
  const child = spawnSync(process.execPath, ['-e', `const comprs = require(${addon});${script}`], {
    encoding: 'utf8',
    timeout: PROCESS_TIMEOUT,
  });
  expect(child.stderr).toBe('');
  expect(child.status).toBe(0);
  return JSON.parse(child.stdout);
}

type Decompress = (input: Buffer) => Buffer;
type DecompressAsync = (input: Buffer) => Promise<Buffer>;

const syncDecompressors: [string, Decompress][] = [
  ['zstdDecompress', zstdDecompress],
  ['zstdDecompressWithCapacity', (input) => zstdDecompressWithCapacity(input, 2 ** 20)],
  ['decompress', decompress],
];

const asyncDecompressors: [string, DecompressAsync][] = [
  ['zstdDecompressAsync', zstdDecompressAsync],
  ['zstdDecompressWithCapacityAsync', (input) => zstdDecompressWithCapacityAsync(input, 2 ** 20)],
  ['decompressAsync', decompressAsync],
];

const dictDecompressors: [string, Decompress][] = [
  ['zstdDecompressWithDict', (input) => zstdDecompressWithDict(input, dict)],
  [
    'zstdDecompressWithDictWithCapacity',
    (input) => zstdDecompressWithDictWithCapacity(input, dict, 2 ** 20),
  ],
];

const dictAsyncDecompressors: [string, DecompressAsync][] = [
  ['zstdDecompressWithDictAsync', (input) => zstdDecompressWithDictAsync(input, dict)],
  [
    'zstdDecompressWithDictWithCapacityAsync',
    (input) => zstdDecompressWithDictWithCapacityAsync(input, dict, 2 ** 20),
  ],
];

describe('zstd one-shot decompression of streamed frames', () => {
  const original = text(10_000);
  const frame = compressWithoutContentSize(original);
  const dictFrame = compressWithDictWithoutContentSize(original);

  it.each(syncDecompressors)('%s should decompress a frame without a content size', (_name, fn) => {
    expect(fn(frame)).toEqual(original);
  });

  it.each(asyncDecompressors)(
    '%s should decompress a frame without a content size',
    async (_name, fn) => {
      expect(await fn(frame)).toEqual(original);
    },
  );

  it.each(dictDecompressors)('%s should decompress a frame without a content size', (_name, fn) => {
    expect(fn(dictFrame)).toEqual(original);
  });

  it.each(dictAsyncDecompressors)(
    '%s should decompress a frame without a content size',
    async (_name, fn) => {
      expect(await fn(dictFrame)).toEqual(original);
    },
  );
});

describe('zstd one-shot decompression of several frames', () => {
  const a = Buffer.alloc(4096, 'a');
  const b = Buffer.alloc(4096, 'b');
  const expected = Buffer.concat([a, b]);
  const inputs: [string, Buffer][] = [
    ['two frames with a content size', Buffer.concat([zstdCompress(a), zstdCompress(b)])],
    [
      'a frame with and one without',
      Buffer.concat([zstdCompress(a), compressWithoutContentSize(b)]),
    ],
    [
      'two frames without a content size',
      Buffer.concat([compressWithoutContentSize(a), compressWithoutContentSize(b)]),
    ],
  ];

  describe.each(inputs)('%s', (_name, input) => {
    it.each(syncDecompressors)('%s should decompress all frames', (_fn, fn) => {
      expect(fn(input)).toEqual(expected);
    });

    it.each(asyncDecompressors)('%s should decompress all frames', async (_fn, fn) => {
      expect(await fn(input)).toEqual(expected);
    });
  });

  it.each(dictDecompressors)('%s should decompress all frames', (_name, fn) => {
    const input = Buffer.concat([
      zstdCompressWithDict(a, dict),
      compressWithDictWithoutContentSize(b),
    ]);
    expect(fn(input)).toEqual(expected);
  });

  it.each(syncDecompressors.slice(0, 2))('%s should skip skippable frames', (_name, fn) => {
    const skippable = skippableFrame(Buffer.from('metadata'));
    for (const frame of [zstdCompress(a), compressWithoutContentSize(a)]) {
      expect(fn(Buffer.concat([skippable, frame]))).toEqual(a);
      expect(fn(Buffer.concat([frame, skippable]))).toEqual(a);
      expect(fn(Buffer.concat([frame, skippable, frame]))).toEqual(Buffer.concat([a, a]));
    }
  });
});

describe('zstd one-shot decompression limits', () => {
  const original = text(4096);
  const frames: [string, Buffer, Buffer][] = [
    ['with a content size', zstdCompress(original), zstdCompressWithDict(original, dict)],
    [
      'without a content size',
      compressWithoutContentSize(original),
      compressWithDictWithoutContentSize(original),
    ],
  ];

  describe.each(frames)('frame %s', (_name, frame, dictFrame) => {
    it('should accept output up to the capacity', async () => {
      expect(zstdDecompressWithCapacity(frame, original.length)).toEqual(original);
      expect(await zstdDecompressWithCapacityAsync(frame, original.length)).toEqual(original);
      expect(zstdDecompressWithDictWithCapacity(dictFrame, dict, original.length)).toEqual(
        original,
      );
    });

    it('should report output over the capacity as a size limit', async () => {
      const limit = original.length - 1;
      const message = `zstd decompress exceeded maximum size of ${limit} bytes`;
      expect(() => zstdDecompressWithCapacity(frame, limit)).toThrow(message);
      await expect(zstdDecompressWithCapacityAsync(frame, limit)).rejects.toThrow(message);

      const dictMessage = `zstd decompress with dict exceeded maximum size of ${limit} bytes`;
      expect(() => zstdDecompressWithDictWithCapacity(dictFrame, dict, limit)).toThrow(dictMessage);
      await expect(zstdDecompressWithDictWithCapacityAsync(dictFrame, dict, limit)).rejects.toThrow(
        dictMessage,
      );
    });
  });
});

describe('zstd frame windows', () => {
  // A frame without a content size whose window descriptor, 0x88, declares a
  // window of 128 MiB, then a raw block that holds "A". Its first 6 bytes are
  // the frame header, after which the decoder allocates the window.
  const frame = Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x00, 0x88, 0x09, 0x00, 0x00, 0x41]);
  const header = frame.subarray(0, 6);
  const MiB = 2 ** 20;

  const contexts: [
    string,
    (maxOutputSize?: number) => ZstdDecompressContext | ZstdDecompressDictContext,
  ][] = [
    ['ZstdDecompressContext', (maxOutputSize) => new ZstdDecompressContext(maxOutputSize)],
    [
      'ZstdDecompressDictContext',
      (maxOutputSize) => new ZstdDecompressDictContext(dict, maxOutputSize),
    ],
  ];

  it('should be decoded under the default limit', async () => {
    expect(zstdDecompress(frame).toString()).toBe('A');
    expect((await zstdDecompressAsync(frame)).toString()).toBe('A');
    expect(zstdDecompressWithCapacity(frame, 256 * MiB).toString()).toBe('A');
    expect(zstdDecompressWithDict(frame, dict).toString()).toBe('A');
    expect(decompress(frame).toString()).toBe('A');
  });

  it('should be rejected under a small capacity', async () => {
    const message = 'zstd decompress exceeded maximum size of 1024 bytes';
    expect(() => zstdDecompressWithCapacity(frame, 1024)).toThrow(message);
    await expect(zstdDecompressWithCapacityAsync(frame, 1024)).rejects.toThrow(message);
    expect(() => decompress(frame, 1024)).toThrow(message);
    await expect(decompressAsync(frame, 1024)).rejects.toThrow(message);
    expect(() => zstdDecompressWithDictWithCapacity(frame, dict, 1024)).toThrow(
      'zstd decompress with dict exceeded maximum size of 1024 bytes',
    );
  });

  it.each(contexts)('%s should decode the frame under the default limit', (_name, create) => {
    const ctx = create();
    expect(ctx.transform(header).length).toBe(0);
    expect(ctx.transform(frame.subarray(header.length)).toString()).toBe('A');
    expect(ctx.finish().length).toBe(0);
  });

  it.each(contexts)('%s should reject the header under a small maxOutputSize', (_name, create) => {
    // The decoder rejects the header before it allocates the window.
    const ctx = create(1024);
    expect(() => ctx.transform(header)).toThrow(
      'zstd stream decompress exceeded maximum size of 1024 bytes',
    );
    ctx.close();
  });
});

describe('huge capacities', { timeout: 2 * PROCESS_TIMEOUT }, () => {
  it('should not be allocated up front', () => {
    const results = runIsolated(`
      const hello = Buffer.from('hello');
      const dict = Buffer.from('zstd dictionary content, '.repeat(20));
      const ctx = new comprs.ZstdCompressContext();
      const streamed = Buffer.concat([ctx.transform(hello), ctx.finish()]);
      const withDict = comprs.zstdCompressWithDict(hello, dict);
      const huge = 2 ** 40;
      Promise.all([
        comprs.zstdDecompressWithCapacity(comprs.zstdCompress(hello), huge),
        comprs.zstdDecompressWithCapacity(streamed, huge),
        comprs.zstdDecompressWithCapacityAsync(streamed, huge),
        comprs.zstdDecompressWithDictWithCapacity(withDict, dict, huge),
        comprs.zstdDecompressWithDictWithCapacityAsync(withDict, dict, huge),
      ]).then((results) => console.log(JSON.stringify(results.map(String))));
    `);
    expect(results).toEqual(['hello', 'hello', 'hello', 'hello', 'hello']);
  });
});

describe('zstdTrainDictionary maxDictSize', () => {
  const samples = Array.from({ length: 100 }, (_, i) =>
    Buffer.from(JSON.stringify({ id: i, name: `user_${i}`, active: i % 2 === 0 })),
  );
  const message = 'maxDictSize must be an integer between 0 and 16777216';

  it('should accept up to 16 MiB', async () => {
    expect(zstdTrainDictionary(samples, 2 ** 24).length).toBeGreaterThan(0);
    expect((await zstdTrainDictionaryAsync(samples, 2 ** 24)).length).toBeGreaterThan(0);
  });

  it('should reject more than 16 MiB', async () => {
    expect(() => zstdTrainDictionary(samples, 2 ** 24 + 1)).toThrow(message);
    await expect(zstdTrainDictionaryAsync(samples, 2 ** 24 + 1)).rejects.toThrow(message);
  });

  it('should reject a huge value without allocating it', { timeout: 2 * PROCESS_TIMEOUT }, () => {
    const results = runIsolated(`
      const samples = Array.from({ length: 100 }, (_, i) => Buffer.from('sample ' + i));
      const messages = [comprs.zstdTrainDictionary, comprs.zstdTrainDictionaryAsync].map(
        async (train) => {
          try {
            await train(samples, 2 ** 40);
          } catch (e) {
            return e.message;
          }
        },
      );
      Promise.all(messages).then((results) => console.log(JSON.stringify(results)));
    `);
    expect(results).toEqual([message, message]);
  });
});
