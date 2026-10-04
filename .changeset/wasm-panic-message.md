---
'@derodero24/comprs': patch
---

Log the message of a panic in the WebAssembly build. A panic aborts the
call with a trap, which throws a bare `RuntimeError: unreachable`; the
build now logs the panic message with `console.error()` first.
