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
  does. Check for `{` before deserializing (`tio-core::jws::from_json_object`).
- **"Must not appear" means present, even as `null`.** A plain `Option<T>`
  reads `null` as absent. Use a presence-detecting `deserialize_with`
  (`tio-core::jws::present`) with `#[serde(default)]`.
- **Declare every member a security rule depends on.** Derived
  `Deserialize` rejects a repeated *declared* member; undeclared ones, and
  `#[serde(flatten)]` / `Value`, silently keep the last value.
- **Strict decoders.** base64url for JWS/JWK is `URL_SAFE_NO_PAD`: no `=`,
  no non-canonical trailing bits, so each value has one accepted encoding.

### Crypto hygiene
- `#![forbid(unsafe_code)]` in `tio-core`.
- Secrets in `Zeroizing<…>` or types deriving `ZeroizeOnDrop`.
- **Zeroize reaches the crate that holds the key.** A `zeroize` feature on an
  umbrella crate (e.g. `aes-gcm`) doesn't turn it on in the inner crates
  (`aes`, `ghash`/`polyval`, `crypto-bigint`). Check
  `cargo tree -p tio-core -e features -i zeroize`, and confirm the wiping
  `Drop` actually runs on the enclave target (x86_64), not only on the dev
  machine: autodetect backends can skip it. Residuals that can't be wiped get
  a `Known residual:` comment.
- Use audited crates (RustCrypto: `curve25519-dalek`, `crypto-bigint`, `hkdf`,
  `aes-gcm`, `sha2`, `k256`, `rsa`). No hand-rolled primitives.
- Randomness from `OsRng` only.

### Anchor programs
- Every account constrained: `seeds` + `bump`, `has_one`, `owner`, `address`.
  No unchecked `AccountInfo` without a `/// CHECK:` comment that explains why.
- Checked arithmetic only (`checked_add`, …). No `as` casts that can truncate.
- One `#[error_code]` enum per program; messages say what failed.
- Every program account starts with a `version: u8` field, so a future
  layout change can be detected and migrated (FORMATS → Version identifiers).
- Reading a foreign account (the SAS attestation): check the owner program id
  and discriminator before deserializing.
- Precompile introspection: the signature, address and message
  instruction-index fields in the secp256k1 offsets must all point at the
  precompile instruction itself. Otherwise an attacker can make the precompile
  verify bytes stored in a different instruction.

### Tooling
- `cargo fmt` and `cargo clippy --all-targets -- -D warnings` must pass.
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
- `"strict": true`, plus `noUncheckedIndexedAccess`. ESM only. Node 22 LTS or later.
- No `any`. Use `unknown` at boundaries and narrow it.
- **Validate every external input with `zod`** (HTTP bodies, env vars, RPC
  data) before use.
- `bigint` for `u64`/`i64` values (lamports, token amounts, timestamps from
  chain). Never `number` for on-chain integers.
- Bytes are `Uint8Array`. Encode/decode explicitly (hex, base64, base64url,
  base58) with one helper module; no ad-hoc `Buffer.toString` scattered around.

### Servers (gateway, sandbox-bank)
- Capture the **raw body** before any JSON middleware on routes that carry
  signatures.
- Errors return `{ error: { code, message } }`. No stack traces in responses.
- Config only from env, validated at startup. `.env.example` lists every key.
- Rate-limit and cap body size on every public route.

### Web (Next.js)
- The browser is untrusted. No keys, no privileged logic.
- Read chain state via RPC; don't trust gateway claims for anything shown as
  verified — the verify page checks on its own.

### Tooling
- `pnpm` (workspace). ESLint + Prettier; `tsc --noEmit` in CI.
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
  test must fail. A check no test notices is untested.
- **A strictness claim needs input the lenient variant would accept.** For
  a strict decoder: correctly padded base64, and non-canonical trailing bits
  with the signature taken over that exact text, so only the decoder can
  reject it. Mutation-check the decoder *config*, not only hand-written `if`s.
- **Repeated members:** every header/JWK member that a rule depends on, and
  especially one read through `deserialize_with`, gets a duplicate-member
  test expecting the specific error.
- **Check order is tested.** When the docs fix an order ("`alg` before
  `kid`"), a test combines two faults and asserts the one reported first.
  The documented order names every early return in the code path.

## 6. Git, commits and PRs
The workflow lives in `CONTRIBUTING.md` → **Git workflow** (single source).
In short: git-flow. Never commit to `main` or `develop`; one
`type/short-name` branch per task from `develop`; Conventional Commits with
`git commit -s`; PR into `develop` with gates + review; squash-merge.
Releases come from release-please and are promoted `develop` → `main`.
