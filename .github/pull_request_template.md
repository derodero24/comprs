## Summary

<!-- Brief description of the changes -->

## Related issue

<!-- Closes #123 -->

## Breaking changes / Deprecations

<!-- If this PR introduces a breaking change or deprecates an export, document it here. -->
<!-- Write N/A if not applicable -->

## Checklist

- [ ] Lint passes (`pnpm run check`)
- [ ] TypeScript type-check passes (`pnpm run typecheck`)
- [ ] Consumer type check passes (`pnpm run test:types`)
- [ ] JS tests pass (`pnpm test`)
- [ ] Rust tests pass (`cargo test` and `cargo test -p comprs-core`)
- [ ] Clippy passes (`cargo clippy --workspace --all-targets -- -D warnings`)
- [ ] Build succeeds (`pnpm run build`)
- [ ] Generated files are committed: `pnpm run build` and `pnpm run build:js` leave nothing to commit (edit `src/` and `crates/`, never the outputs)
- [ ] Middleware checks pass, if `packages/middleware` changes (`pnpm --filter @derodero24/comprs-middleware typecheck` and `pnpm --filter @derodero24/comprs-middleware test`)
- [ ] Changeset included, if a published package changes for its users (not for tests, CI or docs alone; see Changesets in CONTRIBUTING.md)
- [ ] Benchmarks run for performance-sensitive changes
