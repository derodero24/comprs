---
title: Browsers
description: Use the WebAssembly build of comprs with Vite, webpack, esbuild or no bundler, in pages and Web Workers.
sidebar:
  order: 4
---

Browser builds that import `@derodero24/comprs`, `@derodero24/comprs/streams` or `@derodero24/comprs/next` get the WebAssembly build, through the `browser` condition of the package's `exports`. Import the functions and call them; there is no initialization function to call:

```ts
import { compressSync, decompressSync } from '@derodero24/comprs/next';

const data = new TextEncoder().encode('Hello from the browser!');
const compressed = compressSync(data, { format: 'zstd' });
const restored = decompressSync(compressed);
```

The entry module fetches and instantiates the WebAssembly binary with top-level `await` when it is imported, so every function works once the import has resolved, and a failed download rejects the import. All three entry points share one WebAssembly module, which holds all four codecs: 1.52 MB, 567 KB with gzip and 425 KB with brotli (see [Platforms](/comprs/reference/platforms/#webassembly-size)).

## Bundlers

The entry locates the binary, `browser/comprs-wasm_bg.wasm` in the package, with `new URL('./comprs-wasm_bg.wasm', import.meta.url)`, a pattern that webpack and Vite turn into an emitted asset; with other tools, copy the binary next to the bundle. The bundler must also support top-level `await`.

| Tool | What it needs |
| --- | --- |
| Vite 8 | Nothing, for `vite build` and `vite dev` |
| Vite 7 and older | `vite dev` needs `optimizeDeps: { exclude: ['@derodero24/comprs'] }`, as the dependency pre-bundling of these versions breaks the URL of the binary. Before Vite 7, the default build target does not support top-level `await`: set `build.target: 'es2022'` or later |
| webpack 5 | Nothing: it enables top-level `await` by default since 5.83 and emits the binary as an asset |
| esbuild | `--format=esm` and a `--target` that supports top-level `await` (the default, `esnext`, does). esbuild leaves `new URL(…)` as it is, so copy `node_modules/@derodero24/comprs/browser/comprs-wasm_bg.wasm` next to the bundle |
| No bundler | Serve the package's `browser/` directory, and map the package name to its entries with an import map (below) |

```html
<script type="importmap">
  {
    "imports": {
      "@derodero24/comprs": "/node_modules/@derodero24/comprs/browser/index.js",
      "@derodero24/comprs/streams": "/node_modules/@derodero24/comprs/browser/streams.js",
      "@derodero24/comprs/next": "/node_modules/@derodero24/comprs/browser/next/browser.js"
    }
  }
</script>
```

Serve `.wasm` files as `application/wasm`, which lets the browser compile the binary while it downloads; with another type, it falls back to slower compilation and logs a warning.

## Web Workers

The WebAssembly build runs on the calling thread, async functions included, so a large input blocks the page while it is compressed. To keep a page responsive, use comprs in a Web Worker:

```ts
// worker.ts
import { compressSync } from '@derodero24/comprs/next';

self.onmessage = ({ data }: MessageEvent<Uint8Array>) => {
  const result = compressSync(data, { format: 'zstd', level: 19 });
  self.postMessage(result);
};
```

```ts
// main.ts
const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
```

To import comprs in a worker that Vite bundles, also set `worker: { format: 'es' }` in the Vite config: Vite's default worker format, `'iife'`, does not support top-level `await`. The [playground](/comprs/playground/) runs comprs this way.

## Differences from the native addon

The WebAssembly build has the one-shot functions, their `*Async` variants, the stream contexts, the stream helpers, the unified API and the `CompressionFormat` enum. They take the same arguments as those of the native addon, and return the same values, except that:

- the functions of the package root return `Uint8Array` rather than `Buffer`;
- LZ4 compression writes different frames from the native one for most inputs of more than a few hundred bytes, as lz4_flex hashes 5 bytes at a time on 64-bit targets and 4 on WebAssembly. Both builds decode the frames of either;
- the `*Async` functions and the asynchronous methods of the stream contexts run their synchronous counterparts on the calling thread before they return, and return a Promise of the result. Every error, including an invalid argument, rejects the Promise and none is thrown, as with the native functions;
- the stream contexts keep their state in WebAssembly memory, which garbage collection frees. As on Node.js, `close()` and `[Symbol.dispose]()` release that state at once; in addition, `free()` frees the context object itself;
- zstd has no worker threads: `workers` other than 0 fail;
- its memory cannot hold more than 4 GiB, so a decompression limit above 4294967295 acts as 4294967295;
- a panic, which aborts the native addon, makes the WebAssembly build throw `RuntimeError: unreachable`, after it logs the panic message with `console.error()`.

The WebAssembly memory grows to the most that the module has used at once, and does not shrink. For data under about 1 KB, the overhead of the call into WebAssembly may exceed the compression itself: batch small items where you can.

## TypeScript

The browser declarations, `browser/index.d.ts`, `browser/streams.d.ts` and `browser/next/browser.d.ts`, list what the WebAssembly build exports. TypeScript uses them only when it resolves the `browser` condition (`"customConditions": ["browser"]` in `tsconfig.json`), and the Node.js declarations otherwise. The declarations of `@derodero24/comprs/next` are the same in both, and need neither the DOM library nor the types of Node.js.

## require() and test runners

The `browser` condition applies to `import` only: `require()` cannot load a module that uses top-level `await`, so `require('@derodero24/comprs')` and the other subpaths load the native addon, also in test runners that set the condition, such as Jest with a jsdom environment. Under Jest's ES module support, that environment imports the WebAssembly build, which does not load in Jest: set `testEnvironmentOptions: { customExportConditions: ['node', 'node-addons'] }` to get the native addon.

`@derodero24/comprs/node` is for Node.js only: it loads the native addon and `node:stream`, so it does not work in browsers.
