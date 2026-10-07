# Coding guidelines

Applies to all code in this repo: Rust (enclave, core library, Anchor
programs), TypeScript (gateway, sandbox-bank, verifier, web) and Python
(test-vector tooling scripts only). Security
rules come first because this project's value is its security properties.

## 0. Engineering principles (all languages)

KISS · DRY · YAGNI (no overengineering) · readable over clever · small
functions (~40 lines) with clear names · fix the stated problem, don't widen
scope. See `AGENTS.md` for the full wording.

## 1. Security rules (all languages)

1. **No plaintext bank data outside the enclave.** Not in logs, errors,
   metrics, files, test snapshots of the gateway, or HTTP responses.
2. **Verify before parse.** Check signatures over raw bytes, then deserialize.
3. **Never trust keys from the network.** Verification keys are pinned
   (compiled in). Ignore `jwk`, `jku`, `x5u`, `x5c` in JWS headers.
4. **Allow-list algorithms.** JWS: RS256/RS512 only. No `none`, no HMAC.
5. **Fail closed.** Any parse, signature, decrypt or policy error ends the
   session with a stable error code. No partial results, no fallback paths.
6. **Never weaken a check to make a test pass.** If a vector fails, the code
   or the vector is wrong — find out which. Don't edit `test-vectors/` by
   hand; regenerate them.
7. **Secrets:** no private keys, API keys or `.env` files in git. Test keys
   are the only exception and are named `*.test-private.*`.
8. **Constant-time comparisons** for MACs, hashes and signatures you compare
   yourself (`subtle` in Rust, `crypto.timingSafeEqual` in Node).
9. **Log ids, not data.** `session_id`, `txnid`, stage, error code.
10. **Formats live in `docs/FORMATS.md`.** Change the doc in the same commit
    as the code. Crypto text there names the exact crate that does each
    secret-dependent step, and error-variant docs in code match the FORMATS
    error-code list.
11. **Errors about key or secret files name the file and the problem, never
    the contents.** No key bytes, PEM text or parsed fields in an error,
    log line or test failure message.

## 2. Rust

### Naming — [Rust API Guidelines](https://rust-lang.github.io/api-guidelines/naming.html)

| Item | Convention | Example |
|---|---|---|
| Crates, modules, functions, methods, locals | `snake_case` | `tio_core`, `derive_session_key` |
| Types, traits, enum variants | `UpperCamelCase` | `KeyMaterial`, `Tier::A` |
| Constants, statics | `SCREAMING_SNAKE_CASE` | `DOMAIN_TAG`, `PAYLOAD_LEN` |
| Type parameters | short `UpperCamelCase` | `T`, `K` |
| Lifetimes | short lowercase | `'a`, `'de` |

- **Acronyms are one word:** `Jws`, `Fiu`, `Rebit`, `AesGcm`, `Uuid` in types;
  `jws`, `fiu`, `aes_gcm` in snake_case. Not `JWS`, `FIU`.
- A single-letter word only at the end: `btree_map`, not `b_tree_map`.
- No `-rs` / `-rust` in crate names.
- **Conversions (C-CONV):** `as_` = free borrow→borrow; `to_` = does work;
  `into_` = consumes self. Single-value wrappers expose `into_inner()`.
- **Getters (C-GETTER):** no `get_` prefix (`fn tier(&self)`), except when
  there is one obvious thing to get.
- **Iterators (C-ITER):** `iter` / `iter_mut` / `into_iter`, and iterator
  types named to match (`Iter`, `IntoIter`).
- **Features (C-FEATURE):** no placeholder words (`std`, not `use-std`), and
  no negative features (`no-x`) — features are additive.
- **Word order (C-WORD-ORDER):** pick one and keep it. Errors are
  verb-object-error: `DecryptPayloadError`, `VerifyJwsError`.
- Constructors: `new`, `with_…`, `from_…`.

### Structure
- `tio-core` is a **library crate with no I/O**: crypto, parsing, scoring,
  payload building. Pure functions in, bytes out. Tested with `cargo test`.
- The `enclave` binary is a thin HTTP wrapper around `tio-core`.
- One concept per module (`jws`, `ecdh`, `rebit`, `classify`, `score`,
  `policy`, `attest`).
- Newtypes for anything security-relevant: `PolicyHash([u8; 32])`,
  `Paise(i64)`, `SessionId(Uuid)` — no bare `[u8; 32]` or `f64` for money.

### Errors and panics
- Library errors: `thiserror` enums with stable variants. Binary: map to
  HTTP error codes in one place.
- **No `unwrap()` / `expect()` / `panic!` / indexing that can panic** outside
  tests and `main` startup. Use `get()`, `checked_*`, `?`.
- **Panic-free slicing:** `split_at_checked`, `split_first_chunk`, `get(..)`,
  `try_into()` — not `split_at` / `copy_from_slice` behind a length check.
  Clippy's `indexing_slicing` doesn't catch those.
- No floats in scoring or money. Integers (paise, basis points, days).

### Parsing untrusted input
- **Wire JSON must be an object.** serde's derived struct visitor also
  accepts a JSON array (fields by position), which no other implementation
  does. Check for `{` before deserializing (`tio-core::encoding::from_json_object`).
  Nested structs too: a `deserialize_with` that re-parses a `RawValue` goes
  through `from_json_object` (`tio-core::policy`).
- **"Must not appear" means present, even as `null`.** A plain `Option<T>`
  reads `null` as absent. Use a presence-detecting `deserialize_with`
  (`tio-core::jws::present`) with `#[serde(default)]`.
- **Declare every member a security rule depends on.** Derived
  `Deserialize` rejects a repeated *declared* member; undeclared ones, and
  `#[serde(flatten)]` / `Value`, silently keep the last value.
- **Strict decoders.** base64url for JWS/JWK is `URL_SAFE_NO_PAD`: no `=`,
  no non-canonical trailing bits, so each value has one accepted encoding.
- **Bound the encoded length before decoding.** Base58 decoding is quadratic
  in the input: reject text longer than the target size can encode to, then
  decode into a fixed buffer (`enclave::config::decode_base58_fixed`).
  Never `into_vec()` network input and check the length afterwards.
- **The enclave's HTTP bodies go through `tio_core::from_json_object`** too,
  not `serde_json::from_slice`: the object-only rule above applies at every
  boundary, including our own API.

### Crypto hygiene
- `#![forbid(unsafe_code)]` in `tio-core`.
- Secrets in `Zeroizing<…>` or types deriving `ZeroizeOnDrop`.
- **Zeroize reaches the crate that holds the key.** A `zeroize` feature on an
  umbrella crate (e.g. `aes-gcm`) doesn't turn it on in the inner crates
  (`aes`, `ghash`/`polyval`, `crypto-bigint`). Check
  `cargo tree -p tio-core -e features -i zeroize`, and confirm the wiping
  `Drop` actually runs on the enclave target (arm64 on Oyster, built with
  `--cfg polyval_force_soft`), not only on the dev machine: autodetect
  backends can skip it. Residuals that can't be wiped get
  a `Known residual:` comment.
- Use audited crates (RustCrypto: `curve25519-dalek`, `crypto-bigint`, `hkdf`,
  `aes-gcm`, `sha2`, `k256`, `rsa`). No hand-rolled primitives.
- Randomness from `OsRng` only.

### Anchor programs
- Every account constrained: `seeds` + `bump`, `has_one`, `owner`, `address`.
  No unchecked `AccountInfo` without a `/// CHECK:` comment that explains why.
- Checked arithmetic only (`checked_add`, …). No `as` casts that can truncate
  (`clippy::cast_possible_truncation` is denied in `programs/*`; for a
  constant, declare it with the narrow type instead of casting).
- One `#[error_code]` enum per program; messages say what failed.
- Every program account starts with a `version: u8` field, so a future
  layout change can be detected and migrated (FORMATS → Version identifiers).
- Reading a foreign account (the SAS attestation): check the owner program id,
  size and discriminator before deserializing. A field that a check could use
  but deliberately doesn't (e.g. the stored SAS `signer`) is named in
  `docs/FORMATS.md` with the reason.
- A `seeds` constraint on an `Account<T>` that this program only ever
  creates at that PDA repeats the owner + discriminator check. Keep it only
  with a comment that says so: no test can show it is there.
- A program that takes a caller-chosen mint decides what the mint's
  `freeze_authority` (and, for Token-2022, each extension) means for it, and
  `docs/FORMATS.md` records the decision.
- Precompile introspection: the signature, address and message
  instruction-index fields in the secp256k1 offsets must all point at the
  precompile instruction itself. Otherwise an attacker can make the precompile
  verify bytes stored in a different instruction.

### Enclave HTTP server
- Every limit is enforced in the enclave itself: its port is public, not
  only reachable by the gateway. **Every route that buffers a body takes an
  in-flight slot before reading it** (`try_acquire` → 503) and has a read
  timeout; a per-request size limit alone doesn't bound memory.
- A concurrency permit for work done in `spawn_blocking` is an owned permit
  (`Arc<Semaphore>::acquire_owned`) **moved into the closure**. A permit held
  by the handler is released when the client disconnects, while the blocking
  work (and its buffers) keeps running.
- Removing an item from a capped store frees its slot, so work that runs
  after the removal needs its own limit.
- Parse path parameters into their type (`Uuid`) before using or logging
  them; log only the parsed value.
- A test-only feature gets `compile_error!` under
  `all(feature = "…", not(debug_assertions))`, so it can't reach a release
  build (the image).
- Request types that carry signed or bank-derived bytes don't derive `Debug`.

### Tooling
- `cargo fmt` and `cargo clippy --all-targets -- -D warnings` must pass.
  Read clippy's exit code, not filtered output.
- A check that must fail closed on `None` is written
  `x.is_none_or(|v| bad(v))`. Clippy rejects `!x.is_some_and(..)`
  (`nonminimal_bool`).
- `Cargo.lock` committed. Pin versions; no `*` or git dependencies without a
  pinned rev.
- Keep dependencies minimal in the enclave — every crate is inside the trust
  boundary.

## 3. TypeScript / Node

### Naming
| Item | Convention | Example |
|---|---|---|
| Variables, functions | `camelCase` | `buildFiRequest` |
| Types, interfaces, classes, enums | `PascalCase` | `KeyMaterial`, `Tier` |
| Constants | `SCREAMING_SNAKE_CASE` | `DOMAIN_TAG` |
| Files | `kebab-case.ts` | `key-material.ts` |
| Wire JSON (ours) | `snake_case` | matches `docs/FORMATS.md` |

- Acronyms as words: `JwsHeader`, `fiuKey`, not `JWSHeader`.
- Types that mirror wire JSON keep the wire key names (snake_case or ReBIT
  casing). Don't rename at the boundary.

### Language
- `"strict": true`, plus `noUncheckedIndexedAccess`. ESM only. Node 24 LTS (`.nvmrc`); scripts run `.ts` directly via Node type stripping, so only erasable syntax (`erasableSyntaxOnly`).
- No `any`. Use `unknown` at boundaries and narrow it.
- **Validate every external input with `zod`** (HTTP bodies, env vars, RPC
  data) before use.
- `bigint` for `u64`/`i64` values (lamports, token amounts, timestamps from
  chain). Never `number` for on-chain integers.
- Generated PDA helpers for another program's PDA (`seeds::program`, e.g.
  `findSasEventAuthorityPda`) default to *our* program id when called on
  their own. Always pass `{ programAddress: <that program> }`.
- Bytes are `Uint8Array`. Encode/decode explicitly (hex, base64, base64url,
  base58) with one helper module; no ad-hoc `Buffer.toString` scattered around.

### Servers (gateway, sandbox-bank)
- Capture the **raw body** before any JSON middleware on routes that carry
  signatures.
- Errors return `{ error: { code, message } }` (the sandbox bank, which speaks ReBIT,
  returns ReBIT's `ErrorResponse` instead, FORMATS §15). No stack traces in responses.
- Config only from env, validated at startup. `.env.example` lists every key.
- Rate-limit and cap body size on every public route.
- A service that relies on being internal-only (no rate limit of its own) states that
  deployment invariant in `docs/FORMATS.md`, not only in a code comment.
- Every outbound network call (RPC, HTTP) has a timeout or `AbortSignal`; a hung
  upstream must become an error, never a hung request. For kit that means
  `.send({ abortSignal })` and an `abortSignal` on `sendAndConfirm`.
- An identifier from an untrusted upstream (an error code) is checked against a
  short pattern before it is logged or returned, so it can't forge log lines or
  carry text. Lookup tables keyed by external strings are `Map`s (a plain object
  answers `constructor`).

### Web (Next.js)
- The browser is untrusted. No keys, no privileged logic.
- Read chain state via RPC; don't trust gateway claims for anything shown as
  verified — the verify page checks on its own.

### Tooling
- `pnpm` (workspace). oxlint (`--type-aware`) + oxfmt, configured in the root
  `.oxlintrc.json` / `.oxfmtrc.json`; `tsc --noEmit` in CI.
- Tests with `vitest`.

## 4. Python (tooling and test scripts)

Python is used only for helper scripts such as `test-vectors/golden/`. Follow the
[Google Python Style Guide](https://google.github.io/styleguide/pyguide.html).
Stdlib only unless a dependency is agreed.

| Item | Convention |
|---|---|
| Modules, functions, variables | `lower_with_under` |
| Classes, exceptions | `CapWords` (exceptions end in `Error`) |
| Constants | `CAPS_WITH_UNDER` |
| Internal | leading `_` |

- **No `assert` for validation.** Raise a specific exception
  (`ValueError`, or a module-level `...Error`).
- No bare `except:` and no `except Exception` unless re-raising. Keep `try`
  blocks small.
- No mutable default arguments (use `None`).
- Files and sockets are opened with `with`.
- Scripts have `def main()` and an `if __name__ == "__main__":` guard, so
  they can be imported by tests. Failures exit non-zero with a one-line
  message, not a traceback.
- Docstrings: a one-line summary plus `Args:` / `Returns:` / `Raises:` for
  public or non-obvious functions.
- f-strings. Comprehensions only when simple (one `for`, no nested filters).
- `x is None`, not `not x`, when `None` is what you mean.
- 80-column lines; implicit line joining, no backslashes.
- Tests: stdlib `unittest`; gates are `python3 -m py_compile` and
  `python3 -m unittest`.

## 5. Tests
- Crypto and parsing: test against `test-vectors/`, positive **and** every
  negative case.
- Programs: one test per `require!` — each check must be shown to reject.
- Name tests by behaviour: `rejects_tampered_ciphertext`,
  `borrow_fails_when_enclave_revoked`.
- **A negative test asserts the specific error**: the error code, variant or
  message (`assertRaisesRegex`, `matches!(err, E::Revoked)`). "It raised
  something" isn't enough, because a different check can fail for a
  different reason and the test still goes green.
- **Tamper tests prove the baseline first.** Check that the untouched input
  passes, then that the tampered input fails *for the expected reason*.
- **A parsed but unused field usually means a missing check.** If you decode
  it, validate it or delete it.
- **Every prefix, template or OID check gets its own negative test with an
  input of the correct length**, so an earlier length check can't mask it.
- **Mutation-check security checks:** disable each check in turn; at least one
  test must fail. A check no test notices is untested. For a condition built
  with `&&`, delete each part separately.
- **A new rule that returns an existing error needs a fixture that breaks
  only the old rule.** Otherwise fixtures that now break both rules make the
  old check invisible: deleting it keeps every test green.
- **A strictness claim needs input the lenient variant would accept.** For
  a strict decoder: correctly padded base64, and non-canonical trailing bits
  with the signature taken over that exact text, so only the decoder can
  reject it. Mutation-check the decoder *config*, not only hand-written `if`s.
- **Repeated members:** every header/JWK member that a rule depends on, and
  especially one read through `deserialize_with`, gets a duplicate-member
  test expecting the specific error.
- **Accepted spellings pair with an escaped duplicate.** When a test accepts
  an alternate spelling (escapes, key order), add a duplicate-key test using
  the escaped spelling of the same key (`"v":2,"\u0076":2`): a last-wins
  parser would accept it.
- **Normalization tests assert `input != canonical` first**, so a lost escape
  (e.g. `\u0041` written as `A`) can't turn the test into a no-op.
- **Check order is tested.** When the docs fix an order ("`alg` before
  `kid`"), a test combines two faults and asserts the one reported first.
  The documented order names every early return in the code path. Each pair
  of neighbouring checks gets such a test.
- **Seeds from an argument get a wrong-PDA test.** When a PDA's seeds come
  from an instruction argument or from signed bytes, a test passes the PDA
  of a different value and asserts the error.
- **Failures outside our program assert where and what.** A test expecting
  a precompile, system-program or SAS failure asserts the failing
  instruction index and that program's error code, not just "not a custom
  error": otherwise an unrelated failure (bad account, stale blockhash)
  passes it.
- **Pre-funded PDAs.** Every PDA a program creates, directly or by CPI, gets
  a test where the address already holds lamports, once below rent and once
  at or above it. Anyone can send lamports to an address before it exists,
  and the two balances take different code paths.
- **Each `has_one` and token constraint gets a negative test in every
  instruction that declares it.** Another program (SPL Token) often rejects
  the same input with a different code, which keeps the tests green after
  the constraint is deleted.
- **Shared test constants are exported once.** Framework error codes and
  account offsets live in one module and are imported, not redeclared per
  test file.
- **A resource-guard test fails if the guard is released early.** For a
  permit, lock or limit, make the guarded work block (a gated test clock,
  a channel) and assert the resource is still held mid-flight, including
  after the caller is cancelled. "Free before and after" passes with the
  guard released too soon. Open the gate in a drop guard, so a failing
  assertion can't hang the runtime.
- **Tests that share state use distinct ids.** Parallel tests planting the
  same id into one shared store race; give each test its own id or state.
- **Mutation restores use plain `cp`** (not `cp -p`). Keeping the old
  timestamp makes cargo reuse the mutated build, so the next mutant is
  tested against the wrong binary.

## 6. Git, commits and PRs
The workflow lives in `CONTRIBUTING.md` → **Git workflow** (single source).
In short: git-flow. Never commit to `main` or `develop`; one
`type/short-name` branch per task from `develop`; Conventional Commits with
`git commit -s`; PR into `develop` with gates + review; squash-merge.
Releases come from release-please and are promoted `develop` → `main`.
