---
'@derodero24/comprs': patch
---

Push the output of the Node.js transforms from `@derodero24/comprs/node` in
chunks of at most `readableHighWaterMark` bytes (64 KiB by default). A small
input chunk that decompressed to many megabytes used to arrive as one chunk
of that size, which downstream consumers had to take in at once. The chunks
are views of the native output, not copies.
