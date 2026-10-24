---
title: From node:zlib
description: Replace node:zlib with comprs, for zstd and LZ4, browsers, and the same API in every runtime.
sidebar:
  order: 3
---

`node:zlib` has gzip, zlib, raw deflate, brotli, and since Node.js 22.15, experimental zstd. comprs adds LZ4, a browser build, Web Streams, and the same API in Node.js, Deno, Bun and browsers. Its brotli is libbrotli, as in `node:zlib`, and it writes the same bytes at the same quality and window when Node.js bundles the same libbrotli release.

```diff
- import { gzipSync, gunzipSync } from 'node:zlib';
- const compressed = gzipSync(data, { level: 9 });
- const restored = gunzipSync(compressed);
+ import { compressSync, decompressSync } from '@derodero24/comprs/next';
+ const compressed = compressSync(data, { format: 'gzip', level: 9 });
+ const restored = decompressSync(compressed, { format: 'gzip' });
```

| node:zlib | comprs (`@derodero24/comprs/next`) | comprs (package root) |
| --- | --- | --- |
| `gzipSync(data, { level })` | `compressSync(data, { format: 'gzip', level })` | `gzipCompress(data, level)` |
| `gunzipSync(data)` | `decompressSync(data, { format: 'gzip' })` | `gzipDecompress(data)` |
| `deflateSync(data)` (zlib) | `compressSync(data, { format: 'deflate' })` | none |
| `inflateSync(data)` (zlib) | `decompressSync(data, { format: 'deflate' })` | none |
| `deflateRawSync(data)` | `compressSync(data, { format: 'deflate-raw' })` | `deflateCompress(data)` |
| `inflateRawSync(data)` | `decompressSync(data, { format: 'deflate-raw' })` | `deflateDecompress(data)` |
| `brotliCompressSync(data, { params: { [BROTLI_PARAM_QUALITY]: 11 } })` | `compressSync(data, { format: 'brotli', level: 11 })` | `brotliCompress(data, 11)` |
| `brotliDecompressSync(data)` | `decompressSync(data, { format: 'brotli' })` | `brotliDecompress(data)` |
| `zstdCompressSync(data)` | `compressSync(data, { format: 'zstd' })` | `zstdCompress(data)` |
| `zstdDecompressSync(data)` | `decompressSync(data, { format: 'zstd' })` | `zstdDecompress(data)` |
| `unzipSync(data)` (gzip or zlib) | `decompressSync(data)`, which detects every format but raw deflate | `decompress(data)` |
| `gzip(data, callback)`, `promisify(gzip)` | `await compress(data, { format: 'gzip' })` | `await gzipCompressAsync(data)` |
| `createGzip()` | `new CompressionStream('gzip')` | `createGzipCompressTransform()` from `@derodero24/comprs/node` |
| `{ maxOutputLength }` | `{ maxOutputSize }` | `decompress(data, maxOutputSize)` |

- **Brotli quality.** `node:zlib` compresses brotli at quality 11 by default; comprs at 6, which is much faster. Pass `level: 11` for the output of `node:zlib`.
- **Limits.** `node:zlib` decompresses up to `buffer.kMaxLength` by default; comprs stops at 256 MiB unless you raise `maxOutputSize`, so that a small malicious input cannot exhaust memory.
- **Strictness.** comprs rejects truncated and empty input, and data after the end of the compressed stream (see [Errors and limits](/comprs/reference/errors-and-limits/)).
- **Threads.** The async functions and the streams run on the libuv thread pool, as those of `node:zlib` do.
- **Streams.** `@derodero24/comprs/node` has a `stream.Transform` factory for each format, such as `createGzipCompressTransform()`, for `stream.pipeline()`.
