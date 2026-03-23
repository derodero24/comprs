# comprs

[![npm version](https://img.shields.io/npm/v/comprs)](https://www.npmjs.com/package/comprs)
[![npm downloads](https://img.shields.io/npm/dm/comprs)](https://www.npmjs.com/package/comprs)
[![CI](https://github.com/derodero24/zflate/actions/workflows/ci.yml/badge.svg)](https://github.com/derodero24/zflate/actions/workflows/ci.yml)
[![codecov](https://codecov.io/gh/derodero24/zflate/graph/badge.svg)](https://codecov.io/gh/derodero24/zflate)
[![CodSpeed](https://img.shields.io/endpoint?url=https://codspeed.io/badge.json&repo=derodero24/zflate)](https://codspeed.io/derodero24/zflate)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Rust-powered universal compression for JavaScript/TypeScript. **zstd**, **gzip**, and **brotli** in one package.

## Why comprs?

The JavaScript compression ecosystem is fragmented across 12+ packages with inconsistent APIs, mixed maintenance status, and no streaming support. comprs consolidates this into a single, fast, well-typed library:

- **Native performance** — Rust core compiled via napi-rs, with WASM fallback for browsers
- **Unified API** — Same interface for zstd, gzip, and brotli
- **Streaming** — Web Streams API (`TransformStream`) for processing large data with bounded memory
- **Universal** — Node.js (native), browsers, Deno, and Bun (WASM)
- **Zero JS dependencies** — Only Rust and the platform

## Installation

```bash
npm install comprs
# or
pnpm add comprs
# or
yarn add comprs
# or
bun add comprs
```

## Quick Start

### One-shot compression

```typescript
import { zstdCompress, zstdDecompress } from 'comprs';

const data = Buffer.from('Hello, comprs!');

// Compress
const compressed = zstdCompress(data);

// Decompress
const decompressed = zstdDecompress(compressed);
```

```typescript
// Gzip
import { gzipCompress, gzipDecompress } from 'comprs';

const compressed = gzipCompress(Buffer.from('Hello, gzip!'));
const decompressed = gzipDecompress(compressed);
```

```typescript
// Brotli
import { brotliCompress, brotliDecompress } from 'comprs';

const compressed = brotliCompress(Buffer.from('Hello, brotli!'));
const decompressed = brotliDecompress(compressed);
```

### Streaming

```typescript
import { createZstdCompressStream, createZstdDecompressStream } from 'comprs';

// Create a readable stream from data
const input = new ReadableStream({
  start(controller) {
    controller.enqueue(new TextEncoder().encode('Hello, streaming comprs!'));
    controller.close();
  },
});

// Compress → Decompress round-trip
const chunks: Uint8Array[] = [];
await input
  .pipeThrough(createZstdCompressStream())
  .pipeThrough(createZstdDecompressStream())
  .pipeTo(new WritableStream({ write(chunk) { chunks.push(chunk); } }));
```

### Compression levels

```typescript
import { zstdCompress } from 'comprs';

// Fast compression (level 1)
zstdCompress(data, 1);

// Default (level 3)
zstdCompress(data);

// Best compression (level 22)
zstdCompress(data, 22);

// Fast mode with negative levels
zstdCompress(data, -1);
```

### Auto-detect

```typescript
import { decompress } from 'comprs';

// Works with any supported format — no need to know the algorithm
const decompressed = decompress(compressedData);
```

### Async

```typescript
import { gzipCompressAsync, gzipDecompressAsync } from 'comprs';

const compressed = await gzipCompressAsync(data);
const decompressed = await gzipDecompressAsync(compressed);
```

### Dictionary

```typescript
import { zstdTrainDictionary, zstdCompressWithDict, zstdDecompressWithDict } from 'comprs';

// Train from samples of similar data
const dict = zstdTrainDictionary(samples);

// Compress/decompress with dictionary
const compressed = zstdCompressWithDict(data, dict);
const decompressed = zstdDecompressWithDict(compressed, dict);
```

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

#### Auto-detect

| Function | Description |
| --- | --- |
| `decompress(data)` | Auto-detect format and decompress (zstd, gzip, brotli) |
| `detectFormat(data)` | Detect compression format. Returns `'zstd'`, `'gzip'`, `'brotli'`, or `'unknown'` |

#### zstd Dictionary

| Function | Description |
| --- | --- |
| `zstdTrainDictionary(samples, maxDictSize?)` | Train a dictionary from sample data (default max: 110 KB) |
| `zstdCompressWithDict(data, dict, level?)` | Compress with pre-trained dictionary |
| `zstdDecompressWithDict(data, dict)` | Decompress dictionary-compressed data |

### Async

All one-shot functions have async variants that run on the libuv thread pool, keeping the event loop free:

| Function | Description |
| --- | --- |
| `zstdCompressAsync(data, level?)` | Async zstd compression |
| `zstdDecompressAsync(data)` | Async zstd decompression |
| `gzipCompressAsync(data, level?)` | Async gzip compression |
| `gzipDecompressAsync(data)` | Async gzip decompression |
| `deflateCompressAsync(data, level?)` | Async deflate compression |
| `deflateDecompressAsync(data)` | Async deflate decompression |
| `brotliCompressAsync(data, quality?)` | Async brotli compression |
| `brotliDecompressAsync(data)` | Async brotli decompression |

### Streaming

| Function | Description |
| --- | --- |
| `createZstdCompressStream(level?)` | Create a zstd compression `TransformStream` |
| `createZstdDecompressStream()` | Create a zstd decompression `TransformStream` |
| `createGzipCompressStream(level?)` | Create a gzip compression `TransformStream` |
| `createGzipDecompressStream()` | Create a gzip decompression `TransformStream` |
| `createDeflateCompressStream(level?)` | Create a raw deflate compression `TransformStream` |
| `createDeflateDecompressStream()` | Create a raw deflate decompression `TransformStream` |
| `createBrotliCompressStream(quality?)` | Create a brotli compression `TransformStream` |
| `createBrotliDecompressStream()` | Create a brotli decompression `TransformStream` |
| `createZstdCompressDictStream(dict, level?)` | Streaming zstd compression with dictionary |
| `createZstdDecompressDictStream(dict)` | Streaming zstd decompression with dictionary |

### Node.js Transform Streams

For Node.js `stream.pipeline()` compatibility, import from `comprs/node`:

```typescript
import { createGzipCompressTransform } from 'comprs/node';
import { pipeline } from 'node:stream/promises';
import { createReadStream, createWriteStream } from 'node:fs';

await pipeline(
  createReadStream('input.txt'),
  createGzipCompressTransform(),
  createWriteStream('output.gz'),
);
```

| Function | Description |
| --- | --- |
| `createZstdCompressTransform(level?)` | Node.js Transform for zstd compression |
| `createZstdDecompressTransform()` | Node.js Transform for zstd decompression |
| `createGzipCompressTransform(level?)` | Node.js Transform for gzip compression |
| `createGzipDecompressTransform()` | Node.js Transform for gzip decompression |
| `createDeflateCompressTransform(level?)` | Node.js Transform for deflate compression |
| `createDeflateDecompressTransform()` | Node.js Transform for deflate decompression |
| `createBrotliCompressTransform(quality?)` | Node.js Transform for brotli compression |
| `createBrotliDecompressTransform()` | Node.js Transform for brotli decompression |
| `createZstdCompressDictTransform(dict, level?)` | Node.js Transform for zstd dict compression |
| `createZstdDecompressDictTransform(dict)` | Node.js Transform for zstd dict decompression |

## Supported Algorithms

| Algorithm | One-shot | Streaming | Status |
| --- | --- | --- | --- |
| zstd | ✅ | ✅ | Available |
| gzip / deflate | ✅ | ✅ | Available |
| brotli | ✅ | ✅ | Available |

## Platform Support

| Platform | Backend | Status |
| --- | --- | --- |
| Node.js ≥ 20 | Native (napi-rs) | ✅ |
| Browsers | WASM | ✅ |
| Deno | WASM | ✅ |
| Bun | WASM | ✅ |

### Build targets

`x86_64-apple-darwin`, `aarch64-apple-darwin`, `x86_64-unknown-linux-gnu`, `x86_64-unknown-linux-musl`, `aarch64-unknown-linux-gnu`, `aarch64-unknown-linux-musl`, `x86_64-pc-windows-msvc`, `aarch64-pc-windows-msvc`, `wasm32-wasip1-threads`

### WASM bundle size

The WASM binary (`wasm32-wasip1-threads`) is optimized with `wasm-opt -O3` during the build process. Binary size is tracked and reported in CI on every build — check the latest [CI run summary](https://github.com/derodero24/zflate/actions/workflows/ci.yml) for current numbers.

## Browser Usage

comprs works in browsers via WASM. Use a bundler like Vite, webpack, or esbuild, or import directly from a CDN:

```typescript
import { gzipCompress, gzipDecompress } from 'comprs';

const encoder = new TextEncoder();
const data = encoder.encode('Hello from the browser!');

const compressed = gzipCompress(data);
const decompressed = gzipDecompress(compressed);
```

> Note: WASM initialization happens automatically on first use. For performance-critical applications, consider warming up the module by calling any function once during app startup.

## Comparison with Alternatives

| Feature | comprs | pako | fflate | node:zlib |
|---------|--------|------|--------|-----------|
| zstd | ✅ | ❌ | ❌ | ✅* |
| gzip/deflate | ✅ | ✅ | ✅ | ✅ |
| brotli | ✅ | ❌ | ❌ | ✅ |
| Web Streams API | ✅ | ❌ | ❌ | ❌ |
| Streaming | ✅ | ✅† | ✅ | ✅ |
| Browser | ✅ | ✅ | ✅ | ❌ |
| Deno/Bun | ✅ | ✅ | ✅ | ❌ |
| Native performance | ✅ | ❌ | ❌ | ✅ |
| TypeScript | ✅ | ✅ | ✅ | ✅ |
| Zero JS deps | ✅ | ✅ | ✅ | ✅ |

\* Node.js ≥ 22.15 (experimental)
† Chunked mode via `Inflate`/`Deflate` classes, not Web Streams API

## Migration

### From pako

```diff
- import pako from 'pako';
- const compressed = pako.gzip(data);
- const decompressed = pako.ungzip(compressed);
+ import { gzipCompress, gzipDecompress } from 'comprs';
+ const compressed = gzipCompress(data);
+ const decompressed = gzipDecompress(compressed);
```

### From node:zlib

```diff
- import { gzipSync, gunzipSync } from 'node:zlib';
- const compressed = gzipSync(data);
- const decompressed = gunzipSync(compressed);
+ import { gzipCompress, gzipDecompress } from 'comprs';
+ const compressed = gzipCompress(data);
+ const decompressed = gzipDecompress(compressed);
```

## Benchmarks

<img src=".github/assets/bench-compress.svg" alt="Compression benchmark chart" width="680" />

<details>
<summary>Raw benchmark data</summary>

Measured on Apple M2, Node.js v22:

### zstd compression throughput

| Data type | Size | ops/sec |
| --- | --- | --- |
| Patterned | 150B | 677,003 |
| Patterned | 10KB | 138,047 |
| Patterned | 1MB | 4,219 |
| Random | 150B | 683,696 |
| Random | 10KB | 80,501 |
| Random | 1MB | 2,585 |
| JSON | 84KB | 9,104 |
| Text | 45KB | 56,757 |

### zstd decompression throughput

| Data type | Size | ops/sec |
| --- | --- | --- |
| Patterned | 150B | 464,668 |
| Patterned | 10KB | 269,381 |
| Patterned | 1MB | 3,415 |
| Random | 150B | 756,275 |
| Random | 10KB | 374,927 |
| Random | 1MB | 3,797 |
| JSON | 84KB | 15,034 |
| Text | 45KB | 37,599 |

</details>

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup and guidelines.

## Security

See [SECURITY.md](SECURITY.md) for vulnerability reporting.

## License

[MIT](LICENSE)
