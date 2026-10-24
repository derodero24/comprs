# Contributing to comprs

Thank you for your interest in contributing! This guide covers everything you need to get started.

## Prerequisites

- [Rust](https://rustup.rs/) ≥ 1.88 (CI lints and tests with the latest stable)
- A C compiler, for the zstd and libbrotli C sources (Clang for the WebAssembly build)
- [Node.js](https://nodejs.org/) 22 (≥ 22.20), 24 (≥ 24.12) or 26 (`engineStrict` in `pnpm-workspace.yaml` makes `pnpm install` fail on a version that a dependency's `engines` field excludes)
- [pnpm](https://pnpm.io/) 12 (`packageManager` in `package.json` sets the exact version)
- [Git](https://git-scm.com/)
- [cargo-deny](https://github.com/EmbarkStudios/cargo-deny) (`cargo install cargo-deny --locked`), which the pre-push hook runs

`rust-version` in `Cargo.toml` is the minimum supported Rust version. The `Rust MSRV` CI job checks the workspace with exactly that version, so a dependency update that needs a newer Rust fails there. Such an update raises `rust-version`, and the Rust version in this section, in the same pull request. To run the check locally:

```bash
rustup toolchain install 1.88 --profile minimal --target wasm32-unknown-unknown
cargo +1.88 check --workspace --all-targets --locked
cargo +1.88 check -p comprs-wasm --target wasm32-unknown-unknown --locked
```

## Development setup

```bash
git clone https://github.com/derodero24/comprs.git comprs
cd comprs
pnpm install --ignore-scripts
pnpm exec lefthook install   # Git hooks (lefthook.yml), which --ignore-scripts skips
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
│   ├── brotli-c/    ← libbrotli, vendored in brotli/, with the safe interface that comprs uses (see Vendored libbrotli)
│   ├── core/        ← napi-rs bindings for Node.js (zstd, gzip, brotli, lz4)
│   ├── wasm/        ← wasm-bindgen bindings for browsers
│   └── bench/       ← Rust benchmarks (Criterion)
├── src/             ← TypeScript sources of the stream helpers, the ES module entry and the unified API
├── browser/         ← Browser entry, and the wasm-bindgen build it loads
├── __test__/        ← Vitest tests and JS benchmarks
├── e2e/             ← Tests of the packed package in Node.js, Deno, Bun and browsers
├── npm/             ← Platform-specific binary packages
├── packages/
│   └── middleware/  ← HTTP compression middleware (@derodero24/comprs-middleware)
├── website/         ← Documentation site and playground (Astro Starlight, GitHub Pages)
├── scripts/         ← Build, packaging, optimization and benchmark report scripts
├── .changeset/      ← Changesets of the next release (see Changesets)
└── .github/
    └── workflows/   ← CI, Build, Release, Fuzz, CodSpeed, CodeQL, Renovate, Website, Bench Report
```

### JavaScript sources

The stream helpers, the ES module entry and the unified API are written in TypeScript, in `src/`, and compiled into tracked files that npm publishes:

| Source | Output |
| ------ | ------ |
| `src/streams.ts` | `streams.js` and `streams.d.ts`: the Web Streams helpers (`@derodero24/comprs/streams`) |
| `src/node.ts` | `node.js` and `node.d.ts`: the Node.js transforms (`@derodero24/comprs/node`) |
| `src/stream-schedule.ts` | `stream-schedule.js` and `stream-schedule.d.ts`: `ChunkScheduler`, which decides which calls of the Web Streams helpers and the Node.js transforms run on the libuv thread pool. npm publishes it for those two modules, which import it; `package.json` does not export it |
| `src/index.mts` | `index.mjs` and `index.d.mts`: the ES module entry |
| `src/browser/streams.ts` | `browser/streams.js` and `browser/streams.d.ts`: the Web Streams helpers for browsers |
| `src/next/` | `next/` and `browser/next/`: the unified API, `@derodero24/comprs/next` ([#577](https://github.com/derodero24/comprs/issues/577)). `api.ts` holds the functions and the stream classes and checks the types of their arguments, `abort.ts` handles the `signal` option of the async functions, and `backend.ts` holds the `Backend` interface, which the backend of each build implements. In `next/`, `native.ts` makes the hidden binding of the native addon (`crates/core/src/next.rs`) the backend, and `index.ts` and `index.mts` are the CommonJS and ES module entries for Node.js. In `browser/next/`, `wasm.ts` makes the functions of the WebAssembly build (`crates/wasm/src/next.rs`), which `browser/wasm.js` loads, the backend, and `browser.ts` is the entry for browsers |

The outputs are committed. Edit the sources, never the outputs, then run `pnpm run build:js` (`scripts/build-js.mjs`, with `tsconfig.build.json`, `tsconfig.browser.json` and `tsconfig.next-browser.json`) and commit the sources and outputs together. CI runs `pnpm run build` and `pnpm run build:js` and fails if they change any file. Each project lists its entries in `files`, and compiles the modules that they import as well. Editors check the sources with `src/tsconfig.json`, `src/browser/tsconfig.json` and `src/next/tsconfig.json`, which take the options and files of those three projects. The projects that `build:js` compiles must stay plain JSON, without comments. A TypeScript update can change the outputs; Renovate proposes it in a pull request of its own, which then needs `pnpm run build:js`. The browser entry, `browser/index.js`, and `browser/wasm.js`, which loads the WebAssembly module for the entry and for `browser/next/`, are written by hand, as are their declarations.

### Vendored libbrotli

`crates/brotli-c/brotli` holds the C sources of [libbrotli](https://github.com/google/brotli), Google's brotli library, as released: the `.c` and `.h` files of `c/common`, `c/dec`, `c/enc` and `c/include`, and its `LICENSE` (MIT). `crates/brotli-c` builds them with `cc` and wraps the part that comprs uses: the streaming encoder and decoder, and raw dictionaries. All the unsafe code that calls libbrotli is in that crate; comprs-core forbids unsafe code (#563).

Never edit the vendored files. `BROTLI_VERSION` in `scripts/vendor-brotli.mjs` names the release, and the script vendors it:

```bash
node scripts/vendor-brotli.mjs          # replace crates/brotli-c/brotli with BROTLI_VERSION
node scripts/vendor-brotli.mjs --check  # what the Rust Lint job runs
```

Renovate updates `BROTLI_VERSION` in a pull request of its own. The Rust Lint job fails on it until the script has been run on that branch and its changes committed.

`wasm32-unknown-unknown` has no C library, so for that target `crates/brotli-c/wasm-shim` supplies the few headers that libbrotli includes. Rust provides the functions behind them: `malloc` and `free` come from `src/alloc.rs`, and Rust's compiler-builtins supplies `memcpy`, `log2` and the rest. If a new libbrotli release includes another libc header, the WebAssembly build fails until the shim covers it. The Rust MSRV job checks that build.

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

Before pushing, run the following, or `pnpm run verify`, which runs all of them and builds before the checks that use the build:

```bash
pnpm run check        # Biome lint and formatting; warnings fail it too
pnpm run typecheck    # TypeScript
pnpm run test:types   # Packed package, type-checked by strict consumer projects
pnpm test             # Vitest tests
cargo test            # Rust tests
cargo test -p comprs-core   # comprs-core alone, without zstdmt, as the WebAssembly build compiles it
cargo clippy --workspace --all-targets -- -D warnings   # Rust lint; warnings fail it too
pnpm run build        # napi-rs build
pnpm run build:js     # Modules and declarations compiled from src/
pnpm --filter @derodero24/comprs-middleware typecheck   # When packages/middleware changes
pnpm --filter @derodero24/comprs-middleware test        # When packages/middleware changes
```

`pnpm run typecheck` checks the tests, the benchmarks and `vitest.config.mts` with `tsconfig.json`, the sources in `src/` with the three projects that `build:js` compiles, and the JavaScript in `scripts/` and `__test__/` with `tsconfig.scripts.json`. The middleware has its own check, `pnpm --filter @derodero24/comprs-middleware typecheck`. They all enable `noPropertyAccessFromIndexSignature`: read a property that comes from an index signature, such as a variable of `process.env` or a field of a parsed `package.json`, with brackets (`process.env['CI']`). Biome's `useLiteralKeys` rule, which would rewrite such reads with a dot, is off, except in `browser/index.js`, `browser/wasm.js` and `website/src/playground/`, which no tsconfig checks.

`pnpm run check` runs `biome ci --error-on-warnings`, as CI does, and the pre-commit hook also fails on warnings. Besides Biome's recommended rules, `biome.json` enables some nursery rules: `noFloatingPromises` and `noMisusedPromises` everywhere, and `useExplicitType` in the published sources, `src/` and `packages/middleware/src/`, where functions, methods and their parameters declare their types. A Biome release can rename or change nursery rules, so `package.json` pins Biome to an exact version, which Renovate updates in a pull request of its own. When such an update fails the check, run `pnpm exec biome migrate --write` and fix what the new version reports.

Clippy runs with `-D warnings` in CI, in the pre-push hook and in `pnpm run verify`, so any warning, from rustc or from clippy, fails it. CI lints with the latest stable Rust, whose new lints can fail a pull request that did not touch the code they flag; fix what they report. The Fuzz workflow lints the fuzz crate the same way (`cargo clippy --all-targets -- -D warnings` in `crates/core-lib/fuzz`).

After changing a workflow in `.github/workflows/`, check it with [actionlint](https://github.com/rhysd/actionlint), which CI's Workflow Lint job runs. Its Docker image includes shellcheck, which actionlint runs on the `run:` scripts:

```bash
docker run --rm -v "$PWD:/repo" -w /repo rhysd/actionlint:1.7.12 -color
```

An installed `actionlint` works too (`actionlint -color`), but it checks the scripts only when `shellcheck` is installed as well, and skips them without a word otherwise.

CI's Coverage job runs the Vitest tests with `pnpm test --coverage`, which fails when the coverage falls below the thresholds in `vitest.config.mts` and writes the report to `coverage/`. It also measures the Rust tests of comprs-core with `cargo llvm-cov`, without the napi and wasm-bindgen bindings, which only the JS tests run; both reports go to Codecov.

CI also tests the WebAssembly build. To run these tests locally:

```bash
pnpm run build:wasm-bindgen   # WebAssembly build (needs wasm-pack and the wasm32-unknown-unknown target)
pnpm run test:wasm            # WebAssembly build, compared with the native addon
pnpm run size:wasm            # Size of the WebAssembly binary, checked against its budget
```

The size budget is in `scripts/wasm-size.mjs`. Raise it in the pull request that needs the extra bytes, and explain why there.

CI then tests the package as it would be published (see [Package tests](#package-tests)).

## Fuzzing

`crates/core-lib/fuzz` holds [cargo-fuzz](https://rust-fuzz.github.io/book/cargo-fuzz.html) targets for `comprs-core`:

| Target | What it runs |
| ------ | ------------ |
| `zstd`, `gzip`, `deflate`, `brotli`, `lz4` | Every one-shot function and stream context of the format, including the dictionary variants, on random bytes or on a damaged valid stream, with small output limits and fuzzer-chosen chunk boundaries |
| `detect` | Format detection, auto-detecting decompression and `gzip::read_header` |
| `round_trip` | Compression in one call or in chunks, then every way of decompressing the result |
| `unified_decompress` | Decompression with format detection through the unified layer (`comprs_core::unified`), in one call and in fuzzer-chosen chunks, on random bytes or on a damaged valid stream of any format |

A target fails when the code under test panics, outputs more than its limit, gives results that disagree between APIs or limits, or allocates more heap memory than its output limit accounts for (`crates/core-lib/fuzz/src/heap.rs` counts the allocations). The Fuzz workflow runs each target for 10 minutes every week and for 1 minute on pull requests that change the fuzz crate, starting with the inputs of fixed failures in `crates/core-lib/fuzz/regressions/<target>/`, and uploads failing inputs as artifacts. On pull requests that change `comprs-core` or its dependencies, it checks that the fuzz crate still builds and passes its tests.

One kind of panic does not fail a target: brotli 9.0.0's encoder panics on some inputs with a custom dictionary ([#623](https://github.com/derodero24/comprs/issues/623)), and `comprs-core` catches that panic and compresses again without the dictionary ([#624](https://github.com/derodero24/comprs/pull/624)). The `brotli` and `round_trip` targets let exactly these panics unwind to `comprs-core` (`crates/core-lib/fuzz/src/panic_hook.rs`), and log a line for each; any other panic, including an encoder panic outside that `catch_unwind`, still aborts the target. The exception names the brotli version, so it ends with the next brotli upgrade; once a release fixes the encoder, remove it together with the fallback in `comprs-core`.

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

With the fix, add the input to `crates/core-lib/fuzz/regressions/<target>/`, so that every Fuzz run checks it.

The fuzz crate is a workspace of its own, as cargo-fuzz sets it up, so that it builds with its own release profile and stays out of the cargo commands run on the comprs workspace. Its `Cargo.lock` must keep the versions of the workspace's `Cargo.lock`, so that the fuzzers build the dependencies that comprs ships; the Fuzz workflow checks this. After changing `Cargo.lock` or the dependencies of `comprs-core`, update it:

```bash
cp Cargo.lock crates/core-lib/fuzz/Cargo.lock
cargo update --workspace --manifest-path crates/core-lib/fuzz/Cargo.toml
```

## Commit messages

Conventional Commits format: `type(scope): description`. The commit-msg hook checks the message with [commitlint](https://commitlint.js.org/) and `@commitlint/config-conventional` (`commitlint.config.ts`). Pull request titles follow the same format: squash-merging a pull request with several commits makes its title the subject of the commit (with one commit, the subject is that commit's).

**Types:** `build`, `chore`, `ci`, `docs`, `feat`, `fix`, `perf`, `refactor`, `revert`, `style`, `test`

**Scopes** are optional and free-form: name the area that the change touches, such as `core`, `zstd`, `gzip`, `brotli`, `lz4`, `detect`, `streams`, `node`, `browser`, `wasm`, `types`, `api`, `middleware`, `bench`, `fuzz`, `e2e`, `release`, `deps`, `renovate`, `ci`, `docs`, `readme`, `playground` or `website`.

## Changesets

A pull request that changes a published package in a way its users can notice adds a changeset; changes to tests, benchmarks, fuzz targets, CI or documentation alone need none. The published files of each package come from these paths:

| Package | Paths |
| ------- | ----- |
| `@derodero24/comprs` | `crates/core-lib/src/`, `crates/core/`, `crates/wasm/`, `src/`, `browser/`, `index.js`, `index.d.ts` |
| `@derodero24/comprs-middleware` | `packages/middleware/src/` |

A change elsewhere can reach users too, such as a dependency update in `Cargo.lock`, the `exports` of a `package.json`, or a build setting of the native binaries. To add a changeset:

```bash
pnpm changeset
```

`@derodero24/comprs-middleware` has `@derodero24/comprs` as a peer dependency. `.changeset/config.json` sets `onlyUpdatePeerDependentsWhenOutOfRange`, so a core release that the middleware's peer range still covers leaves the middleware alone. A core release outside that range, such as a new major, makes `changeset version` release the middleware as a patch with its peer range moved to the new version, which breaks installs that keep the older core. With a breaking core change, add a `major` changeset for `@derodero24/comprs-middleware` as well.

## Release packaging

CI and the release build the native binaries with the same workflow, `.github/workflows/build.yml`. On pushes to `develop` and on pull requests that change native code, CI's `test` job runs the tests with each binary on its own platform, in an Alpine Linux container for the musl ones; other pull requests build and test Linux x64 only.

The `Release Dry Run` CI job assembles the npm packages from the build artifacts with `scripts/prepare-release.mjs`, the script the release workflow runs before `npm publish`, then checks them with `scripts/check-release.mjs`. Nothing is published. To reproduce a failure locally, download the run's `bindings-*` artifacts into `artifacts/`, one directory per artifact, and run both scripts:

```bash
gh run download <run-id> --pattern 'bindings-*' --dir artifacts
node scripts/prepare-release.mjs --artifacts-dir artifacts
node scripts/check-release.mjs
```

Pass `--allow-missing-targets` to both scripts when the run built only some targets, as CI does for pull requests that build only Linux (see the `changes` job in `ci.yml`). `prepare-release.mjs` writes the build outputs into the working tree (the package root and `npm/`), as the release does.

The Release Dry Run job also checks the files that the release attaches to the GitHub release, with `node scripts/github-release.mjs --dry-run` (plus `--allow-missing-targets` for a partial build): each binary needs its `THIRD_PARTY_LICENSES`, and each file a unique asset name. It prints the assets and the release notes, the section of `CHANGELOG.md` for the version in `package.json`. Only a real release creates the GitHub release.

The packages ship the license notices of the code that the binaries link statically. `prepare-release.mjs` writes `THIRD_PARTY_LICENSES` into the root package, for the WebAssembly build, and into each `npm/<abi>/` package, for its target, and copies `LICENSE` into each `npm/<abi>/`. It generates the notices with `scripts/third-party-licenses.mjs`, from the crates that `cargo tree` lists for the build and their license files, so it needs `cargo`, and network access the first time, when cargo downloads the crates in `Cargo.lock`. `check-release.mjs` compares each notice with a fresh generation. To print the notice of one build:

```bash
node scripts/third-party-licenses.mjs --package comprs --target x86_64-unknown-linux-gnu
node scripts/third-party-licenses.mjs --package comprs-wasm --target wasm32-unknown-unknown
```

A new dependency whose crate publishes no license file fails the dry run until its upstream license is added: commit a verbatim copy of the license file of its repository to `scripts/licenses/`, and add an entry for it to `OVERRIDES` in `scripts/third-party-licenses.mjs`, with the URL of the file at the commit it was copied from. If the crate keeps its license files below its root instead, name them in `EXTRA_FILES`. A crate that compiles C sources whose headers carry copyright notices that its license files lack, as zstd-sys does, needs those headers too: commit each one verbatim to `scripts/licenses/`, after a note on where it comes from, and add an entry for its source file to `SOURCE_NOTICES`. When a crate update changes such a header, the generation fails until the copy is updated.

## Releases

This section is for maintainers. Releases go through `.github/workflows/release.yml`:

1. Pull requests into `develop` add [changesets](#changesets).
2. On each push to `develop`, the Prepare Version job applies the changesets with a read-only token: versions, changelogs, and the versions of the Rust crates and of the platform packages in `npm/`. The Version job (changesets/action) then commits the result and opens or updates the Version Packages pull request. It runs none of the repository's code, so no build sees its token, which can write.
3. Once it is merged, no changeset is left, and the Version job opens or updates the release pull request from `develop` into `main`, which lists the versions to publish.
4. Squash-merging the release pull request publishes them. The workflow builds the native binaries with `build.yml` and the WebAssembly build, then the Publish job assembles the packages with `scripts/prepare-release.mjs` and runs `npm publish` on the core package, whose `prepublishOnly` script, `napi prepublish --no-gh-release`, first publishes the platform packages. The GitHub Release job then creates the GitHub release `v<version>` on the published commit, with the version's section of `CHANGELOG.md` as its notes, and attaches `LICENSE` and each platform binary, `comprs.<abi>.node`, next to the license notices of the code that it links, `THIRD_PARTY_LICENSES.<abi>.txt`. The Publish job stages these files with `scripts/github-release.mjs` before it publishes anything; the GitHub Release job, which can write to the repository, runs only `gh` on them. If it fails, re-run it: it uploads the files to the release that an earlier attempt created. The Publish Middleware job publishes the middleware, if its version is new.
5. The Merge Back job merges `main` into `develop`, or opens a pull request for that when it cannot.

The Version job opens and updates both pull requests with `GITHUB_TOKEN`. Its pushes start no workflow, and the `pull_request` workflows of those pull requests do not run either: GitHub lists their runs with the conclusion `action_required` and runs no job. Those runs are not a failure of the pull request. Instead, after each update of the Version Packages pull request, the Version job dispatches the CI workflow on its branch, `changeset-release/develop`, which `GITHUB_TOKEN` may do: the checks of that run show on the pull request. If they are missing, run CI on the branch from the Actions tab (**CI** → **Run workflow**) before merging it. The release pull request shows the checks of its head commit, which CI ran when a merge pushed that commit to `develop`; if it shows none, run CI on `develop` in the same way.

Both publish jobs run in the `npm-publish` environment and publish through trusted publishing: the repository stores no npm token.

### Trusted publishing

Every package publishes through [trusted publishing](https://docs.npmjs.com/trusted-publishers) ([#584](https://github.com/derodero24/comprs/issues/584)). npm 11.5.1 and later, which the Node.js version in `.nvmrc` bundles (CI's Release Dry Run job checks it), exchange the job's OIDC token for a short-lived token that can publish the package, when the package has a trusted publisher that matches the workflow. The `npm publish` calls of `napi prepublish` inherit the environment of the core publish step, so the platform packages publish the same way. The publish steps pass no npm token, so a package without a matching trusted publisher fails to publish instead of falling back to a token.

- Packages: `@derodero24/comprs`, the 8 platform packages `@derodero24/comprs-{darwin-arm64,darwin-x64,linux-arm64-gnu,linux-arm64-musl,linux-x64-gnu,linux-x64-musl,win32-arm64-msvc,win32-x64-msvc}`, and `@derodero24/comprs-middleware`.
- Settings of each trusted publisher: owner `derodero24`, repository `comprs`, workflow `release.yml`, environment `npm-publish`, with `npm publish` allowed, not only `npm stage publish`: the release publishes directly.
- The publish steps must stay in `release.yml` and in the `npm-publish` environment, which the trusted publishers name. The deployment branches of the `npm-publish` environment should be limited to `main`.
- After a release, `npm view <package>@<version> _npmUser` shows `GitHub Actions` for a trusted publish. With no token in use, each package's **Publishing access** can be set to "Require two-factor authentication and disallow tokens".

A new package name, such as the platform package of a new napi target, needs a first publish before it can have a trusted publisher: npm adds trusted publishers only to packages that it already has ([`npm trust`](https://docs.npmjs.com/cli/v11/commands/npm-trust)). Publish its first version from a maintainer's machine, logged in to an account with two-factor authentication, then add its trusted publisher under the package's **Settings** → **Trusted publishing** → **GitHub Actions** on npmjs.com, or from a terminal with npm 11.15.0 and later:

```bash
npm trust github "@derodero24/<package>" --file release.yml --repo derodero24/comprs --env npm-publish --allow-publish --yes
```

A new trusted publisher expires unless a publish through it succeeds within 2 days, so add it shortly before a release that publishes the package. A trusted publisher cannot be changed, so an expired one is deleted (`npm trust list`, then `npm trust revoke --id`) and added again. `@derodero24/comprs-wasm32-wasi` is no longer published ([#600](https://github.com/derodero24/comprs/pull/600)) and needs none.

## Package tests

The `Package E2E` CI job installs the packages that the release would publish into the fixtures in `e2e/`, which import `@derodero24/comprs` by name, as applications do: in Node.js (with `import` and `require()`), Deno and Bun, which load the native addon, and in browser builds made with esbuild, webpack, Vite (`vite build` and `vite dev`) and an import map, which load the WebAssembly build in Chromium, Firefox and WebKit. `e2e/` is a pnpm project of its own, with its own lockfile, which pins the bundlers.

To run the fixtures locally, assemble the packages with `scripts/prepare-release.mjs`, from the artifacts of a CI run (see [Release packaging](#release-packaging)) or from your own build, then install them into the fixtures with `e2e/install-package.mjs`:

```bash
pnpm run build && pnpm run build:wasm-bindgen
mkdir -p artifacts/native artifacts/bindings-wasm-bindgen
cp comprs.*.node artifacts/native/
cp browser/comprs-wasm* artifacts/bindings-wasm-bindgen/
node scripts/prepare-release.mjs --allow-missing-targets
pnpm --dir e2e install --frozen-lockfile
node e2e/install-package.mjs
pnpm exec tsc -p e2e && pnpm exec tsc -p e2e/browser   # against the installed declarations
pnpm --dir e2e run test:node          # also test:deno and test:bun
pnpm --dir e2e run build              # the browser bundles, into e2e/dist
pnpm --dir e2e exec playwright install --only-shell chromium firefox webkit
pnpm --dir e2e run test:browser       # --project=chromium for one browser
```

The fixtures use the installed copy of the package, not the working tree: run `node e2e/install-package.mjs` again after changing the package, and the steps before it after rebuilding it.

## Website

`website/` is the documentation site and the playground, which the Website workflow (`.github/workflows/website.yml`) deploys to GitHub Pages at <https://derodero24.github.io/comprs/>. It is built with [Astro Starlight](https://starlight.astro.build/): the pages are Markdown and MDX files in `website/src/content/docs/`, the playground is `website/src/pages/playground.astro` with its scripts in `website/src/playground/`, and the API reference is generated at build time from the declaration files of the package (`index.d.ts`, `streams.d.ts`, `node.d.ts` and `next/index.d.ts`) by starlight-typedoc, into `website/src/content/docs/api/`, which is gitignored. Like `e2e/`, it is a pnpm project of its own, and it imports `@derodero24/comprs` by name, through a `file:..` dependency that installs the package from the working tree with the files it would publish. The playground loads the WebAssembly build: build that first, and install the site's dependencies again after each build, as the installed package holds the files that existed at install time, which a rebuild does not always update.

```bash
pnpm run build:js
pnpm run build:wasm-bindgen
pnpm --dir website install --frozen-lockfile
pnpm --dir website run dev         # or build, into website/dist
pnpm --dir website run check       # astro check: the types of the site
```

Without the WebAssembly build, the build of the playground page fails. To work on the playground without it, set `COMPRS_PLAYGROUND_MOCK=1`, which replaces the package with fake compressors.

CI checks and builds the site with these commands in its `Build website` job, on the WebAssembly build of its `Build - wasm-bindgen` job, so a pull request that breaks the build fails there, and the Website workflow deploys it from `develop`.

## Pull request checklist

- [ ] Tests pass (`pnpm test`, `cargo test` and `cargo test -p comprs-core`)
- [ ] Lint passes (`pnpm run check` and `cargo clippy --workspace --all-targets -- -D warnings`)
- [ ] TypeScript types checked (`pnpm run typecheck` and `pnpm run test:types`)
- [ ] Build succeeds and generated files are committed (`pnpm run build` and `pnpm run build:js`)
- [ ] Middleware checks pass, if `packages/middleware` changes (`pnpm --filter @derodero24/comprs-middleware typecheck` and `pnpm --filter @derodero24/comprs-middleware test`)
- [ ] Changeset added, if a published package changes for its users (see [Changesets](#changesets))
- [ ] PR title follows Conventional Commits
- [ ] Issue linked (`Closes #<number>`)

## Benchmarks

If your change affects performance:

```bash
pnpm run bench                # JS benchmarks, with comparisons to other libraries
pnpm run bench:ci             # JS benchmarks of comprs alone
cargo bench -p comprs-bench   # Rust benchmarks
```

The JS benchmarks in `__test__/*.bench.ts` use Vitest's [`bench` fixture](https://vitest.dev/guide/benchmarking): a test runs one benchmark with `bench(name, fn).run(BENCH_OPTIONS)`, or compares several with `bench.compare(...)`: comprs with other libraries, or, in `next.bench.ts`, the functions of the root entry with those of the unified API (`./next`) at the same settings, which shows what its options object and argument checks cost, and the root's dictionary functions with a prepared `Dictionary`, which shows what preparing it once saves. Both sides of `next.bench.ts` are comprs, so `pnpm run bench:ci` runs it with the other benchmarks of comprs alone. `BENCH_OPTIONS` in `__test__/bench-fixtures.ts` sets how long each benchmark runs, and `pnpm run typecheck` checks the benchmarks' types. With `BENCH_SMOKE=1` (`BENCH_SMOKE=1 pnpm run bench --run`), every benchmark runs once, without warmup, so the run takes seconds but its numbers mean nothing. CI runs every benchmark this way to check that the benchmarks still work: the benchmarks of comprs alone with `pnpm run bench:ci --run`, and the comparisons through `scripts/bench-report.mjs` (see [Regenerating the benchmarks](#regenerating-the-benchmarks)), which also checks that their results still reach the report.

The comparisons, `__test__/*.compare.bench.ts`, run every library at the same settings, which the test names state (`gzip compress level 6 - JSON 84KB`), on the inputs in `INPUTS` (brotli quality 11 and the Node.js streams on fewer); every library decompresses the output of comprs, so that only the decoders differ. `algorithms.compare.bench.ts` compares the formats of comprs with each other instead, each at its default level and decompressing its own output. `compareLibraries` in `__test__/bench-fixtures.ts` registers the one-shot comparisons, and checks that every library restores the input. `pnpm run bench:ci` leaves the comparisons out.

CodSpeed runs the Rust benchmarks on pull requests that change Rust code. They call `comprs-core`, so they measure comprs's own code (output sizing, stream contexts, dictionaries) together with the codecs; the benchmarks marked `(upstream)` call a codec crate alone as a baseline. The patterned, random and JSON inputs are the same in both languages (`crates/bench/src/lib.rs` and `__test__/bench-fixtures.ts`), and tests on both sides check that the generated bytes match.

`cargo bench` keeps its results in `target/criterion/` and compares each run with the previous one. It writes HTML reports with plots only when [gnuplot](http://www.gnuplot.info/) is installed: the bench crate turns off Criterion's `plotters` backend, whose `web-sys` dependency would block wasm-bindgen updates ([#640](https://github.com/derodero24/comprs/issues/640)).

## Regenerating the benchmarks

The tables of the [Benchmarks page](https://derodero24.github.io/comprs/reference/benchmarks/) of the website, `website/src/bench/report.md`, which `website/src/content/docs/reference/benchmarks.mdx` includes, and the two charts that the page and the README show, `.github/assets/bench-compress.svg` and `.github/assets/bench-cross-algorithm.svg`, come from `scripts/bench-report.mjs`. The script runs the comparisons (`__test__/{algorithms,gzip,deflate,brotli,zstd,streaming}.compare.bench.ts`) with Vitest's JSON reporter, which gives the median time of a call of each benchmark, while the benchmarks record the input and output sizes (`recordSizes`, into the file that `COMPRS_BENCH_SIZES` names). From these, `scripts/bench-render.mjs` writes the speeds in MB/s of uncompressed data, the compression ratios, and a paragraph that names the comprs version and commit, the versions of Node.js, pako and fflate, the CPU, the platform, the date, the settings and the workflow run. The tables follow the test names, so a new library, setting or input needs no change to the scripts, but a new comparison file must be added to the list in `scripts/bench-report.mjs`, which fails on one that the list leaves out. The script fails on a test whose name does not follow the pattern of `compareLibraries` or of the stream comparisons, and on a test without recorded sizes, so that no result is left out silently; `__test__/bench-report.spec.ts` tests the rendering with fixed results. The rest of the page, its Takeaways included, is written by hand.

The repository publishes only numbers from the Bench Report workflow (`.github/workflows/bench-report.yml`), which runs on a GitHub-hosted runner and records its run in the paragraph above the tables. Numbers from another machine cannot be compared with them: never commit the output of a local run. To regenerate the numbers:

1. Run the workflow on `develop` from the Actions tab (**Bench Report** → **Run workflow**). Its `bench` job builds the release addon, runs the script, and uploads the report, the two charts and the raw results (Vitest's JSON report and the sizes) as the `bench-report` artifact. It has a read-only token.
2. Its `publish-branch` job, which can push but runs no code from the repository, commits the report and the charts on top of the measured commit, as `github-actions[bot]`, to a new branch, `bench-report/<run id>-<run attempt>`, so that a re-run of the workflow pushes to a branch of its own. It never pushes to `develop` or `main`. The summary of the run links to a pull request from that branch.
3. Open that pull request into `develop`. Pushes made with `GITHUB_TOKEN` start no workflow, but a pull request that you open runs CI as usual. Review the new numbers, update the Takeaways of the Benchmarks page and the text around the charts in the README to match them in the same pull request, and squash-merge it. If `develop` changed the report in the meantime, merge `develop` into the branch, keeping the generated report.

To check what the script writes without publishing numbers, run it locally with `BENCH_SMOKE=1`: every benchmark runs once, the run takes under a minute, and the text says that the numbers mean nothing. Then revert its changes:

```bash
pnpm run build
BENCH_SMOKE=1 node scripts/bench-report.mjs   # --raw-dir <dir> keeps the raw results
git diff website/src/bench .github/assets
git checkout website/src/bench .github/assets
```

## Troubleshooting

### "Cannot find native binding" error

The native `.node` binary has not been built yet. Run:

```bash
pnpm run build
```

### TypeScript typecheck fails after a Rust API change

napi-rs generates `index.d.ts` and `index.js` from the bindings in `crates/core`, and both are committed, so `pnpm run typecheck` passes on a fresh clone without a build. After a change to the API of the bindings, the typecheck still sees the old declarations, so it fails on code that uses the new API until `pnpm run build` (or `pnpm run build:debug`) regenerates them. Commit the regenerated files with the change.

### Rust compilation errors after switching branches

Stale build cache from a different feature branch can cause unexpected errors. Clean and rebuild:

```bash
cargo clean
pnpm run build
```

## Code style

- **Rust:** rustfmt + clippy, whose warnings fail CI. `comprs-core` forbids unsafe code (`#![forbid(unsafe_code)]`). Unsafe code is limited to the bindings, the napi-rs addon at the Node-API boundary (`crates/core/src/async_args.rs`, `crates/core/src/convert.rs` and `crates/core/src/next.rs`) and the WebAssembly build in its global allocator and where it copies byte arrays into its memory (`crates/wasm/src/lib.rs`), and to test allocators: the counting allocators of comprs-core's integration tests and fuzz crate, and the allocator stubs in the unit tests of `crates/wasm`. Explain each unsafe block or implementation in a `SAFETY` comment that says why it is sound.
- **TypeScript/JavaScript:** Biome.

## Questions?

File an issue on [GitHub](https://github.com/derodero24/comprs/issues).
