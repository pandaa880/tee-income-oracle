<!-- Title: a Conventional Commit (feat/fix/docs/…). It becomes the squash
     commit on develop and drives release-please (CONTRIBUTING.md). -->

## What

<!-- The change in 2–5 bullets. -->

## Why

<!-- The problem or task it addresses (build step, issue, review finding). -->

## Files worth reviewing

<!-- Where a reviewer should spend their time, most important first, with
     one line each on what to look for. List generated or mechanical files
     separately so they can be skimmed (test-vectors/ output, lockfiles,
     formatting-only changes). -->

**Review closely**
- `path/to/file` — what to check

**Skim (generated / mechanical)**
- `path/` — how it was produced (e.g. `pnpm gen:vectors`)

## How verified

<!-- Gates run and their results (AGENTS.md → Commands), plus any manual or
     cross-implementation checks. -->

- [ ] Rust: `cargo fmt --all -- --check`, `cargo clippy --all-targets -- -D warnings`, `cargo test -p tio-core`
- [ ] TS: `pnpm --filter @tio/sandbox-bank typecheck`, `lint`, `format:check`, `test`
- [ ] Vectors: `pnpm gen:vectors` leaves `git diff test-vectors/` empty (or the format change is intended)
- [ ] Code review done; blocking findings fixed

## Checklist

- [ ] A changed wire or data format updates `docs/FORMATS.md`, both implementations and the regenerated vectors in this PR
- [ ] No secrets committed; test keys only under `test-vectors/keys/*.test-private.*`
- [ ] Security checks and tests are not weakened or skipped
