// A CommonJS consumer that resolves the package like Node.js does, with
// strict settings and its dependencies' declarations type-checked
// (skipLibCheck: false). scripts/check-consumer-types.mjs installs the packed
// package next to it and runs tsc.
import type { GzipHeader } from '@derodero24/comprs';
import {
  CompressionFormat,
  detectFormat,
  GzipCompressContext,
  gzipCompress,
  gzipReadHeader,
  zstdCompress,
  zstdCompressAsync,
} from '@derodero24/comprs';
import { createZstdCompressTransform } from '@derodero24/comprs/node';
import { createGzipCompressStream, createGzipDecompressStream } from '@derodero24/comprs/streams';

// The root re-exports the stream helpers for `import` only: require() of the
// root has none, so a CommonJS consumer imports them from
// '@derodero24/comprs/streams'.

// @ts-expect-error TS2305: the CommonJS root declares no stream helpers.
import { createZstdCompressStream } from '@derodero24/comprs';

const input = new TextEncoder().encode('hello');

const gzipped: Buffer = gzipCompress(input, 6);
const header: GzipHeader = gzipReadHeader(gzipped);
const mtime: number = header.mtime;
const filename: string = header.filename ?? '';
const format: CompressionFormat = detectFormat(gzipped);
// CompressionFormat is a regular enum, so its members are values that
// isolatedModules allows (#567); the strings still compare with it.
const isZstd: boolean = detectFormat(zstdCompress(input)) === CompressionFormat.Zstd;
const isGzip: boolean = format === 'gzip';

/** A switch over every member, with no default: TS2366 if one is missing. */
function label(detected: CompressionFormat): string {
  switch (detected) {
    case CompressionFormat.Zstd:
      return 'Zstandard';
    case CompressionFormat.Gzip:
      return 'gzip';
    case CompressionFormat.Brotli:
      return 'Brotli';
    case CompressionFormat.Lz4:
      return 'LZ4';
    case CompressionFormat.Unknown:
      return 'unknown format';
  }
}

const context = new GzipCompressContext();
const chunks: Buffer[] = [context.transform(input), context.finish()];

const zstd: Promise<Buffer> = zstdCompressAsync(input);
const transform = createZstdCompressTransform(3);
transform.end(input);

const source = new ReadableStream<Uint8Array>({
  start(controller) {
    controller.enqueue(input);
    controller.close();
  },
});
const roundTrip: ReadableStream<Uint8Array> = source
  .pipeThrough(createGzipCompressStream())
  .pipeThrough(createGzipDecompressStream());

export {
  chunks,
  createZstdCompressStream,
  filename,
  format,
  isGzip,
  isZstd,
  label,
  mtime,
  roundTrip,
  zstd,
};
