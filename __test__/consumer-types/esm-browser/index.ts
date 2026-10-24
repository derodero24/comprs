// An ES module consumer that resolves the package like a bundler does for
// browsers, with the `browser` condition, which selects the declarations of
// the WebAssembly build, those of @derodero24/comprs/next included. It has
// strict settings, the DOM library and no Node.js types, and its
// dependencies' declarations are type-checked (skipLibCheck: false).
// scripts/check-consumer-types.mjs installs the packed package next to it
// and runs tsc.
import type { GzipHeader, StreamContextOptions } from '@derodero24/comprs';
import {
  BrotliCompressDictContext,
  CompressionFormat,
  detectFormat,
  GzipCompressContext,
  gzipCompress,
  gzipCompressAsync,
  gzipReadHeader,
  Lz4DecompressContext,
  zstdCompress,
} from '@derodero24/comprs';
import type { DecompressOptions, Format } from '@derodero24/comprs/next';
import * as next from '@derodero24/comprs/next';
import { createDecompressStream, createGzipCompressStream } from '@derodero24/comprs/streams';

const input = new TextEncoder().encode('hello');

const gzipped: Uint8Array = gzipCompress(input, 6);
const header: GzipHeader = gzipReadHeader(gzipped);
const mtime: number = header.mtime;
const filename: string = header.filename ?? '';
const format: CompressionFormat = detectFormat(gzipped);
// The browser entry exports CompressionFormat as well, with the members of
// the native one (#567); the strings still compare with it.
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
const chunks: Uint8Array[] = [context.transform(input), context.finish()];

// The options of the stream contexts take `undefined` for a property under
// exactOptionalPropertyTypes, as the contexts do at run time.
const contextOptions: StreamContextOptions = { incremental: undefined };
const incrementalContexts = [
  new Lz4DecompressContext(undefined, { incremental: true }),
  new Lz4DecompressContext(1024, contextOptions),
  new BrotliCompressDictContext(input, undefined, { incremental: true }),
  new BrotliCompressDictContext(input, 5, contextOptions),
];

const compressed: Uint8Array = await gzipCompressAsync(input);

// The unified API returns Uint8Arrays over an ArrayBuffer, which the DOM
// typings take as a BlobPart or a BufferSource.
const brotli = await next.compress(input, { format: 'brotli', level: 5 });
const blob = new Blob([brotli, next.compressSync(input, { format: 'deflate-raw' })]);
const digest: ArrayBuffer = await crypto.subtle.digest('SHA-256', brotli);
const decompressOptions: DecompressOptions = { format: 'brotli', maxOutputSize: undefined };
const restored: Uint8Array<ArrayBuffer> = next.decompressSync(brotli, decompressOptions);
const detected: Format | undefined = next.detectFormat(compressed);

const source = new ReadableStream<Uint8Array>({
  start(controller) {
    controller.enqueue(input);
    controller.close();
  },
});
const roundTrip: ReadableStream<Uint8Array> = source
  .pipeThrough(createGzipCompressStream())
  .pipeThrough(createDecompressStream());

// The stream classes of the unified API, in the WebAssembly build.
const nextRoundTrip: ReadableStream<Uint8Array<ArrayBuffer>> = roundTrip
  .pipeThrough(new next.CompressionStream('lz4'))
  .pipeThrough(new next.DecompressionStream('auto'));

export {
  blob,
  chunks,
  compressed,
  detected,
  digest,
  filename,
  format,
  incrementalContexts,
  isGzip,
  isZstd,
  label,
  mtime,
  nextRoundTrip,
  restored,
  roundTrip,
};
