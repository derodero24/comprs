---
'@derodero24/comprs': minor
---

The 14 stream context classes gain `transformAsync()`, `flushAsync()` and
`finishAsync()`, in the native and the browser build (where they run
synchronously). In Node.js, the Web streams and Node transforms run expensive
chunks on the libuv thread pool and yield between cheap ones, so the event
loop keeps turning. Output is byte-identical. A call while an asynchronous
call on the same context is in flight fails with `<name> is busy: an
asynchronous call has not finished`, e.g. `lz4 stream is busy: an
asynchronous call has not finished`.
