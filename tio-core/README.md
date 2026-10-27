# tio-core

The Rust library that runs inside the enclave. **Trusted:** it is the only
code in the project that touches secret keys or decrypted bank data.

It has no I/O: no network, no files, no clock and no randomness of its own.
The enclave passes those in. That keeps the library small enough to audit,
and easy to test against fixed examples.

## What it does, in plain English

A borrower wants a loan, and the lender wants proof of steady income. The
borrower's bank can send a statement. But the borrower doesn't want anyone,
including us, to read their full transaction history.

So the project builds a **sealed box**: the enclave. The bank statement goes
in, and only a grade comes out: A, B, C or REJECT. Nobody can look inside,
and anyone can check that the box runs this published code.

`tio-core` is the code inside the box. Everything else (the website, the
server, the blockchain) only moves sealed envelopes around.

### The private mailbox: key exchange and decryption

The statement travels through our server, and we treat our own server as
untrusted. So the bank must lock the statement in a way only the box can
unlock.

- For each loan application, the box makes a fresh **padlock and key** (a
  key pair). It hands out the open padlock and keeps the key inside. The key
  never leaves.
- The bank does the same. Each side combines its own key with the other
  side's padlock. Both arrive at the same **shared secret**, which is never
  sent. Someone watching the traffic sees both padlocks but can't work out
  the secret.
- Both sides also add a random number, so every session's lock is different.
- The bank seals the statement with that secret. The seal is also
  **tamper-evident**: if anyone changes one byte on the way, the box notices
  and refuses the statement.
- Indian bank software writes these padlocks in an older format
  (`wei25519`). It is the same math in different coordinates. `tio-core`
  converts between the two formats, so a well-tested library does the secret
  math instead of crypto we wrote ourselves.
- Our code must reproduce real examples from India's official reference
  software byte for byte.

### The signature checker

The bank and the Account Aggregator each **sign** what they send. For each
signature, the box checks that:

- it comes from a signer the box already knows. Their public keys are built
  into the box, so the server can't swap in fake ones;
- it uses an approved signature algorithm;
- it is checked *before* the box reads the contents.

The box also signs its own request to the bank, with a key the box made
itself. So the server can't slip in its own padlock and read the statement.

Our code must reproduce the signature example from the JWS standard
(RFC 7515) byte for byte.

### The practice exams

A separate generator, written in TypeScript (`sandbox-bank`), writes:

- statements for four made-up borrowers, and the tier each one should get;
- their sealed envelopes;
- deliberately broken copies: one byte changed, a wrong signer, a missing
  seal.

`tests/vectors.rs` feeds every case through `tio-core`. It must accept each
good case. It must reject each broken case *for the right reason*, with the
exact error code. Two independent implementations have to agree, so each one
catches the other's mistakes.

### Why it is built this way

- **Small and boring.** It is the one part everyone must trust.
- **No secrets leave the box.** The server carries sealed data it can neither
  open nor forge.
- **Tested against real-world examples,** not only against itself.

## Test

```bash
cargo test -p tio-core
```

- [`tests/vectors.rs`](tests/vectors.rs) runs every case in
  [`test-vectors/manifest.json`](../test-vectors/manifest.json) through
  `evaluate`. The independent TypeScript generator in `sandbox-bank` writes
  those cases.
  - Each positive case must reproduce the generator's tier, features, payload
    and message bytes.
  - Each negative case must fail with exactly its expected error code.
- [`tests/evaluate_boundaries.rs`](tests/evaluate_boundaries.rs) moves the
  clock and the session values across each check's boundary.
- Reference vectors:
  [`test-vectors/golden/rahasya/`](../test-vectors/golden/rahasya/) and
  [`test-vectors/golden/rfc7515/`](../test-vectors/golden/rfc7515/).

## Layout

| Module | Does |
|---|---|
| `ecdh` | Per-session Curve25519 key pair; parses and validates a peer key (`wei25519` BouncyCastle SPKI or RFC 7748 `x25519`); shared secret |
| `cipher` | 32-byte nonces; `HKDF-SHA256(shared, salt = xn[0..20])`, `iv = xn[20..32]`; AES-256-GCM decrypt |
| `key_material` | ReBIT `KeyMaterial` JSON: builds ours, reads a peer's |
| `jws` | RS256/RS512 verify of detached (RFC 7797, `b64:false`) and compact JWS, against pinned keys only; strict header rules; blinded RS256 signing with the enclave's FIU key |
| `money` | Raw JSON money text → exact integer paise (`Paise`). Accepts any exact spelling; never `f64`, never rounded |
| `rebit` | Decrypted ReBIT DEPOSIT FI → `DepositFi` (integers + bounce/EMI flags). Lenient about shape, strict about meaning; never reads PII |
| `policy` | Scoring policy JSON → validated `Policy`; strict parse, canonical JCS bytes, `policy_hash` |
| `score` | `DepositFi` + `Policy` → outcome (tier A/B/C or REJECT) + features: loans, FOIR, income CV, bounces, overdraft days, over all months and recent months, on India calendar days. Integers only |
| `evaluate` | The whole pipeline, in a fixed order (FORMATS §10.1). **Before** decryption: AA signature; response tied to the session (`txnid`, `consentId`); consent valid now; window inside the consent and not too short, stale or in the future. Then: decrypt, FIP signature, parse, statement inside the window, score |
| `attest` | The 83-byte attestation payload (§7) and the 232-byte message the enclave signs (§8). A REJECT can't be written: the type has no such tier |
| `time` | Unix seconds ↔ ReBIT ISO-8601: formats ours; parses FI timestamps (converting offsets) and dates |
| `encoding` | PEM and base64 helpers |

## Rules

- `#![forbid(unsafe_code)]`.
- Secrets live in `Zeroizing` buffers, so they are wiped when dropped.
- No panics in library code; clippy enforces this.
- Error codes are stable, through the `ErrorCode` trait.

## See also

- Formats, in [`docs/FORMATS.md`](../docs/FORMATS.md): §1 money and FI data,
  §3 key exchange, §4 JWS, §5 ReBIT messages, §6 policy, §6.1 scoring,
  §7 payload, §8 signed message, §10.1 evaluate check order, §12 interop.
- Security model: [`docs/ARCHITECTURE.md`](../docs/ARCHITECTURE.md).
- Where it fits: [How it works](../README.md#how-it-works) in the root README.
- The order it runs its checks, with error codes:
  [check order](../test-vectors/README.md#check-order-and-error-codes).
