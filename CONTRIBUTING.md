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

GitHub flow: `main` plus short-lived branches, merged by pull request.
Kept simple on purpose. There are no `develop`/`release` branches.

### `main`
- `main` is always green: builds, tests pass, docs match the code.
- **Nobody commits or pushes to `main` directly.** Every change arrives by PR.
- No force-push to `main`, and no rewriting its history.

### Branches
- One branch per task, created from an up-to-date `main`:
  ```bash
  git switch main && git pull --ff-only
  git switch -c <type>/<short-kebab-description>
  ```
- `<type>` matches the Conventional Commit type: `feat`, `fix`, `docs`,
  `test`, `refactor`, `chore`, `ci`. Examples: `feat/tio-core-ecdh`,
  `fix/replay-expiry`, `docs/git-workflow`.
- Keep branches short-lived (hours to a couple of days). Rebase on `main`
  if it moves: `git fetch && git rebase origin/main`. Force-pushing your
  *own* branch after a rebase is fine (`git push --force-with-lease`).
- Delete the branch after merge.

### Commits
- Conventional Commits: `type(scope): summary`, imperative mood, ≤ 72
  characters. Examples: `feat(tio-core): parse wei25519 SPKI keys`,
  `test(vectors): add layered negative cases`. Add a body when the *why*
  isn't obvious.
- DCO sign-off on every commit: `git commit -s`.
- One logical change per commit. Don't mix a refactor with a behaviour change.
- Never commit secrets, `.env`, real keys or build output (see `.gitignore`).

### Pull requests
1. Push the branch: `git push -u origin <branch>`.
2. Open a PR: `gh pr create --fill` (or on GitHub). The description says
   **what** changed, **why**, and **how it was verified** (gates run, test
   output).
3. Run the gates for every language touched (see `AGENTS.md` → Commands) and
   a code review (`/code-review` or a reviewer) before merging. Fix blocking
   findings first.
4. **Squash-merge** so `main` gets one Conventional Commit per PR. Its title
   becomes the commit message.
5. Small, focused PRs. A format change touches `docs/FORMATS.md`, both
   implementations and the regenerated vectors, in the same PR.

### Parallel work (agents / worktrees)
- A parallel session works in its own worktree **on its own branch**, under
  `.claude/worktrees/<branch-name>/`. Never two sessions on one branch.
- Remove the worktree after its PR merges:
  `git worktree remove <path> && git branch -d <branch>`.

### Tags
- Tag demo and submission builds on `main`: `git tag -s demo-YYYY-MM-DD`
  (or `-a`), then push the tag.

## Sending a PR (external contributors)

1. Fork, then follow the branch, commit and PR rules above.
2. Sign off every commit (`git commit -s`).
3. Open a PR describing what changed, why, and how you verified it.
