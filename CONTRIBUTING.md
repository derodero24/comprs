# Contributing to comprs

Thank you for your interest in contributing! This guide covers everything you need to get started.

## Prerequisites

- [Rust](https://rustup.rs/) ≥ 1.85 (stable toolchain)
- [Node.js](https://nodejs.org/) ≥ 22
- [pnpm](https://pnpm.io/) ≥ 10
- [Git](https://git-scm.com/)

## Development setup

```bash
git clone https://github.com/derodero24/comprs.git comprs
cd comprs
pnpm install --ignore-scripts
pnpm run build
pnpm test
cargo test
```

## Project structure

```
comprs/
├── crates/
│   ├── core-lib/    ← Pure Rust compression logic (no FFI dependencies)
│   │   └── fuzz/    ← cargo-fuzz targets for core-lib
│   ├── core/        ← napi-rs bindings for Node.js (zstd, gzip, brotli, lz4)
│   ├── wasm/        ← wasm-bindgen bindings for browsers
│   └── bench/       ← Rust benchmarks (Criterion)
├── __test__/        ← Vitest tests and JS benchmarks
├── e2e/             ← Browser and runtime E2E tests (Playwright, Deno, Bun)
├── npm/             ← Platform-specific binary packages
├── playground/      ← Interactive playground (GitHub Pages)
├── scripts/         ← Build, packaging and optimization scripts
└── .github/
    └── workflows/   ← CI, Release, CodeQL, Renovate, Playground
```

## Workflow

All changes must start from a GitHub Issue.

1. Check existing issues or open a new one
2. Fork the repository and create a branch: `type/issue-<number>-<short-summary>`
3. Make your changes
4. Run the full verification suite
5. Open a pull request targeting the `develop` branch

### Branch naming

| Type          | Example                          |
| ------------- | -------------------------------- |
| Feature       | `feat/issue-42-batch-api`        |
| Bug fix       | `fix/issue-13-edge-case`         |
| Documentation | `docs/issue-28-contributing`     |
| CI/tooling    | `ci/issue-20-path-filters`       |

## Verification

Before pushing, run all of the following:

```bash
pnpm run check        # Biome lint
pnpm run typecheck    # TypeScript (requires prior build)
pnpm test             # Vitest tests
cargo test            # Rust tests
cargo clippy          # Rust lint
pnpm run build        # napi-rs build
```

CI also runs the package in other runtimes. To run these checks locally:

```bash
pnpm run test:bun             # Bun, through the native addon
pnpm run test:deno            # Deno, through the native addon
pnpm run build:wasm-bindgen   # WebAssembly build (needs wasm-pack and the wasm32-unknown-unknown target)
pnpm run test:wasm            # WebAssembly build, compared with the native addon
pnpm run test:browser         # WebAssembly build in Chromium (Playwright)
```

## Fuzzing

`crates/core-lib/fuzz` holds [cargo-fuzz](https://rust-fuzz.github.io/book/cargo-fuzz.html) targets for `comprs-core`:

| Target | What it runs |
| ------ | ------------ |
| `zstd`, `gzip`, `deflate`, `brotli`, `lz4` | Every one-shot function and stream context of the format, including the dictionary variants, on random bytes or on a damaged valid stream, with small output limits and fuzzer-chosen chunk boundaries |
| `detect` | Format detection, auto-detecting decompression and `gzip::read_header` |
| `round_trip` | Compression in one call or in chunks, then every way of decompressing the result |

A target fails when the code under test panics, outputs more than its limit, gives results that disagree between APIs or limits, or allocates more heap memory than its output limit accounts for (`crates/core-lib/fuzz/src/heap.rs` counts the allocations). The Fuzz workflow runs each target for 10 minutes every week and for 1 minute on pull requests that change the fuzz crate, and uploads failing inputs as artifacts. On pull requests that change `comprs-core` or its dependencies, it checks that the fuzz crate still builds.

To fuzz locally (Linux or macOS), install a nightly toolchain and cargo-fuzz, then run a target for as long as you like:

```bash
rustup toolchain install nightly --profile minimal
cargo install cargo-fuzz --locked
cargo +nightly fuzz list --fuzz-dir crates/core-lib/fuzz
cargo +nightly fuzz run --fuzz-dir crates/core-lib/fuzz zstd -- -max_total_time=60
```

The corpus and failing inputs go to `corpus/` and `artifacts/` in the fuzz crate, which git ignores.

To reproduce a failure from CI, download the input and pass it to the target:

```bash
gh run download <run-id> --name fuzz-zstd --dir fuzz-zstd
cargo +nightly fuzz run --fuzz-dir crates/core-lib/fuzz zstd fuzz-zstd/crash-<hash>
```

The fuzz crate is a workspace of its own, as cargo-fuzz sets it up, so that it builds with its own release profile and stays out of the cargo commands run on the comprs workspace. Its `Cargo.lock` must keep the versions of the workspace's `Cargo.lock`, so that the fuzzers build the dependencies that comprs ships; the Fuzz workflow checks this. After changing `Cargo.lock` or the dependencies of `comprs-core`, update it:

```bash
cp Cargo.lock crates/core-lib/fuzz/Cargo.lock
cargo update --workspace --manifest-path crates/core-lib/fuzz/Cargo.toml
```

## Commit messages

Conventional Commits format: `type(scope): description`

**Types:** `feat`, `fix`, `perf`, `refactor`, `test`, `docs`, `ci`, `chore`

**Scopes:** `core`, `zstd`, `gzip`, `brotli`, `wasm`, `bench`, `ci`, `docs`

## Changesets

Required for changes to `crates/`:

```bash
pnpm changeset
```

`@derodero24/comprs-middleware` has `@derodero24/comprs` as a peer dependency. `.changeset/config.json` sets `onlyUpdatePeerDependentsWhenOutOfRange`, so a core release that the middleware's peer range still covers leaves the middleware alone. A core release outside that range, such as a new major, makes `changeset version` release the middleware as a patch with its peer range moved to the new version, which breaks installs that keep the older core. With a breaking core change, add a `major` changeset for `@derodero24/comprs-middleware` as well.

## Release packaging

The `Release Dry Run` CI job assembles the npm packages from the build artifacts with `scripts/prepare-release.mjs`, the script the release workflow runs before `npm publish`, then checks them with `scripts/check-release.mjs`. Nothing is published. To reproduce a failure locally, download the run's `bindings-*` artifacts into `artifacts/`, one directory per artifact, and run both scripts:

```bash
gh run download <run-id> --pattern 'bindings-*' --dir artifacts
node scripts/prepare-release.mjs --artifacts-dir artifacts
node scripts/check-release.mjs
```

Pass `--allow-missing-targets` to both scripts when the run built only some targets, as CI does for pull requests that build only Linux (see the `changes` job in `ci.yml`). `prepare-release.mjs` writes the build outputs into the working tree (the package root and `npm/`), as the release does.

## Pull request checklist

- [ ] Tests pass (`pnpm test` and `cargo test`)
- [ ] Lint passes (`pnpm run check` and `cargo clippy`)
- [ ] TypeScript types checked (`pnpm run typecheck`)
- [ ] Build succeeds (`pnpm run build`)
- [ ] Changeset added (if applicable)
- [ ] PR title follows Conventional Commits
- [ ] Issue linked (`Closes #<number>`)

## Benchmarks

If your change affects performance:

```bash
pnpm run bench                # JS benchmarks
cargo bench -p comprs-bench   # Rust benchmarks
```

CodSpeed runs the Rust benchmarks on pull requests that change Rust code. They call `comprs-core`, so they measure comprs's own code (output sizing, stream contexts, dictionaries) together with the codecs; the benchmarks marked `(upstream)` call a codec crate alone as a baseline. The patterned, random and JSON inputs are the same in both languages (`crates/bench/src/lib.rs` and `__test__/bench-fixtures.ts`), and tests on both sides check that the generated bytes match.

## Troubleshooting

### "Cannot find native binding" error

The native `.node` binary has not been built yet. Run:

```bash
pnpm run build
```

### TypeScript typecheck fails on fresh clone

`index.d.ts` is generated by napi-rs during the build step. Run `pnpm run build` before `pnpm run typecheck`.

### Rust compilation errors after switching branches

Stale build cache from a different feature branch can cause unexpected errors. Clean and rebuild:

```bash
cargo clean
pnpm run build
```

## Code style

- **Rust:** rustfmt + clippy. No `unsafe` code.
- **TypeScript/JavaScript:** Biome.

## Questions?

File an issue on [GitHub](https://github.com/derodero24/comprs/issues).
