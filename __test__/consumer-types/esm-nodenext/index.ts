// An ES module consumer that resolves the package like Node.js does, with
// strict settings and its dependencies' declarations type-checked
// (skipLibCheck: false). scripts/check-consumer-types.mjs installs the packed
// package next to it and runs tsc.
import type { CompressionFormat, GzipHeader } from '@derodero24/comprs';
import {
  createGzipDecompressStream,
  detectFormat,
  GzipCompressContext,
  gzipCompress,
  gzipReadHeader,
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

const context = new GzipCompressContext();
const chunks: Buffer[] = [context.transform(input), context.finish()];

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

export { chunks, filename, format, fromBinary, mtime, narrow, roundTrip, zstd };
