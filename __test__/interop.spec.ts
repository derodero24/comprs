import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import * as zlib from 'node:zlib';
import {
  brotliCompressSync,
  brotliDecompressSync,
  deflateRawSync,
  gunzipSync,
  gzipSync,
  inflateRawSync,
} from 'node:zlib';
import { describe, expect, it } from 'vitest';
import {
  brotliCompress,
  brotliDecompress,
  DeflateCompressContext,
  deflateCompress,
  deflateDecompress,
  GzipCompressContext,
  gzipCompress,
  gzipDecompress,
  Lz4CompressContext,
  lz4Compress,
  lz4Decompress,
  zstdCompress,
  zstdDecompress,
} from '../index.js';

// Check if zstd is available in current Node.js version (22.15+)
const zstdAvailable = 'zstdCompressSync' in zlib;

/**
 * node:zlib options that decode the start of a stream as far as it goes, as
 * the client of a flushed stream does.
 */
const SYNC_FLUSH = { finishFlush: zlib.constants.Z_SYNC_FLUSH };

// The reference LZ4 implementation, where its CLI is installed
const lz4CliAvailable = spawnSync('lz4', ['--version']).status === 0;

/** Run the `lz4` CLI with `args`, feeding it `input` on stdin. */
function lz4Cli(args: string[], input: Uint8Array): Buffer {
  const result = spawnSync('lz4', args, { input });
  if (result.status !== 0) {
    throw new Error(`lz4 ${args.join(' ')} exited with ${result.status}: ${result.stderr}`);
  }
  return result.stdout;
}

describe('brotli Node.js zlib interop', () => {
  const testData = Buffer.from('Hello, interop testing with brotli compression!'.repeat(10));

  it('comprs brotli output should be decompressible by node:zlib', () => {
    const compressed = brotliCompress(testData);
    const decompressed = brotliDecompressSync(compressed);
    expect(Buffer.from(decompressed)).toEqual(testData);
  });

  it('node:zlib brotli output should be decompressible by comprs', () => {
    const compressed = brotliCompressSync(testData);
    const decompressed = brotliDecompress(Buffer.from(compressed));
    expect(Buffer.from(decompressed)).toEqual(testData);
  });

  it('should interop at different quality levels', () => {
    for (const quality of [0, 4, 11]) {
      const compressed = brotliCompress(testData, quality);
      const decompressed = brotliDecompressSync(compressed);
      expect(Buffer.from(decompressed)).toEqual(testData);
    }
  });

  it('should round-trip through both implementations', () => {
    // comprs compress -> node decompress -> node compress -> comprs decompress
    const step1 = brotliCompress(testData);
    const step2 = brotliDecompressSync(step1);
    const step3 = brotliCompressSync(step2);
    const step4 = brotliDecompress(Buffer.from(step3));
    expect(Buffer.from(step4)).toEqual(testData);
  });
});

describe('gzip Node.js zlib interop', () => {
  const testData = Buffer.from('Hello, interop testing with gzip compression!'.repeat(10));

  it('comprs gzip output should be decompressible by node:zlib', () => {
    const compressed = gzipCompress(testData);
    const decompressed = gunzipSync(compressed);
    expect(Buffer.from(decompressed)).toEqual(testData);
  });

  it('node:zlib gzip output should be decompressible by comprs', () => {
    const compressed = gzipSync(testData);
    const decompressed = gzipDecompress(Buffer.from(compressed));
    expect(Buffer.from(decompressed)).toEqual(testData);
  });

  it('should interop at different compression levels', () => {
    for (const level of [1, 6, 9]) {
      const compressed = gzipCompress(testData, level);
      const decompressed = gunzipSync(compressed);
      expect(Buffer.from(decompressed)).toEqual(testData);
    }
  });

  it('node:zlib should decode the output of flush() to all the input so far', () => {
    // Random input can leave the encoder's output buffer nearly full, and
    // flush() used to stop there, up to about 16 KiB short (#701).
    const data = randomBytes(64 * 1024);
    for (const level of [0, 1, 6, 9]) {
      const ctx = new GzipCompressContext(level);
      const flushed = Buffer.concat([ctx.transform(data), ctx.flush()]);
      const decompressed = gunzipSync(flushed, SYNC_FLUSH);
      expect(decompressed.length, `level ${level}`).toBe(data.length);
      expect(decompressed.equals(data), `level ${level}`).toBe(true);
      ctx.close();
    }
  });

  it('should round-trip through both implementations', () => {
    const step1 = gzipCompress(testData);
    const step2 = gunzipSync(step1);
    const step3 = gzipSync(step2);
    const step4 = gzipDecompress(Buffer.from(step3));
    expect(Buffer.from(step4)).toEqual(testData);
  });
});

describe('deflate Node.js zlib interop', () => {
  const testData = Buffer.from('Hello, interop testing with deflate compression!'.repeat(10));

  it('comprs deflate output should be decompressible by node:zlib', () => {
    const compressed = deflateCompress(testData);
    const decompressed = inflateRawSync(compressed);
    expect(Buffer.from(decompressed)).toEqual(testData);
  });

  it('node:zlib deflate output should be decompressible by comprs', () => {
    const compressed = deflateRawSync(testData);
    const decompressed = deflateDecompress(Buffer.from(compressed));
    expect(Buffer.from(decompressed)).toEqual(testData);
  });

  it('should interop at different compression levels', () => {
    for (const level of [1, 6, 9]) {
      const compressed = deflateCompress(testData, level);
      const decompressed = inflateRawSync(compressed);
      expect(Buffer.from(decompressed)).toEqual(testData);
    }
  });

  it('node:zlib should decode the output of flush() to all the input so far', () => {
    const data = randomBytes(64 * 1024);
    for (const level of [0, 1, 6, 9]) {
      const ctx = new DeflateCompressContext(level);
      const flushed = Buffer.concat([ctx.transform(data), ctx.flush()]);
      const decompressed = inflateRawSync(flushed, SYNC_FLUSH);
      expect(decompressed.length, `level ${level}`).toBe(data.length);
      expect(decompressed.equals(data), `level ${level}`).toBe(true);
      ctx.close();
    }
  });

  it('should round-trip through both implementations', () => {
    const step1 = deflateCompress(testData);
    const step2 = inflateRawSync(step1);
    const step3 = deflateRawSync(step2);
    const step4 = deflateDecompress(Buffer.from(step3));
    expect(Buffer.from(step4)).toEqual(testData);
  });
});

describe.skipIf(!zstdAvailable)('zstd Node.js zlib interop', () => {
  const testData = Buffer.from('Hello, interop testing with zstd compression!'.repeat(10));

  // Cast to access experimental zstd functions
  // biome-ignore lint/suspicious/noExplicitAny: zstd is experimental and not in all type definitions
  const zlibWithZstd = zlib as any;

  it('comprs zstd output should be decompressible by node:zlib', () => {
    const compressed = zstdCompress(testData);
    const decompressed = zlibWithZstd.zstdDecompressSync(compressed);
    expect(Buffer.from(decompressed)).toEqual(testData);
  });

  it('node:zlib zstd output should be decompressible by comprs', () => {
    const compressed = zlibWithZstd.zstdCompressSync(testData);
    const decompressed = zstdDecompress(Buffer.from(compressed));
    expect(Buffer.from(decompressed)).toEqual(testData);
  });

  it('should interop at different compression levels', () => {
    for (const level of [1, 3, 19]) {
      const compressed = zstdCompress(testData, level);
      const decompressed = zlibWithZstd.zstdDecompressSync(compressed);
      expect(Buffer.from(decompressed)).toEqual(testData);
    }
  });

  it('should round-trip through both implementations', () => {
    const step1 = zstdCompress(testData);
    const step2 = zlibWithZstd.zstdDecompressSync(step1);
    const step3 = zlibWithZstd.zstdCompressSync(step2);
    const step4 = zstdDecompress(Buffer.from(step3));
    expect(Buffer.from(step4)).toEqual(testData);
  });
});

describe.skipIf(!lz4CliAvailable)('lz4 CLI interop', () => {
  // Over 256 KiB, so that frames hold several blocks: lz4Compress() writes
  // 256 KiB blocks for it, Lz4CompressContext and `lz4 -B4` 64 KB blocks.
  const testData = Buffer.from('Hello, interop testing with lz4 compression! '.repeat(8000));

  it('comprs lz4 output should be decompressible by the lz4 CLI', () => {
    expect(lz4Cli(['-d', '-c'], lz4Compress(testData))).toEqual(testData);

    const ctx = new Lz4CompressContext();
    const streamed = Buffer.concat([ctx.transform(testData), ctx.flush(), ctx.finish()]);
    expect(lz4Cli(['-d', '-c'], streamed)).toEqual(testData);
  });

  it('lz4 CLI output should be decompressible by comprs', () => {
    // The default frame, a frame without checksums, linked 64 KB blocks with
    // block checksums, and a legacy frame.
    for (const args of [[], ['--no-frame-crc'], ['-B4', '-BD', '-BX'], ['-l']]) {
      expect(lz4Decompress(lz4Cli(['-c', ...args], testData))).toEqual(testData);
    }
  });

  it('should decode concatenated frames like the lz4 CLI', () => {
    const input = Buffer.concat([
      lz4Compress(testData),
      lz4Cli(['-c', '--no-frame-crc'], Buffer.from('second frame')),
    ]);
    expect(lz4Decompress(input)).toEqual(lz4Cli(['-d', '-c'], input));
  });
});

describe('cross-algorithm output differentiation', () => {
  const data = Buffer.from('Test data for cross-algorithm verification'.repeat(10));

  it('same input produces different compressed output per algorithm', () => {
    const zstd = zstdCompress(data);
    const gzip = gzipCompress(data);
    const brotli = brotliCompress(data);
    const deflate = deflateCompress(data);

    // All should be different from each other
    expect(Buffer.from(zstd)).not.toEqual(Buffer.from(gzip));
    expect(Buffer.from(zstd)).not.toEqual(Buffer.from(brotli));
    expect(Buffer.from(zstd)).not.toEqual(Buffer.from(deflate));
    expect(Buffer.from(gzip)).not.toEqual(Buffer.from(brotli));
    expect(Buffer.from(gzip)).not.toEqual(Buffer.from(deflate));
    expect(Buffer.from(brotli)).not.toEqual(Buffer.from(deflate));
  });

  it('all algorithms decompress back to the original data', () => {
    expect(Buffer.from(zstdDecompress(zstdCompress(data)))).toEqual(data);
    expect(Buffer.from(gzipDecompress(gzipCompress(data)))).toEqual(data);
    expect(Buffer.from(brotliDecompress(brotliCompress(data)))).toEqual(data);
    expect(Buffer.from(deflateDecompress(deflateCompress(data)))).toEqual(data);
  });

  it('compressed output has distinct magic bytes per format', () => {
    const zstd = zstdCompress(data);
    const gzip = gzipCompress(data);
    const brotli = brotliCompress(data);

    // zstd magic number: 0xFD2FB528 (little-endian)
    expect(zstd[0]).toBe(0x28);
    expect(zstd[1]).toBe(0xb5);
    expect(zstd[2]).toBe(0x2f);
    expect(zstd[3]).toBe(0xfd);

    // gzip magic number: 0x1F8B
    expect(gzip[0]).toBe(0x1f);
    expect(gzip[1]).toBe(0x8b);

    // brotli has no fixed magic bytes, but first byte should differ from others
    expect(brotli[0]).not.toBe(0x28); // not zstd
    expect(brotli[0]).not.toBe(0x1f); // not gzip
  });
});
