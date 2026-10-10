---
'@derodero24/comprs': minor
---

The 14 stream context classes gain `transformAsync()`, `flushAsync()` and
`finishAsync()`, in the native and the browser build (where they run
synchronously). A call while an asynchronous call on the same context is in
flight fails with "<name> is busy: an asynchronous call has not finished",
e.g. "lz4 stream is busy: an asynchronous call has not finished".
