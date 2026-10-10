# Contributing to comprs

Thank you for your interest in contributing! This guide covers everything you need to get started.

## Prerequisites

- [Rust](https://rustup.rs/) ≥ 1.88 (CI lints and tests with the latest stable)
- A C compiler, for the zstd C sources (Clang for the WebAssembly build)
- [Node.js](https://nodejs.org/) ≥ 22.13
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
├── playground/      ← Interactive playground (GitHub Pages)
├── scripts/         ← Build, packaging, optimization and benchmark report scripts
├── .changeset/      ← Changesets of the next release (see Changesets)
└── .github/
    └── workflows/   ← CI, Build, Release, Fuzz, CodSpeed, CodeQL, Renovate, Playground, Bench Report
```

### JavaScript sources

The stream helpers, the ES module entry and the unified API are written in TypeScript, in `src/`, and compiled into tracked files that npm publishes. `next/` is tracked as well, but npm publishes it only once `package.json` lists it:

| Source | Output |
| ------ | ------ |
| `src/streams.ts` | `streams.js` and `streams.d.ts`: the Web Streams helpers (`@derodero24/comprs/streams`) |
| `src/node.ts` | `node.js` and `node.d.ts`: the Node.js transforms (`@derodero24/comprs/node`) |
| `src/index.mts` | `index.mjs` and `index.d.mts`: the ES module entry |
| `src/browser/streams.ts` | `browser/streams.js` and `browser/streams.d.ts`: the Web Streams helpers for browsers |
| `src/next/` | `next/`: the unified API, `@derodero24/comprs/next` ([#577](https://github.com/derodero24/comprs/issues/577)), which `package.json` neither exports nor lists yet. `api.ts` holds the functions and checks the types of their arguments, `backend.ts` holds the `Backend` interface, which the backend of each build implements, `native.ts` makes the hidden binding of the native addon (`crates/core/src/next.rs`) the backend, and `index.ts` and `index.mts` are the CommonJS and ES module entries |

The outputs are committed. Edit the sources, never the outputs, then run `pnpm run build:js` (`scripts/build-js.mjs`, with `tsconfig.build.json` and `tsconfig.browser.json`) and commit the sources and outputs together. CI runs `pnpm run build` and `pnpm run build:js` and fails if they change any file. Each project lists its entries in `files`, and compiles the modules that they import as well. Editors check the sources with `src/tsconfig.json` and `src/browser/tsconfig.json`, which take the options and files of those two projects. The two projects that `build:js` compiles must stay plain JSON, without comments. A TypeScript update can change the outputs; Renovate proposes it in a pull request of its own, which then needs `pnpm run build:js`. The browser entry, `browser/index.js`, and its declarations are written by hand.

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
pnpm run check        # Biome lint and formatting; warnings fail it too
pnpm run typecheck    # TypeScript
pnpm run test:types   # Packed package, type-checked by strict consumer projects
pnpm test             # Vitest tests
cargo test            # Rust tests
cargo clippy --workspace --all-targets -- -D warnings   # Rust lint; warnings fail it too
pnpm run build        # napi-rs build
pnpm run build:js     # Modules and declarations compiled from src/
```

`pnpm run typecheck` checks the tests, the benchmarks and `vitest.config.mts` with `tsconfig.json`, the sources in `src/` with the two projects that `build:js` compiles, and the JavaScript in `scripts/` and `__test__/` with `tsconfig.scripts.json`. The middleware has its own check, `pnpm --filter @derodero24/comprs-middleware typecheck`. They all enable `noPropertyAccessFromIndexSignature`: read a property that comes from an index signature, such as a variable of `process.env` or a field of a parsed `package.json`, with brackets (`process.env['CI']`). Biome's `useLiteralKeys` rule, which would rewrite such reads with a dot, is off, except in `browser/index.js` and `playground/`, which no tsconfig checks.

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

**Scopes** are optional and free-form: name the area that the change touches, such as `core`, `zstd`, `gzip`, `brotli`, `lz4`, `detect`, `streams`, `node`, `browser`, `wasm`, `types`, `api`, `middleware`, `bench`, `fuzz`, `e2e`, `release`, `deps`, `renovate`, `ci`, `docs`, `readme` or `playground`.

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

## Releases

This section is for maintainers. Releases go through `.github/workflows/release.yml`:

1. Pull requests into `develop` add [changesets](#changesets).
2. On each push to `develop`, the Version job (changesets/action) opens or updates the Version Packages pull request, which applies the changesets: versions, changelogs, and the versions of the Rust crates and of the platform packages in `npm/`.
3. Once it is merged, no changeset is left, and the Version job opens or updates the release pull request from `develop` into `main`, which lists the versions to publish.
4. Squash-merging the release pull request publishes them. The workflow builds the native binaries with `build.yml` and the WebAssembly build, then the Publish job assembles the packages with `scripts/prepare-release.mjs` and runs `npm publish` on the core package, whose `prepublishOnly` script, `napi prepublish`, first publishes the platform packages and creates the GitHub release. The Publish Middleware job then publishes the middleware, if its version is new.
5. The Merge Back job merges `main` into `develop`, or opens a pull request for that when it cannot.

The Version job opens and updates both pull requests with `GITHUB_TOKEN`, whose pushes and pull requests start no workflow. CI therefore never runs on the Version Packages pull request on its own: before merging it, run the CI workflow on its branch, `changeset-release/develop`, from the Actions tab (**CI** → **Run workflow**). The release pull request shows the checks of its head commit, which CI ran when a merge pushed that commit to `develop`; if it shows none, run CI on `develop` in the same way.

Both publish jobs run in the `npm-publish` environment and authenticate with the `NPM_TOKEN` secret (`NODE_AUTH_TOKEN`), a granular access token. npm lets a token that can publish live for at most 90 days: renew it before it expires, or the next release fails.

### Trusted publishing

npm 11.5.1 and later, which the Node.js version in `.nvmrc` bundles (CI's Release Dry Run job checks it), try [trusted publishing](https://docs.npmjs.com/trusted-publishers) on every `npm publish` in GitHub Actions: when the package has a trusted publisher that matches the workflow, npm exchanges the job's OIDC token for a short-lived token that can publish that package, and uses it instead of `NODE_AUTH_TOKEN`. Otherwise it silently keeps `NODE_AUTH_TOKEN`. The `npm publish` calls of `napi prepublish` inherit the environment of the core publish step, so the platform packages work the same way. To move the release to trusted publishing ([#584](https://github.com/derodero24/comprs/issues/584)):

1. Add a trusted publisher to each of the 10 packages shortly before a release that publishes it: a new trusted publisher expires unless a publish through it succeeds within 2 days, and an expired one has to be deleted and added again. A release publishes the middleware only when its version changes, so its trusted publisher may have to wait for a later release than the others.
   - Packages: `@derodero24/comprs`, the 8 platform packages `@derodero24/comprs-{darwin-arm64,darwin-x64,linux-arm64-gnu,linux-arm64-musl,linux-x64-gnu,linux-x64-musl,win32-arm64-msvc,win32-x64-msvc}`, and `@derodero24/comprs-middleware`.
   - Settings: owner `derodero24`, repository `comprs`, workflow `release.yml`, environment `npm-publish`. Allow `npm publish`, not only `npm stage publish`: the release publishes directly.
   - On npmjs.com, they are under each package's **Settings** → **Trusted publishing** → **GitHub Actions**. npm 11.15.0 and later can also add them from a terminal, logged in to an account with two-factor authentication. This adds them to the core package and the platform packages, which every release publishes:

     ```bash
     for pkg in comprs comprs-{darwin-arm64,darwin-x64,linux-arm64-gnu,linux-arm64-musl,linux-x64-gnu,linux-x64-musl,win32-arm64-msvc,win32-x64-msvc}; do
       npm trust github "@derodero24/$pkg" --file release.yml --repo derodero24/comprs --env npm-publish --allow-publish --yes
       sleep 2
     done
     ```

     Add the middleware's only before a release that changes its version: `npm trust github @derodero24/comprs-middleware --file release.yml --repo derodero24/comprs --env npm-publish --allow-publish --yes`. A package has at most one trusted publisher, so replacing an expired one takes `npm trust list` and `npm trust revoke --id` first.
2. In the repository settings, limit the deployment branches of the `npm-publish` environment to `main`.
3. After the release, check how each package was published: `npm view <package>@<version> _npmUser` shows `GitHub Actions` for a trusted publish, and `derodero24` for a token publish. Once all 10 packages have published as `GitHub Actions`, a follow-up pull request removes `NODE_AUTH_TOKEN` from both publish steps; then delete the `NPM_TOKEN` secret and revoke the token on npmjs.com. Each package's **Publishing access** can then be set to "Require two-factor authentication and disallow tokens".

The publish steps must stay in `release.yml` and in the `npm-publish` environment, which the trusted publishers name. A new package name, such as the platform package of a new napi target, needs a first publish with a token before it can have a trusted publisher: npm adds trusted publishers only to packages that it already has ([`npm trust`](https://docs.npmjs.com/cli/v11/commands/npm-trust)). `@derodero24/comprs-wasm32-wasi` is no longer published ([#600](https://github.com/derodero24/comprs/pull/600)) and needs none.

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

## Playground

`playground/` is the site that the Playground workflow deploys to GitHub Pages. Like `e2e/`, it is a pnpm project of its own, and it imports `@derodero24/comprs` by name, through a `file:..` dependency that installs the package from the working tree with the files it would publish. It loads the WebAssembly build: build that first, and install the playground's dependencies again after each build, as the installed package holds the files that existed at install time, which a rebuild does not always update.

```bash
pnpm run build:wasm-bindgen
pnpm --dir playground install --frozen-lockfile
pnpm --dir playground run dev         # or build, into playground/dist
```

Without the WebAssembly build, the dev server and the build fail. To work on the UI without it, set `COMPRS_PLAYGROUND_MOCK=1`, which replaces the package with fake compressors.

## Pull request checklist

- [ ] Tests pass (`pnpm test` and `cargo test`)
- [ ] Lint passes (`pnpm run check` and `cargo clippy --workspace --all-targets -- -D warnings`)
- [ ] TypeScript types checked (`pnpm run typecheck`)
- [ ] Build succeeds (`pnpm run build`)
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

The JS benchmarks in `__test__/*.bench.ts` use Vitest's [`bench` fixture](https://vitest.dev/guide/benchmarking): a test runs one benchmark with `bench(name, fn).run(BENCH_OPTIONS)`, or compares several with `bench.compare(...)`: comprs with other libraries, or, in `next.bench.ts`, the functions of the root entry with those of the unified API (`./next`) at the same settings, which shows what its options object and argument checks cost. Both sides of `next.bench.ts` are comprs, so `pnpm run bench:ci` runs it with the other benchmarks of comprs alone. `BENCH_OPTIONS` in `__test__/bench-fixtures.ts` sets how long each benchmark runs, and `pnpm run typecheck` checks the benchmarks' types. With `BENCH_SMOKE=1` (`BENCH_SMOKE=1 pnpm run bench --run`), every benchmark runs once, without warmup, so the run takes seconds but its numbers mean nothing. CI runs every benchmark this way to check that the benchmarks still work: the benchmarks of comprs alone with `pnpm run bench:ci --run`, and the comparisons through `scripts/bench-report.mjs` (see [Regenerating the README benchmarks](#regenerating-the-readme-benchmarks)), which also checks that their results still reach the README.

The comparisons, `__test__/*.compare.bench.ts`, run every library at the same settings, which the test names state (`gzip compress level 6 - JSON 84KB`), on the inputs in `INPUTS` (brotli quality 11 and the Node.js streams on fewer); every library decompresses the output of comprs, so that only the decoders differ. `algorithms.compare.bench.ts` compares the formats of comprs with each other instead, each at its default level and decompressing its own output. `compareLibraries` in `__test__/bench-fixtures.ts` registers the one-shot comparisons, and checks that every library restores the input. `pnpm run bench:ci` leaves the comparisons out.

CodSpeed runs the Rust benchmarks on pull requests that change Rust code. They call `comprs-core`, so they measure comprs's own code (output sizing, stream contexts, dictionaries) together with the codecs; the benchmarks marked `(upstream)` call a codec crate alone as a baseline. The patterned, random and JSON inputs are the same in both languages (`crates/bench/src/lib.rs` and `__test__/bench-fixtures.ts`), and tests on both sides check that the generated bytes match.

`cargo bench` keeps its results in `target/criterion/` and compares each run with the previous one. It writes HTML reports with plots only when [gnuplot](http://www.gnuplot.info/) is installed: the bench crate turns off Criterion's `plotters` backend, whose `web-sys` dependency would block wasm-bindgen updates ([#640](https://github.com/derodero24/comprs/issues/640)).

## Regenerating the README benchmarks

The tables in the [Benchmarks](README.md#benchmarks) section of the README, between `<!-- bench:start -->` and `<!-- bench:end -->`, and its two charts, `.github/assets/bench-compress.svg` and `.github/assets/bench-cross-algorithm.svg`, come from `scripts/bench-report.mjs`. The script runs the comparisons (`__test__/{algorithms,gzip,deflate,brotli,zstd,streaming}.compare.bench.ts`) with Vitest's JSON reporter, which gives the median time of a call of each benchmark, while the benchmarks record the input and output sizes (`recordSizes`, into the file that `COMPRS_BENCH_SIZES` names). From these, `scripts/bench-render.mjs` writes the speeds in MB/s of uncompressed data, the compression ratios, and a paragraph that names the comprs version and commit, the versions of Node.js, pako and fflate, the CPU, the platform, the date, the settings and the workflow run. The tables follow the test names, so a new library, setting or input needs no change to the scripts, but a new comparison file must be added to the list in `scripts/bench-report.mjs`, which fails on one that the list leaves out. The script fails on a test whose name does not follow the pattern of `compareLibraries` or of the stream comparisons, and on a test without recorded sizes, so that no result is left out silently; `__test__/bench-report.spec.ts` tests the rendering with fixed results. The Key takeaways under the tables are written by hand.

The README publishes only numbers from the Bench Report workflow (`.github/workflows/bench-report.yml`), which runs on a GitHub-hosted runner and records its run in the paragraph above the tables. Numbers from another machine cannot be compared with them: never commit the output of a local run. To regenerate the numbers:

1. Run the workflow on `develop` from the Actions tab (**Bench Report** → **Run workflow**). Its `bench` job builds the release addon, runs the script, and uploads the README, the two charts and the raw results (Vitest's JSON report and the sizes) as the `bench-report` artifact. It has a read-only token.
2. Its `publish-branch` job, which can push but runs no code from the repository, commits the README and the charts on top of the measured commit, as `github-actions[bot]`, to a new branch, `bench-report/<run id>-<run attempt>`, so that a re-run of the workflow pushes to a branch of its own. It never pushes to `develop` or `main`. The summary of the run links to a pull request from that branch.
3. Open that pull request into `develop`. Pushes made with `GITHUB_TOKEN` start no workflow, but a pull request that you open runs CI as usual. Review the new numbers, update the Key takeaways to match them in the same pull request, and squash-merge it. If `develop` changed the Benchmarks section in the meantime, merge `develop` into the branch, keeping the generated text between the markers.

To check what the script writes without publishing numbers, run it locally with `BENCH_SMOKE=1`: every benchmark runs once, the run takes under a minute, and the text says that the numbers mean nothing. Then revert its changes:

```bash
pnpm run build
BENCH_SMOKE=1 node scripts/bench-report.mjs   # --raw-dir <dir> keeps the raw results
git diff README.md .github/assets
git checkout README.md .github/assets
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

- **Rust:** rustfmt + clippy, whose warnings fail CI. `comprs-core` forbids unsafe code (`#![forbid(unsafe_code)]`). Unsafe code is limited to the bindings, the napi-rs addon at the Node-API boundary (`crates/core/src/async_args.rs`, `crates/core/src/convert.rs` and `crates/core/src/next.rs`) and the WebAssembly build in its global allocator (`crates/wasm/src/lib.rs`), and to test allocators: the counting allocators of comprs-core's integration tests and fuzz crate, and the allocator stubs in the unit tests of `crates/wasm`. Explain each unsafe block or implementation in a `SAFETY` comment that says why it is sound.
- **TypeScript/JavaScript:** Biome.

## Questions?

File an issue on [GitHub](https://github.com/derodero24/comprs/issues).
