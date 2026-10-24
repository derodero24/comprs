import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { isArrayBuffer } from 'node:util/types';
import { describe, expect, it } from 'vitest';
import {
  BrotliCompressContext,
  BrotliCompressDictContext,
  BrotliDecompressContext,
  BrotliDecompressDictContext,
  brotliCompress,
  brotliCompressWithDict,
  brotliDecompress,
  brotliDecompressWithCapacity,
  brotliDecompressWithDict,
  brotliDecompressWithDictWithCapacity,
  DeflateCompressContext,
  DeflateDecompressContext,
  decompress,
  deflateCompress,
  deflateDecompress,
  deflateDecompressWithCapacity,
  GzipCompressContext,
  GzipDecompressContext,
  gzipCompress,
  gzipCompressWithHeader,
  gzipDecompress,
  gzipDecompressWithCapacity,
  Lz4CompressContext,
  Lz4DecompressContext,
  lz4Compress,
  lz4Decompress,
  lz4DecompressWithCapacity,
  ZstdCompressContext,
  ZstdCompressDictContext,
  ZstdDecompressContext,
  ZstdDecompressDictContext,
  zstdCompress,
  zstdCompressWithDict,
  zstdDecompress,
  zstdDecompressWithCapacity,
  zstdDecompressWithDict,
  zstdDecompressWithDictWithCapacity,
  zstdTrainDictionary,
} from '../index.js';
import { JSON_DATA } from './bench-fixtures.js';

// The synchronous functions and the stream contexts copy results of up to
// 2 MiB into memory that V8 allocates (SYNC_COPY_LIMIT in
// crates/core/src/convert.rs). Unlike the memory of the addon, which Node.js
// marks as untransferable, such a result can be transferred to a worker, and
// V8 frees it as soon as it collects the result, without waiting for the
// event loop.

const data = Buffer.from('comprs returns results in memory that V8 owns. '.repeat(2000));
const dict = Buffer.from('a dictionary for the results of comprs '.repeat(20));
const samples = Array.from({ length: 100 }, (_, i) => JSON_DATA.subarray(i * 800, (i + 1) * 800));

/**
 * Check that `out` is a Buffer whose memory can be transferred, which
 * detaches it, and that the transfer takes its bytes along.
 */
function expectTransferable(out: Buffer): void {
  expect(Buffer.isBuffer(out)).toBe(true);
  expect(out.byteLength).toBeGreaterThan(0);
  const bytes = Uint8Array.from(out);
  const { buffer } = out;
  if (!isArrayBuffer(buffer)) {
    throw new Error('expected an ArrayBuffer');
  }
  const moved = structuredClone(out, { transfer: [buffer] });
  expect(out.byteLength).toBe(0);
  expect(moved).toEqual(bytes);
}

/**
 * Check that `out` is a Buffer that holds `expected` and whose memory
 * cannot be transferred, so that the transfer throws and leaves it intact.
 */
function expectUntransferable(out: Buffer, expected: Buffer): void {
  expect(Buffer.isBuffer(out)).toBe(true);
  const { buffer } = out;
  if (!isArrayBuffer(buffer)) {
    throw new Error('expected an ArrayBuffer');
  }
  expect(() => structuredClone(out, { transfer: [buffer] })).toThrow(
    expect.objectContaining({ name: 'DataCloneError' }),
  );
  expect(out.equals(expected)).toBe(true);
}

describe('synchronous one-shot functions', () => {
  const zstd = zstdCompress(data);
  const gzip = gzipCompress(data);
  const deflate = deflateCompress(data);
  const brotli = brotliCompress(data);
  const lz4 = lz4Compress(data);
  const zstdDict = zstdCompressWithDict(data, dict);
  const brotliDict = brotliCompressWithDict(data, dict);

  it.each<[string, () => Buffer]>([
    ['zstdCompress', () => zstdCompress(data)],
    ['zstdDecompress', () => zstdDecompress(zstd)],
    ['zstdDecompressWithCapacity', () => zstdDecompressWithCapacity(zstd, data.byteLength)],
    ['zstdTrainDictionary', () => zstdTrainDictionary(samples, 4096)],
    ['zstdCompressWithDict', () => zstdCompressWithDict(data, dict)],
    ['zstdDecompressWithDict', () => zstdDecompressWithDict(zstdDict, dict)],
    [
      'zstdDecompressWithDictWithCapacity',
      () => zstdDecompressWithDictWithCapacity(zstdDict, dict, data.byteLength),
    ],
    ['gzipCompress', () => gzipCompress(data)],
    ['gzipCompressWithHeader', () => gzipCompressWithHeader(data, { filename: 'data.txt' })],
    ['gzipDecompress', () => gzipDecompress(gzip)],
    ['gzipDecompressWithCapacity', () => gzipDecompressWithCapacity(gzip, data.byteLength)],
    ['deflateCompress', () => deflateCompress(data)],
    ['deflateDecompress', () => deflateDecompress(deflate)],
    [
      'deflateDecompressWithCapacity',
      () => deflateDecompressWithCapacity(deflate, data.byteLength),
    ],
    ['brotliCompress', () => brotliCompress(data)],
    ['brotliDecompress', () => brotliDecompress(brotli)],
    ['brotliDecompressWithCapacity', () => brotliDecompressWithCapacity(brotli, data.byteLength)],
    ['brotliCompressWithDict', () => brotliCompressWithDict(data, dict)],
    ['brotliDecompressWithDict', () => brotliDecompressWithDict(brotliDict, dict)],
    [
      'brotliDecompressWithDictWithCapacity',
      () => brotliDecompressWithDictWithCapacity(brotliDict, dict, data.byteLength),
    ],
    ['lz4Compress', () => lz4Compress(data)],
    ['lz4Decompress', () => lz4Decompress(lz4)],
    ['lz4DecompressWithCapacity', () => lz4DecompressWithCapacity(lz4, data.byteLength)],
    ['decompress', () => decompress(zstd)],
  ])('%s returns a result that can be transferred', (_, call) => {
    expectTransferable(call());
  });

  // This test and the next pin SYNC_COPY_LIMIT from both sides: the largest
  // result that is copied, and one byte more, which is not.
  it('returns a result of 2 MiB that can be transferred', () => {
    const size = 2 * 1024 * 1024;
    const out = gzipDecompress(gzipCompress(Buffer.alloc(size, 7)));
    expect(out.byteLength).toBe(size);
    expectTransferable(out);
  });

  // A larger result stays in the memory of the addon, which Node.js marks as
  // untransferable, so that the transfer throws and leaves it intact.
  it('returns a larger result as a Buffer that cannot be transferred', () => {
    const size = 2 * 1024 * 1024 + 1;
    const out = gzipDecompress(gzipCompress(Buffer.alloc(size, 7)));
    expectUntransferable(out, Buffer.alloc(size, 7));
  });

  it('returns an empty result as a Buffer', () => {
    const out = zstdDecompress(zstdCompress(Buffer.alloc(0)));
    expect(Buffer.isBuffer(out)).toBe(true);
    expect(out.byteLength).toBe(0);
  });
});

// zstd decodes frames that declare their content sizes, as zstdCompress()
// writes them, straight into memory that V8 allocates, at any size, except
// in the musl builds, where results larger than 2 MiB stay in the memory of
// the addon (DIRECT_DECODE_LIMIT in crates/core/src/convert.rs, #679).
describe('synchronous zstd decompression of frames with content sizes', () => {
  const size = 2 * 1024 * 1024 + 1;
  const large = Buffer.alloc(size, 'zstd decodes into memory that V8 owns ');
  const zstd = zstdCompress(large);
  const zstdDict = zstdCompressWithDict(large, dict);

  /** Check that `out`, larger than 2 MiB, holds `expected` in V8's memory. */
  function expectDecodedIntoV8(out: Buffer, expected: Buffer): void {
    if (isMuslLinux()) {
      expectUntransferable(out, expected);
      return;
    }
    expect(out.equals(expected)).toBe(true);
    expectTransferable(out);
  }

  it.each<[string, () => Buffer]>([
    ['zstdDecompress', () => zstdDecompress(zstd)],
    ['zstdDecompressWithCapacity', () => zstdDecompressWithCapacity(zstd, size)],
    ['zstdDecompressWithDict', () => zstdDecompressWithDict(zstdDict, dict)],
    [
      'zstdDecompressWithDictWithCapacity',
      () => zstdDecompressWithDictWithCapacity(zstdDict, dict, size),
    ],
  ])('%s returns a result larger than 2 MiB in memory that V8 allocates', (_, call) => {
    expectDecodedIntoV8(call(), large);
  });

  it('decodes several frames into one result in memory that V8 allocates', () => {
    const out = zstdDecompress(Buffer.concat([zstd, zstdCompress(data)]));
    expectDecodedIntoV8(out, Buffer.concat([large, data]));
  });

  // Up to 2 MiB, every build decodes into V8's memory.
  it('returns a result of 2 MiB that can be transferred', () => {
    const exact = large.subarray(0, 2 * 1024 * 1024);
    const out = zstdDecompress(zstdCompress(exact));
    expect(out.equals(exact)).toBe(true);
    expectTransferable(out);
  });

  // A frame that a stream context writes declares no content size, so its
  // output grows as it decodes and, above 2 MiB, stays in the memory of the
  // addon.
  it('returns the result of a frame without a content size as before', () => {
    const ctx = new ZstdCompressContext();
    const frame = Buffer.concat([ctx.transform(large), ctx.finish()]);
    expectUntransferable(zstdDecompress(frame), large);
  });

  it('throws for frames that decode to less than they declare', () => {
    // The frame header of zstdCompress() output declares the content size
    // in its last 4 bytes for sizes from 65792 bytes up to 4 GiB.
    const frame = Buffer.from(zstd);
    const descriptor = frame[4] ?? 0;
    expect(descriptor >> 6).toBe(2);
    const offset = descriptor & 0x20 ? 5 : 6;
    frame.writeUInt32LE(size + 1, offset);
    expect(() => zstdDecompress(frame)).toThrow();
  });
});

describe('stream contexts', () => {
  it('return transform, flush and finish results that can be transferred', () => {
    const ctx = new GzipCompressContext();
    const outputs = [ctx.transform(data), ctx.flush(), ctx.finish()];
    for (const out of outputs) {
      expectTransferable(out);
    }
  });

  /** The methods that every stream context class has. */
  interface Context {
    transform(chunk: Uint8Array): Buffer;
    flush(): Buffer;
    finish(): Buffer;
  }

  it.each<[string, () => Context, Buffer]>([
    ['ZstdCompressContext', () => new ZstdCompressContext(), data],
    ['ZstdDecompressContext', () => new ZstdDecompressContext(), zstdCompress(data)],
    ['ZstdCompressDictContext', () => new ZstdCompressDictContext(dict), data],
    [
      'ZstdDecompressDictContext',
      () => new ZstdDecompressDictContext(dict),
      zstdCompressWithDict(data, dict),
    ],
    ['GzipCompressContext', () => new GzipCompressContext(), data],
    ['GzipDecompressContext', () => new GzipDecompressContext(), gzipCompress(data)],
    ['DeflateCompressContext', () => new DeflateCompressContext(), data],
    ['DeflateDecompressContext', () => new DeflateDecompressContext(), deflateCompress(data)],
    ['BrotliCompressContext', () => new BrotliCompressContext(), data],
    ['BrotliDecompressContext', () => new BrotliDecompressContext(), brotliCompress(data)],
    ['BrotliCompressDictContext', () => new BrotliCompressDictContext(dict), data],
    [
      'BrotliDecompressDictContext',
      () => new BrotliDecompressDictContext(dict),
      brotliCompressWithDict(data, dict),
    ],
    ['Lz4CompressContext', () => new Lz4CompressContext(), data],
    ['Lz4DecompressContext', () => new Lz4DecompressContext(), lz4Compress(data)],
  ])('%s returns results that can be transferred', (_, create, input) => {
    const ctx = create();
    const outputs = [ctx.transform(input), ctx.flush(), ctx.finish()];
    const produced = outputs.filter((out) => out.byteLength > 0);
    expect(produced.length).toBeGreaterThan(0);
    for (const out of produced) {
      expectTransferable(out);
    }
  });
});

// How long rss-loop.cjs may run. Vitest fails a test that outlasts its own
// timeout (5 s by default) even while it waits in execFileSync, so the test
// gets twice this.
const PROCESS_TIMEOUT = 60_000;

/** Whether this process runs on Linux with the GNU C library. */
function isGlibcLinux(): boolean {
  if (process.platform !== 'linux') {
    return false;
  }
  const report = process.report.getReport();
  if (!('header' in report)) {
    return false;
  }
  const { header } = report;
  return (
    typeof header === 'object' &&
    header !== null &&
    'glibcVersionRuntime' in header &&
    header.glibcVersionRuntime !== undefined
  );
}

/** Whether this process runs on Linux with another C library, musl. */
function isMuslLinux(): boolean {
  return process.platform === 'linux' && !isGlibcLinux();
}

describe('memory', () => {
  // The memory of a result that the addon allocates is freed only on a later
  // turn of the event loop, even after V8 has collected the result, so a
  // synchronous loop never got it back: 200 calls that return 1 MB each
  // grew the resident set by about 190 MiB. A result in V8's memory is freed
  // when V8 collects it, and V8 collects garbage at the latest once about
  // 64 MB of such memory has been allocated, so the growth stays well below
  // 128 MiB.
  // Other C libraries return freed memory to the system differently, so
  // the test runs on glibc only.
  it.skipIf(!isGlibcLinux())(
    'frees the results of a synchronous loop before it yields',
    { timeout: 2 * PROCESS_TIMEOUT },
    async ({ annotate }) => {
      const rssGrowthMiB = runRssLoop([]);
      // In GitHub Actions, the annotation becomes a notice, so that CI shows
      // the growth that it measured even when the test passes.
      await annotate(`the resident set grew by ${rssGrowthMiB} MiB`);
      expect(rssGrowthMiB).toBeLessThan(128);
    },
  );

  // zstd decodes frames with content sizes into memory that V8 allocates
  // above 2 MiB too (#679): 200 calls that return 4 MiB each grew the
  // resident set by about 800 MiB in the memory of the addon. In V8's
  // memory, the growth is a multiple of the 4 MiB results that V8 has not
  // collected yet. V8 starts a collection once the memory has grown by its
  // limit, which it raises after each collection, and CI measured from 4 to
  // 92 MiB, and once 128 MiB, so the bound leaves room for twice that and
  // still fails far below the leak.
  it.skipIf(!isGlibcLinux())(
    'frees zstd results larger than 2 MiB in a synchronous loop before it yields',
    { timeout: 2 * PROCESS_TIMEOUT },
    async ({ annotate }) => {
      const rssGrowthMiB = runRssLoop(['zstd']);
      await annotate(`the resident set grew by ${rssGrowthMiB} MiB`);
      expect(rssGrowthMiB).toBeLessThan(256);
    },
  );
});

/** Run rss-loop.cjs with `args` and return the growth that it printed. */
function runRssLoop(args: readonly string[]): number {
  const script = resolve(__dirname, 'fixtures/rss-loop.cjs');
  const stdout = execFileSync(process.execPath, [script, ...args], {
    encoding: 'utf8',
    timeout: PROCESS_TIMEOUT,
  });
  const { rssGrowthMiB }: { rssGrowthMiB: unknown } = JSON.parse(stdout);
  if (typeof rssGrowthMiB !== 'number') {
    throw new Error(`rss-loop.cjs printed ${stdout}`);
  }
  return rssGrowthMiB;
}
