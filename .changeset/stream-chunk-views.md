---
'@derodero24/comprs': patch
---

The Web streams of the native and browser builds read the bytes of each
chunk rather than its `byteLength`, `byteOffset` and `buffer` properties,
as the other functions do. A typed array subclass or a view with own such
properties is now compressed and decompressed as the bytes it holds;
`createDecompressStream()` buffered such chunks at the wrong size, and a
`DataView` with an own `byteOffset` was read from the wrong place.
