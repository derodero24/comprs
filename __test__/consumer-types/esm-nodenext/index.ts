// An ES module consumer that resolves the package like Node.js does, with
// strict settings and its dependencies' declarations type-checked
// (skipLibCheck: false). scripts/check-consumer-types.mjs installs the packed
// package next to it and runs tsc.
import type { GzipHeader, StreamContextOptions } from '@derodero24/comprs';
import {
  CompressionFormat,
  createGzipDecompressStream,
  detectFormat,
  GzipCompressContext,
  gzipCompress,
  gzipReadHeader,
  Lz4DecompressContext,
  zstdCompress,
  zstdCompressAsync,
} from '@derodero24/comprs';
import { createZstdCompressTransform } from '@derodero24/comprs/node';
import { createGzipCompressStream } from '@derodero24/comprs/streams';

const input = new TextEncoder().encode('hello');

const gzipped: Buffer = gzipCompress(input, 6);
const header: GzipHeader = gzipReadHeader(gzipped);
const mtime: number = header.mtime;
const filename: string = header.filename ?? '';
const format: CompressionFormat = detectFormat(gzipped);
// CompressionFormat is a regular enum, so its members are values that
// isolatedModules and verbatimModuleSyntax allow (#567); the strings still
// compare with it.
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

// The options of the stream contexts take `undefined` for a property under
// exactOptionalPropertyTypes, as the contexts do at run time.
const lz4Options: StreamContextOptions = { incremental: undefined };
const lz4Contexts = [
  new Lz4DecompressContext(undefined, { incremental: true }),
  new Lz4DecompressContext(1024, lz4Options),
];

const zstd: Buffer = await zstdCompressAsync(input);
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

// The Web streams accept any binary chunk, and they still fit the narrower
// type that their declarations used to have.
const binary = new ReadableStream<ArrayBuffer | DataView>({
  start(controller) {
    controller.enqueue(input.buffer.slice(0));
    controller.enqueue(new DataView(input.buffer));
    controller.close();
  },
});
const fromBinary: ReadableStream<Uint8Array> = binary.pipeThrough(createGzipCompressStream());
const narrow: TransformStream<Uint8Array, Uint8Array> = createGzipDecompressStream();

export {
  chunks,
  filename,
  format,
  fromBinary,
  isGzip,
  isZstd,
  label,
  lz4Contexts,
  mtime,
  narrow,
  roundTrip,
  zstd,
};
