---
title: Classic API
description: The functions of the package root, one per format and variant, with their async versions, dictionaries and stream contexts.
sidebar:
  order: 1
---

The package root, `@derodero24/comprs`, has a function for each format and variant. It is supported alongside the [unified API](/comprs/guides/unified-api/), which writes the same bytes at the same settings; the [API reference](/comprs/api/readme/) documents every declaration.

```ts
import { brotliCompress, gzipCompress, lz4Compress, zstdCompress, zstdDecompress } from '@derodero24/comprs';

const compressed = zstdCompress(data, 19);
const restored = zstdDecompress(compressed);
```

In the native addon, the functions return a Node.js `Buffer`; in the WebAssembly build, a `Uint8Array`. Their errors carry the codes of comprs 2.x: `InvalidArg` or `GenericFailure` in the native addon, and none in the WebAssembly build.

## One-shot functions

| Function | Description |
| --- | --- |
| `zstdCompress(data, level?)` | zstd, level -131072 to 22 (default 3) |
| `zstdDecompress(data)` | zstd, up to 256 MB of output |
| `zstdDecompressWithCapacity(data, capacity)` | **Deprecated** ([replacement](#deprecated-functions)). Zstd, with an explicit output limit |
| `gzipCompress(data, level?)` | gzip, level 0 to 9 (default 6) |
| `gzipCompressWithHeader(data, header, level?)` | gzip with a header: `filename`, `mtime` |
| `gzipReadHeader(data)` | The gzip header, without decompressing |
| `gzipDecompress(data)` | gzip |
| `gzipDecompressWithCapacity(data, capacity)` | **Deprecated** ([replacement](#deprecated-functions)). Gzip, with an explicit output limit |
| `deflateCompress(data, level?)` | Raw deflate (RFC 1951), level 0 to 9 (default 6) |
| `deflateDecompress(data)` | Raw deflate |
| `deflateDecompressWithCapacity(data, capacity)` | **Deprecated** ([replacement](#deprecated-functions)). Raw deflate, with an explicit output limit |
| `brotliCompress(data, quality?)` | brotli, quality 0 to 11 (default 6) |
| `brotliDecompress(data)` | brotli, up to 256 MB of output |
| `brotliDecompressWithCapacity(data, capacity)` | **Deprecated** ([replacement](#deprecated-functions)). Brotli, with an explicit output limit |
| `lz4Compress(data)` | LZ4 frame format, with a content checksum |
| `lz4Decompress(data)` | LZ4, including concatenated, skippable and legacy frames, up to 256 MB of output |
| `lz4DecompressWithCapacity(data, capacity)` | **Deprecated** ([replacement](#deprecated-functions)). LZ4, with an explicit output limit |
| `decompress(data, maxOutputSize?)` | zstd, gzip, brotli or LZ4, detected from the data |
| `detectFormat(data)` | A `CompressionFormat`: `'zstd'`, `'gzip'`, `'brotli'`, `'lz4'` or `'unknown'` |
| `crc32(data, initialValue?)` | CRC-32, incrementally from `initialValue` |
| `version()` | The version of the library |

`detectFormat()` returns a member of the `CompressionFormat` enum. Compare it with a member, such as `CompressionFormat.Zstd`, which also lets TypeScript check that a `switch` over the members handles every format, or with the member's value. Like the object that TypeScript compiles an enum into, `CompressionFormat` has a plain property for each member.

## Dictionaries

| Function | Description |
| --- | --- |
| `zstdTrainDictionary(samples, maxDictSize?)` | Train a zstd dictionary (default up to 110 KB, at most 16 MB) |
| `zstdCompressWithDict(data, dict, level?)` | **Deprecated** ([replacement](#deprecated-functions)). Zstd with a dictionary |
| `zstdDecompressWithDict(data, dict)` | **Deprecated** ([replacement](#deprecated-functions)). Zstd with a dictionary |
| `zstdDecompressWithDictWithCapacity(data, dict, capacity)` | **Deprecated** ([replacement](#deprecated-functions)). Zstd with a dictionary and an explicit output limit |
| `brotliCompressWithDict(data, dict, quality?)` | **Deprecated** ([replacement](#deprecated-functions)). Brotli with a custom dictionary |
| `brotliDecompressWithDict(data, dict)` | **Deprecated** ([replacement](#deprecated-functions)). Brotli with a custom dictionary |
| `brotliDecompressWithDictWithCapacity(data, dict, capacity)` | **Deprecated** ([replacement](#deprecated-functions)). Brotli with a custom dictionary and an explicit output limit |

See [Dictionaries](/comprs/guides/dictionaries/) for prepared dictionaries, which are much faster for small messages.

## Deprecated functions

The `*WithCapacity`, `*WithDict` and `*WithDictWithCapacity` functions of the package root, and their `*Async` forms, are deprecated in favor of options of the unified API ([#577](https://github.com/derodero24/comprs/issues/577)). They keep working in 2.x, and editors show them struck through. Each maps to a call of [`@derodero24/comprs/next`](/comprs/guides/unified-api/):

| Deprecated | Replacement |
| --- | --- |
| `zstdDecompressWithCapacity(data, capacity)` | `decompressSync(data, { format: 'zstd', maxOutputSize: capacity })` |
| `gzipDecompressWithCapacity(data, capacity)` | `decompressSync(data, { format: 'gzip', maxOutputSize: capacity })` |
| `deflateDecompressWithCapacity(data, capacity)` | `decompressSync(data, { format: 'deflate-raw', maxOutputSize: capacity })` |
| `brotliDecompressWithCapacity(data, capacity)` | `decompressSync(data, { format: 'brotli', maxOutputSize: capacity })` |
| `lz4DecompressWithCapacity(data, capacity)` | `decompressSync(data, { format: 'lz4', maxOutputSize: capacity })` |
| `zstdCompressWithDict(data, dict, level?)` | `compressSync(data, { format: 'zstd', dictionary: dict, level })` |
| `zstdDecompressWithDict(data, dict)` | `decompressSync(data, { format: 'zstd', dictionary: dict })` |
| `zstdDecompressWithDictWithCapacity(data, dict, capacity)` | `decompressSync(data, { format: 'zstd', dictionary: dict, maxOutputSize: capacity })` |
| `brotliCompressWithDict(data, dict, quality?)` | `compressSync(data, { format: 'brotli', dictionary: dict, level: quality })` |
| `brotliDecompressWithDict(data, dict)` | `decompressSync(data, { format: 'brotli', dictionary: dict })` |
| `brotliDecompressWithDictWithCapacity(data, dict, capacity)` | `decompressSync(data, { format: 'brotli', dictionary: dict, maxOutputSize: capacity })` |

The `*Async` form of each maps to `await compress(...)` or `await decompress(...)` with the same options, which also take an `AbortSignal`. Each side decompresses what the other compresses. The replacements differ in these ways:

- They return a `Uint8Array` rather than a `Buffer` in Node.js. Where a `Buffer` is needed, `Buffer.from(result.buffer, result.byteOffset, result.byteLength)` wraps it without a copy.
- An empty dictionary, which the deprecated functions take as no dictionary, fails with `ERR_COMPRS_INVALID_ARG`: leave `dictionary` out instead.
- Errors carry the codes of the unified API (see [Errors and limits](/comprs/reference/errors-and-limits/)).
- For many small messages, a `Dictionary` in place of the bytes digests a zstd dictionary once rather than on every call (see [Prepared dictionaries](/comprs/guides/dictionaries/)).

## Async functions

Every one-shot and dictionary function has an `Async` variant, such as `zstdCompressAsync(data, level?)`, `brotliDecompressAsync(data)`, `zstdTrainDictionaryAsync(samples, maxDictSize?)` and `decompressAsync(data, maxOutputSize?)`, except `gzipCompressWithHeader()`, `gzipReadHeader()`, `detectFormat()`, `crc32()` and `version()`. In the native addon they run on the libuv thread pool; in browsers, on the calling thread.

```ts
const compressed = await zstdCompressAsync(data, 19);
const restored = await gzipDecompressAsync(gzipped);
```

- They report every error through the returned Promise, invalid arguments included: they reject with the error that the synchronous function throws for the same arguments and never throw themselves.
- They copy their input on the calling thread before they hand the work to the thread pool, and keep no reference to it, so changing or transferring the input once the call has returned is safe. The copy blocks the event loop for about 0.6 ms per MB; for very large inputs, call them from a worker thread.
- They take no `AbortSignal`; the async functions of the unified API do.

## Stream contexts

| Compression | Decompression |
| --- | --- |
| `ZstdCompressContext(level?)` | `ZstdDecompressContext(maxOutputSize?)` |
| `ZstdCompressDictContext(dict, level?)` | `ZstdDecompressDictContext(dict, maxOutputSize?)` |
| `GzipCompressContext(level?)` | `GzipDecompressContext(maxOutputSize?)` |
| `DeflateCompressContext(level?)` | `DeflateDecompressContext(maxOutputSize?)` |
| `BrotliCompressContext(quality?)` | `BrotliDecompressContext(maxOutputSize?)` |
| `BrotliCompressDictContext(dict, quality?, options?)` | `BrotliDecompressDictContext(dict, maxOutputSize?)` |
| `Lz4CompressContext()` | `Lz4DecompressContext(maxOutputSize?, options?)` |

Each has `transform(chunk)`, `flush()`, `finish()`, their `Async` variants, and `close()`; see [Stream contexts](/comprs/guides/streaming/#stream-contexts).

## Numeric arguments

Levels, qualities, `capacity`, `maxOutputSize`, `maxDictSize`, the `crc32()` initial value and the gzip header `mtime` must be integers in their documented ranges. Other numbers, such as `NaN`, `Infinity` and `1.5`, or a level or `mtime` of `2 ** 32`, throw an error that names the argument and its range instead of being converted to a valid value. `capacity` and `maxOutputSize` range from 0 to `Number.MAX_SAFE_INTEGER`, and a limit of 0 accepts only data that decompresses to nothing; `maxDictSize` ranges from 0 to 16 MiB (16777216).
