---
'@derodero24/comprs-middleware': patch
---

The package can now be loaded with `require()` as well as `import`. Its
entry points were exported for `import` only, so `require()` failed with
`ERR_PACKAGE_PATH_NOT_EXPORTED`, and TypeScript projects that compile to
CommonJS reported `TS2307`. `@derodero24/comprs-middleware/package.json` is
exported too. The package still ships ES modules only, so it now requires
Node.js 22.12 or later instead of 22.0: 22.12 is the first Node.js 22 release
whose `require()` loads ES modules without a flag. A TypeScript project that
compiles to CommonJS needs `module` set to `nodenext` or `node20`.

Express is no longer a peer dependency: the Express adapter only uses the
Node.js request and response, and works with Express 4 and 5.

When both packages are released together, the middleware is now published
only after `@derodero24/comprs`, so its peer range can always be met. The
published manifest no longer lists `workspace:*` for the `@derodero24/comprs`
devDependency, and the package now includes its license file.
