---
'@derodero24/comprs': patch
---

Regenerate the napi-rs loader with `@napi-rs/cli` 3.7.2. The generated
`index.js` drops the `node:` import prefix and optional chaining (`?.`) from
its native-binding loader, improving compatibility with older Node.js
versions and bundlers that don't support these syntax forms.
