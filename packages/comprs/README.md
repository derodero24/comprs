# comprs

Rust-powered universal compression for JavaScript/TypeScript.
**zstd**, **gzip**, **brotli**, and **lz4** in one package, natively in Node.js, Deno and Bun, and through WebAssembly in browsers.

This package is [`@derodero24/comprs`](https://www.npmjs.com/package/@derodero24/comprs) under a shorter name. Each of its entry points re-exports the one of `@derodero24/comprs` with the same subpath, and both packages are released together at the same version, so you can use either name and follow the same documentation.

```bash
npm install comprs
```

```typescript
import { zstdCompress, zstdDecompress } from 'comprs';

const compressed = zstdCompress(new TextEncoder().encode('Hello, comprs!'));
const restored = zstdDecompress(compressed);
```

| Entry point | Re-exports |
| --- | --- |
| `comprs` | `@derodero24/comprs`: one-shot functions, stream contexts, dictionaries and format detection |
| `comprs/streams` | `@derodero24/comprs/streams`: Web Streams (`TransformStream`) |
| `comprs/node` | `@derodero24/comprs/node`: Node.js `stream.Transform` |
| `comprs/next` | `@derodero24/comprs/next`: the unified API |

Bundlers that target browsers get the WebAssembly build, as they do with `@derodero24/comprs`.

In version 3.0, the code moves to this package, and `@derodero24/comprs` becomes the one that re-exports it ([#752](https://github.com/derodero24/comprs/issues/752)).

See the [documentation on GitHub](https://github.com/derodero24/comprs#readme) for the API, the supported platforms, browser usage, migration guides and benchmarks, and try it in the [playground](https://derodero24.github.io/comprs/).

## License

[MIT](https://github.com/derodero24/comprs/blob/develop/LICENSE)
