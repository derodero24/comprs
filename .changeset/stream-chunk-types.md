---
'@derodero24/comprs': patch
---

Accept any `ArrayBuffer` or `ArrayBufferView` chunk, as `CompressionStream`
does, and a `SharedArrayBuffer` as well, in the Web streams that
`@derodero24/comprs/streams` provides with the native addon (Node.js, Deno
and Bun). A bare `ArrayBuffer` used to fail with `Value is none of these
types`, and `createDecompressStream()` failed to detect the format of
`DataView` and `Uint16Array` chunks, which it read as empty or element by
element. Every chunk is now read byte for byte, and a chunk that is not
binary data errors the stream with a `TypeError`. The typings accept these
chunks and remain assignable to `TransformStream<Uint8Array, Uint8Array>`.
The browser build still takes `Uint8Array` chunks.
