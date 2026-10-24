---
title: Platforms
description: Supported runtimes, operating systems and architectures, and the size of the WebAssembly build.
sidebar:
  order: 4
---

| Runtime | Backend |
| --- | --- |
| Node.js 22 or later | Native addon (napi-rs) |
| Deno 2 | Native addon (napi-rs) |
| Bun | Native addon (napi-rs) |
| Browsers | WebAssembly (wasm-bindgen) |

## Native binaries

Node.js, Deno and Bun load a prebuilt native binary, which the package manager installs as an optional dependency, one package per platform:

| OS | Architectures |
| --- | --- |
| macOS | x64 (Intel), ARM64 (Apple Silicon) |
| Linux | x64 and ARM64, with glibc 2.17 or later, or musl |
| Windows | x64, ARM64 |

The Windows binaries link the C runtime statically, so they do not need the Visual C++ Redistributable.

On any other platform, loading comprs in Node.js, Deno or Bun throws `Cannot find native binding`: the WebAssembly build is not used as a fallback there. The error's `cause` chain lists every file and package the loader tried, and the innermost one names the platform, such as `Unsupported OS: aix, architecture: ppc64`. On a listed platform, the same error means that the binary package was not installed, for example because optional dependencies were omitted, or installed on another platform and copied. The chain also names `@derodero24/comprs-wasm32-wasi`: the loader that napi-rs generates still looks for this WASI build, which is no longer published (2.0.2 was its last version). Do not install it, as a newer comprs would load that outdated build.

## WebAssembly size

The browser build is one WebAssembly module, which holds all four codecs, optimized for size. The entry points of the families of `@derodero24/comprs/next` load a module with one family each (see [Browsers](/comprs/guides/browsers/#one-family-of-formats)):

| Binary | Raw | gzip (level 9) | brotli (quality 11) |
| --- | ---: | ---: | ---: |
| `comprs-wasm_bg.wasm` | 1.52 MB | 568 KB | 425 KB |
| `comprs-wasm-zstd_bg.wasm` | 534 KB | 160 KB | 121 KB |
| `comprs-wasm-gzip_bg.wasm` | 177 KB | 76 KB | 64 KB |
| `comprs-wasm-brotli_bg.wasm` | 830 KB | 337 KB | 249 KB |
| `comprs-wasm-lz4_bg.wasm` | 107 KB | 42 KB | 36 KB |

The compressed sizes are those of Node.js's zlib; what a CDN serves depends on its compressor and level. CI reports these sizes on every pull request, and fails when the raw or gzip size grows over its budget.

## What comprs is built on

| Format | Library |
| --- | --- |
| zstd | [zstd](https://github.com/facebook/zstd), the reference C library, through the zstd crate |
| gzip, zlib, raw deflate | [zlib-rs](https://github.com/trifectatechfoundation/zlib-rs), a Rust implementation of zlib, through flate2 |
| brotli | [libbrotli](https://github.com/google/brotli), the reference C library, which `node:zlib` uses too |
| LZ4 | [lz4_flex](https://github.com/PSeitz/lz4_flex), a Rust implementation |

The npm packages include `THIRD_PARTY_LICENSES`, with the licenses of the Rust crates and the C libraries that the native addon and the WebAssembly build link statically.
