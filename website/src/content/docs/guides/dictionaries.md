---
title: Dictionaries
description: Train zstd dictionaries, use brotli custom dictionaries, and prepare a dictionary once for many small messages.
sidebar:
  order: 3
---

A dictionary seeds the compressor with the strings it should expect, so that small messages, such as RPC payloads, cache entries and log lines, compress far better than they do alone. Both sides need the same dictionary.

## Prepared dictionaries

zstd digests the bytes of a dictionary before it compresses or decompresses anything with them, which costs far more than a small message: a call that takes the bytes digests them every time ([#557](https://github.com/derodero24/comprs/issues/557)). A `Dictionary` of the [unified API](/comprs/guides/unified-api/) digests them once, for every call that takes it as its `dictionary`:

```ts
import { compressSync, Dictionary, decompressSync, trainDictionarySync } from '@derodero24/comprs/next';

const dictionary = Dictionary.from(trainDictionarySync(samples), { format: 'zstd', level: 3 });

const compressed = compressSync(message, { format: 'zstd', dictionary });
decompressSync(compressed, { dictionary }); // in the format of the dictionary

dictionary.close(); // or declare it with `using`, which closes it at the end of the block
```

With the workload of #557, 2,000 JSON messages of about 110 bytes and a trained dictionary of 110 KiB, compressing the messages one by one took 599 ms with `zstdCompressWithDict()` and 5.1 ms with a `Dictionary`, and decompressing them 78 ms with `zstdDecompressWithDict()` and 4.2 ms with a `Dictionary` (Node.js 22, Linux x64). Creating the `Dictionary` took 0.3 ms at level 3 and 12 ms at level 19.

| Member | Description |
| --- | --- |
| `Dictionary.from(bytes, { format, level? })` | Prepare a dictionary for `'zstd'` or `'brotli'` from a copy of `bytes`, which must not be empty. A zstd dictionary is digested for compression at `level`, 3 by default, which 0 also selects, and for decompression. A brotli dictionary takes no level |
| `format` | `'zstd'` or `'brotli'` |
| `byteLength` | The size of the dictionary, in bytes |
| `toBytes()` | A copy of the bytes of the dictionary |
| `close()` | Free the memory of the dictionary now, rather than when the garbage collector collects it. `[Symbol.dispose]()` is the same method, for `using` declarations |

- **Formats.** A `Dictionary` is for its `format` alone: with another format, the functions fail with `ERR_COMPRS_INVALID_ARG` ("this Dictionary is for zstd"). Decompression with a `Dictionary` and without a `format`, or with `'auto'`, decompresses in the format of the dictionary; with the bytes of a dictionary, it still needs a `format`. Data compressed with a `Dictionary` decompresses with its bytes, such as with `zstdDecompressWithDict()`, and the other way round.
- **Levels.** Compression without a `level` compresses at the level of the `Dictionary`. `level: 0` selects 3, as without a dictionary, not the level of the `Dictionary`. Any other level works too: the dictionary digests it on its first use, which costs as much as creating a dictionary at that level, and keeps the last 3 of them.
- **Frames.** zstd compresses an input with the parameters that a `Dictionary` was prepared for, unless the input has at least 128 KiB and at least 6 times the `byteLength` of the dictionary: such an input gets parameters for its size. Up to level 8, inputs of at most 512 KiB get the frames that the bytes of the dictionary give at the same level. Above level 8, and for inputs of more than 512 KiB, zstd can write other frames with a `Dictionary` than with its bytes, as it sizes its window or splits blocks otherwise. Both decompress the same.
- **Memory.** A zstd `Dictionary` holds memory outside the JavaScript heap: a copy of the bytes, a digest for decompression of about their size, and a digest for each compression level that it keeps, which grows with the level. A dictionary of 110 KiB holds 0.8 MB in all at level 3, and 2 MB at level 19. The native addon reports that memory to V8 when it creates the dictionary, but not the memory of the levels that it digests later. `close()` frees the memory once the calls that already started with the dictionary have finished; any later call with it fails with `ERR_COMPRS_INVALID_ARG` ("this Dictionary is closed"). The async functions keep using a `Dictionary` that is closed after they were called.
- **Brotli.** A brotli `Dictionary` is hashed for compression when it is created, for every level, into about 270 KB of tables plus 4 bytes for each byte of the dictionary. With the bytes instead, brotli compression hashes them on any call that does not find them among the last 4 dictionaries of up to 256 KiB that the thread hashed (see [Memory](/comprs/reference/memory/)). Hashing takes 0.3 ms for a dictionary of 4 KiB, 2 to 4 ms for 256 KiB and 12 to 32 ms for 2 MiB: with a 512 KiB dictionary, compressing a 150-byte message at quality 5 took 2.7 ms with the bytes and 0.017 ms with a `Dictionary`. Decompression takes the bytes as they are, either way.
- **Browsers.** The browser build has the same class. A `Dictionary` of one build is no dictionary of the other: pass it to the functions of the entry that created it.

## Training a zstd dictionary

`trainDictionary()` and `trainDictionarySync()` train a zstd dictionary from an iterable of samples of the data to compress. `maxSize` caps its size: 110 KiB by default, at most 16 MiB. Training that finds too little to learn from, such as a few tiny samples, fails with `ERR_COMPRS_OPERATION_FAILED`.

```ts
import { trainDictionary } from '@derodero24/comprs/next';

const bytes = await trainDictionary(samples, { maxSize: 64 * 1024 });
```

Store the trained bytes with the data, or ship them with both sides of a protocol: decompression needs the same bytes.

## Brotli custom dictionaries

Brotli takes any bytes as a dictionary, with no training step: strings that the data is likely to repeat, such as the field names of a JSON schema.

```ts
import { compressSync, decompressSync } from '@derodero24/comprs/next';

const dictionary = new TextEncoder().encode('{"id":0,"name":"","email":"@example.com"}'.repeat(10));
const compressed = compressSync(data, { format: 'brotli', dictionary });
decompressSync(compressed, { format: 'brotli', dictionary });
```

## The functions of the package root

The package root has dictionary variants of each function, which take the bytes of the dictionary on every call. They are [deprecated](/comprs/reference/classic-api/#deprecated-functions) in favor of the `dictionary` option above, and keep working in 2.x:

```ts
import {
  brotliCompressWithDict,
  brotliDecompressWithDict,
  zstdCompressWithDict,
  zstdDecompressWithDict,
  zstdTrainDictionary,
} from '@derodero24/comprs';

const dict = zstdTrainDictionary(samples);
const compressed = zstdCompressWithDict(data, dict);
const decompressed = zstdDecompressWithDict(compressed, dict);

const brotliDict = Buffer.from('{"id":0,"name":"","email":"@example.com"}'.repeat(10));
const brotli = brotliCompressWithDict(data, brotliDict);
brotliDecompressWithDict(brotli, brotliDict);
```

`zstdCompressWithDict()` and `zstdDecompressWithDict()` digest the dictionary on every call; for many small messages, prefer a `Dictionary`. The streams take dictionaries too: `createZstdCompressDictStream(dict, level?)`, `createBrotliCompressDictStream(dict, quality?)` and their decompression and Node.js Transform counterparts (see [Streaming](/comprs/guides/streaming/)).
