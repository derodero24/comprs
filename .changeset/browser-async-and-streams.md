---
'@derodero24/comprs': minor
---

Give browsers the `*Async` functions and `@derodero24/comprs/streams`, so
that code written for the native addon runs there too. In 2.0.x, the types
of the `browser` condition declared the `*Async` functions, but the browser
entry did not export them, and `@derodero24/comprs/streams` loaded the
native addon even in browser builds. The browser entry now exports all 23
`*Async` functions, and its declarations declare them. A browser has no
thread pool to run them on: each one runs its synchronous function on the
calling thread before it returns, and returns a Promise of the result,
which rejects on any error, including an invalid argument.
`@derodero24/comprs/streams` now has a `browser` condition for imports,
which resolves to the same Web Streams helpers on the WebAssembly build,
with their own declarations; `require()` keeps loading the native addon.
`@derodero24/comprs/node` remains for Node.js only.
