---
'@derodero24/comprs': patch
---

Declare `CompressionFormat` as a regular enum rather than a `const enum`.
TypeScript cannot use the members of a declared `const enum` in projects
that enable `isolatedModules` or `verbatimModuleSyntax`, as esbuild, swc
and Vite setups do: there, `detectFormat(data) === CompressionFormat.Zstd`,
an exhaustive `switch` with `case CompressionFormat.Zstd:` and, with
`verbatimModuleSyntax` on TypeScript 5.9 and later, even importing the enum
failed with TS2748. They now type-check. Code that `tsc` compiles reads the
members from the exported object instead of inlining their strings.

The browser entry now exports `CompressionFormat` as well: in 2.0.x, the
declarations of the `browser` condition declared it, but the entry did not
export it. The values are unchanged, the strings `'zstd'`, `'gzip'`,
`'brotli'`, `'lz4'` and `'unknown'`, so comparisons with strings keep
working. As in the native addon, the members are not enumerable:
`Object.keys(CompressionFormat)` and `Object.values(CompressionFormat)`
return `[]`.
