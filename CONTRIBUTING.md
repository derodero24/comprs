# Contributing to zflate

Thank you for your interest in contributing! This guide covers everything you need to get started.

## Prerequisites

- [Rust](https://rustup.rs/) ≥ 1.85 (stable toolchain)
- [Node.js](https://nodejs.org/) ≥ 20
- [pnpm](https://pnpm.io/) ≥ 10
- [Git](https://git-scm.com/)

## Development setup

```bash
git clone https://github.com/derodero24/zflate.git
cd zflate
pnpm install --ignore-scripts
pnpm run build
pnpm test
cargo test
```

## Project structure

```
zflate/
├── crates/
│   └── core/        ← Rust core library (zstd, gzip, brotli)
├── __test__/        ← Vitest tests and JS benchmarks
├── npm/             ← Platform-specific binary packages
├── scripts/         ← Build and optimization scripts
└── .github/
    └── workflows/   ← CI, Release, CodeQL, Renovate
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

## Commit messages

Conventional Commits format: `type(scope): description`

**Types:** `feat`, `fix`, `perf`, `refactor`, `test`, `docs`, `ci`, `chore`

**Scopes:** `core`, `zstd`, `gzip`, `brotli`, `wasm`, `bench`, `ci`, `docs`

## Changesets

Required for changes to `crates/`:

```bash
pnpm changeset
```

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

## Code style

- **Rust:** rustfmt + clippy. No `unsafe` code.
- **TypeScript/JavaScript:** Biome.

## Questions?

Open a GitHub Discussion or file an issue.
