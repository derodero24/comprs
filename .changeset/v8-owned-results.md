---
'@derodero24/comprs': patch
---

In the native addon, the synchronous functions and the stream contexts now
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
