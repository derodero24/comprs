---
'@derodero24/comprs': patch
---

Reject the Promise of the `*Async` functions on invalid arguments instead of
throwing synchronously. An invalid level, quality, `capacity`,
`maxOutputSize` or `maxDictSize`, and an argument of the wrong type, such as
a string instead of a `Buffer`, used to throw before any Promise existed, so
`promise.catch()` missed the error. Every `*Async` function now returns a
Promise that rejects with the error that the synchronous function throws
for the same arguments, with the same message and `code`. Code that awaits
the call inside `try`/`catch` is unaffected; code that relied on a
synchronous throw from a call it does not await now gets a rejection
instead.
