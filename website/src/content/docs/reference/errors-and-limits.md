---
title: Errors and limits
description: Error codes, the default decompression limit, strict decoding of truncated data, and zstd window limits.
sidebar:
  order: 2
---

comprs is built to decompress untrusted data: it stops at a size limit, rejects truncated and trailing data, and checks every argument.

## Error codes

The errors that the [unified API](/comprs/guides/unified-api/) raises have a `code`. Errors that come from the caller, such as one thrown by a getter of an options object or by the iterator of the samples, and the `reason` of an aborted `signal`, are passed on unchanged, without one.

| `code` | When |
| --- | --- |
| `ERR_COMPRS_INVALID_ARG` | An argument or an option is invalid: of the wrong type, out of range, or not for the format. The error is a `TypeError` |
| `ERR_COMPRS_UNKNOWN_FORMAT` | Decompression without a `format` could not detect the format of the data, empty data included |
| `ERR_COMPRS_CORRUPT_DATA` | The data is not valid in its format, or has data after the end of the compressed stream |
| `ERR_COMPRS_TRUNCATED` | The data ends before the end of the compressed stream, as empty data in a given `format` does |
| `ERR_COMPRS_SIZE_LIMIT` | The output would exceed `maxOutputSize`, or, under a `maxOutputSize` of 64 MiB or less, a zstd frame declares a window larger than the limit allows |
| `ERR_COMPRS_STREAM_FINISHED` | A stream was used after it finished |
| `ERR_COMPRS_STREAM_CLOSED` | A stream was used after it was closed |
| `ERR_COMPRS_OPERATION_FAILED` | Any other failure, such as a failed allocation, or dictionary training that found too little to learn from |

Every error but `ERR_COMPRS_INVALID_ARG` is a plain `Error`. `ERR_COMPRS_STREAM_FINISHED` and `ERR_COMPRS_STREAM_CLOSED` report a misuse of a stream, not a problem with the data. New codes may be added in minor releases, so treat a code that this table does not list as a failure of its own. The `ErrorCode` type lists them.

The functions of the package root keep the codes of comprs 2.x: `InvalidArg` or `GenericFailure` in the native addon, and none in the WebAssembly build. Their messages name the problem, such as `zstd stream is truncated: unexpected end of input` or `... exceeded maximum size of <limit> bytes`.

## Decompression limit

All decompression stops at 256 MiB of output by default, so that a small malicious input cannot expand to gigabytes. Raise the limit with `maxOutputSize` in the unified API and the streams, or with the `maxOutputSize` argument of `decompress()` in the package root:

```ts
decompressSync(data, { maxOutputSize: 1024 * 1024 * 1024 }); // 1 GiB
```

The `*WithCapacity()` functions of the package root take the limit too, but are [deprecated](/comprs/reference/classic-api/#deprecated-functions).

The limit is not an allocation size: output buffers grow with the decompressed data, so a large limit reserves no memory up front, and size fields in the input, such as the zstd frame content size or the gzip size trailer, are trusted only as far as the input can expand. Streams enforce the limit while they decode: memory stays near the limit even when a single small chunk would expand to gigabytes.

### zstd windows

A zstd frame header can declare a window, or for a single-segment frame a content size, of up to 128 MiB, which the streaming decoder allocates as soon as it has read the header, before it writes any output. Stream contexts decode every frame this way; the one-shot functions decode frames that declare their content size in one pass into a buffer of that size, which the limit bounds, and only other input, such as frames without a content size, this way.

The limit also bounds the window, to the limit rounded up to a power of two but at least 8 MiB, enough for the frames that zstd writes at levels up to 19, and at most zstd's own bound of 128 MiB. A limit of 64 MiB or less lowers zstd's bound: a frame whose window exceeds the lowered bound fails with the size-limit error instead of reserving the window. Raising the limit decodes such a frame if its window is at most 128 MiB. A limit of more than 64 MiB, such as the default, keeps zstd's bound of 128 MiB, and a frame whose window exceeds it fails with zstd's `Frame requires too much memory for decoding` corrupt-data error.

## Truncated, empty and trailing data

zstd, gzip, deflate and brotli decompression fail when the input ends before the compressed stream does, so an interrupted download or a partial file is never returned as a shorter result. Streams check this when their input ends; the decompression contexts check it in `finish()`.

Empty input fails for every format, because no format has a valid zero-length encoding (`node:zlib` rejects it for gzip, deflate and brotli too). Data after the end of the compressed stream fails too, except further zstd and LZ4 frames and gzip members, which are decompressed one after the other.

Once a decompression context has failed, its later calls fail too, `finish()` included, so that the output decoded before the bad data is never returned as a whole result.

## Format detection

zstd, gzip, zlib and LZ4 are recognized by their headers. Brotli has none, so it is recognized heuristically, by decoding up to the first 64 KiB of the data: a truncated brotli stream, or other data that happens to pass for brotli, fails with the same error as data of unknown format. Raw deflate cannot be detected: pass its format. The `decompress()` function of the package root detects zstd, gzip, brotli and LZ4, but not zlib.

## Numeric arguments

Levels, limits, sizes and the gzip `mtime` must be integers in their ranges. Other numbers, such as `NaN`, `Infinity` and `1.5`, or a level or `mtime` of `2 ** 32`, fail with an error that names the argument and its range instead of being converted to a valid value. Limits range from 0 to `Number.MAX_SAFE_INTEGER` on every platform, and a limit of 0 accepts only data that decompresses to nothing.
