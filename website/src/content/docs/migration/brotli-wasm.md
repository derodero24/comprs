---
title: From brotli-wasm
description: Replace brotli-wasm with comprs, which loads its WebAssembly build on its own and adds zstd, gzip and LZ4.
sidebar:
  order: 4
---

brotli-wasm compiles the Rust brotli crates to WebAssembly. comprs uses libbrotli, the C library that browsers and `node:zlib` use, in a WebAssembly build that loads itself when it is imported, and the native addon in Node.js, Deno and Bun.

```diff
- import brotliPromise from 'brotli-wasm';
- const brotli = await brotliPromise;
- const compressed = brotli.compress(data, { quality: 11 });
- const restored = brotli.decompress(compressed);
+ import { compressSync, decompressSync } from '@derodero24/comprs/next';
+ const compressed = compressSync(data, { format: 'brotli', level: 11 });
+ const restored = decompressSync(compressed, { format: 'brotli' });
```

- **Loading.** There is no promise to await: the entry module instantiates the WebAssembly module with top-level `await` when it is imported. See [Browsers](/comprs/guides/browsers/) for the bundler setup.
- **Streams.** Replace brotli-wasm's `CompressStream` and `DecompressStream` with `new CompressionStream('brotli')` and `new DecompressionStream('brotli')` of the unified API, which work with `pipeThrough()`.
- **Quality.** comprs compresses at quality 6 by default. Pass `level` for another quality, from 0 to 11.
- **Size.** comprs's full WebAssembly module holds zstd, gzip and LZ4 as well: 568 KB with gzip. If brotli is all you need, import `@derodero24/comprs/next/brotli`, which loads a module with brotli alone: 337 KB with gzip (see [Browsers](/comprs/guides/browsers/#one-family-of-formats)).
- **Dictionaries.** comprs takes a custom brotli dictionary (see [Dictionaries](/comprs/guides/dictionaries/)).
