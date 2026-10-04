---
'@derodero24/comprs': patch
---

Accept any `ArrayBuffer` or `ArrayBufferView` chunk, and a
`SharedArrayBuffer` as well, in the browser build of the Web streams that
`@derodero24/comprs/streams` provides, as the streams of the native addon
now do. A bare `ArrayBuffer` or `SharedArrayBuffer` used to fail, and
`createDecompressStream()` read a `DataView` as empty and a `Uint16Array`
element by element, so that it failed to detect the format; it could also
keep a view of an `ArrayBuffer` chunk, which the writer might overwrite,
while it waited for enough input to detect the format. Every chunk is now
read byte for byte, and a chunk that is not binary data errors the stream
with a `TypeError`. The browser typings accept these chunks too.
