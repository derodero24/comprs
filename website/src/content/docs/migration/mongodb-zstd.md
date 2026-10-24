---
title: From @mongodb-js/zstd
description: Replace @mongodb-js/zstd with comprs, with synchronous calls, streams, dictionaries and a browser build.
sidebar:
  order: 5
---

`@mongodb-js/zstd` is a native zstd addon with two async functions. comprs also links the zstd C library, and adds synchronous calls, streams, dictionaries, multithreaded compression and a browser build.

```diff
- import { compress, decompress } from '@mongodb-js/zstd';
- const compressed = await compress(buffer, 9);
- const restored = await decompress(compressed);
+ import { compress, decompress } from '@derodero24/comprs/next';
+ const compressed = await compress(buffer, { format: 'zstd', level: 9 });
+ const restored = await decompress(compressed, { format: 'zstd' });
```

- **Results.** The unified API returns a `Uint8Array`; wrap it with `Buffer.from(result.buffer, result.byteOffset, result.byteLength)` where a `Buffer` is required, or call `zstdCompressAsync(buffer, level)` and `zstdDecompressAsync(data)` of the package root, which return a `Buffer`.
- **Limits.** comprs stops decompressing at 256 MiB by default; pass `maxOutputSize` for more.
- **More.** `compressSync()` and `decompressSync()` run on the calling thread, `workers` compresses large inputs on several threads, a `Dictionary` speeds up small messages, and `CompressionStream('zstd')` streams (see [Unified API](/comprs/guides/unified-api/)).
