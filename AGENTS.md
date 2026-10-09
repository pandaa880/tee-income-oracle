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
                      tests/ = TS program tests (vitest on embedded surfpool).
clients/ts/oracle/    Codama-generated kit client for the oracle (from the IDL; committed).
packages/encoding/    `@tio/encoding`: the one TS module for hex / base64 / base64url (strict,
                      canonical decoders). sandbox-bank, gateway and ops use it.
packages/ui/          `@tio/ui`: standalone React UI package for web (design tokens light/dark,
                      shadcn/Radix primitives, ledger patterns). No Solana, no web imports.
programs/demo-pool/   Anchor. Reads + checks the SAS attestation, lends testnet tokens.
                      tests/ = TS program tests (reuse the oracle test harness).
clients/ts/demo-pool/ Codama-generated kit client for the demo pool (committed).
tio-core/             Rust lib, no I/O. Key exchange, decryption, JWS, money and FI (DEPOSIT)
                      parsing, scoring policy and scoring, the evaluate pipeline and the
                      attestation payload. Everything trusted that isn't HTTP.
enclave/              Rust. Runs in the Oyster CVM. HTTP wrapper around tio-core.
                      Built with Docker + docker-compose (images pinned by digest).
gateway/              Node/TS, untrusted orchestrator + tx relayer (formerly proxy/).
sandbox-bank/         Node/TS mock FIP + AA (ReBIT, demo keys) + test-vector generator.
verifier/             TS. Nitro attestation doc → AWS root; image id; on-chain key match.
ops/                  TS admin scripts (admin wallet): `oracle:init`, `sas:setup` (SAS credential
                      + schema), `pool:setup` (demo mint + pool), `enclave:rotate` (attested
                      Oyster key → registry + pools), `e2e:devnet`.
deployments/          Public addresses per cluster (`<cluster>.json`), written by ops.
test-fixtures/        Hand-calculated scoring cases; `sas/` = SAS binary dumped from devnet
                      (+ SOURCE.md with sha256, LICENSE). Not generated, unlike test-vectors/.
web/                  Vite + React SPA on `@tio/ui`. Borrower flow, loan book, verify page.
test-vectors/         Generated fixtures + TEST-ONLY keys. Positive and negative cases.
docs/                 ARCHITECTURE.md, FORMATS.md (wire formats, source of truth),
                      CODING-GUIDELINES.md, DEPLOY.md (devnet runbook).
```

## Exploring the code: codegraph

Use [CodeGraph](https://github.com/colbymchenry/codegraph) (`codegraph` CLI) to find
your way around before reading files one by one or running broad grep sweeps. It
indexes the Rust and TypeScript code into a symbol graph (functions, types, imports,
call edges) in `.codegraph/` (gitignored, one index per checkout or worktree).

- **Set up:** `codegraph init` once in the checkout (or worktree); `codegraph sync`
  after pulling, switching branches or large edits. Don't install it for the user:
  if `codegraph` is missing, ask (rule below) or fall back to grep.
- **Understand an area or task:** `codegraph explore "<area>"` (symbols' source plus
  call paths), `codegraph context "<task>"`, `codegraph node <symbol or file>`.
- **Before changing shared code:** `codegraph callers <symbol>`,
  `codegraph impact <symbol>`; after the change, `codegraph affected <files>` lists
  the tests to run.
- If your agent has the CodeGraph MCP server, its `codegraph_explore` and
  `codegraph_node` tools return the same output.
- The index is an aid, not the source of truth: it can be stale, so read the file
  before editing it. Formats and invariants still come from `docs/FORMATS.md` and
  this file.

## Toolchain

Rust 1.89.0 (pinned in `rust-toolchain.toml`, Anchor 1.2's toolchain) · Anchor 1.2.0 · Solana/Agave CLI 4.3.0 · pnpm 12.6.0 (corepack) ·
Node 24 LTS (`.nvmrc`; runs TS directly: `sandbox-bank` via type stripping, `gateway` and `ops` via `node --import tsx` because they load the Codama clients) · tsx 4.23.15 · Docker. Chain: devnet (localnet for tests).
Solana TS: `@solana/kit` 7.1.1 · `sas-lib` 2.0.0-beta.1 (renamed upstream to
`@solana/attestation`, not on npm yet) · `@solana/surfpool` 1.6.0 (embedded `Surfnet`, offline;
its kit plugin needs kit 8, so it isn't used).

Two build worlds: Cargo workspace (`programs/*`, `tio-core`) and pnpm
workspace (TS packages). `enclave/` builds via Docker, not `anchor build`.

## Commands

The repo is early: `tio-core` has key exchange, decryption, JWS, a paise money parser, the DEPOSIT FI parser, the scoring policy (v2, canonical JSON hash), the scorer (FORMATS §6.1), and the evaluate pipeline with the attestation payload and message (§7, §8, §10.1); `sandbox-bank`
has the test-vector and demo-key generators and the live mock FIP + AA HTTP service (FORMATS §15; deployed on Azure Container Apps behind `BANK_TOKEN`); `enclave` serves the §10 HTTP API around `tio-core` (deployed on Marlin Oyster); `gateway` orchestrates sessions over the §16 HTTP API (SSE stages), relays the attestation transaction and sponsors the demo pool's borrow/repay transactions after an 11-rule shape check (end to end on localnet and on devnet, deployed on Azure Container Apps); `ops` has the admin scripts for a cluster (oracle init, SAS credential/schema, demo pool, attested enclave rotation, devnet E2E; tested on surfpool and run on devnet, `docs/DEPLOY.md`); the `oracle` program has the enclave registry and `submit_attestation` (secp256k1 precompile check + SAS write, FORMATS §8, §13), `demo-pool` lends on the attestation (`create_pool`, `update_pool`, `borrow`, `repay`, FORMATS §14); most other packages
hold only READMEs. Update the status as each one starts working.

| Step | Command | Status |
|---|---|---|
| Build (Rust) | `cargo build` | works (programs + `tio-core`) |
| Build (programs) | `anchor build` | works (`oracle`, `demo-pool`) |
| Generate program clients | `pnpm --filter @tio/oracle-client generate` and `pnpm --filter @tio/demo-pool-client generate` after `anchor build` — must leave `git diff clients/` empty | works (CI regenerates and diffs) |
| Build (enclave) | `enclave/scripts/build-image.sh` (arm64 image built twice, digests compared; `--push <repo>` to publish) | works (local only; not in CI) |
| Test (enclave) | `cargo test --manifest-path enclave/Cargo.toml --all-features` (+ `cargo fmt`/`cargo clippy --all-targets --all-features -- -D warnings` with the same `--manifest-path`) | works (attester, intent, guard, config, sessions, and the HTTP routes against every test vector; also in CI) |
| Demo keys | `pnpm --filter @tio/sandbox-bank gen:demo-keys` — once; refuses to overwrite | works (private halves in `sandbox-bank/.secrets/`, gitignored) |
| Test (Rust) | `cargo test -p tio-core` — against `test-vectors/golden/` and the generated vectors (`tests/vectors.rs`) | works (key exchange, decryption, JWS, money parser, FI parser, policy, scoring incl. hand-calculated fixtures in `test-fixtures/scoring/`, evaluate pipeline + payload/message on every vector, check-order boundaries in `tests/evaluate_boundaries.rs`, layered negatives); `cargo test -p oracle`: precompile/message layouts, attestation readers and clock rules; `cargo test -p demo-pool`: the pool's lending rules (all three also in CI) |
| Test (golden vectors) | `cd test-vectors/golden/rahasya && python3 -m unittest -v test_golden.py` | works |
| Test (programs) | `anchor test` (= `pnpm --filter @tio/oracle-tests --filter @tio/demo-pool-tests test`, embedded offline surfpool) | works (`oracle` registry + `submit_attestation` against the dumped SAS binary; `demo-pool` against the real oracle, SAS and SPL Token; also in CI) |
| Test (TS) | `pnpm -r test` (vitest) | works (`sandbox-bank`, `ui` (components on happy-dom, token contrast and package-rule tests), `web` (domain, adapters with chunk-split SSE and 429 backoff, hooks on fake ports, the gateway's own relay shape check on built loan transactions, the import-rule test), `ops` unit tests incl. an offline surfpool suite with the dumped SAS binary (`pnpm --filter @tio/ops test:programs` runs the suites that need the built programs), `oracle-tests`, `demo-pool-tests`, `oracle-client` (hand-written `attest.ts`: §8 message, precompile, SAS reader) and `gateway` (unit + surfpool relayer/registry/loan-relay suites; the local E2E is skipped without `TIO_E2E=1`) after `anchor build`; also in CI) |
| Lint (Rust) | `cargo fmt --all -- --check && cargo clippy --all-targets -- -D warnings` | works (also in CI) |
| Lint/typecheck (TS) | `pnpm --filter <@tio/encoding, @tio/ui, @tio/web, @tio/sandbox-bank, @tio/ops, @tio/gateway, @tio/oracle-client, @tio/oracle-tests or @tio/demo-pool-tests> typecheck && … lint && … format:check` (tsc, oxlint `--type-aware`, oxfmt; configs `.oxlintrc.json`, `.oxfmtrc.json`) | works (also in CI) |
| Generate vectors | `pnpm gen:vectors` — must leave `git diff test-vectors/` empty unless a format changed | works (CI regenerates and diffs) |
| Oracle init (admin) | `pnpm --filter @tio/ops oracle:init --cluster <localnet\|devnet>` — the admin wallet must be the oracle's upgrade authority; env in `ops/README.md` | works on surfpool and devnet (2026-10-08) |
| SAS setup (admin) | `pnpm --filter @tio/ops sas:setup --cluster localnet` — env in `ops/README.md`; re-run is a no-op, a mismatch fails | works on localnet and devnet (2026-10-08) |
| Demo pool (admin) | `pnpm --filter @tio/ops pool:setup --cluster <c> [--pool-id <0–255>] [--tier-limits <a,b,c>]` — mint (no freeze authority, created once and shared) + pool + funded vault in one transaction; re-run is a no-op | works on surfpool and devnet (2026-10-08) |
| Enclave rotate (admin) | `pnpm --filter @tio/ops enclave:rotate --cluster <c> --enclave-ip <ipv4>` — needs `oyster-cvm` on PATH; archives the attestation in `deployments/<c>/` | works on surfpool (fake Oyster ports) and against Oyster on devnet (2026-10-08) |
| E2E (devnet) | `pnpm --filter @tio/ops e2e:devnet --cluster devnet --gateway <url>` — 4 personas + tier A borrow/repay against the deployed gateway | local only; passes on devnet (2026-10-08, before and after an enclave restart) |
| Test (ops, programs) | `pnpm --filter @tio/ops test:programs` after `anchor build` — `oracle:init`, `pool:setup`, `enclave:rotate` against the real programs | works (also in CI, `programs` job) |
| Run (sandbox bank, local) | `pnpm --filter @tio/sandbox-bank start:local` (demo keys from `sandbox-bank/.secrets/`, RPC defaults to `127.0.0.1:8899`; env in `sandbox-bank/README.md`) | works |
| Build (sandbox bank image) | `docker build -f sandbox-bank/Dockerfile -t tio-sandbox-bank:dev .` (context = repo root; `sandbox-bank/Dockerfile.dockerignore`) | works (local only; not in CI) |
| Run (web, local) | `pnpm --filter @tio/web dev` (http://localhost:5173) | works (placeholder home on `@tio/ui`) |
| Build (web) | `pnpm --filter @tio/web build` (→ `web/dist`; deployed by Vercel, `web/README.md`) | works (also in CI) |
| Run (gateway, local) | `pnpm --filter @tio/gateway start` with the env in `gateway/README.md` (needs a running enclave, the bank and an RPC; boot checks the enclave's registry entry) | works |
| Build (gateway image) | `docker build -f gateway/Dockerfile -t tio-gateway:dev .` (context = repo root; `gateway/Dockerfile.dockerignore`) | works (local only; not in CI) |
| E2E (local) | `TIO_E2E=1 [TIO_ENCLAVE_IMAGE=tio-enclave:dev] pnpm --filter @tio/gateway test src/e2e.local.test.ts` — real enclave container + bank process + surfnet (oracle, SAS, demo-pool) + gateway; needs the demo keys and the ops admin wallet | works (local only; never in CI: the demo keys aren't committed) |
| Run (enclave, local) | `docker run -p 8080:8080 -v <32-byte key file>:/app/ecdsa.sec:ro tio-enclave:dev` (see `enclave/README.md`) | works |

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

- `Anchor.toml`: `provider.cluster` stays `localnet` so `anchor test` runs offline;
  `[programs.devnet]` has the same ids. Deploy to devnet with
  `--provider.cluster devnet`, never by editing the default.
- Anchor check order isn't field order: it loads every account (3012), then
  creates `init` accounts ("already in use", `init` seeds), then checks the
  other constraints field by field, then runs the handler. Document error
  order that way and pin it with a combined-fault test.
- The program tests run the built `target/deploy/oracle.so`: run
  `anchor build` first, then regenerate the client if the IDL changed
  (account order counts: a stale client fails with Anchor error 3008).
- The oracle client uses `@codama/renderers-js` 2.3.x, the last line for
  `@solana/kit` 7. It ignores `importExtension`/`erasableSyntax` and doesn't
  render events, so `clients/ts/oracle` and its tests use `Bundler`
  resolution (vitest) rather than Node type stripping, and the tests decode
  events themselves (`programs/oracle/tests/src/events.ts`).
- Program keypairs live in `target/deploy/` (gitignored). Losing them changes
  the program ids; they are backed up outside the repo.
- `rust-toolchain.toml` pins Rust 1.89.0 for the whole workspace, even though
  a newer rustc is installed. Don't bump it without checking Anchor support.
- The Anchor wallet is `~/.config/solana/tee-income-oracle.json`, not the
  default `id.json`.
- `enclave/` runs on Marlin Oyster (Docker + docker-compose). There is no
  `nitro-cli` / `.eif` step — that was the parked self-hosted Nitro path.
- Oyster: `oyster-cvm update` with an unchanged compose file doesn't restart
  the enclave (change the metadata, e.g. `--debug true` then `false`), and
  never register a `--debug` enclave (zeroed PCRs: verify says `image id
  mismatch`). `docs/DEPLOY.md` §3, §6.
- Azure Container Apps here is an **express** environment: no
  `--allow-insecure`, an "internal" app still answers on its public URL (so
  the bank needs `BANK_TOKEN`), `az containerapp update --set-env-vars`
  doesn't replace the running replica (recreate the app), and `az
  containerapp logs show` fails. `docs/DEPLOY.md` §4, §6.
- Crypto function names quoted in comments, `Cargo.toml` or FORMATS go
  stale when the code changes (`try_sign_with_rng` vs `sign_with_rng`).
  Grep each cited name against the code before a PR.
- Judge a gate by its exit code, not by grepping its output. Coloured `tsc`
  errors slipped past `grep "error TS"` twice; if you must grep, strip ANSI
  codes first (`sed 's/\x1b\[[0-9;]*m//g'`).
- Mutation checks: restore files with plain `cp`, not `cp -p`, or cargo
  reuses the mutated build (CODING-GUIDELINES §5).
- `surfnet_timeTravel`'s `absoluteTimestamp` is in **milliseconds** and
  only moves forward; the surfnet clock stands still between transactions.
- Read clippy's exit code before calling it clean; piping it through a
  filter once hid three errors. It runs on the pinned 1.89 toolchain, the
  same as CI.
- Program tests share one surfnet clock per file, and every `freshClock`
  (so every helper that issues an attestation) moves it 10 000 s forward.
  An attestation prepared first is that much older when it is used:
  prepare the one that must still be fresh last, or give the pool a long
  `max_age_secs`.
- `anchor-spl` needs the `token_2022` feature even for classic Token
  accounts: Anchor's `init` for a token account calls
  `token_interface::initialize_account3`.
- `enclave/` is its own Cargo workspace (own `Cargo.lock`): root `cargo`
  commands don't touch it; pass `--manifest-path enclave/Cargo.toml`. Its
  tests need `--all-features` (`test-hooks`), which can't compile into a
  release build.
- `tio-core/Cargo.toml` sets `edition`/`rust-version` itself instead of
  inheriting them: the enclave image builds it without the root workspace.
  Keep them in sync with the root `Cargo.toml` by hand.
- `sandbox-bank` runs on Node's type stripping: only erasable syntax works (no
  parameter properties, `enum`, `namespace`). vitest accepts them, so a test
  run won't catch it: `tsc` (`erasableSyntaxOnly`) or starting the entry point
  does. The sandbox bank's first container run crashed on one.
- The root `.dockerignore` is for the enclave image only. The sandbox-bank
  image uses `sandbox-bank/Dockerfile.dockerignore` (BuildKit's per-Dockerfile
  ignore file), which keeps `.secrets/` and tests out of the context.
- The Codama kit-7 clients (`@tio/oracle-client`, `@tio/demo-pool-client` root
  exports) don't load under plain Node (extensionless imports, `enum`):
  `ERR_UNSUPPORTED_DIR_IMPORT`. So `gateway` and `ops` run with
  `node --import tsx` (their package scripts, the gateway Dockerfile from
  `WORKDIR /app/gateway`: tsx resolves from the cwd) and use the generated
  client directly; `gateway/src/main.smoke.test.ts` starts `main.ts` that way.
  Don't hand-write instructions, PDAs or account decoders the IDL describes.
  The generated decoders don't check length or discriminator: check both
  before decoding an account you didn't create (`gateway/src/registry.ts`).
- Evidence whose hash may already be on chain (archived attestation documents
  in `deployments/<cluster>/`) is never overwritten: check an existing archive
  by content, not by name, never `rename` over an existing file, and on a
  re-run reconcile local files against the on-chain hash first
  (`ops/src/rotate.ts`). One rotation at a time (exclusive lock file) and one
  pending file per attempt, so a run archives the document it registered.
  Run-time files a script writes under the committed `deployments/` tree
  (locks, pending, temp) get a `.gitignore` entry in the same change.
- Behind one trusted proxy, the client IP is the **last** `X-Forwarded-For`
  hop (the one the proxy appended); earlier hops are client-written.
- `@tio/encoding` uses Node's `Buffer`: fine for gateway/ops/sandbox-bank,
  broken in the browser. `web/` uses kit's codecs.
- The TS lint config has both `switch-exhaustiveness-check` and
  `consistent-return`, so any `switch` fails one of them: use `Record`
  lookups or narrowing `if` chains.
- Node's `AbortSignal.timeout` ignores vitest fake timers: test a deadline
  with real, short timeouts.
- Web CSS order: `@tio/ui/fonts.css` (a remote `@import url()`) must come
  before `@import "tailwindcss"`; anywhere later, browsers ignore it and the
  fonts silently don't load. `web/src/styles.css` has the order.
- `VITE_*` values are compiled into the public web bundle. Never put a
  secret or a keyed RPC URL (Helius) in one; browser code reads config only
  through `import.meta.env` (no `process.*`: `web/tsconfig.json` has no node
  types).
- In `@tio/ui` tests (happy-dom), a `vi.spyOn` on `localStorage` or
  `Storage.prototype` leaks into later tests even after `restoreAllMocks`: a
  test passed alone and failed in the suite. Stub the whole object with
  `vi.stubGlobal('localStorage', fake)` (`theme-toggle.test.tsx`).
- `pnpm add` of a package younger than pnpm's minimum release age can silently
  add a `minimumReleaseAgeExclude` entry to `pnpm-workspace.yaml`. Check that
  file after every install; pick an older release instead of keeping the entry.
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
- **Sync the docs with every change, on the same branch.** Before opening a
  PR, grep the repo for whatever the change replaced or introduced (tool and
  function names, versions, commands, "planned"/"not yet" lines), and update:
  `README.md` (Status, diagrams), this file (Commands table, Toolchain,
  Gotchas), `CONTRIBUTING.md`, `docs/CODING-GUIDELINES.md`,
  `docs/FORMATS.md`, `docs/ARCHITECTURE.md`, `docs/DEPLOY.md`, the package READMEs, and
  `.github/pull_request_template.md`. Say in the PR which docs you checked.
- Explain crypto reasoning in comments where it isn't obvious (why a check
  exists, what it prevents), not what the code does line by line.
