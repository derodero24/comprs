# comprs

## 2.1.0

### Minor Changes

- a44e897: Brotli dictionary compression streams now hold at most the first 4 MiB
  less 16 bytes (4,194,288 bytes) of input and then stream, instead of
  holding the whole input until it ends: `createBrotliCompressDictStream()`
  and `createBrotliCompressDictTransform()` emit the output of those bytes as
  soon as the input passes them, then compress each chunk as it arrives. A
  stream that ends within them, as far as brotli can refer back to the
  dictionary, gives the output of `brotliCompressWithDict()`. A longer stream
  is compressed without the dictionary, which only helps the start of a
  stream, because brotli's encoder can panic with a custom dictionary on some
  data past the first 8 MiB. Its output decodes the same with or without the
  dictionary, and is about as small: on JSON lines with a 2 KiB dictionary,
  from 5.5% smaller to 2.2% larger than the output of
  `brotliCompressWithDict()`, and at most 0.8% larger at qualities 1 to 11.
  
  `BrotliCompressDictContext` accepts `{ incremental: true }` as a third
  argument, which the streams use; `flush()` then returns all the output of
  the input so far once the input has passed the first 4,194,288 bytes.
  Without it, the context keeps its documented behaviour: it holds all of its
  input and compresses it with the dictionary in `finish()`.
- 0ef61e6: Give browsers the `*Async` functions and `@derodero24/comprs/streams`, so
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
- b5fee8a: Add an optional `maxOutputSize` argument to `decompress()` and
  `decompressAsync()`, in the native addon and the WASM build. Like the
  `maxOutputSize` of `createDecompressStream()`, it limits the decompressed
  size in bytes whatever the detected format, and it defaults to 256 MB, so
  code that auto-detects the format no longer has to call `detectFormat()`
  and dispatch to the `*DecompressWithCapacity()` functions to set another
  limit. A second argument used to be silently ignored and is now the limit,
  so code that passes one by accident, such as `buffers.map(decompress)`,
  which passes the array index, must call `buffers.map((data) =>
  decompress(data))` instead. Values that are not integers from 0 to
  `Number.MAX_SAFE_INTEGER` throw.
- 9ddb3cd: Stop building and publishing `@derodero24/comprs-wasm32-wasi`, the WASI
  build of the native addon; 2.0.2 is its last version. Since 2.0.2 it was no
  longer an optional dependency of `@derodero24/comprs`, so it was only used
  where it had been installed by hand. Node.js, Deno and Bun keep loading the
  native addon for their platform. The wasm-bindgen build, which the
  package's `browser` entry loads, is now the only WebAssembly build.
  
  If you installed `@derodero24/comprs-wasm32-wasi` or set
  `NAPI_RS_FORCE_WASI`, uninstall the package and unset the variable: on a
  supported platform the native addon loads instead, and in browsers the
  wasm-bindgen build. The generated loader still looks for the WASI package
  when no native binary loads or when `NAPI_RS_FORCE_WASI` is `true` or
  `error`, so a copy left in `node_modules` would be loaded with a newer
  `@derodero24/comprs` whose API it does not match. On a platform without a
  native binary, loading comprs in Node.js, Deno or Bun throws `Cannot find
  native binding`; if you relied on the WASI build there, stay on
  `@derodero24/comprs` 2.0.x.
- 0a98674: LZ4 decompression streams now emit each block as soon as all of it has
  arrived, and hold at most one block of their input (up to 4 MiB, or a
  little over 8 MiB in a legacy frame), instead of the whole input until it
  ends:
  `createLz4DecompressStream()`, `createLz4DecompressTransform()`, and
  `createDecompressStream()` and `createDecompressTransform()` for LZ4 input.
  They report data after the last frame on the chunk that holds it.
  Each block of a legacy frame (`lz4 -l`) is decoded into a buffer no larger
  than its compressed size allows, rather than one of 8 MiB, so legacy frames
  of small blocks also decode faster with the one-shot functions.
  
  `Lz4DecompressContext` accepts `{ incremental: true }` as a second argument,
  which the streams use: `transform()` then returns each block as it
  arrives and throws as soon as the input is invalid, `flush()` returns
  nothing, `finish()` throws unless the input ended between frames, and
  `maxOutputSize` limits the output of the whole stream. Without it, the
  context keeps its documented buffering behaviour, including the output
  limit that applies to each `flush()` on its own. The `StreamContextOptions`
  type declares the options.
- fa0e184: `compress`, `decompress` and `trainDictionary` from `@derodero24/comprs/next`
  accept an `AbortSignal` as the `signal` option. An aborted call rejects with
  the `reason` of the signal. In Node.js, a call whose work no thread of the
  libuv pool has started yet rejects at once, and the pool skips the work; work
  that has started finishes, and its result is discarded. The `*Async`
  functions of the package root take no signal.
- a971e09: `CompressionStream` and `DecompressionStream` from `@derodero24/comprs/next`
  are ponyfills of the classes of the Compression Streams standard, in Node.js
  and in browsers. They cover zstd, gzip, deflate (zlib), deflate-raw, brotli
  and lz4, and `'auto'` for decompression, with the `level`, `dictionary`,
  `gzipHeader`, `workers` and `maxOutputSize` options and the error codes of
  the unified API. In Node.js, chunks that take 2 ms or more run on the libuv
  thread pool. The WebAssembly binary grows by about 6 KB with gzip.
- 6b99ce5: `Dictionary.from(bytes, { format, level })` in `@derodero24/comprs/next`
  prepares a zstd or brotli dictionary once, which makes repeated zstd
  compression and decompression of small messages with a dictionary much
  cheaper: the `dictionary` option of `compress`, `decompress` and their
  `*Sync` variants takes it in place of the bytes of a dictionary, and
  decompression defaults to its format. `close()`, or a `using` declaration,
  frees it early.
- 971d4f9: New entry `@derodero24/comprs/next` for Node.js and browsers: `compress`,
  `compressSync`, `decompress`, `decompressSync`, `detectFormat`,
  `trainDictionary` and `trainDictionarySync`. It takes options objects,
  supports zlib (`'deflate'`) and raw deflate (`'deflate-raw'`), returns plain
  `Uint8Array` results, gives every error a stable `code`, and has a `workers`
  option for zstd in Node.js. The root API is unchanged.
- c40243c: Report the native memory of the stream contexts to V8 and allow releasing
  it early. A context keeps its encoder or decoder state outside the
  JavaScript heap, from a few hundred kilobytes for gzip to about 90 MB for
  zstd at level 19, but V8 saw only a small object and had no reason to
  collect it. A server that dropped contexts, such as the streams of aborted
  responses, could grow to gigabytes before an unrelated garbage collection
  freed them. The contexts now report their memory, so that V8 collects
  abandoned contexts in time.
  
  Every context class gains a `close()` method that releases the native state
  right away; later calls throw `<format> stream already closed`. Contexts are
  also disposable, so `using ctx = new ZstdCompressContext()` closes the
  context at the end of the scope. `finish()` releases the state too, and
  `Lz4DecompressContext` gains the `finish()` that the other contexts have.
  The Web streams and Node.js Transforms close their context when they end,
  fail, or are cancelled or destroyed. The contexts of the browser build gain
  `close()` and `Lz4DecompressContext.finish()` as well.
- c1a46b2: The 14 stream context classes gain `transformAsync()`, `flushAsync()` and
  `finishAsync()`, in the native and the browser build (where they run
  synchronously). In Node.js, the Web streams and Node transforms run expensive
  chunks on the libuv thread pool and yield between cheap ones, so the event
  loop keeps turning. Output is byte-identical. A call while an asynchronous
  call on the same context is in flight fails with `<name> is busy: an
  asynchronous call has not finished`, e.g. `lz4 stream is busy: an
  asynchronous call has not finished`.

### Patch Changes

- 80da8a5: Reject the Promise of the `*Async` functions on invalid arguments instead of
  throwing synchronously. An invalid level, quality, `capacity`,
  `maxOutputSize` or `maxDictSize`, and an argument of the wrong type, such as
  a string instead of a `Buffer`, used to throw before any Promise existed, so
  `promise.catch()` missed the error. Every `*Async` function now returns a
  Promise that rejects with the error that the synchronous function throws
  for the same arguments, with the same message and `code`. Code that awaits
  the call inside `try`/`catch` is unaffected; code that relied on a
  synchronous throw from a call it does not await now gets a rejection
  instead.
- b5fee8a: Detect every supported format reliably in `detectFormat()`, `decompress()`,
  `decompressAsync()`, `createDecompressStream()` and
  `createDecompressTransform()`. The empty brotli stream that
  `brotliCompress()` writes for empty input, zstd and LZ4 frames that follow
  skippable frames, and LZ4 legacy frames (`lz4 -l`) used to be reported as
  `'unknown'`; they are now detected. The auto-detecting streams decided on
  the format after 4 bytes and failed on brotli input that arrived in small
  chunks; they now buffer the input until the format is detected, up to
  64 KiB.
  
  Brotli, which has no magic number, is now recognized by decoding up to the
  first 64 KiB of the input instead of a single byte. Random data shorter than
  64 KiB and raw deflate, some of which used to be reported as `'brotli'`, are
  now `'unknown'`, and so is data that continues after the end of a brotli
  stream shorter than 64 KiB, which `decompress()` used to decompress while
  ignoring the rest. When data detected as brotli does not decode, including
  a truncated brotli stream, `decompress()` throws the `unable to detect
  compression format` error instead of a brotli error. That error now also
  points to `deflateDecompress()` for raw deflate.
- 74cece7: Enforce `maxOutputSize` while streaming decompression runs instead of after
  each chunk. The gzip, deflate and brotli decompression streams and contexts
  used to inflate a whole input chunk before checking the limit, so one small,
  highly compressed chunk could allocate gigabytes before the size-limit error.
  They now stop as soon as the output would exceed the limit, keeping memory
  near `maxOutputSize`. `finish()` on `GzipDecompressContext` and
  `DeflateDecompressContext` now counts its output toward the limit too.
  
  Reject truncated input instead of returning a shorter result. The zstd,
  brotli and raw deflate decompression streams, `DeflateDecompressContext` and
  the `deflateDecompress*()` functions used to succeed with whatever had been
  decoded when the input ended mid-stream; they now throw `<format> stream is
  truncated: unexpected end of input`. The zstd and brotli decompression
  contexts gain a `finish()` method that performs this check, and their
  streams, including the auto-detecting ones, call it when their input ends.
  
  Empty input now throws for every format, in the one-shot functions and in
  the streams alike, because no format has a valid zero-length encoding.
  `zstdDecompress*()`, `deflateDecompress*()`, `lz4Decompress*()` and most
  decompression streams used to return an empty result for it.
- 23454f2: `BrotliDecompressContext` and `BrotliDecompressDictContext` now return all
  the output of a chunk that ends mid-stream from `transform()`, in the
  Node.js and browser builds, instead of 4 KiB of it per call, with the rest
  held until more input arrived. The brotli decompression streams, and the
  auto-detecting ones for brotli input, emit it right away too, so a reader of
  a stream that is flushed after each message, such as a brotli response
  flushed after each event, gets the whole message as it arrives.
- 59055c4: Work around two bugs in the brotli 9.0.0 encoder that `brotliCompressWithDict()`,
  `brotliCompressWithDictAsync()` and `BrotliCompressDictContext` hit for some
  inputs. At qualities 2 to 9, including the default, the encoder panicked,
  which aborted the Node.js process; at qualities 10 and 11 it returned a
  stream that `brotliDecompressWithDict()` rejected with "Invalid Data". When
  the encoder panics, or when quality 10 or 11 output does not decode back to
  the input, comprs now compresses that input again with neither the
  dictionary nor brotli's built-in one, whose references a decoder given the
  custom dictionary would misread. The result is a valid brotli stream that
  decodes with or without the dictionary, only less compressed in these cases.
  The native addon recovers from the panic without printing it to stderr;
  every other panic still prints.
  In the WebAssembly build, where panics cannot be caught, the panic still
  traps until brotli is fixed.
- 9305256: `brotliCompressWithDict()`, `brotliCompressWithDictAsync()`, a
  `BrotliCompressDictContext` without `{ incremental: true }` and `compress()`
  of `@derodero24/comprs/next` with a brotli dictionary now compress an input
  of more than 8 MiB without the dictionary, and without brotli's built-in
  one, into output that decodes the same with or without the dictionary. The
  brotli encoder could panic on such inputs with a dictionary: the browser
  build threw `RuntimeError: unreachable`, and the native addon compressed the
  input twice. The output of shorter inputs does not change.
- 933b413: Brotli stream compression at qualities 0 and 1 no longer compresses small
  chunks far worse than large ones. At those qualities the encoder
  compresses the input of each call on its own: written in chunks of 100
  bytes, 300 KB of text that compresses to 120 bytes in one call took
  204,335 bytes at quality 1, and 233,478 bytes of 300 KB of random words
  that compress to 53,598. `BrotliCompressContext`, the streams and Node.js
  Transforms built on it, and the `CompressionStream` of
  `@derodero24/comprs/next`, in the Node.js and browser builds, now pass
  their input to the encoder in blocks of 64 KiB at qualities 0 and 1, so
  that their output is the same however the input is split into chunks.
  `transform()` holds up to 64 KiB of input until it completes a block, and
  `flush()` and `finish()` compress what it holds. Qualities 2 to 11 are
  unchanged.
- 118ed81: Reject Large Window Brotli streams in every brotli decompression function,
  stream context and `decompress()`, as RFC 7932 decoders and Node.js zlib
  do. Their header declares a window of up to 1 GiB, and the decoder
  reserved a buffer of that size before writing any output, whatever the
  output limit: 12 bytes of input grew the memory of the WebAssembly build
  to 1.5 GiB, which it never returns. comprs does not write these streams;
  only encoders with the extension explicitly enabled do.
- 694894d: The one-shot brotli decompression functions (`brotliDecompress()`,
  `brotliDecompressWithDict()`, their `WithCapacity` and `Async` variants,
  and `decompress()` and `decompressAsync()` on brotli data) hand the decoder
  the whole input at once. Small brotli decompressions no longer allocate a
  4 MiB ring buffer: 10 KB of incompressible data decompresses about 40 times
  faster, and 1 MB of incompressible data about twice as fast.
- fd2542f: Brotli compression of up to 256 KiB in one call keeps the ring buffer of
  its encoder, at most 8.3 MiB, per thread instead of allocating and
  zero-filling a new one for every call that fills it. Every call with a
  dictionary filled it: compressing a 110-byte message with a 110 KiB
  dictionary at quality 5 takes about 0.32 ms instead of 0.65 ms, with a
  2 KiB dictionary 0.05 ms instead of 0.38 ms, in `brotliCompressWithDict()`
  and in `compress()` of `@derodero24/comprs/next` with a brotli `Dictionary`
  alike. Larger inputs and the streams allocate a fresh ring buffer, as
  before: with glibc, keeping it made the compression of 1 MB and more
  slower. The output does not change.
- 6e5f891: Make the browser entry work with bundlers. In 2.0.x, browser builds of
  `import … from '@derodero24/comprs'` failed with esbuild and webpack, and
  Vite produced a bundle that threw on the first call: resolvers picked the
  Node.js entry before the `browser` one, webpack refused to parse the
  browser files as ES modules, `"sideEffects": false` let bundlers drop the
  WebAssembly initialisation, esbuild could not bundle the `.wasm` import,
  and the 2.0.2 browser entry imported the WASI package, which 2.0.2 does not
  install.
  
  Imports under the `browser` condition now resolve to the WebAssembly build,
  ahead of the Node.js entry, with type declarations that describe it rather
  than the native addon. The browser files moved to a `browser/` directory
  that declares `"type": "module"`, and the entry instantiates the
  WebAssembly module with top-level `await`, from
  `new URL('./comprs-wasm_bg.wasm', import.meta.url)`: the functions are
  ready once the import resolves, with no init call. Bundlers must support
  top-level `await`. webpack 5 and Vite emit the `.wasm` file as an asset;
  with esbuild, copy `browser/comprs-wasm_bg.wasm` next to the bundle. On
  Vite 7 and older, `vite dev` needs
  `optimizeDeps: { exclude: ['@derodero24/comprs'] }`, and before Vite 7,
  `vite build` needs `build.target: 'es2022'`.
  
  `require()` cannot load a module that uses top-level `await`, so
  `require('@derodero24/comprs')` keeps loading the native addon even where
  the `browser` condition is set, as in Jest with a jsdom environment. Under
  Jest's ES module support, that environment now imports the WebAssembly
  build, which does not load in Jest; set
  `testEnvironmentOptions: { customExportConditions: ['node', 'node-addons'] }`
  to keep the native addon. The top-level browser files (`browser-entry.js`,
  `browser.js`, `browser-streaming.js` and `comprs-wasm*`) and the `browser`
  field of `package.json`, which pointed at `browser-entry.js`, are gone.
- 89a005b: Accept any `ArrayBuffer` or `ArrayBufferView` chunk, and a
  `SharedArrayBuffer` as well, in the browser build of the Web streams that
  `@derodero24/comprs/streams` provides, as the streams of the native addon
  now do. A bare `ArrayBuffer` or `SharedArrayBuffer` used to fail, and
  `createDecompressStream()` read a `DataView` as empty and a `Uint16Array`
  element by element, so that it failed to detect the format; it could also
  keep a view of an `ArrayBuffer` chunk, which the writer might overwrite,
  while it waited for enough input to detect the format. Every chunk is now
  read byte for byte, and a chunk that is not binary data errors the stream
  with a `TypeError`. The browser typings accept these chunks too.
- 0ef61e6: Make the stream contexts of the browser entry stream. They were JavaScript
  stand-ins that kept every chunk until the end and then ran the one-shot
  function: they held the whole input in memory, kept a view of each chunk
  rather than a copy, so a caller that reused its buffer compressed
  overwritten data, returned nothing from `flush()` (or, when decompressing
  zstd, brotli or LZ4, ended the stream there), reported corrupt input only
  at the end, and passed a zstd `maxOutputSize` on as a capacity that grew
  the WebAssembly memory to that size. The browser entry now exports the
  stream contexts of the WebAssembly build, which work like the native
  ones: `transform()` and `flush()` return output as soon as it is ready,
  so code that kept only what `finish()` returned must keep what every call
  returns, as on Node.js. Like those, they have `close()`, which
  `[Symbol.dispose]()` calls, and `Lz4DecompressContext.finish()`; they
  also have a `free()` method, which frees the context object and its
  WebAssembly memory before garbage collection does.
- 8133e5b: Declare `CompressionFormat` as a regular enum rather than a `const enum`.
  TypeScript cannot use the members of a declared `const enum` in projects
  that enable `isolatedModules` or `verbatimModuleSyntax`, as esbuild, swc
  and Vite setups do: there, `detectFormat(data) === CompressionFormat.Zstd`,
  an exhaustive `switch` with `case CompressionFormat.Zstd:` and, with
  `verbatimModuleSyntax` on TypeScript 5.9 and later, even importing the enum
  failed with TS2748. They now type-check. Code that `tsc` compiles reads the
  members from the exported object instead of inlining their strings.
  
  The browser entry now exports `CompressionFormat` as well: in 2.0.x, the
  declarations of the `browser` condition declared it, but the entry did not
  export it. The values are unchanged, the strings `'zstd'`, `'gzip'`,
  `'brotli'`, `'lz4'` and `'unknown'`, so comparisons with strings keep
  working. As in the native addon, the members are not enumerable:
  `Object.keys(CompressionFormat)` and `Object.values(CompressionFormat)`
  return `[]`.
- 532cc79: gzip, zlib and raw deflate stream compression no longer compresses small
  chunks worse than large ones. At levels 5 and 6 (6 is the default), the
  output of zlib-rs depends on how its calls split the input: a stream
  written in chunks of 1,000 bytes compressed repetitive text 17% larger
  than in one call, and in chunks of 100 bytes 57% larger.
  `GzipCompressContext`, `DeflateCompressContext`, the streams and Node.js
  Transforms built on them, and the `CompressionStream` of
  `@derodero24/comprs/next`, in the Node.js and browser builds, now compress
  their input in blocks of 32 KiB, so that their output is the same however
  the input is split into chunks, and small chunks compress faster.
  `transform()` holds up to 32 KiB of input until it completes a block, and
  `flush()` and `finish()` compress what it holds.
  
  A stream that is flushed when its input pauses, as the middleware does,
  still sends each write promptly: a small write now reaches the client with
  that flush, the gzip header and the response headers included, instead of
  partly before it.
- e939fc2: Derive the ES module entry from the CommonJS one. `index.mjs` listed every
  export by hand and has drifted from the native addon before; it now
  re-exports the CommonJS loader and the stream helpers with `export *`, so
  the two entries cannot drift apart. Node.js and Deno see the same exports
  as before. Bundlers now follow the entry into the loader and bundle it,
  instead of leaving a `require('./index.js')` that fails once the bundle
  moves; as before, the native addon itself must stay external.
- e939fc2: Fix the type declarations of the ES module entry. `index.d.mts` re-exported
  declaration files, which TypeScript rejects with TS2846, so ES module
  projects that type-check their dependencies (`skipLibCheck: false`) got two
  errors from `node_modules`. It now re-exports `./index.js` and
  `./streams.js`, and the exported types are unchanged.
- 3d0d9b2: `flush()` of `GzipCompressContext` and `DeflateCompressContext` now emits
  all the input written so far, in the Node.js and browser builds. After a
  `transform()` of much poorly compressible input, such as random or already
  compressed data, a flush could leave up to about 16 KiB of it in the
  encoder until the next call, so a client decoding the output as it arrives,
  such as that of a response the middleware flushes while its handler waits,
  got less than had been written. A flush that was already complete returns
  the same bytes as before.
- 568419c: Update flate2 to 1.1.10 with its `runtime_detection` feature, so zlib-rs
  keeps using SIMD and CRC instructions and gzip and deflate keep their
  speed in the native binary. One-shot gzip decompression (`gzipDecompress`,
  its variants and `decompress`) of input that ends inside the compressed
  data can now report "incomplete deflate stream" instead of "unexpected end
  of file"; the gzip streams and contexts report the same errors as before.
- 23454f2: `transform()` of `GzipDecompressContext` now returns all the output of its
  chunk, in the Node.js and browser builds. It kept the last 32 KiB or less
  until the next call, so a gzip stream that is flushed after each message,
  such as a response the middleware flushes after each event, reached a
  reader of `createGzipDecompressStream()`, `createGzipDecompressTransform()`
  or the auto-detecting streams one message late, and a short message not at
  all until the next one.
- 0f15e49: Reject gzip header filenames that cannot be stored. `gzipCompressWithHeader()`
  with a `filename` that contains a NUL character (`'\u0000'`) aborted the
  Node.js process, and trapped with `RuntimeError: unreachable` in the WASM
  build. It now throws `gzip filename must not contain NUL characters`. A
  filename longer than 65535 bytes in UTF-8 was written, but `gzipDecompress()`
  and `gzipReadHeader()` could not read the result back; it now throws `gzip
  filename must be at most 65535 bytes long`.
- 15b4d0b: Stop gzip decompression from reserving memory because of a forged size
  trailer. `gzipDecompress()`, `gzipDecompressWithCapacity()`, their async
  variants and `decompress()` sized their initial output buffer from the
  ISIZE trailer, which nothing verifies until decoding ends, so a few bytes of
  input could reserve up to 4 GiB, capped only by the output limit (256 MB by
  default). The initial buffer is now also capped by what the input can
  expand to and by 64 MiB, and larger outputs grow the buffer as they decode.
  In the native addon, gzip, brotli and LZ4 decompression also report a failed
  reservation of the initial output buffer as an error instead of aborting the
  process.
- 18fb990: Write LZ4 frames in blocks of at most 256 KiB. For more than 256 KiB of
  input, `lz4Compress()` and `lz4CompressAsync()` wrote 4 MiB blocks, as the
  `lz4` CLI does by default, so the encoder and every decoder of the frame
  needed 4 MiB buffers. They now write 256 KiB blocks: compressing 1 MB of
  repetitive data is about 3 times faster, and the output is about 0.3%
  larger on text. They also make room for the whole frame up front, so
  compressing 1 MB that does not compress is about 30% faster.
  `Lz4CompressContext` and the LZ4 compression streams sized their blocks
  from the first chunk and now always write 64 KiB blocks, so a first chunk
  of more than 256 KiB no longer makes the context hold 8 MiB that it did not
  report to V8; their output is then about 1.5 to 2% larger on text than with
  the 4 MiB blocks that such a chunk gave. The compressed bytes change for
  more than 256 KiB of input, and for streams whose first chunk holds more
  than 64 KiB; they are still standard LZ4 frames that any LZ4 decoder reads.
- 3d7ddef: Write a content checksum in LZ4 frames. `lz4Compress()`,
  `lz4CompressAsync()`, `Lz4CompressContext` and the LZ4 compression streams
  now add an xxHash32 of the data to each frame, as the `lz4` CLI does by
  default, so decompression detects corrupted data instead of returning it.
  The output is still a standard LZ4 frame that any LZ4 decoder reads, 4 bytes
  longer than before, and its FLG byte changes from `0x60` to `0x64`.
  Computing the checksum makes compression about 15% slower, and verifying it
  makes decompressing these frames up to about 30% slower. Frames without a
  checksum, as other encoders may write them, still decode.
- 18fb990: Decode LZ4 frames that declare large blocks faster. `lz4Decompress()`,
  `lz4DecompressWithCapacity()`, their async variants, `decompress()` and
  `decompressAsync()` on LZ4 input, `Lz4DecompressContext` and the LZ4
  decompression streams zero-filled a buffer of the frame's block maximum
  size on every call: 4 MiB for frames from the `lz4` CLI, which declares
  4 MiB blocks by default even for small content. Each thread now keeps that
  buffer for its next call while it holds at most 4 MiB, and only its growth
  is zero-filled: decoding 10 KB from such a frame is about 35 times faster,
  and 84 KB of JSON about 5 times. The 8 MiB buffer of a legacy frame
  (`lz4 -l`) is not kept.
- 3d7ddef: Decode every frame of LZ4 input and reject truncated or trailing data.
  `lz4Decompress()`, `lz4DecompressWithCapacity()`, their async variants,
  `decompress()`, `Lz4DecompressContext` and the LZ4 decompression streams
  used to stop at the end of the first frame, or at the first empty block, and
  silently drop whatever followed, and they accepted a frame cut short at a
  block boundary. They now decode concatenated frames like the `lz4` CLI.
  Input that ends inside a frame, including a frame without its end mark,
  throws `lz4 stream is truncated: unexpected end of input`, and a frame
  followed by data that is not a frame throws an `unexpected data after the
  end of a frame` error. The output limit (`capacity`, `maxOutputSize`) covers
  all frames together.
  
  The LZ4-specific functions, context and streams also skip skippable frames,
  which used to fail with `SkippableFrame`, and accept a legacy frame
  (`lz4 -l`) followed by further frames, or with blocks of data that does not
  compress, which used to fail with `BlockTooBig`.
- b15d12d: The Node.js entry of the package root now also exports
  `__napiBindingTarget`, through `require()` and `import`. The loader that
  @napi-rs/cli 3.10 generates adds it to report which binding it loaded.
  It is declared as `'native' | 'wasm32-wasi' | 'wasm32-wasip1'`, and with
  the native addons that this package publishes its value is `'native'`.
  It comes from napi-rs and is not part of the comprs API. The browser
  entry and the `streams` and `node` subpaths do not export it.
- ebb2190: `require('@derodero24/comprs')` no longer lists 23 undeclared `*Task`
  classes, such as `ZstdCompressTask`, that napi-rs generated for the
  `*Async` functions and that could not be constructed. The ES module entry,
  which now re-exports the CommonJS loader, does not list them under Bun and
  bundlers either. The `*Async` functions, their results and their errors
  are unchanged.
- 89a005b: Push the output of the Node.js transforms from `@derodero24/comprs/node` in
  chunks of at most `readableHighWaterMark` bytes (64 KiB by default, 16 KiB on
  Windows). A small input chunk that decompressed to many megabytes used to
  arrive as one chunk of that size, which downstream consumers had to take in
  at once. The chunks are views of the native output, not copies.
- 694894d: Buffers returned by the one-shot compression and decompression functions
  no longer retain an allocation sized from the input. The encoders reserved
  an output buffer as large as the input, and the decoders grew theirs by
  doubling; the whole allocation lived as long as the returned Buffer, so 50
  retained `brotliCompress()` results of an 8 MB input held about 400 MB of
  memory for less than 1 KB of output. Results now release large spare
  capacity before they are returned. The LZ4 compression streams also stop
  copying each output chunk.
- 43d32c8: Update Rust crates that compile into the published native binary and WASM
  build, including zlib-rs 0.6.8 (the gzip and deflate backend),
  brotli-decompressor 6.0.1, crc32fast 1.5.2, twox-hash 2.1.5 and thiserror
  2.0.21, and for the WASM build wasm-bindgen 0.2.129 and js-sys 0.3.106.
- 9fcb6c6: `DeflateDecompressContext`, `BrotliDecompressContext` and
  `BrotliDecompressDictContext` now keep failing after an error, in the
  Node.js and browser builds: once `transform()` has thrown, for example on
  data after the end of the compressed stream, `flush()` and `finish()` throw
  the same error instead of `finish()` returning the output decoded before
  that data, and the context releases its decoder state at once. The other
  decompression contexts already failed there. The streams, which close their
  context on any error, are not affected.
- 89a005b: Accept any `ArrayBuffer` or `ArrayBufferView` chunk, as `CompressionStream`
  does, and a `SharedArrayBuffer` as well, in the Web streams that
  `@derodero24/comprs/streams` provides with the native addon (Node.js, Deno
  and Bun). A bare `ArrayBuffer` used to fail with `Value is none of these
  types`, and `createDecompressStream()` failed to detect the format of
  `DataView` and `Uint16Array` chunks, which it read as empty or element by
  element. Every chunk is now read byte for byte, and a chunk that is not
  binary data errors the stream with a `TypeError`. The typings accept these
  chunks and remain assignable to `TransformStream<Uint8Array, Uint8Array>`.
- 94945f4: The Web streams of the native and browser builds read the bytes of each
  chunk rather than its `byteLength`, `byteOffset` and `buffer` properties,
  as the other functions do. A typed array subclass or a view with own such
  properties is now compressed and decompressed as the bytes it holds;
  `createDecompressStream()` buffered such chunks at the wrong size, and a
  `DataView` with an own `byteOffset` was read from the wrong place.
- e25f89a: The npm packages now include `THIRD_PARTY_LICENSES`, the licenses of the Rust
  crates and of the zstd C library that the native and WebAssembly builds link
  statically, and the platform packages include comprs's `LICENSE`.
- ccfb44d: No API change: `streams.js`, `node.js`, `index.mjs` and `browser/streams.js`
  are now compiled from TypeScript, and their declarations are generated from
  the code.
- 54bf460: Fix a crash in Bun and Deno when a method of a native context class is
  called with an instance of another context class as `this`, such as
  `ZstdCompressContext.prototype.transform.call(gzipContext, chunk)`. The
  method used the other class's native state as its own, and the process
  crashed with a segmentation fault. It now throws an `InvalidArg` error;
  Node.js already rejected such calls with `Illegal invocation`.
  
  The fix comes with the update of the native addon to napi 3.14.0,
  napi-derive 3.6.10 and napi-build 2.6.0, which tag every class instance
  and check the tag before a method uses it. The crates were held at 3.9.1 /
  3.5.6 / 2.3.2 for the WASI build, which is no longer published.
- dc859ee: In the native addon, the synchronous functions and the stream contexts now
  return results of up to 2 MiB in memory that the JavaScript engine owns,
  instead of memory that Node.js frees only on a later turn of the event
  loop. A synchronous loop no longer page-faults fresh memory on every call
  or holds on to every result until it yields: on Linux with glibc,
  `deflateDecompress()` calls that return 1 MB take about 0.4 ms instead of
  1.1 ms, and 200 of them grow the resident set by about 12 MiB on Node.js 22
  and 50 MiB on Node.js 24, instead of about 190 MiB. Such results can also
  be transferred to workers, so the Web streams no longer copy each chunk a
  second time, and a chunk of the Node.js transforms that holds a whole
  result can be transferred too. Larger results, and the results of the
  `*Async` functions, stay in the memory of the addon, which saves a copy.
- 0f15e49: Reject invalid numeric arguments instead of silently converting them.
  Compression levels and qualities, the `crc32()` initial value and the gzip
  header `mtime` were converted to 32-bit integers before any check ran, so
  `NaN` and `Infinity` became 0 (no compression for gzip, deflate and brotli),
  `1.9` became 1, `2 ** 32 + 1` became 1 and `crc32(data, -1)` used
  `0xFFFFFFFF`. This applied to the one-shot and async functions and to the
  stream contexts, in the native addon and in the WASM build, which also
  turned non-numeric strings and objects into 0. `maxOutputSize` truncated
  fractions (`0.5` became a limit of 0 bytes), and a `capacity` of `2 ** 64`
  passed validation. All of these now throw an error that names the argument
  and its accepted range, for example `gzip compression level must be an
  integer between 0 and 9`; the messages of the existing range errors changed
  to this form. `capacity` and `maxOutputSize` accept integers from 0 to
  `Number.MAX_SAFE_INTEGER` on every platform (the WASM build used to reject a
  `capacity` of `2 ** 32` or more), and a limit of 0 accepts only data that
  decompresses to nothing. `maxDictSize` accepts integers from 0 to 16777216.
- 5cead12: Read the bytes of input arrays in the browser (WebAssembly) build, rather
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
- 7cf02d8: Make the WebAssembly build take and return what the native addon does.
  Its `gzipCompressWithHeader()` took `(data, level, filename, mtime)`
  rather than the `(data, header, level)` of the published types, so
  `gzipCompressWithHeader(data, { filename }, 6)` failed with
  `RuntimeError: memory access out of bounds`. It now takes
  `(data, header, level)`, as the native addon does; the positional form was
  never part of the published types, and calls that use it must pass the
  header as an object. `gzipReadHeader()` now leaves out the header fields
  that are absent, rather than setting them to `null`, as the native addon
  does.
  
  Byte array arguments are now checked as the native addon checks them:
  anything but a `Uint8Array` (a `Buffer` is one) or another `ArrayBuffer`
  view throws an `Error`. The WebAssembly build used to compress an
  `ArrayBuffer` as empty input and a string as one zero byte per character,
  and its stream contexts took an `ArrayBuffer` or an array of numbers as a
  chunk.
- 7cf02d8: Log the message of a panic in the WebAssembly build. A panic aborts the
  call with a trap, which throws a bare `RuntimeError: unreachable`; the
  build now logs the panic message with `console.error()` first.
- 2180aaf: Shrink the WebAssembly build that browsers load. `comprs-wasm_bg.wasm`,
  which 2.0.2 compiled for speed, is now compiled for size, which makes the
  same code about a fifth smaller, 14% smaller to download with gzip (level
  9) and 12% smaller with brotli (quality 11). The README lists the sizes of
  the current build, under "WASM bundle size". In exchange, brotli
  compression runs about 40% slower in the browser, brotli decompression
  about 30%, gzip decompression about 20% and LZ4 compression about 10%
  slower; zstd, gzip compression and LZ4 decompression keep their speed. The
  native addon is unchanged.
- b683226: Fix a memory-safety bug in the browser (WebAssembly) build: a zstd operation
  whose memory allocation cannot be satisfied — for example decompressing a
  frame that declares a very large window in a memory-constrained tab — used to
  corrupt WebAssembly linear memory and trap with an opaque out-of-bounds error.
  It now fails deterministically at the point the allocation fails. The wasm
  crate installs a global allocator that aborts on allocation failure, so
  zstd-sys's WebAssembly allocation shim can never receive a null pointer and
  hand zstd a buffer derived from it. The native addon uses the system allocator
  and was never affected.
- bae7130: Link the C runtime statically into the Windows ARM64 binary
  (`@derodero24/comprs-win32-arm64-msvc`), as the x64 one already did. Up to
  2.0.2 it imported `VCRUNTIME140.dll` and the `api-ms-win-crt-*` DLLs, so
  loading comprs failed on Windows on Arm machines without the Visual C++
  Redistributable for ARM64. It now loads without it.
- 15b4d0b: Size zstd one-shot decompression output from the data instead of reserving
  it up front. `zstdDecompress()`, `zstdDecompressWithDict()`, their async
  variants and `decompress()` reserved 256 MB for every frame without a
  content size, which streaming encoders such as `ZstdCompressContext` write,
  and the `*WithCapacity()` variants allocated the whole `capacity`, so a value
  such as `2 ** 40` aborted the process. The output buffer now grows with the
  decompressed data: frames that declare their size still decode straight
  into a buffer of that size, as long as the input could actually expand to
  it, and everything else goes through the streaming decoder. `capacity` is
  only a limit, and output over it throws `zstd decompress exceeded maximum
  size of <capacity> bytes` like the other formats, instead of `Destination
  buffer is too small`.
  
  The one-shot zstd functions now accept concatenated frames and skippable
  frames, as the streaming API already did, and report truncated input as
  `zstd stream is truncated: unexpected end of input`; data after the last
  frame now usually reports `Unknown frame descriptor` instead of `Src size is
  incorrect`. Like the streaming API and `zstd -d`, they reject a frame
  without a content size whose window exceeds 128 MiB (written by
  `zstd --long=28` or higher on piped input) with `Frame requires too much
  memory for decoding`.
- 15b4d0b: Reject a `maxDictSize` above 16 MiB (16777216 bytes) in
  `zstdTrainDictionary()` and `zstdTrainDictionaryAsync()`. The value was
  allocated up front, so one that could not be allocated, such as `2 ** 40`,
  aborted the process (a trap in the WASM build). zstd recommends
  dictionaries of about 100 KB, and training allocates several buffers of
  `maxDictSize` bytes.
- 8f6967f: Speed up small one-shot zstd calls. `zstdCompress()`, `zstdDecompress()`,
  `zstdDecompressWithCapacity()`, their `*Async` variants, and `decompress()`
  and `decompressAsync()` for zstd input reuse one compression and one
  decompression context per thread instead of creating one per call:
  compressing messages of about 110 bytes is about 6 times faster, and
  decompressing them about 12 times. A thread keeps a context only while it
  holds at most 8 MiB, so a large or high-level call does not leave its
  workspace behind. The output is unchanged, and the dictionary functions
  still create a context per call.
- 8f6967f: Speed up zstd stream compression with small chunks. `ZstdCompressContext`,
  `ZstdCompressDictContext` and the zstd compression streams no longer
  zero-fill a 128 KiB output buffer on every call: 10 MiB written in 1 KiB
  chunks compresses about 10 times faster for highly compressible data and
  up to twice as fast for JSON lines. The output is unchanged.
- 27a3926: Bound the window of the zstd decoders by the output limit. A zstd frame
  header can declare a window, or for a single-segment frame a content size,
  of up to 128 MiB, which the streaming decoder allocated as soon as it had
  read the header, whatever `capacity` or `maxOutputSize` said. Stream
  contexts decode every frame with it, and the one-shot functions any input
  whose frame headers do not size the output, such as frames without a
  content size: 100 `ZstdDecompressContext`s with a `maxOutputSize` of 1024
  bytes, fed the 6-byte header of such a frame, held 12.5 GiB of address
  space and reported it to V8, and the WebAssembly build grew its memory by
  128 MiB for good.
  
  `zstdDecompressWithCapacity()`, `zstdDecompressWithDictWithCapacity()`,
  their async variants, `decompress()` and `decompressAsync()` for zstd input,
  `ZstdDecompressContext`, `ZstdDecompressDictContext` and the zstd
  decompression streams now accept a window of at most the limit rounded up
  to a power of two, but never less than 8 MiB, the most that zstd writes at
  levels up to 19, nor more than zstd's default of 128 MiB. A frame whose
  window exceeds the bound fails before the decoder allocates anything, in
  one of two ways:
  
  - A limit of 64 MiB or less lowers zstd's bound, and the frame throws
    `zstd frame window exceeded maximum size of <limit> bytes`, the size-limit
    error. Raising the limit decodes the frame if its window is at most
    128 MiB; a window over 128 MiB throws the same error, although no limit
    decodes it.
  - A limit of more than 64 MiB, such as the default of 256 MB, keeps zstd's
    bound of 128 MiB, and a frame whose window exceeds it still throws zstd's
    `Frame requires too much memory for decoding`, a corrupt-data error.
  
  Of the frames that zstd writes, only those without a content size whose
  window exceeds 8 MiB can now fail under a limit that their output fits in:
  streams that `ZstdCompressContext`, the streams built on it or
  `zstd --ultra` reading a pipe compress at levels 20 to 22, and streams
  compressed with `zstd --long`. Under an explicit limit, they now need one of
  more than 16 MiB at level 20, 32 MiB at level 21, and 64 MiB at level 22 or
  with `--long`. Frames that zstd compresses with a known size, such as those
  of `zstdCompress()`, declare no window larger than their content and decode
  under any limit that their content fits in.

## 2.0.2

### Patch Changes

- 5d9d464: Update the `brotli` crate to 9.0 (with `brotli-decompressor` 6.0) and the
  Criterion benchmark harness to `codspeed-criterion-compat` 5.0. The brotli
  API and output format used by comprs are unchanged; this ships in the
  native binary and WASM build.
- b1ddd73: Regenerate the napi-rs loaders with `@napi-rs/cli` 3.9.1. The browser WASI
  loader shipped in `@derodero24/comprs-wasm32-wasi` keeps lazy worker reuse
  (`reuseWorker: true`): the eager worker pool that 3.9 generates makes
  `@emnapi/wasi-threads` call Node-only worker APIs under Bun and Deno.
- 480795f: Update Rust crate dependencies to their latest semver-compatible versions
  (zstd 0.14, lz4_flex 0.14, brotli 8.0.4, crc32fast 1.5.1, wasm-bindgen
  0.2.128, js-sys 0.3.105, thiserror 2.0.20, and transitive crates). flate2
  stays pinned at 1.1.9 because 1.1.10 regresses gzip and deflate throughput
  with the zlib-rs backend, and the napi crates stay at 3.9.1 / 3.5.6 / 2.3.2
  because the 3.12 line links against emnapi 2 for the WASI target. These
  compile into the published native binary and WASM build.

## 2.0.1

### Patch Changes

- aa90292: Regenerate the napi-rs loader with `@napi-rs/cli` 3.7.2. The generated
  `index.js` drops the `node:` import prefix and optional chaining (`?.`) from
  its native-binding loader, improving compatibility with older Node.js
  versions and bundlers that don't support these syntax forms.
- 5099f17: Regenerate the napi-rs loader with `@napi-rs/cli` 3.7. The generated
  `index.js` now treats `NAPI_RS_FORCE_WASI` as a tri-state flag: only `'true'`
  or `'error'` force the WASI fallback, so values like `NAPI_RS_FORCE_WASI=false`
  or `=0` no longer inadvertently trigger the WASI path (which could fail with
  ENOENT for packages shipped without a `.wasi.cjs` file).
- 3f50b0a: Update Rust crate dependencies to their latest semver-compatible versions
  (brotli, lz4_flex, napi/napi-derive/napi-build, wasm-bindgen, js-sys,
  criterion, and transitive crates). These compile into the published native
  binary and WASM build.

## 2.0.0

### Major Changes

- da8d285: Drop Node.js 20 support and bump napi ABI to napi9.

  Node.js 20 reached end-of-life on 2026-04-30. The minimum supported Node.js
  version is now 22 (Active LTS). The napi-rs ABI feature has been bumped from
  `napi6` to `napi9` (Node 18.17+ / 20.3+), which is safe under the new floor.

  **Breaking change:** Users on Node.js 20 must upgrade to Node.js 22 or later.

## 1.1.0

### Minor Changes

- 673c726: Performance improvements: gzip ISIZE buffer pre-allocation, zstd
  multi-threaded compression (zstdmt; corrected: libzstd is built with
  multi-threading support, but nothing enables its worker threads, so zstd
  compression runs on one thread, see
  [#561](https://github.com/derodero24/comprs/issues/561)), streaming buffer
  reuse

## 1.0.1

### Patch Changes

- af5c0b8: Fix missing zstdDecompressWithDictWithCapacityAsync ESM export and sync Cargo.toml versions

## 1.0.0

### Major Changes

- 796774f: First stable release with wasm-bindgen browser support (no SharedArrayBuffer required), three-crate architecture, and full algorithm coverage (zstd, gzip, brotli, lz4)

## 0.4.1

### Patch Changes

- 5130974: Fix npm publish for scoped platform packages by adding publishConfig and release workflow permissions

## 0.4.0

### Minor Changes

- 3ac395a: Add Brotli dictionary compression and decompression support

## 0.3.1

### Patch Changes

- 38a3787: Enforce maxOutputSize in browser WASM ZstdDecompressDictContext by adding zstdDecompressWithDictWithCapacity
- 764ba82: Use `decompress_with_limit` in async auto-detect decompression for gzip and brotli, replacing manual chunk-read loops that performed a double-copy through an intermediate stack buffer.
- ad5add2: Fix missing validation for maxDictSize parameter in zstdTrainDictionary

## 0.3.0

### Minor Changes

- c23b4e6: Add brotli compression/decompression support via `brotliCompress()` and `brotliDecompress()` functions. Includes streaming API with `createBrotliCompressStream()` and `createBrotliDecompressStream()`. Quality levels 0-11 (default: 6).
- 98e64a9: Add gzip and raw deflate compression/decompression support via `gzipCompress()`, `gzipDecompress()`, `deflateCompress()`, `deflateDecompress()` functions. Includes streaming API with `createGzipCompressStream()`, `createGzipDecompressStream()`, `createDeflateCompressStream()`, and `createDeflateDecompressStream()`.
- 356319f: Add LZ4 frame compression/decompression support via `lz4Compress()` and `lz4Decompress()` functions. Includes streaming API with `createLz4CompressStream()` and `createLz4DecompressStream()`, and Node.js Transform streams via `createLz4CompressTransform()` and `createLz4DecompressTransform()`. Auto-detect (`decompress()`, `detectFormat()`) now recognizes LZ4 frames.

### Patch Changes

- 49b5c2d: Rename package from `zflate` to `comprs` to avoid npm typosquat protection.

## 0.2.0

### Minor Changes

- fb7c15f: Add streaming compression/decompression API using Web Streams API (`TransformStream`). New functions `createZstdCompressStream()` and `createZstdDecompressStream()` enable chunked processing of large data with bounded memory usage. Streaming output is fully interoperable with one-shot `zstdCompress()`/`zstdDecompress()`.
- 9ceb306: Add zstd compression and decompression support via `zstdCompress()`, `zstdDecompress()`, and `zstdDecompressWithCapacity()` functions. Supports compression levels 1-22 (default: 3) and negative levels for fast mode.
