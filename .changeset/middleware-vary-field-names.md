---
'@derodero24/comprs-middleware': patch
---

Read `Vary` as a list of field names when adding `Accept-Encoding` to it. A
`Vary` that names a field merely containing `accept-encoding`, such as
`X-Accept-Encoding-Hint`, now gets `Accept-Encoding` added, which it used to
miss, and a `Vary` that lists `*` next to other field names is left as it is.
