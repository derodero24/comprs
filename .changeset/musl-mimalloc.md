---
'@derodero24/comprs': patch
---

Speed up the musl builds (`linux-x64-musl` and `linux-arm64-musl`, as on Alpine Linux) by allocating the native addon's memory with mimalloc instead of musl's allocator. On x86-64 Alpine Linux with 64 KiB of input, brotli and LZ4 decompression became about twice as fast, brotli compression 1.8 times and gzip decompression 1.5 times. Results of 128 KiB to 2 MiB, which the synchronous functions copy into memory that V8 allocates, also take less extra time to copy. The glibc, macOS and Windows builds are unchanged.
