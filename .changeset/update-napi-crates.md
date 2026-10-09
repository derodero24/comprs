---
'@derodero24/comprs': patch
---

Fix a crash in Bun and Deno when a method of a native context class is
called with an instance of another context class as `this`, such as
`ZstdCompressContext.prototype.transform.call(gzipContext, chunk)`. The
method used the other class's native state as its own, and the process
crashed with a segmentation fault. It now throws an `InvalidArg` error;
Node.js already rejected such calls with `Illegal invocation`.

The fix comes with the update of the native addon to napi 3.14.0,
napi-derive 3.6.10 and napi-build 2.6.0, which tag every class instance
and check the tag before a method uses it. The crates were held at 3.9.1 /
3.5.6 / 2.3.2 for the WASI build, which is no longer published.
