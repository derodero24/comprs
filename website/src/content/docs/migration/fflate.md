---
title: From fflate
description: Replace fflate's gzip, zlib and deflate functions with comprs.
sidebar:
  order: 2
---

fflate is a fast pure-JavaScript implementation of gzip, zlib, raw deflate and ZIP. comprs covers the same compression formats, but not ZIP archives, and adds zstd, brotli and LZ4, dictionaries for zstd and brotli, and Web Streams.

```diff
- import { gzipSync, gunzipSync } from 'fflate';
- const compressed = gzipSync(data, { level: 9 });
- const restored = gunzipSync(compressed);
+ import { compressSync, decompressSync } from '@derodero24/comprs/next';
+ const compressed = compressSync(data, { format: 'gzip', level: 9 });
+ const restored = decompressSync(compressed, { format: 'gzip' });
```

| fflate | comprs (`@derodero24/comprs/next`) | comprs (package root) |
| --- | --- | --- |
| `gzipSync(data, { level })` | `compressSync(data, { format: 'gzip', level })` | `gzipCompress(data, level)` |
| `gunzipSync(data)` | `decompressSync(data, { format: 'gzip' })` | `gzipDecompress(data)` |
| `zlibSync(data)` | `compressSync(data, { format: 'deflate' })` | none |
| `unzlibSync(data)` | `decompressSync(data, { format: 'deflate' })` | none |
| `deflateSync(data)` (raw) | `compressSync(data, { format: 'deflate-raw' })` | `deflateCompress(data)` |
| `inflateSync(data)` (raw) | `decompressSync(data, { format: 'deflate-raw' })` | `deflateDecompress(data)` |
| `decompressSync(data)` | `decompressSync(data)`, which detects gzip and zlib | `decompress(data)`, which detects gzip |
| `gzip(data, callback)` | `await compress(data, { format: 'gzip' })` | `await gzipCompressAsync(data)` |
| `new Gzip()`, `push()` | `new CompressionStream('gzip')`, or a `GzipCompressContext` | `createGzipCompressStream()` |
| `strToU8()`, `strFromU8()` | `TextEncoder`, `TextDecoder` | |

- **Asynchronous calls.** fflate's callback functions run on Web Workers; comprs's async functions run on the libuv thread pool in Node.js, and on the calling thread in browsers.
- **Dictionaries.** fflate's deflate dictionaries (its `dictionary` option) have no counterpart in comprs.
- **ZIP.** comprs does not read or write ZIP archives: keep fflate for those.
