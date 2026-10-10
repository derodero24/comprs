<div align="center">

# comprs

Rust-powered universal compression for JavaScript/TypeScript.
**zstd**, **gzip**, **brotli**, and **lz4** in one package.

[![npm version](https://img.shields.io/npm/v/%40derodero24%2Fcomprs)](https://www.npmjs.com/package/@derodero24/comprs)
[![npm downloads](https://img.shields.io/npm/dm/%40derodero24%2Fcomprs)](https://www.npmjs.com/package/@derodero24/comprs)
[![CI](https://github.com/derodero24/comprs/actions/workflows/ci.yml/badge.svg)](https://github.com/derodero24/comprs/actions/workflows/ci.yml)
[![codecov](https://codecov.io/gh/derodero24/comprs/graph/badge.svg)](https://codecov.io/gh/derodero24/comprs)
[![CodSpeed](https://img.shields.io/endpoint?url=https://codspeed.io/badge.json&repo=derodero24/comprs)](https://codspeed.io/derodero24/comprs)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D22-brightgreen)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-ready-blue)](https://www.typescriptlang.org/)
[![Playground](https://img.shields.io/badge/playground-try%20it%20live-8b5cf6)](https://derodero24.github.io/comprs/)

**[→ Try the live playground](https://derodero24.github.io/comprs/)**

</div>

## Table of Contents

- [Why comprs?](#why-comprs)
- [Comparison with Alternatives](#comparison-with-alternatives)
- [Installation](#installation)
- [Quick Start](#quick-start)
- [Choosing an Algorithm](#choosing-an-algorithm)
- [API](#api)
- [Supported Algorithms](#supported-algorithms)
- [Platform Support](#platform-support)
- [Browser Usage](#browser-usage)
- [Migration](#migration)
- [Benchmarks](#benchmarks)
- [Contributing](#contributing)

## Why comprs?

The JavaScript compression ecosystem is fragmented across 12+ packages with inconsistent APIs and mixed maintenance status. comprs consolidates this into a single, fast, well-typed library:

- **Native performance** — Rust core compiled via napi-rs, with a WebAssembly build for browsers
- **Unified API** — Same interface for zstd, gzip, brotli, and lz4
- **Streaming** — Web Streams API (`TransformStream`) for processing large data with bounded memory, in Node.js and browsers, except LZ4 decompression and brotli-dictionary compression streams, which buffer the whole input (see [Notes](#notes))
- **Universal** — Node.js, Deno, and Bun (native), and browsers (WebAssembly)
- **Zero JS dependencies** — Only Rust and the platform
- **Interactive playground** — [Try any algorithm live in your browser](https://derodero24.github.io/comprs/), no install needed

## Comparison with Alternatives

| Feature | comprs | pako | fflate | node:zlib |
| --- | :---: | :---: | :---: | :---: |
| zstd | ✅ | ❌ | ❌ | ⚠️ Experimental* |
| gzip/deflate | ✅ | ✅ | ✅ | ✅ |
| brotli | ✅ | ❌ | ❌ | ✅ |
| lz4 | ✅ | ❌ | ❌ | ❌ |
| Web Streams API | ✅ | ❌ | ❌ | ❌ |
| Node.js Transform | ✅ | ❌ | ❌ | ✅ |
| Streaming | ✅ | Chunked† | ✅ | ✅ |
| Browser | ✅ | ✅ | ✅ | ❌ |
| Deno/Bun | ✅ | ✅ | ✅ | ✅‡ |
| Native performance | ✅ | ❌ | ❌ | ✅ |
| TypeScript | ✅ | ✅ | ✅ | ✅ |
| Dictionary | zstd, brotli | deflate | deflate | deflate; zstd (Node.js 22.19+, 24.6+) |
| Zero JS deps | ✅ | ✅ | ✅ | ✅ |

\* `node:zlib` zstd support requires Node.js ≥ 22.15 and is experimental\
† pako uses chunked `Inflate`/`Deflate` classes, not the Web Streams API\
‡ Deno 2 and Bun implement `node:zlib`

## Installation

```bash
npm install @derodero24/comprs
# or
pnpm add @derodero24/comprs
# or
yarn add @derodero24/comprs
# or
bun add @derodero24/comprs
```

## Quick Start

> **Try it live** → [derodero24.github.io/comprs](https://derodero24.github.io/comprs/)

```typescript
import { zstdCompress, zstdDecompress } from '@derodero24/comprs';

const data = Buffer.from('Hello, comprs!');
const compressed = zstdCompress(data);
const decompressed = zstdDecompress(compressed);
```

All algorithms use the same pattern:

```typescript
import { gzipCompress, brotliCompress, lz4Compress } from '@derodero24/comprs';

const gzipped = gzipCompress(data);    // gzip
const brotlied = brotliCompress(data); // brotli
const lz4ed = lz4Compress(data);       // lz4
```

### Streaming (Web Streams API)

```typescript
import { createGzipCompressStream } from '@derodero24/comprs/streams';

const response = await fetch('https://example.com/data.json');
if (!response.body) throw new Error('Response has no body');

// Pipe through a compression TransformStream
const compressed = response.body.pipeThrough(createGzipCompressStream());
```

### Streaming (Node.js Transform)

```typescript
import { createGzipCompressTransform } from '@derodero24/comprs/node';
import { pipeline } from 'node:stream/promises';
import { createReadStream, createWriteStream } from 'node:fs';

await pipeline(
  createReadStream('input.txt'),
  createGzipCompressTransform(),
  createWriteStream('output.gz'),
);
```

### Auto-detect

```typescript
import { decompress } from '@derodero24/comprs';

// Works with any supported format — no need to know the algorithm
const decompressed = decompress(compressedData);

// Limit the decompressed size (default: 256 MB)
const limited = decompress(compressedData, 10 * 1024 * 1024);
```

zstd, gzip and LZ4 are recognized by their magic numbers. Brotli has none, so it is recognized heuristically, by decoding up to the first 64 KiB of the data: a truncated brotli stream, or other data that happens to pass for brotli, makes `decompress()` throw the same error as data of unknown format. The auto-detecting streams buffer up to 64 KiB of input to detect the format. Raw deflate cannot be detected: use `deflateDecompress()` for it.

`detectFormat()` returns the format, without decompressing, as a member of the `CompressionFormat` enum. Compare it with a member, such as `CompressionFormat.Zstd`, which also lets TypeScript check that a `switch` over the members handles every format, or with the member's value, one of the strings `'zstd'`, `'gzip'`, `'brotli'`, `'lz4'` and `'unknown'`. The members are not enumerable: `Object.keys(CompressionFormat)` and `Object.values(CompressionFormat)` return `[]`, so use them by name.

### Async

```typescript
import { gzipCompressAsync, gzipDecompressAsync } from '@derodero24/comprs';

// In Node.js, runs on the libuv thread pool — keeps the event loop free
const compressed = await gzipCompressAsync(largeData);
const decompressed = await gzipDecompressAsync(compressed);
```

### Compression levels

```typescript
import { zstdCompress } from '@derodero24/comprs';

zstdCompress(data, 1);   // fast compression
zstdCompress(data);      // default (level 3)
zstdCompress(data, 22);  // best compression
zstdCompress(data, -1);  // fast mode with negative levels
```

### Dictionary compression

```typescript
import { zstdTrainDictionary, zstdCompressWithDict, zstdDecompressWithDict } from '@derodero24/comprs';

// Train from samples of similar data
const dict = zstdTrainDictionary(samples);

// Compress/decompress with dictionary
const compressed = zstdCompressWithDict(data, dict);
const decompressed = zstdDecompressWithDict(compressed, dict);
```

```typescript
// Brotli dictionary (no training step — provide raw dictionary bytes)
import { brotliCompressWithDict, brotliDecompressWithDict } from '@derodero24/comprs';

const dict = Buffer.from('{"id":0,"name":"","email":"@example.com"}'.repeat(10));
const compressed = brotliCompressWithDict(data, dict);
const decompressed = brotliDecompressWithDict(compressed, dict);
```

### Deno / Bun

```typescript
// Deno
import { gzipCompress } from 'npm:@derodero24/comprs';

// Bun (same as Node.js)
import { gzipCompress } from '@derodero24/comprs';
```

Both runtimes load the native addon, as Node.js does. Deno needs permission for it: run with `--allow-ffi --allow-read --allow-env`, or `--allow-all`. Without `--allow-ffi`, the import fails with a misleading `Cannot find native binding` error, which blames a bug in npm. Deno also needs a local `node_modules` directory, which holds the platform package with the binary: set `"nodeModulesDir": "auto"` in `deno.json`, or install the package into a local `node_modules` with npm.

## Choosing an Algorithm

| Use case | Recommended | Why |
| --- | --- | --- |
| Web asset delivery (CDN, HTTP) | **brotli** | Best compression ratio; native browser `Accept-Encoding` support |
| General-purpose file compression | **zstd** | Fastest all-round with excellent compression ratio |
| Real-time data / logging / IPC | **lz4** | Lowest latency; optimized for speed over ratio |
| Legacy systems / maximum compatibility | **gzip** | Universal support; every tool and platform can decompress |
| Many small similar records (JSON, logs) | **zstd + dictionary** | Dictionary pre-seeds the compressor with expected patterns |
| Brotli with domain-specific data | **brotli + dictionary** | Custom dictionary for repeated structures without training |

### Choosing an API mode

| Mode | When to use |
| --- | --- |
| **Sync** (`zstdCompress`) | Small data (< 1 MB), low-latency requirements, scripts |
| **Async** (`zstdCompressAsync`) | Large data or when the Node.js event loop must stay free (servers); browsers run them on the calling thread |
| **Streaming** (`createZstdCompressStream`) | Unknown/unbounded data size, memory-constrained environments |
| **Dictionary** (`zstdCompressWithDict`) | Compressing many small, structurally similar items |

The Web Streams and Node.js Transforms process each chunk synchronously on the calling thread, so the event loop is blocked while a chunk is compressed or decompressed. `node:zlib` streams [use the libuv thread pool](https://nodejs.org/api/zlib.html#threadpool-usage-and-performance-considerations) instead. For large inputs where event-loop latency matters, use the `*Async` one-shot functions or a worker thread.

## API

### One-shot

#### zstd

| Function | Description |
| --- | --- |
| `zstdCompress(data, level?)` | Compress with zstd. Level: -131072 to 22 (default: 3) |
| `zstdDecompress(data)` | Decompress zstd data (max 256 MB output) |
| `zstdDecompressWithCapacity(data, capacity)` | Decompress with explicit output size limit |

#### gzip / deflate

| Function | Description |
| --- | --- |
| `gzipCompress(data, level?)` | Compress with gzip. Level: 0-9 (default: 6) |
| `gzipCompressWithHeader(data, header, level?)` | Compress with custom gzip header (filename, mtime) |
| `gzipReadHeader(data)` | Read gzip header metadata without decompressing |
| `gzipDecompress(data)` | Decompress gzip data |
| `gzipDecompressWithCapacity(data, capacity)` | Decompress with explicit output size limit |
| `deflateCompress(data, level?)` | Compress with raw deflate. Level: 0-9 (default: 6) |
| `deflateDecompress(data)` | Decompress raw deflate data |
| `deflateDecompressWithCapacity(data, capacity)` | Decompress with explicit output size limit |

#### brotli

| Function | Description |
| --- | --- |
| `brotliCompress(data, quality?)` | Compress with brotli. Quality: 0-11 (default: 6) |
| `brotliDecompress(data)` | Decompress brotli data (max 256 MB output) |
| `brotliDecompressWithCapacity(data, capacity)` | Decompress with explicit output size limit |

#### lz4

| Function | Description |
| --- | --- |
| `lz4Compress(data)` | Compress with LZ4 frame format, with a content checksum |
| `lz4Decompress(data)` | Decompress LZ4 data, including concatenated, skippable and legacy frames (max 256 MB output) |
| `lz4DecompressWithCapacity(data, capacity)` | Decompress with explicit output size limit |

#### Auto-detect

| Function | Description |
| --- | --- |
| `decompress(data, maxOutputSize?)` | Auto-detect format and decompress (zstd, gzip, brotli, lz4). `maxOutputSize` limits the output (default: 256 MB) |
| `detectFormat(data)` | Detect compression format. Returns a `CompressionFormat`: `'zstd'`, `'gzip'`, `'brotli'`, `'lz4'`, or `'unknown'` |

#### Utilities

| Function | Description |
| --- | --- |
| `crc32(data, initialValue?)` | Compute CRC32 checksum (supports incremental computation) |
| `version()` | Returns the library version |

<details>
<summary><strong>Dictionary API</strong></summary>

#### zstd Dictionary

| Function | Description |
| --- | --- |
| `zstdTrainDictionary(samples, maxDictSize?)` | Train a dictionary from sample data (default max: 110 KB, limit: 16 MB) |
| `zstdCompressWithDict(data, dict, level?)` | Compress with pre-trained dictionary |
| `zstdDecompressWithDict(data, dict)` | Decompress dictionary-compressed data |
| `zstdDecompressWithDictWithCapacity(data, dict, capacity)` | Decompress with dictionary and explicit output size limit |

#### Brotli Dictionary

| Function | Description |
| --- | --- |
| `brotliCompressWithDict(data, dict, quality?)` | Compress with custom dictionary |
| `brotliDecompressWithDict(data, dict)` | Decompress dictionary-compressed data |
| `brotliDecompressWithDictWithCapacity(data, dict, capacity)` | Decompress with explicit capacity |

</details>

### Async

All one-shot functions have async variants that run on the libuv thread pool. Append `Async` to any function name. In browsers, they run on the calling thread instead (see [Browser Usage](#browser-usage)):

```typescript
const compressed = await zstdCompressAsync(data, level);
const decompressed = await gzipDecompressAsync(compressed);
```

They report every error through the returned Promise, invalid arguments included: they reject with the error that the synchronous function throws for the same arguments and never throw themselves, so `.catch()` or `await` inside `try` handles all of them.

<details>
<summary><strong>Full async API list</strong></summary>

| Function | Description |
| --- | --- |
| `zstdCompressAsync(data, level?)` | Async zstd compression |
| `zstdDecompressAsync(data)` | Async zstd decompression |
| `zstdDecompressWithCapacityAsync(data, capacity)` | Async zstd decompression with explicit size limit |
| `zstdCompressWithDictAsync(data, dict, level?)` | Async zstd compression with dictionary |
| `zstdDecompressWithDictAsync(data, dict)` | Async zstd decompression with dictionary |
| `zstdDecompressWithDictWithCapacityAsync(data, dict, capacity)` | Async zstd decompression with dictionary and size limit |
| `zstdTrainDictionaryAsync(samples, maxDictSize?)` | Async dictionary training |
| `gzipCompressAsync(data, level?)` | Async gzip compression |
| `gzipDecompressAsync(data)` | Async gzip decompression |
| `gzipDecompressWithCapacityAsync(data, capacity)` | Async gzip decompression with explicit size limit |
| `deflateCompressAsync(data, level?)` | Async deflate compression |
| `deflateDecompressAsync(data)` | Async deflate decompression |
| `deflateDecompressWithCapacityAsync(data, capacity)` | Async deflate decompression with explicit size limit |
| `brotliCompressAsync(data, quality?)` | Async brotli compression |
| `brotliDecompressAsync(data)` | Async brotli decompression |
| `brotliDecompressWithCapacityAsync(data, capacity)` | Async brotli decompression with explicit size limit |
| `brotliCompressWithDictAsync(data, dict, quality?)` | Async brotli compression with dictionary |
| `brotliDecompressWithDictAsync(data, dict)` | Async brotli decompression with dictionary |
| `brotliDecompressWithDictWithCapacityAsync(data, dict, capacity)` | Async brotli decompression with dictionary and size limit |
| `lz4CompressAsync(data)` | Async LZ4 compression |
| `lz4DecompressAsync(data)` | Async LZ4 decompression |
| `lz4DecompressWithCapacityAsync(data, capacity)` | Async LZ4 decompression with explicit size limit |
| `decompressAsync(data, maxOutputSize?)` | Async auto-detect format and decompress, with an optional output size limit |

</details>

The `*Async` functions copy their input (data, dictionary or training samples) on the calling thread before they hand the work to the thread pool, and keep no reference to it: changing or transferring the input once the call has returned is safe and does not affect the result. The copy blocks the event loop for about 0.6 ms per MB; for very large inputs, call the functions from a worker thread.

### Streaming

Web Streams API (`TransformStream`) for all algorithms, in Node.js, Deno, Bun and browsers. Import from `@derodero24/comprs/streams`:

```typescript
import { createGzipCompressStream } from '@derodero24/comprs/streams';
```

The package root re-exports the stream helpers for `import` only, and not in browsers (see [Browser Usage](#browser-usage)); `@derodero24/comprs/streams` works with both `import` and `require()`.

These streams accept the chunks that `CompressionStream` accepts, any `ArrayBuffer` or `ArrayBufferView` (a `DataView`, a `Uint16Array`, ...), as well as a `SharedArrayBuffer`, and read them byte for byte, both with the native addon (Node.js, Deno and Bun) and in the browser build.

<details>
<summary><strong>Full streaming API list</strong></summary>

| Function | Description |
| --- | --- |
| `createZstdCompressStream(level?)` | Create a zstd compression `TransformStream` |
| `createZstdDecompressStream(maxOutputSize?)` | Create a zstd decompression `TransformStream` |
| `createGzipCompressStream(level?)` | Create a gzip compression `TransformStream` |
| `createGzipDecompressStream(maxOutputSize?)` | Create a gzip decompression `TransformStream` |
| `createDeflateCompressStream(level?)` | Create a raw deflate compression `TransformStream` |
| `createDeflateDecompressStream(maxOutputSize?)` | Create a raw deflate decompression `TransformStream` |
| `createBrotliCompressStream(quality?)` | Create a brotli compression `TransformStream` |
| `createBrotliDecompressStream(maxOutputSize?)` | Create a brotli decompression `TransformStream` |
| `createLz4CompressStream()` | Create an LZ4 compression `TransformStream` |
| `createLz4DecompressStream(maxOutputSize?)` | Create an LZ4 decompression `TransformStream` |
| `createZstdCompressDictStream(dict, level?)` | Streaming zstd compression with dictionary |
| `createZstdDecompressDictStream(dict, maxOutputSize?)` | Streaming zstd decompression with dictionary |
| `createBrotliCompressDictStream(dict, quality?)` | Streaming brotli compression with dictionary |
| `createBrotliDecompressDictStream(dict, maxOutputSize?)` | Streaming brotli decompression with dictionary |
| `createDecompressStream(maxOutputSize?)` | Auto-detect format and create a decompression `TransformStream` |

</details>

### Node.js Transform Streams

For Node.js `stream.pipeline()` compatibility, import from `@derodero24/comprs/node`. This subpath is built on `node:stream`, so it does not work in browsers:

```typescript
import { createGzipCompressTransform } from '@derodero24/comprs/node';
import { pipeline } from 'node:stream/promises';
import { createReadStream, createWriteStream } from 'node:fs';

await pipeline(
  createReadStream('input.txt'),
  createGzipCompressTransform(),
  createWriteStream('output.gz'),
);
```

The transforms push their output in chunks of at most `readableHighWaterMark` bytes (64 KiB by default), even when a single small input chunk decompresses to many megabytes.

<details>
<summary><strong>Full Node.js Transform API list</strong></summary>

| Function | Description |
| --- | --- |
| `createZstdCompressTransform(level?)` | Node.js Transform for zstd compression |
| `createZstdDecompressTransform(maxOutputSize?)` | Node.js Transform for zstd decompression |
| `createGzipCompressTransform(level?)` | Node.js Transform for gzip compression |
| `createGzipDecompressTransform(maxOutputSize?)` | Node.js Transform for gzip decompression |
| `createDeflateCompressTransform(level?)` | Node.js Transform for deflate compression |
| `createDeflateDecompressTransform(maxOutputSize?)` | Node.js Transform for deflate decompression |
| `createBrotliCompressTransform(quality?)` | Node.js Transform for brotli compression |
| `createBrotliDecompressTransform(maxOutputSize?)` | Node.js Transform for brotli decompression |
| `createLz4CompressTransform()` | Node.js Transform for LZ4 compression |
| `createLz4DecompressTransform(maxOutputSize?)` | Node.js Transform for LZ4 decompression |
| `createZstdCompressDictTransform(dict, level?)` | Node.js Transform for zstd dict compression |
| `createZstdDecompressDictTransform(dict, maxOutputSize?)` | Node.js Transform for zstd dict decompression |
| `createBrotliCompressDictTransform(dict, quality?)` | Node.js Transform for brotli dict compression |
| `createBrotliDecompressDictTransform(dict, maxOutputSize?)` | Node.js Transform for brotli dict decompression |
| `createDecompressTransform(maxOutputSize?)` | Auto-detect format and create a decompression Transform |

</details>

## Supported Algorithms

| Algorithm | One-shot | Streaming | Status |
| --- | --- | --- | --- |
| zstd | ✅ | ✅ | Available |
| gzip / deflate | ✅ | ✅ | Available |
| brotli | ✅ | ✅ | Available |
| lz4 | ✅ | ✅ | Available |

## Platform Support

| Platform | Backend | Status |
| --- | --- | --- |
| Node.js ≥ 22 | Native (napi-rs) | ✅ |
| Deno | Native (napi-rs) | ✅ |
| Bun | Native (napi-rs) | ✅ |
| Browsers | WASM (wasm-bindgen) | ✅ |

Node.js, Deno, and Bun load a prebuilt native binary, which the package manager installs as an optional dependency on the platforms listed under [Build targets](#build-targets). In browsers, comprs uses its WebAssembly build instead (see [Browser Usage](#browser-usage)).

On any other platform, loading comprs in Node.js, Deno, or Bun throws `Cannot find native binding`: the WebAssembly build is not used as a fallback there. The error's `cause` chain lists every file and package the loader tried, and the innermost one names the platform, such as `Unsupported OS: aix, architecture: ppc64` or `./comprs.linux-riscv64-gnu.node`. On a listed platform, the same error means that the binary package was not installed, for example because optional dependencies were omitted. The chain also names `@derodero24/comprs-wasm32-wasi`: the loader that napi-rs generates still looks for this WASI build, which is no longer published (2.0.2 was its last version). Do not install it, as a newer comprs would load that outdated build.

### Build targets

| OS | Architectures |
| --- | --- |
| macOS | Intel (x64), Apple Silicon (ARM64) |
| Linux | x64, ARM64 (glibc & musl) |
| Windows | x64, ARM64 |
| WASM | wasm32-unknown-unknown (wasm-bindgen) |

The Linux glibc binaries need glibc 2.17 or newer. The Windows binaries link the C runtime statically, so they do not need the Visual C++ Redistributable.

### WASM bundle size

The browser WASM binary (`wasm32-unknown-unknown`) is built with `wasm-pack`, optimized for size (`opt-level = "s"`). It contains all four codecs.

| `comprs-wasm_bg.wasm` | Size |
| --- | --- |
| Raw | 1.87 MB |
| gzip (level 9) | 792 KB |
| brotli (quality 11) | 545 KB |

The compressed sizes are those of Node.js's zlib; what a CDN serves depends on its compressor and level. CI reports these sizes on every pull request, and fails when the raw or gzip size grows over its budget.

## Browser Usage

Browser builds that import `@derodero24/comprs` get its WebAssembly build, through the `browser` condition of the package's `exports`. Import the functions and call them; there is no initialization function to call:

```typescript
import { gzipCompress, gzipDecompress } from '@derodero24/comprs';

const data = new TextEncoder().encode('Hello from the browser!');
const compressed = gzipCompress(data);
const decompressed = gzipDecompress(compressed);
```

The entry module fetches and instantiates the WebAssembly binary with top-level `await` when it is imported, so every function works once the import has resolved, and a failed download rejects the import. It locates the binary, `browser/comprs-wasm_bg.wasm` in the package, with `new URL('./comprs-wasm_bg.wasm', import.meta.url)`, a pattern that webpack and Vite turn into an emitted asset; with other tools, copy the binary next to the bundle. The bundler must also support top-level `await`:

| Tool | What it needs |
| --- | --- |
| Vite 8 | Nothing, for `vite build` and `vite dev`. |
| Vite 7 and older | `vite dev` needs `optimizeDeps: { exclude: ['@derodero24/comprs'] }`, as the dependency pre-bundling of these versions breaks the URL of the binary. Before Vite 7, the default build target does not support top-level `await`: set `build.target: 'es2022'` or later. |
| webpack 5 | Nothing: it enables top-level `await` by default since 5.83 and emits the binary as an asset. |
| esbuild | `--format=esm` and a `--target` that supports top-level `await` (the default, `esnext`, does). esbuild leaves `new URL(…)` as it is, so copy `node_modules/@derodero24/comprs/browser/comprs-wasm_bg.wasm` next to the bundle. |
| No bundler | Serve the package's `browser/` directory, and map the package name to its entry with an import map: `<script type="importmap">{ "imports": { "@derodero24/comprs": "/node_modules/@derodero24/comprs/browser/index.js", "@derodero24/comprs/streams": "/node_modules/@derodero24/comprs/browser/streams.js" } }</script>` |

To import comprs in a web worker that Vite bundles, also set `worker: { format: 'es' }` and create the worker with `{ type: 'module' }`: Vite's default worker format, `'iife'`, does not support top-level `await`.

Serve `.wasm` files as `application/wasm`, which lets the browser compile the binary while it downloads; with another type, it falls back to slower compilation and logs a warning.

The Web Streams helpers of `@derodero24/comprs/streams` have a browser build as well, on the same WebAssembly module. Import them from that subpath: unlike the ES module entry of Node.js, the browser entry does not re-export them.

```typescript
import { createGzipDecompressStream } from '@derodero24/comprs/streams';

const response = await fetch('/data.json.gz');
if (!response.body) throw new Error('Response has no body');
const json = await new Response(response.body.pipeThrough(createGzipDecompressStream())).json();
```

The WebAssembly build has the one-shot functions, their `*Async` variants, the streaming contexts (`GzipCompressContext` and the like) and the `CompressionFormat` enum. They take the same arguments as those of the native addon, and return the same values, except that:

- functions return `Uint8Array` rather than `Buffer`;
- the `*Async` functions do not run on another thread. Each one runs its synchronous function on the calling thread before it returns, and returns a Promise of the result: they keep code written for the native addon working, but block the page as long as the synchronous call. To keep a page responsive while it compresses large data, use comprs in a Web Worker. Every error, including an invalid argument, rejects the Promise and none is thrown, as with the native functions;
- the streaming contexts keep their state in WebAssembly memory, which garbage collection frees, and do not report it to the engine. As on Node.js, `close()` and `[Symbol.dispose]()` release that state at once; in addition, `free()` frees the context object itself. A closed or freed context throws when it is used. The streams of `@derodero24/comprs/streams` free their context as soon as they end or fail, and when they are cancelled, where the runtime calls the `cancel()` method of their transformer;
- a panic, which aborts the native addon, makes the WebAssembly build throw `RuntimeError: unreachable`, after it logs the panic message with `console.error()`.

As in Node.js, the streams work in bounded memory, except LZ4 decompression and brotli dictionary compression, which hold their whole input until it ends. The WebAssembly memory grows to the most that the module has used at once, and does not shrink.

Its declarations, `browser/index.d.ts` and `browser/streams.d.ts`, list what it exports; TypeScript uses them only when it resolves the `browser` condition (`"customConditions": ["browser"]` in `tsconfig.json`), and the Node.js declarations otherwise. The `browser` condition applies to `import` only: `require()` cannot load a module that uses top-level `await`, so `require('@derodero24/comprs')` and `require('@derodero24/comprs/streams')` load the native addon, also in test runners that set the condition, such as Jest with a jsdom environment. Under Jest's ES module support, that environment imports the WebAssembly build, which does not load in Jest: set `testEnvironmentOptions: { customExportConditions: ['node', 'node-addons'] }` to get the native addon. The `@derodero24/comprs/node` subpath is for Node.js only: it loads the native addon and `node:stream`, so it does not work in browsers.

### Framework Integration (SSR)

Native modules need to be externalized in SSR frameworks:

**Next.js**

```js
// next.config.js
const nextConfig = {
  serverExternalPackages: ['@derodero24/comprs'],
};
```

**Vite SSR**

```js
// vite.config.js
export default {
  ssr: {
    external: ['@derodero24/comprs'],
  },
};
```

Client bundles resolve the `browser` condition and get the WebAssembly build, with the bundler setup described above.

## Migration

### From pako

```diff
- import pako from 'pako';
- const compressed = pako.gzip(data);
- const decompressed = pako.ungzip(compressed);
+ import { gzipCompress, gzipDecompress } from '@derodero24/comprs';
+ const compressed = gzipCompress(data);
+ const decompressed = gzipDecompress(compressed);
```

### From fflate

```diff
- import { gzipSync, gunzipSync } from 'fflate';
- const compressed = gzipSync(data);
- const decompressed = gunzipSync(compressed);
+ import { gzipCompress, gzipDecompress } from '@derodero24/comprs';
+ const compressed = gzipCompress(data);
+ const decompressed = gzipDecompress(compressed);
```

comprs adds what fflate lacks: zstd, brotli and LZ4, dictionaries for zstd and brotli, and the Web Streams API. fflate's deflate dictionaries (its `dictionary` option) have no counterpart in comprs.

### From node:zlib

```diff
- import { gzipSync, gunzipSync } from 'node:zlib';
- const compressed = gzipSync(data);
- const decompressed = gunzipSync(compressed);
+ import { gzipCompress, gzipDecompress } from '@derodero24/comprs';
+ const compressed = gzipCompress(data);
+ const decompressed = gzipDecompress(compressed);
```

## Benchmarks

The tables and charts below were measured in March 2026, before comprs 1.0, on an Apple M2 with Node.js 22, with each library at its default level. They are being regenerated by a script, with equal levels and compression ratios ([#556](https://github.com/derodero24/comprs/issues/556)). Run the benchmarks locally with `pnpm run bench`. Numbers vary by machine and data type.

comprs uses a pure-Rust brotli encoder: at equal quality, it is slower than `node:zlib`'s C encoder, especially for small inputs. Prefer zstd when speed matters.

<img src=".github/assets/bench-cross-algorithm.svg" alt="Cross-algorithm compression benchmark" width="680" />

<img src=".github/assets/bench-compress.svg" alt="Gzip compression benchmark chart" width="680" />

<details>
<summary><strong>gzip: comprs vs pako vs fflate vs node:zlib</strong></summary>

**Compression** (ops/sec, higher is better)

| Size | comprs | pako | fflate | node:zlib |
| --- | ---: | ---: | ---: | ---: |
| 150B patterned | 1,352 | 1,578 | 7,785 | 13,078 |
| 10KB patterned | 3,605 | 133 | 345 | 1,878 |
| 1MB patterned | 246 | 14 | 11 | 100 |
| 150B random | 29,914 | 4,653 | 7,471 | 1,423 |
| 10KB random | 400 | 42 | 652 | 3,459 |
| 1MB random | 13 | 5 | 6 | 10 |

**Decompression** (ops/sec, higher is better)

| Size | comprs | pako | fflate | node:zlib |
| --- | ---: | ---: | ---: | ---: |
| 150B patterned | 162,220 | 65,141 | 521,933 | 308,493 |
| 10KB patterned | 95,300 | 19,235 | 46,402 | 102,585 |
| 1MB patterned | 903 | 123 | 310 | 1,451 |
| 150B random | 29,040 | 1,952 | 560,840 | 140,243 |
| 10KB random | 7,004 | 17,616 | 407,789 | 271,245 |
| 1MB random | 1,508 | 278 | 19,341 | 4,282 |

</details>

<details>
<summary><strong>deflate: comprs vs pako vs fflate vs node:zlib</strong></summary>

**Compression** (ops/sec, higher is better)

| Size | comprs | pako | fflate | node:zlib |
| --- | ---: | ---: | ---: | ---: |
| 150B patterned | 106,183 | 13,666 | 55,434 | 4,107 |
| 10KB patterned | 2,746 | 5,160 | 3,218 | 7,161 |
| 1MB patterned | 1,963 | 91 | 217 | 472 |
| 150B random | 56,537 | 18,763 | 51,817 | 89,617 |
| 10KB random | 7,331 | 1,500 | 510 | 1,941 |
| 1MB random | 21 | 8 | 24 | 22 |

**Decompression** (ops/sec, higher is better)

| Size | comprs | pako | fflate | node:zlib |
| --- | ---: | ---: | ---: | ---: |
| 150B patterned | 124,501 | 21,119 | 8,938 | 34,967 |
| 10KB patterned | 23,416 | 5,808 | 3,061 | 9,753 |
| 1MB patterned | 306 | 65 | 70 | 116 |
| 150B random | 35,178 | 11,449 | 204,088 | 91,795 |
| 10KB random | 7,986 | 13,079 | 62,782 | 114,130 |
| 1MB random | 610 | 350 | 238 | 176 |

</details>

<details>
<summary><strong>Cross-algorithm comparison (comprs only)</strong></summary>

**Compression** (ops/sec, higher is better)

| Size | zstd | gzip | brotli | lz4 |
| --- | ---: | ---: | ---: | ---: |
| 150B patterned | 515,284 | 78,073 | 24,300 | 274,935 |
| 10KB patterned | 161,706 | 31,941 | 15,146 | 165,821 |
| 1MB patterned | 5,607 | 2,252 | 642 | 4,153 |
| 150B random | 643,393 | 69,616 | 23,634 | 97,111 |
| 10KB random | 129,576 | 31,525 | 13,411 | 74,162 |
| 1MB random | 4,320 | 2,262 | 478 | 5,419 |
| JSON 84KB | 8,914 | 1,828 | 758 | 4,531 |
| text 45KB | 52,262 | 31,111 | 8,022 | 22,953 |

**Decompression** (ops/sec, higher is better)

| Size | zstd | gzip | brotli | lz4 |
| --- | ---: | ---: | ---: | ---: |
| 150B patterned | 510,595 | 433,472 | 132,960 | 291,921 |
| 10KB patterned | 224,034 | 135,437 | 24,028 | 84,465 |
| 1MB patterned | 3,206 | 2,561 | 303 | 1,806 |
| 150B random | 461,787 | 441,290 | 30,870 | 371,571 |
| 10KB random | 245,513 | 135,314 | 23,516 | 89,173 |
| 1MB random | 3,498 | 2,309 | 656 | 1,792 |
| JSON 84KB | 17,345 | 9,737 | 4,644 | 20,356 |
| text 45KB | 82,783 | 29,115 | 3,415 | 41,811 |

</details>

### Key takeaways

- **zstd is the fastest** all-round: highest throughput for both compression and decompression across most data sizes
- **gzip/deflate decompression**: performance varies by format and data; comprs leads on patterned deflate data, while fflate or `node:zlib` is faster on gzip and on small random payloads
- **Native addon only**: these numbers are from the native (napi-rs) addon; the WebAssembly build was not measured

## Notes

> [!NOTE]
> **Default decompression limit**: All decompression functions cap output at 256 MB by default. Use `*WithCapacity()` variants, or the `maxOutputSize` argument of `decompress()` and `decompressAsync()`, for larger data:
> ```typescript
> const decompressed = zstdDecompressWithCapacity(data, 1024 * 1024 * 1024); // 1 GB
> ```
> The capacity is a limit, not an allocation size: output buffers grow with the decompressed data, so a large capacity reserves no memory up front, and size fields in the input (the zstd frame content size, the gzip size trailer) are trusted only as far as the input can expand. Output over the limit throws an `... exceeded maximum size of <limit> bytes` error.
> Streaming decompression takes the limit as its `maxOutputSize` argument and enforces it while decoding: memory stays near `maxOutputSize` even when a single small chunk would expand to gigabytes.
> zstd frames that do not declare their content size can declare a window of up to 128 MiB, which the decoder allocates as soon as it has read the frame header. The limit also bounds that window, to the limit rounded up to a power of two but at least 8 MiB, enough for the frames that zstd writes at levels up to 19: a frame that declares a larger window throws the same `... exceeded maximum size of <limit> bytes` error instead of reserving it. The default limit keeps zstd's own bound of 128 MiB.

> [!NOTE]
> **Numeric arguments**: levels, qualities, `capacity`, `maxOutputSize`, `maxDictSize`, the `crc32()` initial value and the gzip header `mtime` must be integers in their documented ranges. Other numbers, such as `NaN`, `Infinity`, `1.5` or `2 ** 32`, throw an error that names the argument and its range instead of being converted to a valid value (the async functions reject with it). `capacity` and `maxOutputSize` range from 0 to `Number.MAX_SAFE_INTEGER`, the same on every platform, and a limit of 0 accepts only data that decompresses to nothing; `maxDictSize` ranges from 0 to 16 MiB (16777216).

> [!NOTE]
> **Truncated and empty input**: zstd, gzip, deflate and brotli decompression throw when the input ends before the compressed stream does, so an interrupted download or a partial file is never returned as a shorter result. Streams check this when their input ends; the decompression contexts check it in `finish()` (LZ4 contexts already in `flush()`). Empty input throws for every format, because no format has a valid zero-length encoding (`node:zlib` rejects it for gzip, deflate and brotli too): format-specific functions and streams report `<format> stream is truncated: unexpected end of input`, and auto-detection reports that it cannot detect the format.

> [!NOTE]
> **Stream context memory**: the stream contexts (`ZstdCompressContext`, `GzipDecompressContext` and so on, which the streams use) keep their encoder or decoder state in native memory: up to a few hundred kilobytes for gzip, deflate and LZ4, several megabytes for zstd and brotli, and far more at high levels (about 90 MB for zstd level 19). They report it to V8, so that the garbage collector frees abandoned contexts in time. `finish()` releases it right away, and so does `close()` for a context that will not be finished; later calls throw `<format> stream already closed`. The buffer that LZ4 decompression decodes blocks into is not part of this state: the thread keeps it, see the LZ4 decode buffer note below. Contexts are disposable, so `using ctx = new ZstdCompressContext()` closes the context at the end of the scope. The Web streams and Node.js Transforms close their context when they end, fail, or are cancelled or destroyed. Closing a cancelled Web stream relies on the `cancel()` hook of `TransformStream` transformers, which Node.js supports; runtimes without it, such as Bun 1.3, leave the context to the garbage collector.

> [!NOTE]
> **One-shot zstd contexts**: `zstdCompress()`, `zstdDecompress()`, `zstdDecompressWithCapacity()` and their `*Async` variants, and `decompress()` for zstd input, keep one compression and one decompression context per thread instead of creating one per call (the calling thread for the synchronous functions, the libuv pool threads for `*Async`), which makes small calls several times faster. A thread keeps a context only while it holds at most 8 MiB, so a large or high-level call does not leave its workspace behind; this memory is not reported to V8. The dictionary functions create a context per call.

> [!NOTE]
> **LZ4 decode buffer**: LZ4 decompression (`lz4Decompress()`, `lz4DecompressWithCapacity()` and their `*Async` variants, `decompress()` and `decompressAsync()` for LZ4 input, `Lz4DecompressContext` and the LZ4 decompression streams) keeps the buffer that it decodes blocks into per thread instead of zero-filling a new one per call (the calling thread for the synchronous functions, the contexts and the streams, the libuv pool threads for `*Async`), which makes frames that declare large blocks, such as the 4 MB blocks that the `lz4` CLI declares by default, much faster to decode. A thread keeps the buffer only while it holds at most 4 MiB, so a legacy frame's (`lz4 -l`) 8 MiB buffer is not kept; this memory is not reported to V8.

> [!NOTE]
> **Small payloads on WASM**: For data under ~1 KB, the WASM runtime overhead may exceed compression time. Consider batching small items or using the native Node.js backend where possible.

> [!NOTE]
> **Streams that buffer their input**: LZ4 decompression streams (`createLz4DecompressStream()`, `createLz4DecompressTransform()`, and `createDecompressStream()` / `createDecompressTransform()` when the input is LZ4) and brotli dictionary compression streams (`createBrotliCompressDictStream()`, `createBrotliCompressDictTransform()`) hold their whole input in memory and produce their output only when the input ends. The other streams in `@derodero24/comprs/streams` and `@derodero24/comprs/node` work in bounded memory. Removing this buffering is tracked in [#565](https://github.com/derodero24/comprs/issues/565).

## Ecosystem

### [`@derodero24/comprs-middleware`](packages/middleware/)

HTTP compression middleware for Express, Fastify, and Hono.

```bash
npm install @derodero24/comprs @derodero24/comprs-middleware
```

```ts
// Express
import { comprs } from '@derodero24/comprs-middleware/express';
app.use(comprs());

// Fastify
import { comprs } from '@derodero24/comprs-middleware/fastify';
app.register(comprs);

// Hono
import { comprs } from '@derodero24/comprs-middleware/hono';
app.use(comprs());
```

See the [middleware README](packages/middleware/README.md) for full documentation.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup and guidelines.

## Security

See [SECURITY.md](SECURITY.md) for vulnerability reporting.

## License

[MIT](LICENSE)
