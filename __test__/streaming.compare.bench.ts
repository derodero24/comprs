import { Readable, type Transform, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import * as zlib from 'node:zlib';
import { test } from 'vitest';
import {
  createGzipCompressTransform,
  createGzipDecompressTransform,
  createZstdCompressTransform,
  createZstdDecompressTransform,
} from '../node.js';
import { LARGE, recordSizes, runBenchmarks } from './bench-fixtures.js';

const CHUNK_SIZE = 16_384;
const INPUT = 'patterned 1MB in 16KB chunks';

/** Create a Readable from data, split into chunks of the given size. */
function toChunkedReadable(data: Buffer, chunkSize: number): Readable {
  let offset = 0;
  return new Readable({
    read() {
      if (offset >= data.length) {
        this.push(null);
        return;
      }
      const end = Math.min(offset + chunkSize, data.length);
      this.push(data.subarray(offset, end));
      offset = end;
    },
  });
}

/**
 * Pipe data in 16KB chunks through the transforms, and return the output, for
 * the setup of a test. The timed runs use {@link drainChunks}.
 */
async function pipeChunks(data: Buffer, ...transforms: Transform[]): Promise<Buffer> {
  const chunks: Buffer[] = [];
  const sink = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      chunks.push(chunk);
      callback();
    },
  });
  await pipeline([toChunkedReadable(data, CHUNK_SIZE), ...transforms, sink]);
  return Buffer.concat(chunks);
}

/**
 * Pipe data in 16KB chunks through the transforms, and discard the output.
 * Keeping the chunks and concatenating them would add the same cost to every
 * library on each call, and narrow the gap between them.
 */
async function drainChunks(data: Buffer, ...transforms: Transform[]): Promise<void> {
  const sink = new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
  await pipeline([toChunkedReadable(data, CHUNK_SIZE), ...transforms, sink]);
}

/** A library's streams for one format, at the settings of a comparison. */
interface StreamLibrary {
  readonly name: string;
  readonly compress: () => Transform;
  readonly decompress: () => Transform;
}

/**
 * Compares the libraries' streams on LARGE, in tests named
 * `<format> stream <compress|decompress|round-trip> <setting> - <input>`,
 * which scripts/bench-report.mjs reads. As in the one-shot comparisons, every
 * library decompresses the output of the first one, comprs.
 */
function compareStreams(
  format: string,
  setting: string,
  libraries: readonly StreamLibrary[],
): void {
  const name = (operation: string): string => `${format} stream ${operation} ${setting} - ${INPUT}`;

  test(name('compress'), async ({ bench }) => {
    const outputs = await Promise.all(
      libraries.map(async (library) => ({
        library,
        output: await pipeChunks(LARGE, library.compress()),
      })),
    );
    const [first] = outputs;
    if (first === undefined) {
      throw new Error(`${name('compress')}: no library to compare`);
    }
    recordSizes(
      `${format} stream ${setting} - ${INPUT}`,
      LARGE.length,
      Object.fromEntries(outputs.map(({ library, output }) => [library.name, output.length])),
    );
    await runBenchmarks(
      bench,
      libraries.map((library) =>
        bench(library.name, async () => {
          await drainChunks(LARGE, library.compress());
        }),
      ),
    );
  });

  test(name('decompress'), async ({ bench }) => {
    const [comprs] = libraries;
    if (comprs === undefined) {
      throw new Error(`${name('decompress')}: no library to compare`);
    }
    const compressed = await pipeChunks(LARGE, comprs.compress());
    // A library that cannot decompress the input would be timed failing.
    const restored = await Promise.all(
      libraries.map((library) => pipeChunks(compressed, library.decompress())),
    );
    if (restored.some((output) => !output.equals(LARGE))) {
      throw new Error(`${name('decompress')}: a library does not restore the input`);
    }
    await runBenchmarks(
      bench,
      libraries.map((library) =>
        bench(library.name, async () => {
          await drainChunks(compressed, library.decompress());
        }),
      ),
    );
  });

  test(name('round-trip'), async ({ bench }) => {
    await runBenchmarks(
      bench,
      libraries.map((library) =>
        bench(library.name, async () => {
          await drainChunks(LARGE, library.compress(), library.decompress());
        }),
      ),
    );
  });
}

// The default level of every library, passed explicitly.
const GZIP_LEVEL = 6;
const ZSTD_LEVEL = 3;

compareStreams('gzip', `level ${GZIP_LEVEL}`, [
  {
    name: 'comprs',
    compress: () => createGzipCompressTransform(GZIP_LEVEL),
    decompress: () => createGzipDecompressTransform(),
  },
  {
    name: 'node:zlib',
    compress: () => zlib.createGzip({ level: GZIP_LEVEL }),
    decompress: () => zlib.createGunzip(),
  },
]);

// node:zlib has no zstd before Node.js 22.15: comprs then runs alone.
const nodeZstd: StreamLibrary = {
  name: 'node:zlib',
  compress: () =>
    zlib.createZstdCompress({ params: { [zlib.constants.ZSTD_c_compressionLevel]: ZSTD_LEVEL } }),
  decompress: () => zlib.createZstdDecompress(),
};

compareStreams('zstd', `level ${ZSTD_LEVEL}`, [
  {
    name: 'comprs',
    compress: () => createZstdCompressTransform(ZSTD_LEVEL),
    decompress: () => createZstdDecompressTransform(),
  },
  ...(typeof zlib.createZstdCompress === 'function' ? [nodeZstd] : []),
]);
