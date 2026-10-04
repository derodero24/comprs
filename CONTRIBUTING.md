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
│   ├── core/        ← napi-rs bindings for Node.js (zstd, gzip, brotli, lz4)
│   ├── wasm/        ← wasm-bindgen bindings for browsers
│   └── bench/       ← Rust benchmarks (Criterion)
├── browser/         ← Browser entry, and the wasm-bindgen build it loads
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
pnpm run bench        # JS benchmarks
cargo bench           # Rust benchmarks
```

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
