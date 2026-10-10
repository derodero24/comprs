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
- [ ] JS tests pass (`pnpm test`)
- [ ] Rust tests pass (`cargo test`)
- [ ] Clippy passes (`cargo clippy --workspace --all-targets -- -D warnings`)
- [ ] Build succeeds (`pnpm run build`)
- [ ] Changeset included, if a published package changes for its users (not for tests, CI or docs alone; see Changesets in CONTRIBUTING.md)
- [ ] Benchmarks run for performance-sensitive changes
