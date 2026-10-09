---
'@derodero24/comprs': patch
---

Fix a memory-safety bug in the browser (WebAssembly) build: a zstd operation
whose memory allocation cannot be satisfied — for example decompressing a
frame that declares a very large window in a memory-constrained tab — used to
corrupt WebAssembly linear memory and trap with an opaque out-of-bounds error.
It now fails deterministically at the point the allocation fails. The wasm
crate installs a global allocator that aborts on allocation failure, so
zstd-sys's WebAssembly allocation shim can never receive a null pointer and
hand zstd a buffer derived from it. The native addon uses the system allocator
and was never affected.
