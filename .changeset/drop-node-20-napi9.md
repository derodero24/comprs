---
'@derodero24/comprs': major
---

Drop Node.js 20 support and bump napi ABI to napi9.

Node.js 20 reached end-of-life on 2026-04-30. The minimum supported Node.js
version is now 22 (Active LTS). The napi-rs ABI feature has been bumped from
`napi6` to `napi9` (Node 18.17+ / 20.3+), which is safe under the new floor.

**Breaking change:** Users on Node.js 20 must upgrade to Node.js 22 or later.
