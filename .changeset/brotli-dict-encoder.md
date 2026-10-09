---
'@derodero24/comprs': patch
---

Work around two bugs in the brotli 9.0.0 encoder that `brotliCompressWithDict()`,
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
