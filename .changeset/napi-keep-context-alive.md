---
"@derodero24/comprs": patch
---

A stream context with an asynchronous call in flight, such as `transformAsync()`, is no longer garbage-collected before the call settles, and is collected once it settles. The native addon is built with napi-rs 3.15.
