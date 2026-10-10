---
'@derodero24/comprs': patch
---

Brotli compression of up to 256 KiB in one call keeps the ring buffer of
its encoder, at most 8.3 MiB, per thread instead of allocating and
zero-filling a new one for every call that fills it. Every call with a
dictionary filled it: compressing a 110-byte message with a 110 KiB
dictionary at quality 5 takes about 0.32 ms instead of 0.65 ms, with a
2 KiB dictionary 0.05 ms instead of 0.38 ms, in `brotliCompressWithDict()`
and in `compress()` of `@derodero24/comprs/next` with a brotli `Dictionary`
alike. Larger inputs and the streams allocate a fresh ring buffer, as
before: with glibc, keeping it made the compression of 1 MB and more
slower. The output does not change.
