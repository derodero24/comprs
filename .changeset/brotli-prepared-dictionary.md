---
'@derodero24/comprs': patch
---

A brotli `Dictionary` of `@derodero24/comprs/next` is now hashed for compression once, when it is created, and the calls and streams that take it share that, along with its bytes (#707). Before, brotli hashed it again on every call unless it was one of the last 4 dictionaries of up to 256 KiB that the thread had used: with a 512 KiB dictionary, compressing a 150-byte message at quality 5 took 2.7 ms, and now takes 0.017 ms. A brotli `Dictionary` now holds about 270 KB of tables, plus 4 bytes for each byte of the dictionary, which it reports to V8. The output is unchanged.
