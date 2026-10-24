---
title: Choosing an algorithm
description: Which compression format fits your data, and which kind of call fits your program.
---

## Formats

| Use case | Recommended | Why |
| --- | --- | --- |
| Web assets (CDN, HTTP) | **brotli** | The best compression ratio, and every browser decodes it as a `Content-Encoding` |
| General-purpose compression | **zstd** | The fastest all-round, with an excellent compression ratio |
| Real-time data, logs, IPC | **LZ4** | The lowest latency, for speed over ratio |
| Compatibility with every tool | **gzip** | Every platform and tool can decompress it |
| Many small, similar records (JSON, logs) | **zstd with a dictionary** | A trained dictionary seeds the compressor with the patterns to expect |
| brotli for domain-specific data | **brotli with a dictionary** | A custom dictionary of repeated structures, with no training step |

In the unified API, the format names follow the [Compression Streams](https://compression.spec.whatwg.org/) standard where it has one: `'gzip'`, `'deflate'` (zlib, RFC 1950) and `'deflate-raw'` (RFC 1951), plus `'zstd'`, `'brotli'` and `'lz4'`.

:::caution['deflate' is zlib]
As in the Compression Streams standard, HTTP's `Content-Encoding: deflate` and `deflateSync()` of `node:zlib`, `'deflate'` is the zlib format: deflate data after a 2-byte header and before an Adler-32 checksum. The `deflateCompress()` and `deflateDecompress()` functions of the package root, and their streams, use raw deflate, which is `'deflate-raw'` in the unified API. Data that `deflateCompress()` wrote decompresses with `{ format: 'deflate-raw' }` only.
:::

## Levels

| Format | Range | Default |
| --- | --- | --- |
| zstd | -131072 to 22; negative levels are faster than 1 | 3 |
| gzip, zlib, raw deflate | 0 to 9 | 6 |
| brotli | 0 to 11 (the root functions call it `quality`) | 6 |
| LZ4 | none | |

## Kinds of call

| Call | When to use |
| --- | --- |
| **Sync** (`compressSync()`, `zstdCompress()`) | Small data (under 1 MB), low latency, scripts |
| **Async** (`compress()`, `zstdCompressAsync()`) | Large data, or a server whose event loop must stay free. Browsers run them on the calling thread |
| **Streams** (`CompressionStream`, `createZstdCompressStream()`) | Data of unknown or unbounded size, or bounded memory |
| **Dictionaries** (`Dictionary`, the `dictionary` option) | Many small, structurally similar items |
| **Workers** (`compress()` with `workers`) | Large zstd inputs, compressed on several threads (native addon only) |

### Threads and the event loop

With the native addon (Node.js, Deno and Bun), the async functions run on the libuv thread pool. The Web streams and Node.js Transforms run each expensive chunk there too, such as 64 KiB at brotli quality 9 or zstd level 19, as `node:zlib` streams [do](https://nodejs.org/api/zlib.html#threadpool-usage-and-performance-considerations), so the event loop keeps turning while the chunk is compressed or decompressed. In Node.js, `fs`, `dns`, `crypto` and `zlib` share that pool, which has 4 threads unless the `UV_THREADPOOL_SIZE` environment variable sets another number.

Cheap chunks, such as most LZ4 chunks, for which a round trip to the pool would cost more than the work, run on the calling thread, and once such chunks have taken a few milliseconds, the streams wait for the event loop to turn, taking turns when several streams run at once. Each stream predicts the cost of a chunk from its size, the blocks in which the codec compresses its input and the speed of the codec, which it measures as it goes. A single chunk that decompresses to far more than such data usually does, such as 64 KiB of zstd that expands to 16 MiB, can still block the event loop while it is decompressed. This changes when the events of a stream happen, as with `node:zlib`, not the bytes, the errors or the API.

In browsers, everything runs on the calling thread, async functions included: use a Web Worker to keep a page responsive.
