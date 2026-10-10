---
'@derodero24/comprs': patch
---

The synchronous functions and the stream contexts now return results of up
to 2 MiB in memory that V8 owns, instead of memory that Node.js frees only
on a later turn of the event loop. A synchronous loop no longer page-faults
fresh memory on every call or holds on to every result until it yields:
`deflateDecompress()` calls that return 1 MB take about 0.4 ms instead of
1.1 ms, and 200 of them grow the resident set by 12 MiB instead of 190 MiB.
Such results can also be transferred to workers, and the Web streams no
longer copy each chunk a second time. In the Node.js transforms, the chunks
that one input chunk produces share one buffer, so transferring one of them
detaches the others, as with `node:zlib`; before, the transfer threw a
`DataCloneError`. Larger results, and the results of the `*Async`
functions, stay in the memory of the addon, which saves a copy.
