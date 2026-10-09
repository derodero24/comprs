import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  brotliCompress,
  brotliCompressAsync,
  brotliCompressWithDict,
  brotliCompressWithDictAsync,
  brotliDecompressAsync,
  brotliDecompressWithCapacityAsync,
  decompress,
  decompressAsync,
  deflateCompress,
  deflateCompressAsync,
  deflateDecompressAsync,
  deflateDecompressWithCapacityAsync,
  gzipCompress,
  gzipCompressAsync,
  gzipDecompressAsync,
  gzipDecompressWithCapacityAsync,
  lz4Compress,
  lz4CompressAsync,
  zstdCompress,
  zstdCompressAsync,
  zstdCompressWithDict,
  zstdCompressWithDictAsync,
  zstdDecompress,
  zstdDecompressAsync,
  zstdDecompressWithCapacityAsync,
  zstdDecompressWithDict,
  zstdDecompressWithDictAsync,
  zstdTrainDictionary,
  zstdTrainDictionaryAsync,
} from '../index.js';
import { JSON_DATA, RANDOM_MEDIUM } from './bench-fixtures.js';

describe('zstd async', () => {
  it('should return a Promise', () => {
    const input = Buffer.from('hello');
    const result = zstdCompressAsync(input);
    expect(result).toBeInstanceOf(Promise);
  });

  it('should round-trip a simple string', async () => {
    const input = Buffer.from('Hello, async zstd!');
    const compressed = await zstdCompressAsync(input);
    const decompressed = await zstdDecompressAsync(compressed);
    expect(decompressed).toEqual(input);
  });

  it('should round-trip empty data', async () => {
    const input = Buffer.alloc(0);
    const compressed = await zstdCompressAsync(input);
    const decompressed = await zstdDecompressAsync(compressed);
    expect(decompressed).toEqual(input);
  });

  it('should produce the same output as sync', async () => {
    const input = Buffer.from('Sync vs async comparison data. '.repeat(50));
    const syncResult = zstdCompress(input);
    const asyncResult = await zstdCompressAsync(input);
    expect(asyncResult).toEqual(syncResult);
  });

  it('should compress with a custom level', async () => {
    const input = Buffer.from('Custom level test data. '.repeat(100));
    const compressed = await zstdCompressAsync(input, 1);
    const decompressed = await zstdDecompressAsync(compressed);
    expect(decompressed).toEqual(input);
  });

  it('should reject on invalid compressed data', async () => {
    const invalid = Buffer.from('not zstd data');
    await expect(zstdDecompressAsync(invalid)).rejects.toThrow();
  });
});

describe('gzip async', () => {
  it('should return a Promise', () => {
    const input = Buffer.from('hello');
    const result = gzipCompressAsync(input);
    expect(result).toBeInstanceOf(Promise);
  });

  it('should round-trip a simple string', async () => {
    const input = Buffer.from('Hello, async gzip!');
    const compressed = await gzipCompressAsync(input);
    const decompressed = await gzipDecompressAsync(compressed);
    expect(decompressed).toEqual(input);
  });

  it('should round-trip empty data', async () => {
    const input = Buffer.alloc(0);
    const compressed = await gzipCompressAsync(input);
    const decompressed = await gzipDecompressAsync(compressed);
    expect(decompressed).toEqual(input);
  });

  it('should produce the same output as sync', async () => {
    const input = Buffer.from('Sync vs async comparison data. '.repeat(50));
    const syncResult = gzipCompress(input);
    const asyncResult = await gzipCompressAsync(input);
    expect(asyncResult).toEqual(syncResult);
  });

  it('should compress with a custom level', async () => {
    const input = Buffer.from('Custom level test data. '.repeat(100));
    const compressed = await gzipCompressAsync(input, 1);
    const decompressed = await gzipDecompressAsync(compressed);
    expect(decompressed).toEqual(input);
  });

  it('should reject on invalid level', async () => {
    const input = Buffer.from('test');
    await expect(gzipCompressAsync(input, 10)).rejects.toThrow(
      'gzip compression level must be an integer between 0 and 9',
    );
  });

  it('should reject on invalid compressed data', async () => {
    const invalid = Buffer.from('not gzip data');
    await expect(gzipDecompressAsync(invalid)).rejects.toThrow();
  });

  it('should decompress concatenated gzip streams', async () => {
    const a = gzipCompress(Buffer.from('Hello'));
    const b = gzipCompress(Buffer.from(' World'));
    const concatenated = Buffer.concat([a, b]);
    const result = await gzipDecompressAsync(concatenated);
    expect(result.toString()).toBe('Hello World');
  });
});

describe('deflate async', () => {
  it('should return a Promise', () => {
    const input = Buffer.from('hello');
    const result = deflateCompressAsync(input);
    expect(result).toBeInstanceOf(Promise);
  });

  it('should round-trip a simple string', async () => {
    const input = Buffer.from('Hello, async deflate!');
    const compressed = await deflateCompressAsync(input);
    const decompressed = await deflateDecompressAsync(compressed);
    expect(decompressed).toEqual(input);
  });

  it('should round-trip empty data', async () => {
    const input = Buffer.alloc(0);
    const compressed = await deflateCompressAsync(input);
    const decompressed = await deflateDecompressAsync(compressed);
    expect(decompressed).toEqual(input);
  });

  it('should produce the same output as sync', async () => {
    const input = Buffer.from('Sync vs async comparison data. '.repeat(50));
    const syncResult = deflateCompress(input);
    const asyncResult = await deflateCompressAsync(input);
    expect(asyncResult).toEqual(syncResult);
  });

  it('should compress with a custom level', async () => {
    const input = Buffer.from('Custom level test data. '.repeat(100));
    const compressed = await deflateCompressAsync(input, 1);
    const decompressed = await deflateDecompressAsync(compressed);
    expect(decompressed).toEqual(input);
  });

  it('should reject on invalid level', async () => {
    const input = Buffer.from('test');
    await expect(deflateCompressAsync(input, 10)).rejects.toThrow(
      'deflate compression level must be an integer between 0 and 9',
    );
  });

  it('should reject on invalid compressed data', async () => {
    const invalid = Buffer.from('not deflate data');
    await expect(deflateDecompressAsync(invalid)).rejects.toThrow();
  });
});

describe('brotli async', () => {
  it('should return a Promise', () => {
    const input = Buffer.from('hello');
    const result = brotliCompressAsync(input);
    expect(result).toBeInstanceOf(Promise);
  });

  it('should round-trip a simple string', async () => {
    const input = Buffer.from('Hello, async brotli!');
    const compressed = await brotliCompressAsync(input);
    const decompressed = await brotliDecompressAsync(compressed);
    expect(decompressed).toEqual(input);
  });

  it('should round-trip empty data', async () => {
    const input = Buffer.alloc(0);
    const compressed = await brotliCompressAsync(input);
    const decompressed = await brotliDecompressAsync(compressed);
    expect(decompressed).toEqual(input);
  });

  it('should produce the same output as sync', async () => {
    const input = Buffer.from('Sync vs async comparison data. '.repeat(50));
    const syncResult = brotliCompress(input);
    const asyncResult = await brotliCompressAsync(input);
    expect(asyncResult).toEqual(syncResult);
  });

  it('should compress with a custom quality', async () => {
    const input = Buffer.from('Custom quality test data. '.repeat(100));
    const compressed = await brotliCompressAsync(input, 1);
    const decompressed = await brotliDecompressAsync(compressed);
    expect(decompressed).toEqual(input);
  });

  it('should reject on invalid quality', async () => {
    const input = Buffer.from('test');
    await expect(brotliCompressAsync(input, 12)).rejects.toThrow(
      'brotli quality must be an integer between 0 and 11',
    );
  });

  it('should reject on invalid compressed data', async () => {
    const invalid = Buffer.from('not brotli data');
    await expect(brotliDecompressAsync(invalid)).rejects.toThrow();
  });
});

describe('async cross-algorithm', () => {
  it('should async compress and sync decompress (zstd)', async () => {
    const input = Buffer.from('Cross async/sync test');
    const compressed = await zstdCompressAsync(input);
    const decompressed = zstdDecompress(compressed);
    expect(decompressed).toEqual(input);
  });

  it('should sync compress and async decompress (gzip)', async () => {
    const input = Buffer.from('Cross sync/async test');
    const compressed = gzipCompress(input);
    const decompressed = await gzipDecompressAsync(compressed);
    expect(decompressed).toEqual(input);
  });

  it('should handle concurrent async operations', async () => {
    const input = Buffer.from('Concurrent test data. '.repeat(50));
    const [zstdResult, gzipResult, deflateResult, brotliResult] = await Promise.all([
      zstdCompressAsync(input),
      gzipCompressAsync(input),
      deflateCompressAsync(input),
      brotliCompressAsync(input),
    ]);

    const [zstdDecomp, gzipDecomp, deflateDecomp, brotliDecomp] = await Promise.all([
      zstdDecompressAsync(zstdResult),
      gzipDecompressAsync(gzipResult),
      deflateDecompressAsync(deflateResult),
      brotliDecompressAsync(brotliResult),
    ]);

    expect(zstdDecomp).toEqual(input);
    expect(gzipDecomp).toEqual(input);
    expect(deflateDecomp).toEqual(input);
    expect(brotliDecomp).toEqual(input);
  });
});

describe('decompress async (auto-detect)', () => {
  const original = Buffer.from('Hello, async auto-detect decompression!');

  it('should auto-detect and decompress zstd', async () => {
    const compressed = zstdCompress(original);
    const result = await decompressAsync(compressed);
    expect(Buffer.compare(result, original)).toBe(0);
  });

  it('should auto-detect and decompress gzip', async () => {
    const compressed = gzipCompress(original);
    const result = await decompressAsync(compressed);
    expect(Buffer.compare(result, original)).toBe(0);
  });

  it('should auto-detect and decompress brotli', async () => {
    const compressed = brotliCompress(original);
    const result = await decompressAsync(compressed);
    expect(Buffer.compare(result, original)).toBe(0);
  });

  it('should reject unknown format', async () => {
    const data = Buffer.from('not compressed');
    await expect(decompressAsync(data)).rejects.toThrow(/unable to detect compression format/);
  });

  it('should produce the same output as sync decompress', async () => {
    const compressed = zstdCompress(original);
    const syncResult = decompress(compressed);
    const asyncResult = await decompressAsync(compressed);
    expect(Buffer.compare(asyncResult, syncResult)).toBe(0);
  });
});

describe('zstdDecompressWithCapacityAsync', () => {
  it('should round-trip with capacity', async () => {
    const input = Buffer.from('Hello, async zstd with capacity!');
    const compressed = zstdCompress(input);
    const decompressed = await zstdDecompressWithCapacityAsync(compressed, 1024 * 1024);
    expect(Buffer.compare(decompressed, input)).toBe(0);
  });

  it('should reject with invalid capacity', async () => {
    const compressed = zstdCompress(Buffer.from('test'));
    await expect(zstdDecompressWithCapacityAsync(compressed, -1)).rejects.toThrow(
      'capacity must be an integer between 0 and 9007199254740991',
    );
  });
});

describe('zstdCompressWithDictAsync / zstdDecompressWithDictAsync', () => {
  const samples = Array.from({ length: 100 }, (_, i) =>
    Buffer.from(
      JSON.stringify({
        id: i,
        name: `user_${i}`,
        email: `user${i}@example.com`,
        active: i % 2 === 0,
      }),
    ),
  );

  it('should round-trip with dictionary', async () => {
    const dict = zstdTrainDictionary(samples);
    const original = Buffer.from(
      JSON.stringify({
        id: 999,
        name: 'test_user',
        email: 'test@example.com',
        active: true,
      }),
    );
    const compressed = await zstdCompressWithDictAsync(original, dict);
    const decompressed = await zstdDecompressWithDictAsync(compressed, dict);
    expect(Buffer.compare(decompressed, original)).toBe(0);
  });

  it('should interop async compress with sync decompress', async () => {
    const dict = zstdTrainDictionary(samples);
    const original = Buffer.from(
      JSON.stringify({
        id: 42,
        name: 'interop_user',
        email: 'interop@example.com',
        active: false,
      }),
    );
    const compressed = await zstdCompressWithDictAsync(original, dict);
    const decompressed = zstdDecompressWithDict(compressed, dict);
    expect(Buffer.compare(decompressed, original)).toBe(0);
  });

  it('should interop sync compress with async decompress', async () => {
    const dict = zstdTrainDictionary(samples);
    const original = Buffer.from(
      JSON.stringify({
        id: 77,
        name: 'interop_user_2',
        email: 'interop2@example.com',
        active: true,
      }),
    );
    const compressed = zstdCompressWithDict(original, dict);
    const decompressed = await zstdDecompressWithDictAsync(compressed, dict);
    expect(Buffer.compare(decompressed, original)).toBe(0);
  });
});

describe('zstdTrainDictionaryAsync', () => {
  const samples = Array.from({ length: 100 }, (_, i) =>
    Buffer.from(
      JSON.stringify({
        id: i,
        name: `user_${i}`,
        email: `user${i}@example.com`,
        active: i % 2 === 0,
      }),
    ),
  );

  it('should train a valid dictionary', async () => {
    const dict = await zstdTrainDictionaryAsync(samples);
    expect(dict.length).toBeGreaterThan(0);
  });

  it('should produce a dictionary usable for compression', async () => {
    const dict = await zstdTrainDictionaryAsync(samples);
    const original = Buffer.from(
      JSON.stringify({
        id: 123,
        name: 'async_dict_user',
        email: 'async@example.com',
        active: true,
      }),
    );
    const compressed = zstdCompressWithDict(original, dict);
    const decompressed = zstdDecompressWithDict(compressed, dict);
    expect(Buffer.compare(decompressed, original)).toBe(0);
  });
});

describe('gzipDecompressWithCapacityAsync', () => {
  it('should round-trip with capacity', async () => {
    const input = Buffer.from('Hello, async gzip with capacity!');
    const compressed = gzipCompress(input);
    const decompressed = await gzipDecompressWithCapacityAsync(compressed, 1024 * 1024);
    expect(Buffer.compare(decompressed, input)).toBe(0);
  });

  it('should reject with invalid capacity', async () => {
    const compressed = gzipCompress(Buffer.from('test'));
    await expect(gzipDecompressWithCapacityAsync(compressed, -1)).rejects.toThrow(
      'capacity must be an integer between 0 and 9007199254740991',
    );
  });
});

describe('deflateDecompressWithCapacityAsync', () => {
  it('should round-trip with capacity', async () => {
    const input = Buffer.from('Hello, async deflate with capacity!');
    const compressed = deflateCompress(input);
    const decompressed = await deflateDecompressWithCapacityAsync(compressed, 1024 * 1024);
    expect(Buffer.compare(decompressed, input)).toBe(0);
  });

  it('should reject with invalid capacity', async () => {
    const compressed = deflateCompress(Buffer.from('test'));
    await expect(deflateDecompressWithCapacityAsync(compressed, -1)).rejects.toThrow(
      'capacity must be an integer between 0 and 9007199254740991',
    );
  });
});

describe('brotliDecompressWithCapacityAsync', () => {
  it('should round-trip with capacity', async () => {
    const input = Buffer.from('Hello, async brotli with capacity!');
    const compressed = brotliCompress(input);
    const decompressed = await brotliDecompressWithCapacityAsync(compressed, 1024 * 1024);
    expect(Buffer.compare(decompressed, input)).toBe(0);
  });

  it('should reject with invalid capacity', async () => {
    const compressed = brotliCompress(Buffer.from('test'));
    await expect(brotliDecompressWithCapacityAsync(compressed, -1)).rejects.toThrow(
      'capacity must be an integer between 0 and 9007199254740991',
    );
  });
});

// The *Async functions copy their byte array arguments before they return
// and keep no reference to them (README, Async): what the caller does with an
// argument afterwards cannot change the result. A task that read the caller's
// memory on the thread pool instead would race with writes to it, and with a
// transfer of its ArrayBuffer, whose new owner may overwrite or free that
// memory: Node-API cannot pin an ArrayBuffer against detachment (#548).
describe('input ownership', () => {
  const FIXTURES: [string, Buffer][] = [
    ['JSON', JSON_DATA],
    ['pseudo-random', RANDOM_MEDIUM],
  ];

  /** A raw-content dictionary: the last 4 KiB of the JSON fixture. */
  const DICT = JSON_DATA.subarray(-4096);

  /**
   * An *Async function under test and the synchronous variant whose result
   * it must return.
   */
  interface Case {
    /** The byte array arguments made from a fixture: the data, then any dictionary. */
    args: (fixture: Buffer) => Buffer[];
    fn: (...args: Uint8Array[]) => Promise<Buffer>;
    sync: (...args: Uint8Array[]) => Buffer;
  }

  const CASES: Record<string, Case> = {
    zstdCompressAsync: {
      args: (fixture) => [fixture],
      fn: (data) => zstdCompressAsync(data),
      sync: (data) => zstdCompress(data),
    },
    gzipCompressAsync: {
      args: (fixture) => [fixture],
      fn: (data) => gzipCompressAsync(data),
      sync: (data) => gzipCompress(data),
    },
    deflateCompressAsync: {
      args: (fixture) => [fixture],
      fn: (data) => deflateCompressAsync(data),
      sync: (data) => deflateCompress(data),
    },
    brotliCompressAsync: {
      args: (fixture) => [fixture],
      fn: (data) => brotliCompressAsync(data),
      sync: (data) => brotliCompress(data),
    },
    lz4CompressAsync: {
      args: (fixture) => [fixture],
      fn: (data) => lz4CompressAsync(data),
      sync: (data) => lz4Compress(data),
    },
    zstdCompressWithDictAsync: {
      args: (fixture) => [fixture, DICT],
      fn: (data, dict) => zstdCompressWithDictAsync(data, dict),
      sync: (data, dict) => zstdCompressWithDict(data, dict),
    },
    brotliCompressWithDictAsync: {
      args: (fixture) => [fixture, DICT],
      fn: (data, dict) => brotliCompressWithDictAsync(data, dict),
      sync: (data, dict) => brotliCompressWithDict(data, dict),
    },
    zstdDecompressAsync: {
      args: (fixture) => [zstdCompress(fixture)],
      fn: (data) => zstdDecompressAsync(data),
      sync: (data) => zstdDecompress(data),
    },
    decompressAsync: {
      args: (fixture) => [zstdCompress(fixture)],
      fn: (data) => decompressAsync(data),
      sync: (data) => decompress(data),
    },
    zstdDecompressWithDictAsync: {
      args: (fixture) => [zstdCompressWithDict(fixture, DICT), DICT],
      fn: (data, dict) => zstdDecompressWithDictAsync(data, dict),
      sync: (data, dict) => zstdDecompressWithDict(data, dict),
    },
  };

  /**
   * Ways to pass an argument. Each copies the bytes into an ArrayBuffer of
   * its own, which {@link overwrite} may then overwrite as a whole.
   */
  const LAYOUTS: [string, (bytes: Uint8Array) => Uint8Array][] = [
    [
      'a Buffer',
      (bytes) => {
        const buffer = Buffer.alloc(bytes.length);
        buffer.set(bytes);
        return buffer;
      },
    ],
    // The bytes around the view differ from the bytes in it, so a copy that
    // read past the view would change the result.
    [
      'a Uint8Array at byte offset 3',
      (bytes) => {
        const backing = new Uint8Array(bytes.length + 6).fill(0x55);
        backing.set(bytes, 3);
        return backing.subarray(3, bytes.length + 3);
      },
    ],
  ];

  /** Overwrite every byte of the ArrayBuffer behind `arg`, the bytes around a view included. */
  function overwrite(arg: Uint8Array): void {
    new Uint8Array(arg.buffer).fill(0xaa);
  }

  describe.each(Object.entries(CASES))('%s', (_name, { args, fn, sync }) => {
    describe.each(FIXTURES)('with %s data', (_fixtureName, fixture) => {
      it.each(LAYOUTS)('copies %s that the caller overwrites after the call', async (_, place) => {
        const pristine = args(fixture);
        const expected = sync(...pristine);
        const placed = pristine.map(place);
        const result = fn(...placed);
        for (const arg of placed) overwrite(arg);
        expect(await result).toEqual(expected);
      });
    });
  });

  it.each(FIXTURES)(
    'zstdCompressAsync copies %s data whose ArrayBuffer the caller transfers after the call',
    async (_, fixture) => {
      const u8 = new Uint8Array(fixture);
      const result = zstdCompressAsync(u8);
      // Detaches the ArrayBuffer, as postMessage() would: its memory moves to
      // the clone, which the new owner then overwrites.
      const moved = structuredClone(u8.buffer, { transfer: [u8.buffer] });
      new Uint8Array(moved).fill(0xaa);
      expect(u8.byteLength).toBe(0);
      expect(await result).toEqual(zstdCompress(fixture));
    },
  );

  it('zstdTrainDictionaryAsync copies samples that the caller overwrites after the call', async () => {
    const pristine = Array.from({ length: 100 }, (_, i) =>
      JSON_DATA.subarray(i * 800, (i + 1) * 800),
    );
    const samples = pristine.map((sample) => new Uint8Array(sample));
    const result = zstdTrainDictionaryAsync(samples, 4096);
    for (const sample of samples) sample.fill(0xaa);
    // Training is deterministic: the same samples give the same dictionary.
    expect(await result).toEqual(zstdTrainDictionary(pristine, 4096));
  });

  // async-gc.cjs runs in a Node.js process of its own, as global.gc() needs
  // --expose-gc. PROCESS_TIMEOUT is how long it may run. Vitest fails a test
  // that outlasts its own timeout (5 s by default) even while it waits in
  // execFileSync, so the test gets twice this.
  const PROCESS_TIMEOUT = 30_000;

  it('zstdCompressAsync returns its results when the inputs are garbage-collected', {
    timeout: 2 * PROCESS_TIMEOUT,
  }, () => {
    const script = resolve(__dirname, 'fixtures/async-gc.cjs');
    expect(() =>
      execFileSync(process.execPath, ['--expose-gc', script], {
        stdio: 'pipe',
        timeout: PROCESS_TIMEOUT,
      }),
    ).not.toThrow();
  });
});
