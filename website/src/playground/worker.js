// Runs the compressors off the main thread, so that large inputs and high
// levels do not freeze the page. Importing the browser entry of the package
// instantiates its WebAssembly module, so this module only starts handling
// messages, and posts { ready: true }, once the compressors work. If the
// module cannot be loaded, the worker reports an error event instead.
import { brotliCompress, gzipCompress, lz4Compress, zstdCompress } from '@derodero24/comprs';

const COMPRESSORS = {
  zstd: (data, level) => zstdCompress(data, level),
  gzip: (data, level) => gzipCompress(data, level),
  brotli: (data, level) => brotliCompress(data, level),
  lz4: (data) => lz4Compress(data),
};

// A request { input, runs: [{ algo, level }] } compresses `input` once per
// run, in order, and is answered with { results }, where each result is
// { compressed, elapsed } or { error }. Requests are answered in order, and
// the compressed buffers are transferred, not copied.
self.addEventListener('message', ({ data: { input, runs } }) => {
  const results = runs.map(({ algo, level }) => {
    try {
      const start = performance.now();
      const compressed = COMPRESSORS[algo](input, level);
      return { compressed, elapsed: performance.now() - start };
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  });
  const buffers = results.filter((r) => r.compressed).map((r) => r.compressed.buffer);
  self.postMessage({ results }, buffers);
});

self.postMessage({ ready: true });
