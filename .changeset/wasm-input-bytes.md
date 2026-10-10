---
'@derodero24/comprs': patch
---

Read the bytes of input arrays in the browser (WebAssembly) build, rather
than trust their `length` property, as the native addon does. A
`Uint8Array` subclass, or a typed array with an own `length` property, whose
`length` disagreed with its bytes made the build return wrong output that
held other data from its WebAssembly memory, or throw a `RangeError` that
left a stream context unusable. Other views now read as in the native addon
too: a view of a detached `ArrayBuffer`, or one out of the bounds of a
resizable `ArrayBuffer` that shrank, reads as empty rather than throwing a
`TypeError`, and a view whose prototype was swapped is read by its bytes
rather than throwing. An object that only inherits from
`Uint8Array.prototype` is rejected with the same `Error` as other values
that are not byte arrays, rather than a `TypeError`.
