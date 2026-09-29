# Contributing

This project is Apache-2.0 licensed (see `LICENSE`). Attribution for
third-party work is in `NOTICE`.

## Developer Certificate of Origin (DCO)

Every commit must be signed off, certifying you wrote it or otherwise have
the right to submit it under this project's license:

```bash
git commit -s -m "your message"
```

This adds a `Signed-off-by: Your Name <email>` line to the commit. PRs
without a sign-off won't be merged.

Full DCO text: https://developercertificate.org/

## Why DCO, not a CLA

A DCO is lighter-weight than a Contributor License Agreement, but still
gives a clear, on-record trail of provenance for every contribution — so
if licensing terms ever need to change for new versions down the line,
there's no ambiguity about who has the right to agree to that.

## Git workflow

Git-flow with two long-lived branches. Everything else is a short-lived
branch merged by pull request.

```
main     ─────────────●───────────────●────   releases only
                     /               /
develop  ──●──●──●──R────●──●──●────R──────   integration (default branch)
            \/ \/          \/
         feat/…  fix/…   feat/…              one branch per task
```

### `develop` and `main`
- **`develop`** is the default branch and where all work lands. It must stay
  green: builds and tests pass, and docs match the code.
- **`main`** only ever receives releases (a promotion PR from `develop`). It
  always equals the latest release.
- **Nobody commits or pushes directly to either.** Both are protected: PR
  required, no force-push, no deletion.

### Branches
- One branch per task, created from an up-to-date `develop`:
  ```bash
  git switch develop && git pull --ff-only
  git switch -c <type>/<short-kebab-description>
  ```
- `<type>` matches the Conventional Commit type: `feat`, `fix`, `docs`,
  `test`, `refactor`, `chore`, `ci`. Examples: `feat/tio-core-ecdh`,
  `fix/replay-expiry`, `docs/git-workflow`.
- Keep branches short-lived (hours to a couple of days). Rebase on `develop`
  if it moves: `git fetch && git rebase origin/develop`. Force-pushing your
  *own* branch after a rebase is fine (`git push --force-with-lease`).
- Branches are deleted automatically after merge.

### Commits
- Conventional Commits: `type(scope): summary`, imperative mood, ≤ 72
  characters. Examples: `feat(tio-core): parse wei25519 SPKI keys`,
  `test(vectors): add layered negative cases`. Add a body when the *why*
  isn't obvious. Use `feat!:` or a `BREAKING CHANGE:` footer for breaking
  changes.
- DCO sign-off on every commit: `git commit -s`. Release commits made by the
  release-please bot are exempt.
- One logical change per commit. Don't mix a refactor with a behaviour change.
- Never commit secrets, `.env`, real keys or build output (see `.gitignore`).

### Pull requests
1. Push the branch: `git push -u origin <branch>`.
2. Open a PR **into `develop`**: `gh pr create --base develop --fill`. Fill in
   the template (`.github/pull_request_template.md`): **what** changed,
   **why**, **which files are worth reviewing** (and which are generated and
   can be skimmed), and **how it was verified** (gates run, test output).
3. Run the gates for every language touched (see `AGENTS.md` → Commands) and
   a code review (`/code-review` or a reviewer) before merging. Fix blocking
   findings first.
4. **Squash-merge.** The PR title becomes the single commit on `develop`, and
   release-please reads it, so it must be a Conventional Commit.
5. Small, focused PRs. A format change touches `docs/FORMATS.md`, both
   implementations and the regenerated vectors, in the same PR.

### Versioning and releases
- **One version for the whole repo**, SemVer `vMAJOR.MINOR.PATCH`, `0.x`
  until production. Pre-1.0, `feat` and breaking changes bump MINOR; `fix`
  bumps PATCH. `docs`/`test`/`chore`/`ci`/`refactor`/`perf` don't cause a release.
- **release-please** (GitHub Action on `develop`) keeps **one** release PR
  open, `chore(develop): release X.Y.Z`. Each feature or fix merged into
  `develop` updates that same PR: version and CHANGELOG. No tags by hand.
- **To release:**
  1. Merge the release PR. That tags `vX.Y.Z` on `develop` and creates the
     GitHub Release.
  2. Open a promotion PR `develop` → `main` and merge it with a **merge
     commit** (not squash, so the tagged commit stays in `main`'s history):
     `gh pr create --base main --head develop --title "release: vX.Y.Z"`.
  3. If the release changes the enclave or a program, add the enclave
     **image id** and any program upgrade to the GitHub Release notes.
- **Protocol versions** (signed-message domain tag, enclave API, policy
  format, SAS schema version, and so on) are listed in `docs/FORMATS.md` →
  Version identifiers. Bumping one is a breaking change (`feat!:`).
- **Hotfixes** go through `develop` like any fix, then release and promote. A
  separate `hotfix/*` → `main` path is added only if a deployed version needs
  a fix while `develop` holds unreleased work.

### Parallel work (agents / worktrees)
- A parallel session works in its own worktree **on its own branch**, under
  `.claude/worktrees/<branch-name>/`. Never two sessions on one branch.
- Remove the worktree after its PR merges:
  `git worktree remove <path> && git branch -d <branch>`.

## Sending a PR (external contributors)

1. Fork, then follow the branch, commit and PR rules above (PRs target `develop`).
2. Sign off every commit (`git commit -s`).
3. Open a PR describing what changed, why, and how you verified it.
