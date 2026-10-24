---
title: Memory
description: What memory comprs keeps per thread, per stream and per result, and how the garbage collector sees it.
sidebar:
  order: 3
---

## Stream contexts

The stream contexts, which the streams use, keep their encoder or decoder state in native memory: up to a few hundred kilobytes for gzip, deflate and LZ4 compression, several megabytes for zstd and brotli, and far more at high levels (about 90 MB for zstd level 19). They report it to V8, so that the garbage collector frees abandoned contexts in time.

- `finish()` releases it right away, and so does `close()` for a context that will not be finished; later calls throw `<format> stream already closed`. While an asynchronous call such as `transformAsync()` is in flight, the call holds the state, and `close()`, like the garbage collector, leaves it to the call to release once it settles.
- An `Lz4DecompressContext` holds the input it buffers, or with `{ incremental: true }` at most one block of input (up to 4 MiB, or a little over 8 MiB in a legacy frame) and, for frames whose blocks refer to earlier ones, up to 128 KiB of output.
- A `BrotliCompressDictContext` holds the dictionary and the input it buffers, or with `{ incremental: true }` at most the first 4 MiB less 16 bytes of input, then the encoder state and the prepared dictionary.
- Contexts are disposable, so in runtimes with explicit resource management, such as Node.js 24 and later, `using ctx = new ZstdCompressContext()` closes the context at the end of the scope; in Node.js 22, call `close()` in a `finally` block. The Web streams and Node.js Transforms close their context when they end, fail, or are cancelled or destroyed. Closing a cancelled Web stream relies on the `cancel()` hook of `TransformStream` transformers, which Node.js supports; runtimes without it, such as Bun 1.3, leave the context to the garbage collector.

## Per-thread caches

Some state is kept per thread rather than per call: the calling thread for the synchronous functions, the libuv pool threads for the async ones. This memory is not reported to V8.

- **One-shot zstd contexts.** `zstdCompress()`, `zstdDecompress()`, `zstdDecompressWithCapacity()` and their `*Async` variants, and the unified API's zstd calls without a dictionary, keep one compression and one decompression context per thread, which makes small calls several times faster. A thread keeps a context only while it holds at most 8 MiB, so a large or high-level call does not leave its workspace behind.
- **LZ4 decode buffer.** LZ4 decompression keeps the buffer that it decodes blocks into per thread instead of zero-filling a new one per call, which makes frames that declare large blocks, such as the 4 MB blocks of the `lz4` command line tool, much faster to decode. A thread keeps the buffer only while it holds at most 4 MiB.
- **Brotli prepared dictionaries.** Before the brotli encoder can refer to a custom dictionary, libbrotli hashes it into about 270 KB of tables, plus 4 bytes for each byte of the dictionary, which takes 0.3 ms for a dictionary of 4 KiB and 2 to 4 ms for 256 KiB, many times longer than compressing a short message. A brotli `Dictionary` is hashed once, when it is created, and holds the tables itself. Brotli compression with the bytes of a dictionary keeps the last 4 dictionaries of up to 256 KiB that it prepared, per thread, and reuses one when it gets the same bytes again. A 150-byte message with a 4 KiB dictionary at quality 5 then compresses in about 0.02 ms. A thread holds at most about 5 MB this way.

## Results

In the native addon, the synchronous functions and the stream contexts return results of up to 2 MiB in memory that the JavaScript engine allocates. The engine frees it as soon as it collects the result, and such a result can be transferred to a worker with `postMessage()` or `structuredClone()`. The synchronous zstd and LZ4 functions, and `decompressSync()` of the unified API for zstd and LZ4 data, also decode frames that declare their content size straight into such memory at any size, as the one-shot compression functions write them, except in the musl builds (as on Alpine Linux), where that would slow down programs that yield between calls.

Other larger results and the results of the `*Async` functions stay in the memory that the addon allocated, which saves a copy. Node.js frees that memory only on a later turn of the event loop, after V8 has collected the result, so a synchronous loop that returns large results holds the memory of all of them until it yields (an occasional `await new Promise(setImmediate)` releases it). Node.js also marks that memory as untransferable, so transferring such a result throws a `DataCloneError`: copy it with `new Uint8Array(result)` first.

The Web streams emit plain `Uint8Array` chunks, each with an `ArrayBuffer` of its own, which can always be transferred. The WebAssembly build returns every result as a copy in JavaScript memory, which can be transferred at any size.

## WebAssembly

The WebAssembly memory grows to the most that the module has used at once, and does not shrink. The stream contexts of the browser build keep their state there, which garbage collection frees; `close()` releases it at once.
