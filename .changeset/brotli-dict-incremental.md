---
'@derodero24/comprs': minor
---

Brotli dictionary compression streams now hold at most the first 4 MiB
less 16 bytes (4,194,288 bytes) of input and then stream, instead of
holding the whole input until it ends: `createBrotliCompressDictStream()`
and `createBrotliCompressDictTransform()` emit the output of those bytes as
soon as the input passes them, then compress each chunk as it arrives. A
stream that ends within them, as far as brotli can refer back to the
dictionary, gives the output of `brotliCompressWithDict()`. A longer stream
is compressed without the dictionary, which only helps the start of a
stream, because brotli's encoder can panic with a custom dictionary on some
data past the first 8 MiB. Its output decodes the same with or without the
dictionary, and is about as small: on JSON lines with a 2 KiB dictionary,
from 5.5% smaller to 2.2% larger than the output of
`brotliCompressWithDict()`, and at most 0.8% larger at qualities 1 to 11.

`BrotliCompressDictContext` accepts `{ incremental: true }` as a third
argument, which the streams use; `flush()` then returns all the output of
the input so far once the input has passed the first 4,194,288 bytes.
Without it, the context keeps its documented behaviour: it holds all of its
input and compresses it with the dictionary in `finish()`.
