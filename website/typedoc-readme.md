# API reference

Every declaration of the package, generated from its TypeScript declaration files. The modules are its entry points:

| Module | Import |
| --- | --- |
| index | `@derodero24/comprs`: the [classic API](/comprs/reference/classic-api/), with a function for each format and variant |
| next | `@derodero24/comprs/next`: the [unified API](/comprs/guides/unified-api/) |
| streams | `@derodero24/comprs/streams`: Web Streams helpers |
| node | `@derodero24/comprs/node`: Node.js Transforms |

These are the declarations of the native addon; the browser build exports the same names but for a few that need Node.js (see [Browsers](/comprs/guides/browsers/)).
