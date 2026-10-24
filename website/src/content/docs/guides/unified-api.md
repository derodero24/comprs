---
title: Unified API
description: compress(), decompress(), dictionaries, streams, error codes and aborting, with one options object for every format.
sidebar:
  order: 1
---

`@derodero24/comprs/next` has one function per direction for every format, with an options object instead of a function per variant ([#577](https://github.com/derodero24/comprs/issues/577)). It works in Node.js, Deno and Bun, on the native addon, and in browsers, on the WebAssembly build. It reads and writes zlib data as well as raw deflate, returns plain `Uint8Array` results in every runtime, gives every error a stable `code`, takes an `AbortSignal`, and compresses zstd with worker threads in Node.js.

It follows semantic versioning, as the package root does: minor releases may add functions, options and error codes to it, but do not break it.

```ts
import { compress, compressSync, decompress, decompressSync, detectFormat } from '@derodero24/comprs/next';

const data = new TextEncoder().encode('Hello, comprs!');

const zstd = await compress(data, { format: 'zstd', level: 19 });
const restored = await decompress(zstd); // detects the format
detectFormat(zstd); // 'zstd'

const gzip = compressSync(data, { format: 'gzip', gzipHeader: { filename: 'hello.txt' } });
decompressSync(gzip, { format: 'gzip', maxOutputSize: 1024 * 1024 });
```

## Functions

| Function | Description |
| --- | --- |
| `compress(data, options)` | Compress `data` in `options.format`, on a thread of the libuv pool in Node.js |
| `compressSync(data, options)` | Compress `data` on the calling thread |
| `decompress(data, options?)` | Decompress `data`, in `options.format` or the format that detection finds, on a thread of the libuv pool in Node.js |
| `decompressSync(data, options?)` | Decompress `data` on the calling thread |
| `detectFormat(data)` | The format of `data`, as `decompress()` detects it, or `undefined` if it finds none |
| `trainDictionary(samples, options?)` | Train a zstd dictionary from an iterable of samples, on a thread of the libuv pool in Node.js |
| `trainDictionarySync(samples, options?)` | Train a zstd dictionary on the calling thread |
| `Dictionary.from(bytes, options)` | Prepare a zstd or brotli dictionary once, for every call that takes it (see [Dictionaries](/comprs/guides/dictionaries/)) |
| `new CompressionStream(format, options?)` | A ponyfill of the standard `CompressionStream`, in every format, with the options of `compress()` (see [Streaming](/comprs/guides/streaming/)) |
| `new DecompressionStream(format, options?)` | A ponyfill of the standard `DecompressionStream`, in every format or `'auto'`, with the options of `decompress()` |

## Options

| Option | Of | Description |
| --- | --- | --- |
| `format` | compression (required), decompression | `'zstd'`, `'gzip'`, `'deflate'` (zlib), `'deflate-raw'`, `'brotli'` or `'lz4'`. Decompression also takes `'auto'`, the default, which detects every format but `'deflate-raw'` |
| `level` | compression | zstd: -131072 to 22, 3 by default, which 0 also selects. With a `Dictionary`, the default is the level that it was prepared for. gzip, deflate and deflate-raw: 0 to 9, 6 by default. brotli: 0 to 11, 6 by default. lz4 takes none |
| `dictionary` | compression, decompression | A `Dictionary`, or the bytes of a dictionary, which must not be empty, for zstd and brotli. Decompression needs the same dictionary, and with its bytes, a `format` |
| `gzipHeader` | compression | `{ filename?, mtime? }`: the name and the modification time, in seconds since the Unix epoch, that the gzip header holds. For gzip only |
| `workers` | compression | The number of threads that compress zstd data besides the calling one: 0, the default, to 256. For zstd only, and for the native addon only |
| `maxOutputSize` | decompression | The largest output, in bytes: 0 to `Number.MAX_SAFE_INTEGER`, 256 MiB by default |
| `maxSize` | dictionary training | The largest dictionary, in bytes: 0 to 16 MiB, 110 KiB by default |
| `signal` | `compress()`, `decompress()`, `trainDictionary()` | An `AbortSignal` that withdraws the call (see [Aborting](#aborting)). The `*Sync` functions take none |

Every option is checked: an option of the wrong type, a number out of its range or not an integer (`NaN`, `1.5`), and an option that does not fit the format, such as a level for lz4, a dictionary for gzip or workers for brotli, fail with `ERR_COMPRS_INVALID_ARG`. Other properties of the options objects are ignored.

## Inputs and results

- **Inputs.** The data, the bytes of a dictionary and each sample may be any `ArrayBuffer`, `SharedArrayBuffer` or `ArrayBufferView`, such as a `Buffer`, a `DataView` or a `Uint16Array`, read byte for byte. Bytes in a `SharedArrayBuffer` are copied before they are read, so that another thread writing them cannot change them midway. The async functions copy their inputs before they return, so changing them afterwards does not change the result.
- **Results.** Every result is a plain `Uint8Array`, not a Node.js `Buffer`, over an `ArrayBuffer`, so the DOM typings accept it as a `BufferSource` or a `BlobPart`, as in `new Blob([result])` or `crypto.subtle.digest('SHA-256', result)`. Whether that `ArrayBuffer` can be transferred with `postMessage()` or `structuredClone()` is not guaranteed: copy a result with `slice()` to transfer it.
- **Output.** Compression writes the bytes that the functions of the package root write at the same settings in the same build, such as `zstdCompress(data, level)`, or `deflateCompress(data, level)` for `'deflate-raw'`, unless zstd compresses with `workers`, or with a `Dictionary` above level 8, or with a `Dictionary` an input of more than 512 KiB or of at least 128 KiB and at least 6 times the `byteLength` of the dictionary.
- **Decompression.** The decoders are strict: data that ends before the end of the compressed stream, empty data included, fails with `ERR_COMPRS_TRUNCATED`, and data after its end with `ERR_COMPRS_CORRUPT_DATA`. zstd and lz4 data may hold several frames, and gzip data several members, which are decompressed one after the other.
- **Detection.** Without a `format`, data whose format detection does not find, empty data included, fails with `ERR_COMPRS_UNKNOWN_FORMAT`. zstd, gzip and LZ4 have magic numbers. Brotli data has none, so detection decodes the start of the data, and data that it takes for brotli but that does not decode fails with `ERR_COMPRS_UNKNOWN_FORMAT` as well. Raw deflate cannot be detected.

## Errors

Every error has a `code`; see [Errors and limits](/comprs/reference/errors-and-limits/) for the table. The async functions report every error, invalid arguments included, by rejecting their Promise, and never throw. An error thrown by the caller's own code, such as a getter of an options object or the iterator of the samples, is passed on unchanged, without a code, and so is the `reason` of an aborted `signal`.

## Aborting

`compress()`, `decompress()` and `trainDictionary()` take a `signal`, an `AbortSignal` that withdraws the call when it aborts. As with `fetch()`, the call then rejects with the `reason` of the signal, as it is: a `DOMException` named `AbortError` for `controller.abort()`, or whatever value was passed to `controller.abort(reason)`. A signal that is already aborted makes the call reject at once, without starting any work.

```ts
const controller = new AbortController();
const pending = compress(data, { format: 'zstd', level: 19, signal: controller.signal });
controller.abort(); // the result is no longer needed
await pending; // rejects with controller.signal.reason, a DOMException named AbortError
```

Withdrawing is best effort. In Node.js, a call whose work no thread of the libuv pool has started yet rejects at once, and the pool skips the work, so that calls whose results are no longer needed do not hold up the other users of the pool, such as `fs` and `dns.lookup()`. Work that has started cannot stop midway: it finishes, and the call rejects once it has, discarding the result. The browser build does the work before the function returns, so there an abort only discards the result. A call that settled before the abort keeps its result.

The call listens to the signal until it settles and leaves its `onabort` property alone. The signal may be an `AbortSignal` of any realm, or an object with its `aborted`, `reason`, `addEventListener()` and `removeEventListener()`, which the `AbortSignalLike` type declares, so that the declarations need neither the DOM library nor the types of Node.js.

## Workers

The `workers` option compresses zstd data on worker threads in the native addon; with 4 workers, it compressed 67 MB of JSON lines nearly 3 times as fast at levels 3 and 9 in the measurements of [#561](https://github.com/derodero24/comprs/issues/561). The output can differ from that without workers.

zstd compresses inputs of at most 512 KiB on the calling thread whatever the number, and each call starts and stops its own workers, so they pay off for large inputs only. They cost memory too: zstd buffers up to `workers + 3` jobs of the input, gives each job an output buffer of about the same size, and gives each worker a compression context of its own. With 4 workers at level 3, where a job is 8 MiB, compressing 96 MiB took about 60 MiB more memory than without workers for JSON lines, and about 100 MiB more for random bytes. The workers are threads beyond the libuv pool that `compress()` runs on: concurrent calls can run up to `UV_THREADPOOL_SIZE * (workers + 1)` threads.

## In browsers

Browser builds that import `@derodero24/comprs/next` get its WebAssembly build, through the `browser` condition (see [Browsers](/comprs/guides/browsers/)). There:

- the async functions do not run on another thread: they compress or decompress on the calling thread, which they block, before they return a Promise of the result. Use a Web Worker to keep a page responsive;
- any `workers` but 0 fails with `ERR_COMPRS_INVALID_ARG`;
- the WebAssembly memory cannot hold more than 4 GiB, so a `maxOutputSize` above 4294967295 acts as 4294967295: errors name that limit, and a zstd frame that declares a larger content size fails with `ERR_COMPRS_SIZE_LIMIT`;
- lz4 frames differ from those of the native build for most inputs of more than a few hundred bytes, and both builds decode either; the other formats come out the same in both;
- a panic, or an allocation that the WebAssembly memory cannot grow for, fails with a `WebAssembly.RuntimeError` without a code.

## Types

The declarations export the types of the arguments and results: `Format`, `Input`, `Bytes`, `ErrorCode`, `CompressOptions`, `DecompressOptions`, `GzipHeaderOptions`, `TrainDictionaryOptions`, `DictionaryOptions`, `CompressionStreamOptions`, `DecompressionStreamOptions`, and `AbortOptions` and `AbortSignalLike` for the `signal` option. They need neither the DOM library nor the types of Node.js.
