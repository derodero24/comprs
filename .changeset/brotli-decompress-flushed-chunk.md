---
'@derodero24/comprs': patch
---

`BrotliDecompressContext` and `BrotliDecompressDictContext` now return all
the output of a chunk that ends mid-stream from `transform()`, in the
Node.js and browser builds, instead of 4 KiB of it per call, with the rest
held until more input arrived. The brotli decompression streams, and the
auto-detecting ones for brotli input, emit it right away too, so a reader of
a stream that is flushed after each message, such as a brotli response
flushed after each event, gets the whole message as it arrives.
