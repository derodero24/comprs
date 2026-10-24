---
title: Streaming
description: Compress and decompress streams of bytes with CompressionStream, Web Streams helpers, Node.js Transforms and stream contexts.
sidebar:
  order: 2
---

comprs has three kinds of streams, which compress and decompress in bounded memory:

| Kind | Import | Runtimes |
| --- | --- | --- |
| `CompressionStream` and `DecompressionStream` | `@derodero24/comprs/next` | Node.js, Deno, Bun, browsers |
| Web Streams helpers (`createGzipCompressStream()` and so on) | `@derodero24/comprs/streams` | Node.js, Deno, Bun, browsers |
| Node.js Transforms (`createGzipCompressTransform()` and so on) | `@derodero24/comprs/node` | Node.js, Deno, Bun |

All of them are built on the stream contexts of the package root, which you can also drive yourself.

## CompressionStream and DecompressionStream

`CompressionStream` and `DecompressionStream` are ponyfills of the classes of the [Compression Streams](https://compression.spec.whatwg.org/) standard ([#344](https://github.com/derodero24/comprs/issues/344)): pipe a stream of bytes through them with `pipeThrough()`. They take every format of the [unified API](/comprs/guides/unified-api/), with the options of `compress()` and `decompress()` but `signal`, and they neither replace nor use the global classes.

```ts
import { CompressionStream, DecompressionStream } from '@derodero24/comprs/next';

const compressed = file.stream().pipeThrough(new CompressionStream('zstd', { level: 9 }));
const response = new Response(compressed, { headers: { 'Content-Encoding': 'zstd' } });

const body = request.body!.pipeThrough(
  new DecompressionStream('auto', { maxOutputSize: 10 * 1024 * 1024 }),
);
```

| Format | Compression | Decompression |
| --- | --- | --- |
| `'zstd'` | `level`, `dictionary`, `workers` | `dictionary`, `maxOutputSize` |
| `'gzip'` | `level`, `gzipHeader` | `maxOutputSize` |
| `'deflate'` (zlib) | `level` | `maxOutputSize` |
| `'deflate-raw'` | `level` | `maxOutputSize` |
| `'brotli'` | `level`, `dictionary` | `dictionary`, `maxOutputSize` |
| `'lz4'` | none | `maxOutputSize` |
| `'auto'` | | `dictionary` (a `Dictionary`), `maxOutputSize` |

- **Formats.** Where the platform's own `CompressionStream` and `DecompressionStream` are enough, for gzip, deflate and deflate-raw without options, keep using them; these classes add the other formats, the options, the output limit and the error codes.
- **Chunks.** The chunks written may be any `ArrayBuffer`, `SharedArrayBuffer` or `ArrayBufferView`, read byte for byte, and bytes in a `SharedArrayBuffer` are copied first. A chunk of any other type, or a detached buffer, errors the stream with `ERR_COMPRS_INVALID_ARG`. The chunks read are plain `Uint8Array`s, never empty; their sizes follow the codec, not the chunks written.
- **Errors.** The constructors check the format and the options, as `compressSync()` and `decompressSync()` do, and throw with `ERR_COMPRS_INVALID_ARG`. Errors of the codec error the stream, with the [error codes](/comprs/reference/errors-and-limits/): decompression is as strict as `decompress()`, so input that ends before the end of the compressed stream, empty input included, errors the stream with `ERR_COMPRS_TRUNCATED` once the writable side closes.
- **Detection.** With `'auto'`, a `DecompressionStream` holds the start of its input until it knows the format, which takes at most 64 KiB, and then decodes as in that format. It knows zstd and lz4 frames whose magic number comes in the first 64 KiB, after any skippable frames, and brotli data once its start decodes to more bytes than the stream holds, or once the input ends. With a `Dictionary`, `'auto'` stands for the format of the dictionary.
- **Threads.** In Node.js, a chunk that the stream predicts to take 2 ms or more is compressed or decompressed on a thread of the libuv pool, and cheaper ones on the calling thread, which yields to the event loop every few milliseconds (see [Threads and the event loop](/comprs/choosing-an-algorithm/#threads-and-the-event-loop)). In browsers, the WebAssembly build compresses each chunk on the calling thread: use a Web Worker to keep a page responsive.
- **Memory.** A stream releases the memory of its codec when it ends, fails or is cancelled. In runtimes whose `TransformStream` does not call the `cancel()` method of its transformer, added to the Streams standard in 2023, the garbage collector releases a cancelled stream instead; the native addon reports the memory of each stream to V8, so that it weighs it.

## Web Streams helpers

`@derodero24/comprs/streams` has a factory of `TransformStream`s for each format and direction, which works with both `import` and `require()`:

```ts
import { createGzipCompressStream } from '@derodero24/comprs/streams';

const response = await fetch('https://example.com/data.json');
if (!response.body) throw new Error('Response has no body');

const compressed = response.body.pipeThrough(createGzipCompressStream());
```

These streams accept the chunks that `CompressionStream` accepts, any `ArrayBuffer` or `ArrayBufferView`, as well as a `SharedArrayBuffer`, and read them byte for byte. The ES module entry of the package root re-exports them in Node.js, but not in browsers: import them from `@derodero24/comprs/streams`.

| Function | Description |
| --- | --- |
| `createZstdCompressStream(level?)` | zstd compression |
| `createZstdDecompressStream(maxOutputSize?)` | zstd decompression |
| `createGzipCompressStream(level?)` | gzip compression |
| `createGzipDecompressStream(maxOutputSize?)` | gzip decompression |
| `createDeflateCompressStream(level?)` | Raw deflate compression |
| `createDeflateDecompressStream(maxOutputSize?)` | Raw deflate decompression |
| `createBrotliCompressStream(quality?)` | brotli compression |
| `createBrotliDecompressStream(maxOutputSize?)` | brotli decompression |
| `createLz4CompressStream()` | LZ4 compression |
| `createLz4DecompressStream(maxOutputSize?)` | LZ4 decompression |
| `createZstdCompressDictStream(dict, level?)` | zstd compression with a dictionary |
| `createZstdDecompressDictStream(dict, maxOutputSize?)` | zstd decompression with a dictionary |
| `createBrotliCompressDictStream(dict, quality?)` | brotli compression with a dictionary |
| `createBrotliDecompressDictStream(dict, maxOutputSize?)` | brotli decompression with a dictionary |
| `createDecompressStream(maxOutputSize?)` | Decompression of a detected format |

## Node.js Transforms

For `stream.pipeline()`, import from `@derodero24/comprs/node`. This subpath is built on `node:stream`, so it does not work in browsers:

```ts
import { createGzipCompressTransform } from '@derodero24/comprs/node';
import { pipeline } from 'node:stream/promises';
import { createReadStream, createWriteStream } from 'node:fs';

await pipeline(
  createReadStream('input.txt'),
  createGzipCompressTransform(),
  createWriteStream('output.gz'),
);
```

It has the factories of `@derodero24/comprs/streams`, named `create*Transform` instead of `create*Stream`, such as `createZstdCompressTransform(level?)`, `createBrotliDecompressDictTransform(dict, maxOutputSize?)` and `createDecompressTransform(maxOutputSize?)`.

- Like the Web streams, the transforms run expensive chunks on the libuv thread pool and cheap ones on the calling thread. Once a transform is destroyed, the result or the error of a chunk still on the pool is dropped, as `node:zlib` drops it.
- They push their output in chunks of at most `readableHighWaterMark` bytes (64 KiB by default, 16 KiB on Windows), even when a single small input chunk decompresses to many megabytes.
- The chunks that one native call produces are views of one buffer, as with `node:zlib`. When a result spans several chunks, the transforms mark its buffer as untransferable, so that on Node.js, transferring one of the chunks to a worker with `postMessage()` or `structuredClone()` throws a `DataCloneError` instead of detaching the others. Where the runtime cannot mark it, as in Bun 1.3 and Deno before 2.7.6, a transfer made while the transform pushes the chunk fails the stream instead, and a later transfer still detaches the other chunks. To transfer any chunk, copy it with `new Uint8Array(chunk)` first.

## Stream contexts

The streams and the Node.js Transforms are built on the stream contexts that the package root exports (`ZstdCompressContext`, `GzipDecompressContext` and so on), which take chunks with `transform(chunk)`, return buffered output with `flush()`, and end the stream with `finish()`.

```ts
import { ZstdCompressContext } from '@derodero24/comprs';

using ctx = new ZstdCompressContext(19);
const output = [ctx.transform(chunk), ctx.finish()];
```

When a chunk ends where its compressor flushed, a decompression context returns all of its output from `transform(chunk)`, so a stream that is flushed after each message, such as a compressed event stream, delivers each message as soon as it arrives.

Each context also has `transformAsync(chunk)`, `flushAsync()` and `finishAsync()`, which return a Promise of what the synchronous methods return, and reject with what they throw. The native addon runs them on the libuv thread pool; the WebAssembly build runs them on the calling thread, before they return. They copy the chunk before they return, so the caller may reuse its memory at once. At most one asynchronous call may be in flight per context: until its Promise settles, another call fails with `<format> stream is busy: an asynchronous call has not finished`. `close()` while a call is in flight releases the native state once the call settles; calls after `close()` fail with `<format> stream already closed`. Contexts are disposable, so `using` closes one at the end of its scope.

`Lz4DecompressContext` and `BrotliCompressDictContext` work in one of two modes. The streams use the incremental ones.

| Mode | `transform(chunk)` | `flush()` | `finish()` | `maxOutputSize` limits |
| --- | --- | --- | --- | --- |
| `new Lz4DecompressContext(maxOutputSize?)` | keeps the chunk and returns an empty buffer | decodes the input kept since the last `flush()`, which must end between frames | decodes what is left | the output of each `flush()` |
| `new Lz4DecompressContext(maxOutputSize?, { incremental: true })` | returns each block once all of it has arrived, and throws as soon as the input is invalid | returns an empty buffer | throws unless the input ended between frames | the output of the whole stream |

| Mode | `transform(chunk)` | `flush()` | `finish()` |
| --- | --- | --- | --- |
| `new BrotliCompressDictContext(dict, quality?)` | keeps the chunk and returns an empty buffer | returns an empty buffer | compresses all of the input, into the output of `brotliCompressWithDict()` |
| `new BrotliCompressDictContext(dict, quality?, { incremental: true })` | keeps the first 4 MiB less 16 bytes of input (4,194,288 bytes) and returns an empty buffer; then returns the output that is ready | returns an empty buffer until the input passes 4,194,288 bytes; then all the output of the input so far | compresses an input of at most 4,194,288 bytes into the output of `brotliCompressWithDict()`; ends the stream after more |

The incremental `BrotliCompressDictContext` holds the first 4,194,288 bytes of its input, which is as far as the brotli encoder refers back with a 4 MiB window, so an input that ends within those bytes compresses into the output of `brotliCompressWithDict()`. Once the input passes them, the context compresses what it holds and streams the rest, with the dictionary all the way. On 16 MiB of JSON lines with a 2 KiB dictionary at quality 6, that stream came out 0.7% larger than the output of `brotliCompressWithDict()`, which sees all of the input at once.

## Streams that hold input

- Brotli dictionary compression streams hold the first 4 MiB less 16 bytes of their input, as far as the dictionary reaches, and produce no output until the input passes them or ends; from then on, they compress the input as it arrives.
- gzip, zlib and raw deflate compression holds up to 32 KiB until it completes a block, and brotli compression up to 64 KiB; `flush()` and the end of the stream compress what they hold. Their output is then the same however the input is split into chunks: at levels 5 and 6, zlib-rs compresses input that comes in small calls worse, and at qualities 0 and 1 the brotli encoder compresses each call on its own, which made repetitive text more than a thousand times larger in chunks of 100 bytes.
- The other streams work in bounded memory: LZ4 decompression streams, for example, emit each block as soon as all of it has arrived and hold at most one block of their input.
- The auto-detecting streams buffer up to 64 KiB of input to detect the format.
