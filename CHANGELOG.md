# comprs

## 2.1.0

### Minor Changes

- 9ddb3cd: Stop building and publishing `@derodero24/comprs-wasm32-wasi`, the WASI
  build of the native addon; 2.0.2 is its last version. Since 2.0.2 it was no
  longer an optional dependency of `@derodero24/comprs`, so it was only used
  where it had been installed by hand. Node.js, Deno and Bun keep loading the
  native addon for their platform. The wasm-bindgen build, which the
  package's `browser` entry loads, is now the only WebAssembly build.
  
  If you installed `@derodero24/comprs-wasm32-wasi` or set
  `NAPI_RS_FORCE_WASI`, uninstall the package and unset the variable: on a
  supported platform the native addon loads instead, and in browsers the
  wasm-bindgen build. The generated loader still looks for the WASI package
  when no native binary loads or when `NAPI_RS_FORCE_WASI` is `true` or
  `error`, so a copy left in `node_modules` would be loaded with a newer
  `@derodero24/comprs` whose API it does not match. On a platform without a
  native binary, loading comprs in Node.js, Deno or Bun throws `Cannot find
  native binding`; if you relied on the WASI build there, stay on
  `@derodero24/comprs` 2.0.x.

### Patch Changes

- 74cece7: Enforce `maxOutputSize` while streaming decompression runs instead of after
  each chunk. The gzip, deflate and brotli decompression streams and contexts
  used to inflate a whole input chunk before checking the limit, so one small,
  highly compressed chunk could allocate gigabytes before the size-limit error.
  They now stop as soon as the output would exceed the limit, keeping memory
  near `maxOutputSize`. `finish()` on `GzipDecompressContext` and
  `DeflateDecompressContext` now counts its output toward the limit too.
  
  Reject truncated input instead of returning a shorter result. The zstd,
  brotli and raw deflate decompression streams, `DeflateDecompressContext` and
  the `deflateDecompress*()` functions used to succeed with whatever had been
  decoded when the input ended mid-stream; they now throw `<format> stream is
  truncated: unexpected end of input`. The zstd and brotli decompression
  contexts gain a `finish()` method that performs this check, and their
  streams, including the auto-detecting ones, call it when their input ends.
  
  Empty input now throws for every format, in the one-shot functions and in
  the streams alike, because no format has a valid zero-length encoding.
  `zstdDecompress*()`, `deflateDecompress*()`, `lz4Decompress*()` and most
  decompression streams used to return an empty result for it.
- 15b4d0b: Stop gzip decompression from reserving memory because of a forged size
  trailer. `gzipDecompress()`, `gzipDecompressWithCapacity()`, their async
  variants and `decompress()` sized their initial output buffer from the
  ISIZE trailer, which nothing verifies until decoding ends, so a few bytes of
  input could reserve up to 4 GiB, capped only by the output limit (256 MB by
  default). The initial buffer is now also capped by what the input can
  expand to and by 64 MiB, and larger outputs grow the buffer as they decode.
  gzip, brotli and LZ4 decompression also report a failed reservation of the
  initial output buffer as an error instead of aborting the process.
- 54bf460: Fix a crash in Bun and Deno when a method of a native context class is
  called with an instance of another context class as `this`, such as
  `ZstdCompressContext.prototype.transform.call(gzipContext, chunk)`. The
  method used the other class's native state as its own, and the process
  crashed with a segmentation fault. It now throws an `InvalidArg` error;
  Node.js already rejected such calls with `Illegal invocation`.
  
  The fix comes with the update of the native addon to napi 3.13.0,
  napi-derive 3.6.9 and napi-build 2.5.0, which tag every class instance
  and check the tag before a method uses it. The crates were held at 3.9.1 /
  3.5.6 / 2.3.2 for the WASI build, which is no longer published. The
  JavaScript API, the TypeScript types and the generated loader are
  unchanged.
- 15b4d0b: Size zstd one-shot decompression output from the data instead of reserving
  it up front. `zstdDecompress()`, `zstdDecompressWithDict()`, their async
  variants and `decompress()` reserved 256 MB for every frame without a
  content size, which streaming encoders such as `ZstdCompressContext` write,
  and the `*WithCapacity()` variants allocated the whole `capacity`, so a value
  such as `2 ** 40` aborted the process. The output buffer now grows with the
  decompressed data: frames that declare their size still decode straight
  into a buffer of that size, as long as the input could actually expand to
  it, and everything else goes through the streaming decoder. `capacity` is
  only a limit, and output over it throws `zstd decompress exceeded maximum
  size of <capacity> bytes` like the other formats, instead of `Destination
  buffer is too small`.
  
  The one-shot zstd functions now accept concatenated frames and skippable
  frames, as the streaming API already did, and report truncated input as
  `zstd stream is truncated: unexpected end of input`; data after the last
  frame now usually reports `Unknown frame descriptor` instead of `Src size is
  incorrect`. Like the streaming API and `zstd -d`, they reject a frame
  without a content size whose window exceeds 128 MiB (written by
  `zstd --long=28` or higher on piped input) with `Frame requires too much
  memory for decoding`.
- 15b4d0b: Reject a `maxDictSize` above 16 MiB (16777216 bytes) in
  `zstdTrainDictionary()` and `zstdTrainDictionaryAsync()`. The value was
  allocated up front, so one that could not be allocated, such as `2 ** 40`,
  aborted the process (a trap in the WASM build). zstd recommends
  dictionaries of about 100 KB, and training allocates several buffers of
  `maxDictSize` bytes.

## 2.0.2

### Patch Changes

- 5d9d464: Update the `brotli` crate to 9.0 (with `brotli-decompressor` 6.0) and the
  Criterion benchmark harness to `codspeed-criterion-compat` 5.0. The brotli
  API and output format used by comprs are unchanged; this ships in the
  native binary and WASM build.
- b1ddd73: Regenerate the napi-rs loaders with `@napi-rs/cli` 3.9.1. The browser WASI
  loader shipped in `@derodero24/comprs-wasm32-wasi` keeps lazy worker reuse
  (`reuseWorker: true`): the eager worker pool that 3.9 generates makes
  `@emnapi/wasi-threads` call Node-only worker APIs under Bun and Deno.
- 480795f: Update Rust crate dependencies to their latest semver-compatible versions
  (zstd 0.14, lz4_flex 0.14, brotli 8.0.4, crc32fast 1.5.1, wasm-bindgen
  0.2.128, js-sys 0.3.105, thiserror 2.0.20, and transitive crates). flate2
  stays pinned at 1.1.9 because 1.1.10 regresses gzip and deflate throughput
  with the zlib-rs backend, and the napi crates stay at 3.9.1 / 3.5.6 / 2.3.2
  because the 3.12 line links against emnapi 2 for the WASI target. These
  compile into the published native binary and WASM build.

## 2.0.1

### Patch Changes

- aa90292: Regenerate the napi-rs loader with `@napi-rs/cli` 3.7.2. The generated
  `index.js` drops the `node:` import prefix and optional chaining (`?.`) from
  its native-binding loader, improving compatibility with older Node.js
  versions and bundlers that don't support these syntax forms.
- 5099f17: Regenerate the napi-rs loader with `@napi-rs/cli` 3.7. The generated
  `index.js` now treats `NAPI_RS_FORCE_WASI` as a tri-state flag: only `'true'`
  or `'error'` force the WASI fallback, so values like `NAPI_RS_FORCE_WASI=false`
  or `=0` no longer inadvertently trigger the WASI path (which could fail with
  ENOENT for packages shipped without a `.wasi.cjs` file).
- 3f50b0a: Update Rust crate dependencies to their latest semver-compatible versions
  (brotli, lz4_flex, napi/napi-derive/napi-build, wasm-bindgen, js-sys,
  criterion, and transitive crates). These compile into the published native
  binary and WASM build.

## 2.0.0

### Major Changes

- da8d285: Drop Node.js 20 support and bump napi ABI to napi9.

  Node.js 20 reached end-of-life on 2026-04-30. The minimum supported Node.js
  version is now 22 (Active LTS). The napi-rs ABI feature has been bumped from
  `napi6` to `napi9` (Node 18.17+ / 20.3+), which is safe under the new floor.

  **Breaking change:** Users on Node.js 20 must upgrade to Node.js 22 or later.

## 1.1.0

### Minor Changes

- 673c726: Performance improvements: gzip ISIZE buffer pre-allocation, zstd multi-threaded compression (zstdmt), streaming buffer reuse

## 1.0.1

### Patch Changes

- af5c0b8: Fix missing zstdDecompressWithDictWithCapacityAsync ESM export and sync Cargo.toml versions

## 1.0.0

### Major Changes

- 796774f: First stable release with wasm-bindgen browser support (no SharedArrayBuffer required), three-crate architecture, and full algorithm coverage (zstd, gzip, brotli, lz4)

## 0.4.1

### Patch Changes

- 5130974: Fix npm publish for scoped platform packages by adding publishConfig and release workflow permissions

## 0.4.0

### Minor Changes

- 3ac395a: Add Brotli dictionary compression and decompression support

## 0.3.1

### Patch Changes

- 38a3787: Enforce maxOutputSize in browser WASM ZstdDecompressDictContext by adding zstdDecompressWithDictWithCapacity
- 764ba82: Use `decompress_with_limit` in async auto-detect decompression for gzip and brotli, replacing manual chunk-read loops that performed a double-copy through an intermediate stack buffer.
- ad5add2: Fix missing validation for maxDictSize parameter in zstdTrainDictionary

## 0.3.0

### Minor Changes

- c23b4e6: Add brotli compression/decompression support via `brotliCompress()` and `brotliDecompress()` functions. Includes streaming API with `createBrotliCompressStream()` and `createBrotliDecompressStream()`. Quality levels 0-11 (default: 6).
- 98e64a9: Add gzip and raw deflate compression/decompression support via `gzipCompress()`, `gzipDecompress()`, `deflateCompress()`, `deflateDecompress()` functions. Includes streaming API with `createGzipCompressStream()`, `createGzipDecompressStream()`, `createDeflateCompressStream()`, and `createDeflateDecompressStream()`.
- 356319f: Add LZ4 frame compression/decompression support via `lz4Compress()` and `lz4Decompress()` functions. Includes streaming API with `createLz4CompressStream()` and `createLz4DecompressStream()`, and Node.js Transform streams via `createLz4CompressTransform()` and `createLz4DecompressTransform()`. Auto-detect (`decompress()`, `detectFormat()`) now recognizes LZ4 frames.

### Patch Changes

- 49b5c2d: Rename package from `zflate` to `comprs` to avoid npm typosquat protection.

## 0.2.0

### Minor Changes

- fb7c15f: Add streaming compression/decompression API using Web Streams API (`TransformStream`). New functions `createZstdCompressStream()` and `createZstdDecompressStream()` enable chunked processing of large data with bounded memory usage. Streaming output is fully interoperable with one-shot `zstdCompress()`/`zstdDecompress()`.
- 9ceb306: Add zstd compression and decompression support via `zstdCompress()`, `zstdDecompress()`, and `zstdDecompressWithCapacity()` functions. Supports compression levels 1-22 (default: 3) and negative levels for fast mode.
