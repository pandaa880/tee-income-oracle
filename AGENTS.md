# AGENTS.md

Guidance for AI coding agents (and humans) working in this repo. Read this
first, then `docs/FORMATS.md` and `docs/CODING-GUIDELINES.md`.
`docs/CODING-GUIDELINES.md` overrides any global or personal agent guidelines.

## What this project is

A borrower's bank statement (India's Account Aggregator / ReBIT format) is
verified, decrypted and scored **inside an AWS Nitro enclave** (hosted on
Marlin Oyster). Only a risk tier leaves the enclave, signed by a key that the
enclave's remote attestation binds to the published code. The result is
written to Solana through the Solana Attestation Service (SAS), and a demo
lending pool reads it inside its own instruction.

The hackathon build uses a **sandbox bank** (mock FIP + AA) that speaks the
real ReBIT protocol with test keys: "simulated bank, real protocol".

## Trust model — the thing you must not break

- **Trusted:** the enclave code (`enclave/`, `tio-core`) and AWS Nitro hardware.
- **Untrusted:** gateway, Oyster host, web, verifier host, sandbox-bank's
  honesty about data, anyone calling the programs.
- Every design choice answers: *how does a host that carries all the bytes
  still fail to read or forge them?* Either a key is born inside the enclave
  and never leaves, or a key is pinned into the measured image.

### Invariants (never violate, never "temporarily" relax)

1. Plaintext bank data exists only inside the enclave, in memory, for one
   session. Never log, persist, return or snapshot it.
2. The Curve25519 session key **and** the FIU request-signing RSA key are
   generated inside the enclave. The gateway only carries signed bytes.
3. Verification keys (FIP, AA) are pinned in `enclave/pinned/`. Never accept
   keys from the network or from JWS headers.
4. Signatures are verified over raw bytes **before** JSON parsing.
5. The enclave signs the full context (domain tag, program, credential,
   schema, wallet, payload, expiry) — see `docs/FORMATS.md` §8.
6. Nothing personal goes on-chain: tier, ids, hashes, timestamps only.
7. The oracle accepts a result only via the secp256k1 precompile in the same
   transaction, with instruction-index fields pointing at that precompile.
8. Test vectors are generated, never hand-edited to make code pass.
9. Committed keys are **test-only** and nothing deployed may trust them.
   Test-vector keys (`test-vectors/`, `*.test-private.*`) are for offline
   tests only. The live sandbox bank uses **separate, never-committed** demo
   keys, and only their public halves go in `enclave/pinned/`. The enclave
   refuses to start if a pinned key is a test key (FORMATS §2).

## Repo map

```
programs/oracle/      Anchor. Enclave registry (image id → attester), verifies the
                      enclave signature via secp256k1 precompile, CPIs SAS.
programs/demo-pool/   Anchor. Reads + checks the SAS attestation, lends testnet tokens.
tio-core/             Rust lib, no I/O. Key exchange, decryption, JWS (later: parsing,
                      scoring, payload). Everything trusted that isn't HTTP.
enclave/              Rust. Runs in the Oyster CVM. HTTP wrapper around tio-core.
                      Built with Docker + docker-compose (images pinned by digest).
gateway/              Node/TS, untrusted orchestrator + tx relayer (formerly proxy/).
sandbox-bank/         Node/TS mock FIP + AA (ReBIT, demo keys) + test-vector generator.
verifier/             TS. Nitro attestation doc → AWS root; image id; on-chain key match.
web/                  Next.js. Borrower flow, lender dashboard, verify page.
test-vectors/         Generated fixtures + TEST-ONLY keys. Positive and negative cases.
docs/                 ARCHITECTURE.md, FORMATS.md (wire formats, source of truth),
                      CODING-GUIDELINES.md.
```

## Toolchain

Rust 1.89.0 (pinned in `rust-toolchain.toml`, Anchor 1.2's toolchain) · Anchor 1.2.0 · Solana/Agave CLI 4.3.0 · pnpm 12.6.0 (corepack) ·
Node 22+ · Docker. Chain: devnet (localnet for tests).

Two build worlds: Cargo workspace (`programs/*`, `tio-core`) and pnpm
workspace (TS packages). `enclave/` builds via Docker, not `anchor build`.

## Commands

The repo is early: `tio-core` has key exchange, decryption and JWS; `sandbox-bank`
has the test-vector generator; the programs are empty skeletons; most other packages
hold only READMEs. Update the status as each one starts working.

| Step | Command | Status |
|---|---|---|
| Build (Rust) | `cargo build` | works (empty program skeletons + `tio-core`) |
| Build (programs) | `anchor build` | works (empty skeletons) |
| Build (enclave) | `docker compose build` in `enclave/` | not yet |
| Test (Rust) | `cargo test -p tio-core` — against `test-vectors/golden/` and the generated vectors (`tests/vectors.rs`) | works (key exchange, decryption, JWS, layered negatives) |
| Test (golden vectors) | `cd test-vectors/golden/rahasya && python3 -m unittest -v test_golden.py` | works |
| Test (programs) | `anchor test` — localnet | not yet |
| Test (TS) | `pnpm -r test` (vitest) | works (`sandbox-bank`, also in CI) |
| Lint (Rust) | `cargo fmt --all -- --check && cargo clippy --all-targets -- -D warnings` | works (also in CI) |
| Lint/typecheck (TS) | `pnpm --filter @tio/sandbox-bank typecheck && … lint && … format:check` (tsc, oxlint `--type-aware`, oxfmt; configs `.oxlintrc.json`, `.oxfmtrc.json`) | works (also in CI) |
| Generate vectors | `pnpm gen:vectors` — must leave `git diff test-vectors/` empty unless a format changed | works (CI regenerates and diffs) |
| Run | — | nothing runnable yet |

## Engineering principles

- **KISS.** Choose the simplest design that meets the requirement.
- **DRY.** One source of truth for each rule, constant or format. Share
  helpers instead of copying code.
- **YAGNI / no overengineering.** Build what is asked. No speculative
  features, options or abstractions "for later".
- **Readable over clever.** Small functions (about 40 lines max) with names
  that say what they do. Docstrings on anything non-obvious.
- **Fix the stated problem.** Don't widen scope. If you spot something else,
  report it rather than silently changing it.
- **Validation raises real errors.** Never use `assert` for checks that must
  hold in production or in verifiers (Python strips asserts under `-O`).

## Gotchas

Add a line whenever an agent makes the same mistake twice.

- `Anchor.toml`: the `test` script is `echo "no tests yet"` — a green
  `anchor test` proves nothing yet. `cluster` is still `localnet`.
- Program keypairs live in `target/deploy/` (gitignored). Losing them changes
  the program ids; they are backed up outside the repo.
- `rust-toolchain.toml` pins Rust 1.89.0 for the whole workspace, even though
  a newer rustc is installed. Don't bump it without checking Anchor support.
- The Anchor wallet is `~/.config/solana/tee-income-oracle.json`, not the
  default `id.json`.
- `enclave/` runs on Marlin Oyster (Docker + docker-compose). There is no
  `nitro-cli` / `.eif` step — that was the parked self-hosted Nitro path.
- Crypto function names quoted in comments, `Cargo.toml` or FORMATS go
  stale when the code changes (`try_sign_with_rng` vs `sign_with_rng`).
  Grep each cited name against the code before a PR.
- `.claude/` and other AI-tool dirs are gitignored: project-local agent
  settings don't reach other contributors. Shared guidance goes here.

## Rules for AI agents

- **Solana / Anchor work:** check APIs against the official Solana docs, not
  memory (Solana Developer MCP: `https://mcp.solana.com/mcp`, if your agent
  supports MCP). Run its Anchor `program_autofixer` on changed programs
  before opening a PR, and never let an MCP tool move funds.
- **Ask before installing** any dependency, CLI tool or global package.
- **Ask before** adding a crate to `enclave/` or `tio-core` — every dependency
  is inside the trust boundary.
- Don't weaken, skip or `#[ignore]` a security check or test to get green.
  If something fails, explain why and propose a fix.
- Don't invent formats. If a byte layout isn't in `docs/FORMATS.md`, stop and
  ask; if you change one, update the doc in the same change.
- No `unwrap`/`expect`/panics in non-test Rust; no `any` in TypeScript; no
  floats for money or scores.
- Never commit secrets. Test keys only as `*.test-private.*` under
  `test-vectors/keys/`.
- **Git: never commit or push to `main` or `develop`.** Follow
  `CONTRIBUTING.md` → Git workflow (git-flow):
  - Branch from an up-to-date `develop` (`git switch -c <type>/<short-name>`,
    e.g. `feat/tio-core-ecdh`), and open PRs **into `develop`**.
  - Commit with `git commit -s` and Conventional Commit messages; the squash
    title drives release-please, so it must be accurate.
  - Don't commit, push, open or merge PRs unless asked. Never force-push
    `main`/`develop` or rewrite their history.
  - Parallel sessions each use their own worktree + branch.
- **Breaking a wire/security contract** means bumping its protocol id
  (`docs/FORMATS.md` → Version identifiers) and a `feat!:` PR title.
- Keep this repo technical. Don't add business, pitch or planning material.
- Explain crypto reasoning in comments where it isn't obvious (why a check
  exists, what it prevents), not what the code does line by line.
