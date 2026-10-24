---
title: From pako
description: Replace pako's gzip, zlib and raw deflate functions with comprs.
sidebar:
  order: 1
---

pako is a JavaScript port of zlib. comprs reads and writes the same three formats, gzip, zlib and raw deflate, with native code in Node.js, Deno and Bun and WebAssembly in browsers, and adds zstd, brotli and LZ4.

```diff
- import pako from 'pako';
- const compressed = pako.gzip(data, { level: 9 });
- const restored = pako.ungzip(compressed);
+ import { compressSync, decompressSync } from '@derodero24/comprs/next';
+ const compressed = compressSync(data, { format: 'gzip', level: 9 });
+ const restored = decompressSync(compressed, { format: 'gzip' });
```

| pako | comprs (`@derodero24/comprs/next`) | comprs (package root) |
| --- | --- | --- |
| `gzip(data, { level })` | `compressSync(data, { format: 'gzip', level })` | `gzipCompress(data, level)` |
| `ungzip(data)` | `decompressSync(data, { format: 'gzip' })` | `gzipDecompress(data)` |
| `deflate(data)` (zlib) | `compressSync(data, { format: 'deflate' })` | none |
| `inflate(data)` (zlib or gzip) | `decompressSync(data)`, which detects zlib and gzip | none |
| `deflateRaw(data)` | `compressSync(data, { format: 'deflate-raw' })` | `deflateCompress(data)` |
| `inflateRaw(data)` | `decompressSync(data, { format: 'deflate-raw' })` | `deflateDecompress(data)` |
| `new Deflate()`, `push()` (zlib) | `new CompressionStream('deflate')` | none |
| `new Deflate({ raw: true })` | `new CompressionStream('deflate-raw')`, or a `DeflateCompressContext` | `createDeflateCompressStream()` |
| `new Deflate({ gzip: true })` | `new CompressionStream('gzip')`, or a `GzipCompressContext` | `createGzipCompressStream()` |
| `gzip(data, { header: { name } })` | `compressSync(data, { format: 'gzip', gzipHeader: { filename } })` | `gzipCompressWithHeader(data, { filename })` |

- **zlib and raw deflate.** pako's `deflate()` writes zlib data, as `'deflate'` of the unified API does. The `deflateCompress()` function of the package root writes raw deflate, like pako's `deflateRaw()`.
- **Results.** The unified API returns a `Uint8Array`, as pako does. The functions of the package root return a Node.js `Buffer` in the native addon, which is a `Uint8Array` too.
- **Strings.** comprs takes and returns bytes only: encode a string with `new TextEncoder().encode(text)`, and decode the result with `new TextDecoder().decode(bytes)`.
- **Errors.** comprs throws an `Error` with a [code](/comprs/reference/errors-and-limits/) for invalid, truncated and oversized data, and stops at a decompression limit of 256 MiB by default.
- **Dictionaries.** pako's deflate dictionaries have no counterpart in comprs, which has dictionaries for zstd and brotli instead.
