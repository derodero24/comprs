---
'@derodero24/comprs': minor
'comprs': minor
---

New package: `comprs`, the same library under an unscoped name. Each of its entry points, `comprs`, `comprs/streams`, `comprs/node` and `comprs/next`, re-exports the one of `@derodero24/comprs` with the same subpath, with the same types and the same browser build for bundlers, and both packages are released together at the same version. In 3.0, the code will move to `comprs`, and `@derodero24/comprs` will re-export it (#752).
