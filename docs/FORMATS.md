# Wire and data formats

Every byte that crosses a component boundary is defined here. Code in Rust
and TypeScript must match this file, not each other. If you change a format,
change this file in the same commit and regenerate `test-vectors/`.

Status markers: **FROZEN** (build against it) · **OPEN** (decide before the
step that needs it).

---

## 0. Conventions — FROZEN

| Thing | Encoding |
|---|---|
| Integers in on-chain bytes | little-endian |
| Timestamps in our own structs | unix seconds, `i64` (or `u32` where noted) |
| Timestamps inside ReBIT JSON | **emit** ISO-8601 UTC `yyyy-MM-dd'T'HH:mm:ss.SSS'Z'`; **accept** `Z`, `+0000`, `+00:00` (see §12 for zone-less values) |
| 32-byte hashes in JSON | lowercase hex, no `0x` (64 chars) |
| secp256k1 signatures in JSON | lowercase hex, 65 bytes `r ‖ s ‖ v`, `v ∈ {0,1}` (recovery id) |
| Ethereum-style address | `0x` + 40 lowercase hex chars |
| Solana public keys | base58 |
| ReBIT binary fields (`Nonce`, `encryptedFI`) | base64 standard alphabet, with padding |
| JWS segments | base64url, no padding (RFC 7515) |
| Ids (`session_id`, `txnid`) | UUIDv4, lowercase, hyphenated |
| Hash function (ours) | SHA-256 unless stated |
| Canonical JSON | RFC 8785 (JCS). Our canonical objects use only strings, integers and arrays — no floats |
| Our own HTTP JSON | `snake_case` keys. ReBIT objects keep their spec casing verbatim |

---

## 0.1 Version identifiers — FROZEN

Each contract below carries its own version. Bump it **only** on a breaking
change to that contract. Bumping one is a breaking change for the repo too,
so the PR title is `feat!:` (see CONTRIBUTING → Versioning and releases). The
same PR updates this file, both implementations and the regenerated vectors.

| Contract | Id today | Bump when |
|---|---|---|
| Enclave signed message (§8) | domain tag `TIO-ATTEST-v1` | any change to the signed bytes or their order |
| FIU key binding (§8.1) | domain tag `TIO-FIU-KEY-v1` | any change to the signed bytes or the JWK members |
| Enclave HTTP API (§10) | path prefix `/v1/` | a breaking request/response change (adding optional fields isn't breaking) |
| Gateway HTTP API (§16) | path prefix `/v1/` | a breaking request/response or event change (adding optional fields isn't breaking) |
| Scoring policy (§6) | `"v": 2` | a policy schema change |
| Attestation payload + SAS schema (§7) | SAS schema `version` (part of the schema PDA) | a payload layout change → create a new schema version; old attestations stay readable; pools pin the schema address they accept |
| `proof_type` values (§7) | `1 = tee_nitro_oyster`; `2 = tee_nitro_aws` reserved | append-only; never reuse or renumber |
| Enclave build | platform measurement (Oyster image id, or AWS PCR0 hash) + on-chain `measurement_id` | every enclave change (automatic); the release notes list it. **`measurement_id`s are append-only: an id is never reused, even after revoke** |
| Anchor programs | program id + IDL; every account starts with `version: u8` (oracle accounts: §13, demo pool: §14) | an account layout change → migration path |
| Test vectors (§11) | `manifest.json` generator version | a vector file-format change |

---

## 1. Persona file and FI data (DEPOSIT) — FROZEN

`test-vectors/personas/<persona_id>.json`. Plaintext input to the generator;
never seen by the enclave directly.

```json
{
  "persona_id": "salaried_steady",
  "description": "Salaried, one EMI, no bounces",
  "expected_tier": "A",
  "fi": { "...": "DEPOSIT FI object, shape below" }
}
```

Four personas, fixed, in this order: `salaried_steady` → A, `trader_lumpy` → B,
`declining` → C (steady salary, then lower gig income in the recent months and one
EMI bounce: full window B, recent window C), `stressed` → `"REJECT"` (weeks of
overdraft, more bounces than any tier allows, and uncured EMI bounces; its loan is measured). 6–12 months of transactions each.
`expected_tier` is `"A"`, `"B"`, `"C"` or `"REJECT"`; the generator fails if its
independent scorer (§6.1) disagrees.

### Schema source
ReBIT `deposit.xsd` (namespace `http://api.rebit.org.in/FISchema/deposit`,
`version` 0.0–2.0), read from `specifications.rebit.org.in` on 2026-09-26.
The XSD is XML: `Account` is the root, XML **elements** are `Profile`,
`Holders`, `Holder`, `Summary`, `Pending`, `Transactions`, `Transaction`;
everything else is an **attribute**.

### JSON form — what real AA data looks like
The XSD does not define JSON. The JSON mapping below is taken from Finvu's
own decrypted sample (`finvu/sandbox` docs, `FIFetch` response), which is the
AA we target:

- Elements keep their XSD name in **PascalCase** as object keys; attributes
  become **camelCase** keys on that object.
- No `Account` wrapper: the FI object *is* the account (`type`,
  `maskedAccNumber`, `linkedAccRef`, `version`, `Profile`, `Summary`,
  `Transactions`, plus an ignorable `schemaLocation`).
- `Transaction` is an **array**. `Holder` is a single **object** in Finvu's
  sample (the XSD says one `Holder`), but JOINT accounts in other AAs use an array.

```json
{
  "type": "DEPOSIT",
  "maskedAccNumber": "XXXXXXXX1234",
  "linkedAccRef": "<ref>",
  "version": "2.0",
  "Profile": { "Holders": { "type": "SINGLE",
    "Holder": { "name": "...", "dob": "1994-09-24", "mobile": "9800000000",
                "nominee": "REGISTERED", "email": "a@b.in", "pan": "ABCDE1234F",
                "ckycCompliance": "true" } } },
  "Summary": { "currentBalance": "175614.64", "currency": "INR",
    "balanceDateTime": "2026-09-25T18:20:00.000+0000", "type": "SAVINGS",
    "branch": "Pune", "facility": "OD", "ifscCode": "SBIN0000454", "micrCode": "411002001",
    "openingDate": "2018-04-01", "currentODLimit": "0", "drawingLimit": "0",
    "status": "ACTIVE", "Pending": { "amount": 0 } },
  "Transactions": { "startDate": "2026-03-26", "endDate": "2026-09-25",
    "Transaction": [ { "type": "CREDIT", "mode": "FT", "amount": 85000,
      "currentBalance": "112340.50", "transactionTimestamp": "2026-04-01T09:12:00.000+0000",
      "valueDate": "2026-04-01", "txnId": "<id>", "narration": "NEFT-SAL-ACME PVT LTD",
      "reference": "<ref>" } ] }
}
```

Enums (XSD): Holders.type `SINGLE|JOINT` · nominee `REGISTERED|NOT-REGISTERED` ·
Summary.type `SAVINGS|CURRENT` · facility `OD|CC` · status `ACTIVE|INACTIVE` ·
Transaction.type `CREDIT|DEBIT` · mode `CASH|ATM|CARD|UPI|FT|OTHERS`.

### Emit rules (generator)
Emit exactly the Finvu-style shape above: PascalCase elements, camelCase
attributes, no wrapper, `Transaction` as array, `Holder` as object for
`SINGLE`, `type: "DEPOSIT"`, `version: "2.0"`. Amounts: `amount` as a JSON
number with at most 2 decimals, balances/limits as strings (as Finvu does).

### Parse rules (enclave) — lenient on shape, strict on meaning
The data is signature-checked before parsing, so leniency here only affects
correctness, not security. Accept:
- an optional root wrapper `Account` / `account` (a root with `account` and
  no `type`);
- member names in any case (`Transactions` / `transactions`) — Setu-style
  lowercase JSON exists in the ecosystem;
- `Transaction` as object **or** array, or absent (no transactions);
- enum values in any ASCII case: FI `type` (`DEPOSIT` / `deposit`),
  transaction `type`, `mode`;
- `startDate` / `endDate` as `xs:date` (optionally with a zone: `Z`,
  `±HH:MM`, `±HHMM`) or as a full timestamp; the written date is used and a
  zone never shifts it;
- members the scorer doesn't use, in any shape. `Profile` (holder PII), ids,
  `reference` and `valueDate` are never read. `Summary` is read only for
  `currency`: absent `Summary` or `currency` means INR;
- money as JSON number **or** string. Parse from the raw JSON text into
  integer **paise** (`i64`); never through `f64`, never rounded. ReBIT types
  `amount` as `xs:float` and balances as `xs:string` with no pattern, so any
  spelling of an **exact whole number of paise** is accepted: grammar
  `[+|-] (digits ['.' [digits]] | '.' digits) [(e|E) [+|-] digits]`, ASCII
  digits, e.g. `1.2E7`, `85000.0`, `1234.050`, `0012.5`, `.5`. Strings: no `\`
  escapes; surrounding spaces are trimmed. Reject: anything else (`NaN`,
  `INF`, `1,234.00`, `12.50 Dr`), a value that isn't whole paise
  (`1234.567`), an exponent beyond ±30, a magnitude above `i64::MAX` paise
  (the range is ±`i64::MAX`), and a negative `amount` (balances may be
  negative; `-0` is zero). When several apply, the first in this order wins:
  bad grammar, exponent range, not whole paise, magnitude, negative.

Narration is optional and is reduced to two flags, then wiped: split it on
every non-ASCII-alphanumeric character and compare whole tokens ignoring
ASCII case. `bounce` = any of `RTN RETURN RETURNED BOUNCE INSUFF`;
`emi_word` = any of `EMI LOAN NACH ECS` (so `SECS` is not `ECS`).

Reject with `bad_fi_data` unless noted. Checks run **top-down, one object
at a time**; the first failing check wins:
1. one leading UTF-8 byte-order mark is skipped; then XML (first non-space
   byte `<`) → `unsupported_fi_format`;
2. invalid JSON or UTF-8 anywhere in the document;
3. the root: not an object, or two members whose names differ only by
   case; then the `Account` wrapper, likewise;
4. FI `type`: missing, not a string, or not DEPOSIT;
5. `Summary` present but not an object or with a repeated member, or
   `currency` not a string (shape errors); `currency` present and not `INR`
   (any ASCII case) → `unsupported_currency`. Amounts become paise, so a
   foreign-currency DEPOSIT account (EEFC or RFC current/savings) can't be
   scored. An absent `currency` is read as INR: an accepted MVP risk for a
   foreign-currency statement that omits it;
6. `Transactions`: missing, not an object, or a repeated member; then
   `startDate`, then `endDate` (missing, not a string, invalid), then
   `startDate` after `endDate`;
7. `Transaction`: not an object or array (`null` included); more than
   20,000 items (counted before any is parsed);
8. each transaction in input order: not an object or a repeated member;
   then `type` (CREDIT|DEBIT), `mode` (CASH|ATM|CARD|UPI|FT|OTHERS),
   `amount`, `currentBalance`, `transactionTimestamp`, `narration`, each
   missing (except `narration`), an unknown enum value, a bad money value, or
   a bad timestamp. For `type`, `mode`, `transactionTimestamp` and
   `narration` a value of the wrong JSON type (`null` included) is a shape
   error; for `amount` and `currentBalance` any value that isn't a number or
   numeric string (`null` included) is a bad money value.

So a problem inside a transaction is reported only after the statement-level
checks pass, and an earlier transaction's error wins over a later one's.

---

## 2. Keys and pinned keys — FROZEN

| Key | Format | Location |
|---|---|---|
| FIP signing key (test) | RSA-2048 JWK, `kid` UUIDv4 | private: `test-vectors/keys/fip.test-private.jwk.json` |
| AA signing key (test) | RSA-2048 JWK, `kid` UUIDv4 | private: `test-vectors/keys/aa.test-private.jwk.json` |
| FIU request key (test) | RSA-2048 JWK, `kid` UUIDv4; stands in for the enclave's per-boot key | private: `test-vectors/keys/fiu.test-private.jwk.json` |
| Rogue key (test) | RSA-2048 JWK, `kid` UUIDv4; never pinned (builds the `unknown_kid` case) | private: `test-vectors/keys/rogue.test-private.jwk.json` |
| Public halves (test) | RSA public JWK (`kty`,`n`,`e`,`kid`) of each key above | `test-vectors/keys/<name>.public.jwk.json` |
| Pinned public keys | RSA public JWK (`kty`,`n`,`e`,`kid`) | `enclave/pinned/aa.jwk.json`, `enclave/pinned/fip.jwk.json` (demo keys), compiled in with `include_bytes!` |
| Demo FIP / AA signing keys | RSA-2048 JWK, `kid` UUIDv4; made once by `pnpm --filter @tio/sandbox-bank gen:demo-keys` | private: `sandbox-bank/.secrets/{aa,fip}.demo-private.jwk.json` (gitignored); public: `enclave/pinned/` |
| FIU request key | RSA-2048, generated in the enclave at boot, `kid` UUIDv4 | public JWK exposed by `GET /v1/info`, with the attester's §8.1 binding signature |
| Enclave attester key | secp256k1, provided by Oyster at `/app/ecdsa.sec` (32 raw bytes, new on every boot) | eth address exposed by `GET /v1/info` |
| Test enclave keys | Curve25519 scalar (used in both §3 modes) + secp256k1, fixed | `test-vectors/keys/enclave.test-private.json` |

### Two key sets: committed test keys vs secret demo keys

| Key set | Committed? | Used by | Pinned in a deployed enclave? |
|---|---|---|---|
| **Test-vector keys** (`test-vectors/keys/*.test-private.*`, golden-vector keys flagged `private_key_test_only`) | **Yes**, on purpose, so anyone can reproduce the vectors | offline unit tests only | **Never** |
| **Demo sandbox-bank keys** (FIP + AA signing keys for the running sandbox bank) | **Never.** Private halves live only in `sandbox-bank/.secrets/` (gitignored, backed up outside the repo) and the deployed service's secret store | the live sandbox bank | Public halves only, in `enclave/pinned/` |

Why two sets: a committed private key is public. If the deployed enclave
pinned a committed key, anyone could forge "signed bank data" and the enclave
would attest to it. That defeats the provenance claim (G1).

Rules:
- A test key is generated only for tests and never reused anywhere else.
- `enclave/pinned/` holds **only** demo (or, later, real FIP/AA) public keys.
  Test-vector public keys stay in `test-vectors/` and reach unit tests as
  inputs.
- **Startup guard:** the enclave keeps a compiled-in deny-list
  (`enclave/src/guard.rs`) of every test-key `kid` and the SHA-256 of every
  test RSA modulus (the big-endian bytes of the JWK `n`) under
  `test-vectors/`, including the golden RFC 7515 / 7520 keys; a test checks
  the list covers them all. At boot, before loading any other key, it
  refuses to start (exit non-zero, `test_key_pinned`) if any pinned key
  matches by `kid` or by modulus, so renaming a test key's `kid` doesn't get
  it past. Known limit: a modulus re-encoded with a leading zero byte hashes
  differently. That guards against mistakes, not against someone committing
  a disguised test key on purpose.
- Committing private keys is allowed **only** under `test-vectors/`, with the
  `test-private` naming or flag. Anywhere else it's a bug; `.gitignore` blocks
  `*.pem`, `*.key` and `id.json`.

---

## 3. Session key material (KeyMaterial) — FROZEN (`wei25519` verified against the reference implementation)

```json
{
  "cryptoAlg": "ECDH",
  "curve": "Curve25519",
  "params": "",
  "DHPublicKey": {
    "expiry": "2026-09-26T10:00:00.000Z",
    "Parameters": "",
    "KeyValue": "-----BEGIN PUBLIC KEY-----MIIBMTCB6gYHKoZIzj0CAT...-----END PUBLIC KEY-----"
  },
  "Nonce": "<base64 of 32 random bytes>"
}
```

**Do not trust `cryptoAlg` / `curve` / `params`.** Finvu's own fetch-response
sample has them shuffled (`cryptoAlg: null, curve: "ECDH", params: "Curve25519"`),
and rahasya V1.2 emits `curve: "curve25519"` (lowercase) and `"Parameter"`
(singular) instead of `"Parameters"`. The key type is decided by parsing
`KeyValue` only. On input accept `Parameter` or `Parameters`; on output emit
`Parameters`.

**`expiry` is enforced by peers.** rahasya rejects a KeyMaterial whose
`expiry` is in the past ("Expired Key"), and issues keys with a 24-hour
expiry. We emit `expiry = now + 24h`. The enclave's clock is untrusted, so on
input the enclave treats an expired peer key as a soft error: it logs a code
but does not rely on the check for security.

### Two key encodings exist — both from Sahamati's reference (rahasya)

| Mode | Curve form | `KeyValue` (PEM, SubjectPublicKeyInfo DER) | ECDH output | Where seen |
|---|---|---|---|---|
| `wei25519` | Curve25519 in **short-Weierstrass** form (BouncyCastle `CustomNamedCurves.getByName("Curve25519")`, JCA `EC` + `ECDH`) | `id-ecPublicKey` (1.2.840.10045.2.1) with **explicit** curve parameters (no named-curve OID, no seed) and a 66-byte BIT STRING holding the uncompressed point `04 ‖ X ‖ Y`. **309-byte DER**; base64 starts `MIIBMTCB6gYHKoZIzj0CAT` | x-coordinate of `d·Q`, **32 bytes big-endian, leading zeros kept** | **Finvu's sandbox samples**; rahasya `ECCService` / `CipherService` |
| `x25519` | RFC 7748 Montgomery | OID 1.3.101.110; 44-byte DER = `302a300506032b656e032100` ‖ 32-byte u | X25519, 32 bytes little-endian | rahasya `X25519Service` / `XCipherService` |

**PEM formatting matters.** rahasya's `wei25519` PEM is a **single line**:
`-----BEGIN PUBLIC KEY-----<base64>-----END PUBLIC KEY-----`, no newlines.
It **rejects** a normal 64-column PEM with newlines (HTTP 500). Bare base64
with no armour is accepted. So we **emit the single-line form** for
`wei25519`, and **parse** any form (strip armour and whitespace).
The private key is PKCS#8, 587 bytes DER; `d` sits in a 32-byte big-endian
zero-padded field. Private keys never leave the enclave or sandbox-bank.

**Decision:** `tio-core` implements both and picks by the SPKI algorithm OID
of the peer key. We **emit `wei25519` by default**: it is what Finvu's docs
show, and it is now verified byte-for-byte against the reference
implementation. `x25519` stays available as a per-session setting, but it is
**not confirmed against any AA**: rahasya V1.2 has no X25519 endpoints, so
its vector comes from OpenSSL. sandbox-bank must support both.

### How `wei25519` is computed with an audited X25519 library
Short-Weierstrass Curve25519 and Montgomery Curve25519 are the same group
under the map `x_W = u + A/3 (mod p)`, with `A = 486662`, `p = 2^255 − 19`.
Derived constants (computed from `A` and `p`; they match BouncyCastle's
`Curve25519` custom curve):

```
a   = (3 − A²)/3        = 0x2aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa984914a144
b   = (2A³ − 9A)/27     = 0x7b425ed097b425ed097b425ed097b425ed097b425ed097b4260b5e9c7710c864
G_x = 9 + A/3           = 0x2aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaad245a
```
So:

- **Our public key:** a clamped scalar `d`, `u = X25519(d, 9)`,
  `x_W = u + A/3`, `y_W = any square root of x_W³ + a·x_W + b`. The sign of
  `y_W` doesn't matter, because only x-coordinates reach the shared secret.
  Clamping is our choice. It is valid (any `d` works) and clears the cofactor
  on the peer's point.
- **Other parties' scalars are NOT clamped.** BouncyCastle picks `d`
  uniformly in `[1, n−1]` (observed `d mod 8` = 6, 1, 3). To reproduce a
  rahasya shared secret *from a rahasya private key* (tests, sandbox-bank
  interop), a normal `X25519()` call gives the **wrong** answer, because it
  clamps. Use `Scalar::from_bytes_mod_order(reverse(d_be))` and
  `MontgomeryPoint * Scalar` (curve25519-dalek, not `mul_clamped`), or plain
  Weierstrass math.
- **Shared secret:** parse the peer's `(x_W, y_W)`. Check the explicit
  parameters equal the Curve25519 Weierstrass constants and the point is on
  the curve. Then `u = x_W − A/3`, `s = X25519(d, u)`, reject all-zero `s`,
  `shared = s + A/3` as 32 bytes **big-endian**.
- Parsing and encoding points touch only public values. The secret scalar
  multiplication is in `curve25519-dalek` (`MontgomeryPoint::mul_clamped`).
  The final `s + A/3` runs on the shared secret, using constant-time
  `crypto-bigint` arithmetic (`tio-core/src/ecdh/wei25519.rs`).

**VERIFIED 2026-09-26** against the reference Java implementation (rahasya
Docker image `gsasikumar/forwardsecrecy:V1.2`, BouncyCastle 1.64). The checks:
- `p`, `a`, `b`, `G`, `n = 2^252 + 27742317777372353535851937790883648493`
  and `h = 8` all match the key's explicit parameters.
- The shared secret equals the Weierstrass x of `d·Q`, 32 bytes big-endian,
  including a case with a leading zero byte.
- Our independently derived key and IV decrypt rahasya's ciphertext and
  re-encrypt it byte for byte.

Vectors and a standard-library re-checker live in
`test-vectors/golden/rahasya/` (`python3 verify.py`).

### Session key derivation — FROZEN (identical for both modes)

```
shared  = ECDH per mode above                                   // 32 B
xn      = our_nonce XOR their_nonce                             // 32 B
aes_key = HKDF-SHA256(ikm = shared, salt = xn[0..20], info = empty, L = 32)
iv      = xn[20..32]                                            // 12 B
ct‖tag  = AES-256-GCM(aes_key, iv, plaintext, aad = empty)      // tag = last 16 B
encryptedFI = base64(ct‖tag)
```
Verified in rahasya: `CipherService` (EC) and `XCipherService` (X25519) share
this exact code.

XOR is symmetric, so both sides compute the same `xn`. A key + nonce pair
must never be reused: the IV is derived from the nonces, so reuse repeats the
GCM IV under the same key.

- **Both nonces must be exactly 32 bytes; otherwise reject.** rahasya sizes
  `xn` by *our* nonce and repeats the remote nonce cyclically, so mismatched
  lengths would silently derive a different key.
- The HKDF input is the raw 32-byte secret. rahasya base64-encodes it and
  decodes it again internally, which changes nothing.
- The plaintext is the UTF-8 bytes of the FI JSON string. On rahasya's
  `/encrypt` the `base64Data` field is **not** base64-decoded (it is taken as
  the string). `/decrypt` returns base64 of the plaintext.

---

## 4. JWS — FROZEN

**Detached, unencoded payload (RFC 7797)** — API bodies (`x-jws-signature`):

```
protected header : {"alg":"RS256","kid":"<uuid>","b64":false,"crit":["b64"]}
signing input    : ASCII(base64url(header)) ‖ "." ‖ raw_body_bytes
wire form        : base64url(header) + ".." + base64url(signature)
```

**Compact (standard)** — the consent artefact:
`base64url(header).base64url(payload).base64url(signature)`, header
`{"alg":"RS256","kid":"<uuid>"}`.

Verification rules (enclave and sandbox-bank):
1. Verify over the **raw bytes as received**, before any JSON parsing.
2. `alg` ∈ {`RS256`, `RS512`}. Anything else (`none`, `HS*`, `PS*`, `ES*`) → reject.
3. `kid` must match a pinned key. Never accept a key or `jwk`/`jku`/`x5u` from the header.
4. Detached form: `b64` must be `false` and `crit` must be exactly `["b64"]`.
   Compact form: neither `b64` nor `crit` may appear.
5. The header must be a JSON object. Any of `jwk`, `jku`, `x5u`, `x5c` in
   it → reject, even with a `null` value (a "may not appear" rule counts
   `null` as present). Unknown other members (`typ`, `x5t`, …) are ignored.
   A repeated member we act on (`alg`, `kid`, `b64`, `crit`, `jwk`, `jku`,
   `x5u`, `x5c`) → reject.
6. Segments are base64url **without padding**, decoded strictly (no `=`, no
   non-canonical trailing bits). Detached: middle segment empty. Compact:
   payload segment non-empty.
7. Pinned keys are public RSA JWK objects (`kty` `RSA`, `n`, `e`, `kid`, no
   private member `d`/`p`/`q`/`dp`/`dq`/`qi`/`oth`) with a modulus of at
   least 2048 bits. `n` and `e` are minimal-length `Base64urlUInt` (RFC 7518
   §2: no leading zero octets).

Check order (one error per case): segments (count, signature base64url,
payload segment empty for detached / non-empty for compact) →
header decode/parse → `alg` →
`b64`/`crit`/embedded-key rules → `kid` (missing → `bad_header`, not pinned →
`unknown_kid`) → signature. `alg` comes before `kid`, so a swapped algorithm
always reports `bad_alg`, even when `kid` is also missing or unknown.

We **sign** with RS256 only. We **verify** RS256 and RS512 (Finvu's sample
header decodes to RS512).

Implementation (`tio-core::jws`): RSASSA-PKCS1-v1_5 from `rsa` 0.9
(`Pkcs1v15Sign`), digests from `sha2`. rsa checks the signature length equals
the modulus size and compares the padded encoding in constant time
(`subtle`). Signing always uses rsa's blinded `sign_with_rng`. Known
residual: RUSTSEC-2023-0071 (Marvin), private-key operations in rsa are not
constant time. Only the per-boot FIU key signs; verification is unaffected.
Golden vector: RFC 7515 Appendix A.2 (`test-vectors/golden/rfc7515/`).

---

## 5. ReBIT messages we use — FROZEN (shape), OPEN (version string)

API version string: `"ver": "1.1.3"` (per Finvu sandbox docs). **OPEN:** confirm with Finvu.

### 5.1 `POST /FI/request` — built and signed by the enclave

```json
{
  "ver": "1.1.3",
  "timestamp": "2026-09-26T10:00:00.000Z",
  "txnid": "<uuid>",
  "Consent": { "id": "<consent uuid>", "digitalSignature": "<signature segment of consent JWS>" },
  "FIDataRange": { "from": "2026-03-26T00:00:00.000Z", "to": "2026-09-26T00:00:00.000Z" },
  "KeyMaterial": { "...": "section 3, enclave's public key + nonce" }
}
```
Header: `x-jws-signature` = detached JWS by the FIU request key.

### 5.2 FI fetch response — built by sandbox-bank, signed by the AA key

```json
{
  "ver": "1.1.3",
  "timestamp": "...",
  "txnid": "<same as request>",
  "FI": [ {
    "fipID": "SANDBOX-FIP",
    "data": [ {
      "linkRefNumber": "<ref>",
      "maskedAccNumber": "XXXXXX1234",
      "encryptedFI": "<base64, section 3>"
    } ],
    "KeyMaterial": { "...": "section 3, FIP's public key + nonce" }
  } ]
}
```
Header: `x-jws-signature` = detached JWS by the AA key over these exact bytes.

`KeyMaterial` sits on the `FI[]` entry (one per FIP), **not** inside each
`data[]` item: this matches Finvu's sample. One FIP key serves all its accounts.

**The enclave accepts exactly one `FI[]` entry with exactly one `data[]`
item** (else `bad_fetch_response`). One `KeyMaterial` + our nonce derive one
AES key **and one IV** (§3). Two `encryptedFI` values under the same key and
IV break AES-GCM: the XOR of the plaintexts leaks and the GHASH key can be
recovered (NIST SP 800-38D). Until a provider shows per-account keys or
nonces, multi-account and multi-FIP responses are refused.

**FIP signature (sandbox extension, not part of ReBIT):** the plaintext inside
`encryptedFI` is a JSON envelope:

```json
{ "fi": "<base64 of the FI JSON bytes>", "jws": "<detached JWS by the FIP key over those bytes>" }
```

The enclave checks the FIP JWS over the decoded `fi` bytes. The ReBIT spec
defines no such signature for the FIU: `FIFetchResponse` carries only `fipID`,
`encryptedFI` and `KeyMaterial`, signed as a whole by the AA, and the DEPOSIT
schema has no signature element (checked 2026-10-05, AA 2.1.0 / FIP 2.2.0 /
`deposit_v2.0.0.xsd`). For a real provider this envelope is therefore absent
unless that provider adds one; it then becomes optional and step 6 of the
evaluate pipeline is skipped, leaving the AA signature as the provenance check.

### 5.3 Consent artefact — compact JWS by the AA key

Payload (subset we rely on):
```json
{ "consentId": "<uuid>", "status": "ACTIVE", "consentStart": "...", "consentExpiry": "...",
  "consentMode": "VIEW", "fetchType": "ONETIME", "consentTypes": ["TRANSACTIONS"],
  "fiTypes": ["DEPOSIT"], "FIDataRange": { "from": "...", "to": "..." },
  "DataLife": { "unit": "DAY", "value": 0 } }
```
- The enclave requires: `consentId` = the id it put in its FI request,
  `status` = `ACTIVE`, `fiTypes` contains `DEPOSIT`,
  `consentStart ≤ now < consentExpiry`, and `FIDataRange.from < to`
  (timestamps per §12). It also requires the range it requested (§5.1
  `FIDataRange`) to lie inside the consent's `FIDataRange`. The binding of
  accounts, FIU id and purpose is not checked yet.
- `window_from` / `window_to` are the **statement's** `startDate` / `endDate`,
  as written, at 00:00 UTC (`u32` unix seconds). They must lie inside the
  requested range (§5.1), which lies inside the consent's (§10.1 check 15).
  The requested range is still checked before decryption (§10.1 checks 8-10),
  and the policy window checks (§6) run on both the requested and the
  statement window (checks 9, 10, 15b, 15c). So the payload never claims more
  than the statement covers (a short request under a long consent, or a stale
  statement under a fresh request, can't get a window it doesn't have), and
  the pool reads exactly what the enclave checked. The requested `to` may not
  be after `now` (§10.1 check 10b).
- `consent_hash = sha256(ASCII bytes of the whole compact JWS string)`.

---

## 6. Scoring policy — FROZEN (format), OPEN (threshold values)

Canonical JSON (JCS). `policy_hash = sha256(JCS(policy))`.

```json
{
  "v": 2,
  "recurrence": { "amount_tol_bps": 1000, "day_tol": 5, "min_occurrences": 2 },
  "recent_months": 3,
  "window": { "min_days": 180, "max_age_days": 7 },
  "tiers": [
    { "tier": "A", "foir_max_bps": 4000, "cv_max_bps": 1500, "bounces_max": 0 },
    { "tier": "B", "foir_max_bps": 5500, "cv_max_bps": 5000, "bounces_max": 1 },
    { "tier": "C", "foir_max_bps": 7000, "cv_max_bps": 6000, "bounces_max": 3 }
  ],
  "reject_if": { "od_days_min": 30 }
}
```

| Key | Meaning |
|---|---|
| `v` | schema version, must be `2` |
| `recurrence.amount_tol_bps`, `.day_tol` | an EMI debit joins a recurring-obligation cluster if its amount is within ±bps and its day of month within ±days of the cluster's first debit (at most one debit per calendar month per cluster, §6.1) |
| `recurrence.min_occurrences` | number of **distinct calendar months** with a matching debit that makes a cluster a loan (≥ 1) |
| `recent_months` | the last N complete months are also scored alone; the worse tier wins (≥ 1) |
| `window.min_days` | shortest consent window accepted |
| `window.max_age_days` | how old the window's end may be when evaluated |
| `tiers[]` | `tier` (`"A"`, `"B"`, `"C"`) + maxima `foir_max_bps`, `cv_max_bps`, `bounces_max` (a feature passes if ≤ its maximum) |
| `reject_if.od_days_min` | this many overdraft days or more → Reject (≥ 1) |

- Integers only (basis points, days, counts), each `0 ≤ n ≤ 2^32 − 1`. Tiers are evaluated in order; first match wins; else Reject.
- **Strict parse** (any failure → `bad_policy`): at most 4096 bytes; the policy, `recurrence`, `window`,
  `reject_if` and each `tiers[]` entry are JSON objects and `tiers` is an array (a positional array in place
  of an object is rejected); unknown, repeated or missing keys; non-integer spellings
  (`3.0`, `3e0`, `"3"`); `v ≠ 2`; `tiers` empty or not strictly ordered A, B, C (no repeats); each tier
  at least as loose as the one before it in every limit and looser in at least one (so every tier can be
  awarded and A is the strictest);
  `recent_months`, `min_occurrences` or `od_days_min` equal to 0 (scoring would be undefined or reject everyone).
- **Hash input.** Any JSON spelling of a valid policy is accepted (whitespace, key order, string escapes).
  The hash is over the JCS bytes of the *parsed* policy, so every spelling gives the same `policy_hash`.

## 6.1 Scoring algorithm — FROZEN

`score(DepositFi, Policy) → { outcome, full, recent }` (`tio-core/src/score.rs`; independent TypeScript
mirror in `sandbox-bank/src/scoring/`). Pure, no clock, **integers only**: money in paise (`i64`), ratios
in basis points, overflow is an error (`bad_fi_data`), never a wrap.

**Time basis: India calendar days.** `day(t) = floor((transactionTimestamp_unix + 19800) / 86400)`
(IST = UTC+05:30, no daylight saving). `startDate` / `endDate` are the dates as written (`xs:date`, no
zone in practice) and are read as India dates: an Indian FIP writes them in IST. Months and day of month
come from these days. API instants (`FIDataRange`, `window_from/to`, §5/§7) are not scoring days and stay
UTC. Transaction order = (`transactionTimestamp`, input index).

0. **Bounds.** A transaction whose day is outside `[startDate, endDate]` → `window_mismatch`.
1. **Classify.** DEBIT + bounce token → *bounce* (an *EMI bounce* if it also has an EMI token);
   DEBIT + EMI token with an amount > 0 → *EMI candidate*; CREDIT without a bounce token → *income*;
   anything else is ignored (a credit with a bounce token, e.g. a reversal, is not income; a ₹0 EMI
   line is not a payment). Tokens: §1 parse rules.
2. **Loans.** Walk EMI candidates in order. Each unassigned candidate `c` anchors a cluster; a later
   unassigned candidate `d` joins iff no member is in `d`'s month yet, `|d − c| × 10000 ≤ c × amount_tol_bps`
   and `|dom(d) − dom(c)| ≤ day_tol`. A cluster with ≥ `min_occurrences` members (= months) is a **loan**:
   `scheduled` = median member amount, `first_day` = day of its first payment, `due_dom` = that
   payment's day of month. Two equal EMIs in the same months are two loans.
3. **Complete months** = calendar months wholly inside `[startDate, endDate]`. *Full* set = all of them;
   *recent* set = the last `min(recent_months, count)`.
4. **Monthly sums** per complete month: income = sum of income amounts; obligation = sum of `scheduled`
   over loans with `first_day ≤` the month's last day. **A loan persists**: a missed or bounced month
   still counts, until statement end.
5. **Features of a set S** (each key as in §11):
   - `months`; `income_median`, `obligation_median` (median: odd → middle, even → floor of the mean of
     the middle two, empty → 0).
   - `foir_bps` = `floor(obligation_median × 10000 / income_median)`; 0 if income is 0; values
     ≥ 2³² − 1 are reported as 2³² − 1, which always rejects.
   - `cv_bps` over the monthly incomes `x` (n months): `D = n·Σx² − (Σx)²`,
     `cv_bps = floor(isqrt(10⁸ · D) / Σx)`, 0 if `Σx = 0`. Scaling before the root keeps it the exact floor
     of `10⁴ · √D / Σx` (`[1,1,2]` → 3535, not 2500).
   - `loans` = loans with `first_day ≤` S's last day; `bounces` = bounces on S's days.
   - `unmatched_emi_bounces` = EMI bounces on S's days that no known loan explains. A loan can explain
     a bounce if it (a) started by the end of the bounce's month, (b) has no payment in that month,
     (c) is due within `day_tol` days of the bounce (`|due_dom − dom(bounce)| ≤ day_tol`), and
     (d) is **cured**: it has a payment in a later month. Bounces are taken in time order; each takes
     the eligible loan with the **earliest due day** (first on ties) not yet used for another bounce
     that month. That greedy choice explains every bounce whenever some pairing can. Why these rules:
     nothing in the reduced data names the loan a bounce belongs to (narration is reduced to flags;
     the bounce line's amount is usually the return charge, not the EMI). A NACH bounce posts on the
     due day, which ties it to loans due near that day, and a later payment proves the loan is alive,
     so the miss was a gap in its own schedule. An uncured bounce could equally be a new, unseen
     loan's first instalment, so it is never attributed. A small loan paid on time, a loan due on
     another day, or a loan that has stopped paying can't hide a bounced unknown one.
   - `od_days` = days of S whose end-of-day balance (the last transaction on or before that day) is
     negative; days before the first transaction don't count.
   - S's days: full = `[startDate, endDate]`, even with no complete months; recent = first to last
     day of the recent months, and a recent set with no months has no days (its day-based counts are 0).
6. **Outcome of a set**, first rule that fires: `months = 0` → Reject · `income_median = 0` → Reject ·
   `foir_bps = 2³² − 1` → Reject · `unmatched_emi_bounces > 0` → Reject (unmeasurable debt never
   counts as zero debt) · `od_days ≥ od_days_min` → Reject · else the first tier with `foir_bps ≤ foir_max_bps`,
   `cv_bps ≤ cv_max_bps` and `bounces ≤ bounces_max`; none → Reject.
7. **Final outcome** = the worse of full and recent (A < B < C < Reject).

**Known limitations** (conservative by design, or out of scope):
- A loan counts until statement end even if it was repaid (no closure detection).
- A NACH retry that succeeds in the month of its bounce looks like an unknown loan → Reject.
- An EMI bounce before a loan's first payment in the statement (e.g. the window's first instalment
  bounced) is unmatched → Reject.
- A bank that posts two bounce lines per miss (e.g. return charge + GST, both with EMI words) double-counts.
- A bounce posted more than `day_tol` days after the due day (late re-presentation) is unmatched → Reject.
- An uncured EMI bounce (no later payment of a matching loan, e.g. in the statement's last month) is
  unmatched → Reject: a fresh, unresolved bounce. Periodic re-pulls re-check it once a payment follows.
- Residual: a known loan that skips a month with no bounce line and pays later, while an unseen loan
  due near the same day bounces that month, still has the bounce explained by the known loan.
- A loan with fewer than `min_occurrences` payments in the statement (default 2: a single payment) is
  not seen.
- Income = every non-bounce credit, so self-transfers, loan proceeds and refunds count. Signatures prove
  where the data came from, not that a credit is income.
- `day_tol` has no month-end wrap (the 31st and the 1st are 30 days apart).
- Transactions with equal timestamps keep input order; reordering them can change an end-of-day balance.
- Not modelled: income regularity/timing, UPI patterns, ongoing monitoring.

Clustering is O(c²) in EMI candidates: about 0.4 s for 20 000 candidates (release build, worst case).

---

## 7. Attestation payload — FROZEN

83 bytes, little-endian. Stored as SAS attestation `data`.

| Offset | Size | Field | Type | Values |
|---|---|---|---|---|
| 0 | 1 | `tier` | u8 | 1=A, 2=B, 3=C. Reject is never written |
| 1 | 1 | `proof_type` | u8 | 1 = `tee_nitro_oyster`; 2 = `tee_nitro_aws` (reserved) |
| 2 | 1 | `measurement_id` | u8 | index into the oracle registry. Append-only: never reused, even after revoke, so revoking an id permanently invalidates its attestations |
| 3 | 32 | `policy_hash` | bytes | section 6 |
| 35 | 32 | `consent_hash` | bytes | section 5.3 |
| 67 | 8 | `issued_at` | i64 | unix seconds, enclave clock (checked on-chain) |
| 75 | 4 | `window_from` | u32 | statement start date, 00:00 UTC, unix seconds |
| 79 | 4 | `window_to` | u32 | statement end date, 00:00 UTC, unix seconds |

SAS schema layout (SAS has no fixed-size arrays; each 32-byte hash is two U128s):
`[U8, U8, U8, U128, U128, U128, U128, I64, U32, U32]`
Field names: `tier, proof_type, measurement_id, policy_hash_lo, policy_hash_hi,
consent_hash_lo, consent_hash_hi, issued_at, window_from, window_to`.
The raw bytes are the same either way; `_lo` = bytes 0..16 of the hash.

SAS attestation account total: 256 bytes.

**Credential and schema.** Created once per cluster by `ops` (`sas:setup`,
see `ops/README.md`), which verifies them on re-runs and never changes them:

| Thing | Value |
|---|---|
| Credential name | `tee-income-oracle` (PDA seed, so ≤ 32 bytes) |
| Credential authority | the admin wallet |
| Credential authorized signers | exactly `[sas_signer]` = PDA `["sas_signer"]` of the oracle program. Any other signer could write attestations the oracle never checked |
| Schema name / version | `tio-income-tier` / `1` |
| Schema description | `TEE Income Oracle attestation payload v1 (FORMATS section 7)` |
| Schema layout + field names | as above |

Addresses: credential = `["credential", authority, name]`, schema =
`["schema", credential, name, version_u8]` under the SAS program. They depend
only on the admin wallet, names and version, so the same admin gets the same
addresses on every cluster. `sas:setup` writes them to
`deployments/<cluster>.json` (snake_case, public data):
`cluster, sas_program, oracle_program, sas_signer, authority, credential,
schema, schema_name, schema_version`.

**Verified on devnet 2026-09-27** (throwaway spike, `sas-lib` 1.0.10, SAS
`22zoJMtdu4tQc2PzL74ZUT7FrwgB1Udec8DdW4yw4BdG`):
- The schema layout above is accepted and stored as `0,0,0,4,4,4,4,8,2,2`.
- An 83-byte payload is stored byte-for-byte. The account is exactly **256
  bytes**, and `deserializeAttestationData` decodes it with this schema.
- Rent for 256 bytes is **1,950,720 lamports (≈ 0.00195 SOL)**, below the
  2,672,640 we had estimated from the older rent rate.
- SAS enforces the rules the oracle relies on:
  - signer not in the credential's authorized signers → error `0x5`;
  - data length that doesn't match the layout (82 bytes) → error `0x6`;
  - a second attestation for the same (credential, schema, nonce) → the
    system program's "account already in use". **Refreshing a borrower's
    attestation needs `close_attestation` first**; `submit_attestation` does
    that itself (§13).
- The attestation address equals `["attestation", credential, schema, nonce]`
  as derived by `deriveAttestationPda`, and the stored `nonce` is the borrower
  wallet.

**How the oracle writes it** (SAS source at commit `12582e23d4`, which matches
the devnet binary in `test-fixtures/sas/`; create and close are unchanged in
SAS 2.0). Tested on surfpool against that binary.
- Instructions, built by hand (the published Rust client pins
  solana-program 2.x): `CreateAttestation` = `[6] ‖ nonce 32 ‖ u32 len ‖ data
  ‖ expiry i64`, accounts payer (w, s), authority (s), credential, schema,
  attestation (w), system program. `CloseAttestation` = `[7]`, accounts payer
  (w), authority (s), credential, attestation (w), event authority (PDA
  `["__event_authority"]` under SAS), system program, SAS program.
- **SAS `expiry`** = `issued_at + 30 days` (oracle constant
  `ATTESTATION_TTL_SECS`; the enclave doesn't sign it). SAS rejects an expiry
  in the past with `0x6` too, not only a bad data length; `0` would mean
  "never expires".
- **Close refunds whatever account is passed as `payer`**, unchecked by SAS.
  The oracle always passes its own payer (the relayer), who also pays the new
  rent, so a refresh costs about nothing. The first payer's rent goes to
  whoever relays the refresh.
- **Stored account** (256 B): `disc u8 (= 2) ‖ nonce 32 ‖ credential 32 ‖
  schema 32 ‖ u32 len ‖ data 83 ‖ signer 32 ‖ expiry i64 ‖ token_account 32`.
  The payload starts at byte 101, so `issued_at` is at byte 168. The oracle
  reads an existing account only after checking owner = SAS, length 256 and
  discriminator 2. It doesn't re-check the stored `signer`: the admin sets
  the credential's signers, and an admin who added another signer could
  write attestations directly anyway. A program that lends on an
  attestation is different: it must check the stored `signer` (byte 184;
  `expiry` is at byte 216), as the demo pool does (§14).
- Anyone can send lamports to an attestation address before it exists. SAS
  creates over them (tops up below rent), so this can't block a wallet.

---

## 8. Enclave signed message — FROZEN

```
msg = b"TIO-ATTEST-v1"        13 B
    ‖ oracle_program_id       32 B
    ‖ sas_credential          32 B
    ‖ sas_schema              32 B
    ‖ subject_wallet          32 B   (becomes the SAS nonce)
    ‖ payload                 83 B   (section 7)
    ‖ expiry (i64 LE)          8 B
                            = 232 B
sig = secp256k1_sign_recoverable(keccak256(msg))  → 65 B r‖s‖v
```
The Solana secp256k1 precompile hashes `msg` with keccak256 itself and checks
the recovered 20-byte eth address.

**Precompile instruction** (program `KeccakSecp256k11111111111111111111111111111`,
no accounts). It must be the instruction directly before
`submit_attestation`, at transaction index `P`, with exactly this 329-byte
layout:

| Offset | Size | Content |
|---|---|---|
| 0 | 1 | signature count = `1` |
| 1 | 11 | offsets, LE: signature `32`, ix `P` · eth address `12`, ix `P` · message `97`, size `232`, ix `P` |
| 12 | 20 | enclave eth address |
| 32 | 64 | `r ‖ s` |
| 96 | 1 | recovery id `v` (`0` or `1`; the precompile rejects 27/28) |
| 97 | 232 | `msg` |

The precompile's instruction-index fields are plain one-byte transaction
indexes with no "this instruction" value, so the oracle compares the whole
offsets block, built for `P`, byte for byte (CODING-GUIDELINES §2). The
precompile accepts high-s signatures, so a signature's bytes are never used
as a replay key; replay is stopped by the strictly increasing `issued_at`
(§13).

**Clock rules** (Solana clock `now`, oracle constants):
`issued_at ≤ now + 300` (`MAX_SKEW_SECS`), `now ≤ expiry`, and
`0 < expiry − issued_at ≤ 600` (`MAX_SIGNATURE_LIFETIME_SECS`). The
enclave's clock comes from its untrusted host; together the rules bound how
early or late a signature can be used. The enclave sets `expiry = now + 600`.
Solana's `Clock::unix_timestamp` is the stake-weighted median of validator
vote timestamps, bounded to ±25% of the expected time since the epoch start
(under Alpenglow the leader sets it, never below its parent's). If it lags
real time by more than 300 s, submissions fail with `IssuedInFuture` until it
catches up: a liveness risk, never a wrong acceptance.

The enclave (`enclave/src/attester.rs`, k256) signs keccak256(`msg`) with
a recoverable ECDSA signature normalized to low-s, `v ∈ {0, 1}`.

### 8.1 FIU key binding — FROZEN

Only the secp256k1 attester key is in the Nitro attestation document. The
FIU request key (§2) is born inside the enclave too, but its public half
reaches the bank through the untrusted gateway, which could swap in its own
FIU key (and its own §3 session key) and get the statement encrypted to
itself. So at boot the attester key signs the FIU public key once:

```
msg = b"TIO-FIU-KEY-v1"                 14 B
    ‖ sha256(JCS(fiu_public_jwk))        32 B
                                       = 46 B
sig = secp256k1_sign_recoverable(keccak256(msg))  → 65 B r‖s‖v, low-s, v ∈ {0,1}
```
`fiu_public_jwk` has exactly the members `e`, `kid`, `kty` (`"RSA"`), `n`
(base64url, no padding); its JCS bytes are
`{"e":…,"kid":…,"kty":"RSA","n":…}`. `GET /v1/info` returns the JWK (as
those JCS bytes) and `fiu_key_signature_hex`. A bank (the sandbox bank,
§15) recovers the eth address from the signature and accepts the FIU key
only if that address is the `attester` of an active oracle registry entry
(§13); then it checks the FI request's FIU JWS with that key, and the entry
again, before encrypting anything. The key and its binding live for one boot, like the
attester key.

---

## 9. Wallet intent (borrower binds a session) — FROZEN

UTF-8 text, signed with the wallet's `signMessage` (Ed25519 over the raw bytes):

```
tee-income-oracle: bind session
session: <session_id>
wallet: <base58 pubkey>
policy: <policy_hash hex>
expires: <unix seconds>
```
Lines separated by `\n`, no trailing newline. The enclave rebuilds the exact
string and verifies; any difference → reject.

---

## 10. Enclave HTTP API — FROZEN (v1)

| Route | Request | Response |
|---|---|---|
| `GET /v1/info` | — | `{ app_version, attester_address, fiu_public_jwk, fiu_key_signature_hex, pinned_kids: [..] }` |
| `POST /v1/sessions` | `{ policy, wallet, consent_jws, measurement_id }` | `{ session_id, key_material, fi_request_body_b64, fi_request_jws, intent, intent_expires }` |
| `POST /v1/sessions/{id}/bind` | `{ wallet, signature_b58 }` | `{ status: "bound" }` |
| `POST /v1/sessions/{id}/evaluate` | `{ fetch_response_b64, fetch_response_jws, consent_jws }` | `{ tier, payload_hex, signature_hex, expiry }` or `{ tier: "REJECT" }` |

- Requests are JSON with exactly the members listed (unknown members →
  `bad_request`); responses carry exactly the members listed and nothing
  else (the evaluate response is built from the outcome and the signed
  payload only; scores never leave). `{id}` is a UUID; anything else →
  `session_not_found`.
- **Create.** `policy` is the lender's §6 policy object (`bad_policy`).
  `wallet` is the borrower's base58 public key (the §9 intent names it).
  `consent_jws` is the AA-signed consent (§5.3): the FI request (§5.1)
  carries its `consentId` and signature segment, so the consent must exist
  before the session; create checks its AA signature and reads the id
  (JWS codes, `bad_consent_signature`, `consent_invalid`), and evaluate
  re-checks all of it (§10.1). `measurement_id` (`0..=254`) is this
  enclave's registry id (§13), set by the gateway: the id only exists after
  registration, which needs the enclave's attester address, and a wrong id
  only fails on-chain (§13 checks 8 and 10). The **enclave** sets the
  requested range: `to` = today 00:00 UTC by its own clock (the clock
  evaluate's check 10b reads), `from` = `to` − 365 days. `KeyMaterial`
  expires at now + 24 h; `intent_expires` = now + 600 s = the session TTL.
  The oracle program id, SAS credential and schema are compiled into the
  image (`enclave/src/config.rs`), so they are part of its measurement.
- **Bind** once, with the session's wallet (`bad_request` otherwise) and an
  Ed25519 signature over the exact §9 intent (`verify_strict`).
- **Evaluate** takes the session before reading the body: unknown, expired
  or unbound → 404 / 410 / 409 without the body being read, and any
  evaluate call on a bound session uses it up, whatever the body or the
  result (single-use). `expiry` = the enclave's now + 600 s (§8).
- **Limits:** at most 256 open sessions (expired ones are swept first);
  session TTL 600 s; at most 32 create/bind requests in flight and 4
  evaluate requests in flight (reading, waiting or running), and 2
  evaluations running at once, each slot taken before any body byte is read
  and held until the request (for evaluate: the computation) ends, even if
  the client disconnects; evaluate body ≤ 8 MiB, other bodies ≤ 64 KiB;
  every body must arrive within 30 s (`body_timeout`). Every body must be a
  JSON object (a positional array is `bad_request`). Base58 values (`wallet`,
  `signature_b58`) longer than 44 / 88 characters are refused before they
  are decoded.
- **Enclave codes** (HTTP status): `bad_request` (400), `bad_intent_signature`
  (401), `session_not_found` (404), `session_not_bound`,
  `session_already_bound` (409), `body_timeout` (408), `session_expired`
  (410), `body_too_large` (413), `too_many_sessions`, `too_many_requests`,
  `too_many_evaluations` (503; a refused evaluate doesn't use the session
  up), `internal_error` (500). `tio-core` codes below are sent with 422.
- Bodies that are signed travel as base64 of the **exact bytes** (`*_b64`), so
  nothing in between can re-serialize them and break the signature.
- Errors: `{ error: { code, message } }` with stable `code` strings
  (`session_not_found`, `session_expired`, `bad_aa_signature`,
  `bad_fip_signature`, `bad_consent_signature`, `bad_key_material`,
  `invalid_point`, `bad_nonce`, `decrypt_failed`, …). Each
  signature layer has its own code, so a failure names the check that caught it.
  Messages never contain payload data.
- Key-exchange codes (`tio-core`): `bad_key_material` (unknown SPKI, wrong
  curve params, bad PEM/base64, or our key mode ≠ the peer's), `invalid_point`
  (coordinate ≥ p, off-curve, or small-order point), `bad_nonce` (not valid
  base64, or not 32 bytes), `decrypt_failed` (bad base64, shorter than the tag, or GCM tag
  mismatch; deliberately one code, so a failure reveals nothing about which
  check fired).
- JWS codes (`tio-core`): `bad_jws` (segment count, base64url, empty or
  non-empty payload segment for the form), `bad_header` (not a JSON object,
  repeated member we act on, missing `kid`, `b64`/`crit` rule, `jwk`/`jku`/`x5u`/`x5c`
  present), `bad_alg`, `unknown_kid`, `bad_signature`, `bad_pinned_key`
  (startup: pinned JWK invalid or under 2048 bits), `sign_failed`. The
  evaluate pipeline reports a `bad_signature` as the code of the layer that
  failed (`bad_aa_signature`, `bad_fip_signature`, `bad_consent_signature`).
- FI data codes (`tio-core`): `unsupported_fi_format` (the decrypted FI is
  XML, not JSON), `unsupported_currency` (`Summary.currency` is not INR),
  `bad_fi_data` (any other §1 parse-rule violation: shape,
  repeated member, not DEPOSIT, missing or invalid member, bad money or
  timestamp, too many transactions). The order is §1's reject list.
- Policy code (`tio-core`): `bad_policy` (any §6 strict-parse rule).
- Scoring codes (`tio-core`, §6.1): `window_mismatch` (a transaction's India day is outside the
  statement's `[startDate, endDate]`), `bad_fi_data` (scoring arithmetic overflow).
- Evaluate codes (`tio-core`, §10.1): `bad_fetch_response` (not an object, or not exactly one
  `FI[]` with exactly one `data[]`, §5.2), `session_mismatch` (`txnid` or `consentId` differs from
  the session's), `consent_invalid`, `window_mismatch` (requested range not inside the consent's,
  statement not inside the requested range, or the requested end after `now`),
  `window_too_short` (the requested window, or the statement itself, is shorter than
  `window.min_days`), `window_stale` (the requested window, or the statement itself, ended
  more than `window.max_age_days` before `now`),
  `bad_fip_envelope` (decrypted plaintext is not `{fi, jws}` with unescaped string members and
  base64 `fi`; any backslash in it is refused),
  `bad_fi_data_range` (session range not `0 ≤ from < to ≤ 2³² − 1`).

### 10.1 Evaluate check order — FROZEN

`tio_core::evaluate` runs these in order; the first failure wins and names
its check. Checks 1–10 run **before decryption**: a request that can't produce
a valid result never touches plaintext.

| # | Check | Code |
|---|---|---|
| 1 | AA detached JWS over the exact fetch-response bytes | JWS codes; a bad signature → `bad_aa_signature` |
| 2 | Fetch-response shape (§5.2: one `FI[]`, one `data[]`; structural `KeyMaterial` errors: a missing member or a wrong type) | `bad_fetch_response` |
| 3 | `txnid` = session's | `session_mismatch` |
| 4 | Consent compact JWS | JWS codes; a bad signature → `bad_consent_signature` |
| 5 | Consent payload parses (§5.3 members, timestamps, `from < to`) | `consent_invalid` |
| 6 | `consentId` = session's | `session_mismatch` |
| 7 | `ACTIVE`, `DEPOSIT`, `consentStart ≤ now < consentExpiry` | `consent_invalid` |
| 8 | Requested range inside the consent's `FIDataRange` | `window_mismatch` |
| 9 | `window_to − window_from < window.min_days` days (floored, §5.3) | `window_too_short` |
| 10 | `now − window_to > window.max_age_days` days | `window_stale` |
| 10b | The requested `to` (raw, not floored) is after `now` | `window_mismatch` |
| 11 | `KeyMaterial` values, key exchange, decryption (§3) | key-exchange codes |
| 12 | FIP envelope `{fi, jws}` (§5.2): string members, base64 `fi`, no escapes in the plaintext | `bad_fip_envelope` |
| 13 | FIP detached JWS over the decoded `fi` bytes | JWS codes; a bad signature → `bad_fip_signature` |
| 14 | FI parse (§1) | FI data codes |
| 15 | Statement inside the requested range by India day: `startDate ≥ day(requested from)`, `endDate ≤ day(requested to)` (§6.1 time basis). The payload window is then the statement's: `window_from = startDate`, `window_to = endDate`, each at 00:00 UTC and a `u32` (§5.3) | `window_mismatch` |
| 15b | Statement long enough: `window_to − window_from ≥ window.min_days` days (the payload length, so exactly what the pool reads; checked after 15's inside-window part) | `window_too_short` |
| 15c | Statement fresh: `now − window_to ≤ window.max_age_days` days (the statement window, as check 10 does for the requested one) | `window_stale` |
| 16 | Score (§6.1) | scoring codes |

A tier yields the §7 payload (`issued_at` = the enclave's `now`) and the §8
message; Reject yields neither. `now` is the enclave clock, which the host
can influence, so the pool re-checks `issued_at` on-chain.

---

## 11. Test vector layout — FROZEN

```
test-vectors/
  keys/                     *.test-private.* — TEST ONLY (+ *.public.jwk.json)
  personas/<persona_id>.json
  policy/default.json       JCS bytes; + default.hash (hex sha256)
  vectors/<case_id>/
    session.json            see below
    fi_request.body         exact bytes
    fi_request.jws          detached, FIU test key
    fetch_response.body     exact bytes
    fetch_response.jws      detached, AA key
    consent.jws             compact, AA key
    expected.json           { policy_hash, consent_hash, window_from, window_to, tier, features,
                              payload_hex, msg_hex }   (both null for REJECT)
  negative/<case>/          same files, one thing broken; expected.json = { error_code }
  manifest.json             { generator_version, cases: [{ id, kind, dir, persona_id, expected }] }
```

`session.json`: `{ case_id, persona_id, mode, aa_alg, enclave_key, enclave_nonce_b64,
session_id, txnid, consent_id, wallet, now_unix, key_expiry_unix, fi_data_range: { from, to },
attest: { oracle_program_id, sas_credential, sas_schema, proof_type, measurement_id, expiry_unix } }`.
`fi_data_range` is the range the enclave requested (§5.3); `consent_id` is the id in its FI
request; `wallet` and the `attest` ids are base58; `now_unix` is also the payload's `issued_at`
and `expiry_unix` the §8 message expiry. `enclave_key`
points at `keys/enclave.test-private.json`; its Curve25519 scalar is used as-is by
`SessionKeyPair::generate` (which clamps it). Positive case ids: the four personas
(`wei25519`, RS256), `rs512_aa` (AA signs the fetch response and consent with RS512) and
`x25519_mode` (§3 second mode), both on `salaried_steady`.

Positive `expected.json` (and the manifest's `expected`) also carry the §6.1 result from the
generator's independent TypeScript scorer: `tier` (`"A"`, `"B"`, `"C"` or `"REJECT"`) and
`features: { full, recent }`, each `{ months, income_median_paise, obligation_median_paise,
foir_bps, cv_bps, loans, bounces, unmatched_emi_bounces, od_days }` (paise as JSON integers,
at most 2⁵³ − 1). `tio-core/tests/vectors.rs` must reproduce them exactly.

**Hand-calculated scoring fixtures** live outside `test-vectors/` in
`test-fixtures/scoring/hand-cases.json`: small statements whose expected features were worked
out by hand from §6.1 (working in each case's `why`). They are written by people, never
generated, and both scorers replay them (`tio-core/tests/scoring_hand.rs`,
`sandbox-bank/src/scoring/hand-cases.test.ts`), which catches a mistake the two
implementations could share.

**Generated, deterministic.** `pnpm --filter @tio/sandbox-bank gen:keys` makes the RSA keys
once (it refuses to overwrite). `gen:vectors` is a pure function of the keys: nonces,
scalars, ids and persona data come from `sha256("tio-vectors/v1/<case>/<label>")`, and the
clock is fixed at `2026-09-26T10:00:00.000Z`. CI regenerates and fails on any diff.

**Layering rule.** The enclave checks layers from the outside in: AA
signature → consent → decrypt (AES-GCM tag) → FIP signature. A negative case
must break exactly **one** layer. The generator then re-applies every layer
*outside* it with valid keys, so the broken layer is the one that fails.
Without this, an outer check fires first, and the inner check is never tested.

Required negative cases:

| Case (`negative/<id>`) | How the generator builds it | Expected code |
|---|---|---|
| `fetch_response_flipped` | flip a byte of `fetch_response.body`, **don't** re-sign | `bad_aa_signature` |
| `ciphertext_flipped` | flip a byte of `encryptedFI`, then **re-sign the fetch response with the AA key** | `decrypt_failed` |
| `fi_plaintext_changed` | change the FI JSON, keep the old FIP JWS, **re-encrypt and re-sign** the fetch response | `bad_fip_signature` |
| `consent_tampered` | flip a byte of the consent payload, don't re-sign | `bad_consent_signature` |
| `consent_not_active` | validly signed consent with `status` = `REVOKED` | `consent_invalid` |
| `unpinned_aa_key` | fetch response validly signed by the rogue key (`kid` not pinned) | `unknown_kid` |
| `alg_none` / `alg_hs256` | fetch-response header algorithm swapped | `bad_alg` |
| `detached_no_crit` | `crit` removed from the fetch-response header, re-signed | `bad_header` |
| `fetch_txnid_mismatch` | fetch-response `txnid` from another session, AA-signed | `session_mismatch` |
| `consent_id_mismatch` | consent signed with another `consentId` | `session_mismatch` |
| `consent_expired` | `ACTIVE`, `consentExpiry` before `now` | `consent_invalid` |
| `consent_not_started` | `ACTIVE`, `consentStart` after `now` | `consent_invalid` |
| `window_outside_consent` | consent `FIDataRange` starts 30 days after the requested `from` | `window_mismatch` |
| `window_too_short` | requested and consent range 179 days | `window_too_short` |
| `window_stale` | range ends 8 days before `now` | `window_stale` |
| `statement_outside_window` | FI `startDate` one day before the requested `from`, FIP-signed | `window_mismatch` |
| `statement_too_short` | FI `Transactions.startDate` = `endDate` − 29 days (a 30-day statement under a full-year request; transactions before the new start dropped, as check 15 runs before scoring), FIP-signed | `window_too_short` |
| `statement_stale` | FI `Transactions.endDate` = the requested `to` date − 30 days (inside the request, long enough; the request itself is fresh); transactions after the new end dropped, FIP-signed | `window_stale` |
| `multi_fip_response` | two `FI[]` entries | `bad_fetch_response` |
| `multi_account_response` | one `FI[]` with two `data[]` items (shared `KeyMaterial`) | `bad_fetch_response` |
| `fip_envelope_malformed` | envelope `fi` not base64, re-encrypted and re-signed | `bad_fip_envelope` |
| `amount_three_decimals` | one `amount` `1234.567`, FIP-signed | `bad_fi_data` |
| `amount_negative_string` | one `amount` `"-0.50"`, FIP-signed | `bad_fi_data` |
| `fi_xml` | the FI bytes are XML, FIP-signed | `unsupported_fi_format` |
| `order_txnid_before_decrypt` | `fetch_txnid_mismatch` **and** a flipped ciphertext byte | `session_mismatch` |
| `order_stale_before_decrypt` | `window_stale` **and** a flipped ciphertext byte | `window_stale` |

The two `order_*` cases break two layers on purpose, against the layering
rule: they prove the §10.1 order (no decryption before the session and
window checks), not just the verdict.

Plus the positive RS512 case `rs512_aa`.

The generator (TypeScript) is independent of the enclave (Rust) on purpose:
two implementations that agree byte-for-byte catch derivation bugs that one
implementation testing itself would not.

---

## 12. Interop notes from real AA samples (Finvu sandbox docs, read 2026-09-26)

Finvu's published samples are inconsistent in places. We **emit** the clean
form above and **accept** these variants:

| Where | Seen | Handling |
|---|---|---|
| `KeyMaterial` labels | `cryptoAlg: null, curve: "ECDH", params: "Curve25519"` | Ignore labels; detect by `KeyValue` OID |
| `KeyValue` PEM | Armour and base64 with no newlines | Strip armour and whitespace, then base64-decode |
| Request `timestamp` | epoch-millis number (`1586430349059`) in one sample, ISO string elsewhere | Emit ISO string; accept both on input |
| Response timestamps | `2020-04-09T11:05:49.059+0000` | Accept `+0000`. FI timestamps: `YYYY-MM-DD'T'HH:MM:SS[.1–9 digits][Z\|±HH:MM\|±HHMM]`, uppercase `T`/`Z`; an offset such as `+05:30` is converted to UTC; no zone = UTC; the fraction is truncated |
| `FIDataRange.from/to` | `2018-10-31T04:10:12.898` (no zone) | ReBIT AA API 2.0.0 / 2.1.0 type these (and `consentStart`, `consentExpiry`, `timestamp`) as `string`, `format: date-time` (RFC 3339: zone required; every spec example uses `Z`), so the zone-less sample breaks the spec. We emit `Z` and treat a zone-less value as UTC. Statement dates (`startDate`, `endDate`: `xs:date`, usually zone-less) are read as India dates for scoring (§6.1). **OPEN** only for live Finvu: confirm their FI dates are IST |
| `valueDate` | full datetime in Finvu sample, `xs:date` in XSD | Accept both; use the date part |
| FI `type` | `DEPOSIT` (XSD fixes `deposit`) | Case-insensitive |
| FI `version` | `1.1` in Finvu sample | Record, don't reject |
| `amount` | JSON number; balances as strings | Accept number or string, parse to paise without floats |
| Decrypted FI format | Finvu sample shows JSON | **OPEN:** some FIPs may send XML. MVP is JSON-only; XML → reject with `unsupported_fi_format` |


---

## 13. Oracle accounts (registry) — FROZEN

Program `oracle`, id `HZyMtqfwXMbqDUwWe9GVSvfZTaXaJZuKAMtJ1i6xwNG8`. Borsh,
little-endian, each account starts with Anchor's 8-byte discriminator. Account
`version` is `1` (§0.1).

**`Config`**, PDA `["config"]`, one per program:

| Field | Type | Meaning |
|---|---|---|
| `version` | u8 | `1` |
| `bump` | u8 | PDA bump |
| `admin` | Pubkey | registers and revokes enclave builds; never the all-zero address |
| `pending_admin` | Option\<Pubkey\> (1-byte tag + 32) | proposed next admin, `None` unless a change is in progress |
| `next_measurement_id` | u8 | id the next registration gets. Only increases; `255` is never assigned (max 255 entries) |

**`EnclaveEntry`**, PDA `["enclave", [measurement_id]]` (one byte):

| Field | Type | Meaning |
|---|---|---|
| `version` | u8 | `1` |
| `bump` | u8 | PDA bump |
| `measurement_id` | u8 | equals the PDA seed; the payload's `measurement_id` (§7) |
| `measurement_kind` | u8 | `1` = Oyster image id, `2` = AWS PCR0 hash. Same numbers as `proof_type` (§7) |
| `measurement` | [u8; 32] | the platform measurement; never all zeros |
| `attester` | [u8; 20] | Ethereum-style address of the enclave's secp256k1 key (what the precompile recovers); never all zeros |
| `attestation_doc_hash` | [u8; 32] | SHA-256 of the attestation document checked off-chain; never all zeros |
| `registered_at` | i64 | unix seconds, Solana clock |
| `revoked_at` | i64 | `0` = active, else unix seconds of the revoke. The only "active" flag |

**Instructions:**

| Instruction | Signer | Effect | Errors |
|---|---|---|---|
| `initialize(admin)` | the program's upgrade authority | creates `Config` with `admin`, counter `0` | account already in use (system 0), `ProgramDataMismatch` (6007), `NotUpgradeAuthority` (6000), `ZeroAdmin` (6008) |
| `register_enclave(kind, measurement, attester, attestation_doc_hash)` | `admin` | creates the entry at `next_measurement_id`, then increments it; event `EnclaveRegistered` | entry not the PDA of `next_measurement_id` (2006; e.g. two registrations built from the same counter, the second fails), `NotAdmin` (6001), `UnknownMeasurementKind` (6002), `ZeroMeasurement` (6003), `ZeroAttester` (6004), `ZeroAttestationDocHash` (6009), `RegistryFull` (6005) |
| `revoke_enclave(measurement_id)` | `admin` | sets `revoked_at`; event `EnclaveRevoked`. One-way | account not initialized (3012), `NotAdmin` (6001), entry not the PDA of `measurement_id` (2006), `AlreadyRevoked` (6006) |
| `propose_admin(new_admin)` | `admin` | sets `pending_admin` (replacing any earlier proposal); event `AdminProposed` | `NotAdmin` (6001), `ZeroAdmin` (6008) |
| `accept_admin()` | the pending admin | `admin` = signer, `pending_admin` = `None`; event `AdminChanged` | `NotPendingAdmin` (6010; also when nothing is pending) |
| `submit_attestation()` | anyone (the relayer pays) | checks the enclave signature and writes the §7 payload to SAS as `sas_signer`; replaces an older attestation for the same wallet; event `AttestationSubmitted` | see below |

Errors are listed in check order. Anchor loads accounts and creates `init`
accounts before it checks other constraints, so "already in use" and "not
initialized" come first; a failed later check still aborts the whole
transaction. An enclave restart gets a new attester key, so it is registered
as a new entry and the old one is revoked.

**`submit_attestation`.** No instruction arguments: every value comes from
the §8 message inside the secp256k1 precompile instruction right before it
(§8 layout), so the bytes checked are the bytes signed.

Accounts: `payer` (signer, w; pays rent, receives the refund on refresh),
`sas_signer` (PDA `["sas_signer"]`, no data), `credential`, `schema`,
`attestation` (w), `enclave_entry`, `instructions` (the instructions sysvar),
`sas_event_authority` (PDA `["__event_authority"]` under SAS), `sas_program`,
`system_program`.

Check order:

| # | Check | Error |
|---|---|---|
| — | Anchor: entry not initialized; `sas_signer` / event authority not the PDA; wrong sysvar / SAS program | 3012; 2006; 2012 |
| 1 | instruction at current − 1 is the secp256k1 precompile (and current isn't 0) | `PrecompileNotFound` (6011) |
| 2 | precompile data is exactly the §8 layout for its own index | `InvalidPrecompileLayout` (6012) |
| 3 | message starts with `TIO-ATTEST-v1` | `WrongDomainTag` (6013) |
| 4 | message program id = this program | `WrongProgramId` (6014) |
| 5 | `credential` = message credential | `CredentialMismatch` (6015) |
| 6 | `schema` = message schema | `SchemaMismatch` (6016) |
| 7 | `attestation` = SAS PDA of (credential, schema, wallet), checked before it is read | `AttestationAddressMismatch` (6017) |
| 8 | `enclave_entry.measurement_id` = payload `measurement_id` | `EnclaveEntryMismatch` (6018) |
| 9 | entry active | `EnclaveRevoked` (6019) |
| 10 | precompile eth address = `entry.attester` | `AttesterMismatch` (6020) |
| 11 | payload `proof_type` = `entry.measurement_kind` | `ProofTypeMismatch` (6021) |
| 12 | tier ∈ {1, 2, 3} | `InvalidTier` (6022) |
| 13 | `issued_at ≤ now + 300` | `IssuedInFuture` (6023) |
| 14 | `now ≤ expiry` | `SignatureExpired` (6024) |
| 15 | `0 < expiry − issued_at ≤ 600` | `ExpiryTooFar` (6025) |
| 16 | existing account (non-empty) is a SAS attestation: owner SAS, 256 B, discriminator 2 | `InvalidExistingAttestation` (6027) |
| 17 | new `issued_at` > stored `issued_at` | `StaleAttestation` (6026) |

Then, for an existing attestation, CPI SAS `close_attestation`, and CPI SAS
`create_attestation` (nonce = wallet, data = payload, expiry =
`issued_at + 30 days`, §7). A bad signature fails in the precompile before
the oracle runs (precompile error `2`, InvalidSignature).

**Replay and refresh.** Strictly increasing `issued_at` per wallet stops an
exact replay and stops an older, still-unexpired signature from replacing a
newer tier. Refreshing is close + create inside one instruction.

Event `AttestationSubmitted { subject, measurement_id, tier, issued_at,
refreshed }`. Measured on surfpool: 17,575 CU to create, 22,968 to refresh;
the transaction (compute-budget ix + precompile + submit) is 882 bytes.

**Id budget.** Ids are never reused, so every registration (each enclave
restart or image update) spends one of the 255 for the life of this
deployment. Running out needs a migration: a new payload version with a
wider `measurement_id` (§7, so a new SAS schema version), a new registry
layout, and pools moving to the new schema. Fine for the hackathon; revisit
before a long-running deployment.

**Admin.** The two-step change lets a lost or compromised admin key be
replaced without redeploying, as long as the current admin can still sign.
Beyond the demo, `admin` should be a multisig (e.g. a Squads vault); if the
admin key itself is lost, the only way out is a program upgrade, so keep the
program upgradeable (and its upgrade authority safe) until then.

---

## 14. Demo pool accounts — FROZEN

Program `demo_pool`, id `DvDkXcQFJAvCvrMfoujKu2BWfWqVYRmL8WW9hpMgW8KC`. Borsh,
little-endian, each account starts with Anchor's 8-byte discriminator. Account
`version` is `1` (§0.1). A minimal lender that shows how a program reads the
§7 attestation inside its own instruction (no CPI). It lends classic SPL
Token mints only.

**`Pool`**, PDA `["pool", admin, [pool_id]]`, 240 bytes. One per lender and
`pool_id`; the admin is a seed, so nobody can take another lender's address:

| Field | Type | Meaning |
|---|---|---|
| `version` | u8 | `1` |
| `bump` | u8 | PDA bump |
| `vault_bump` | u8 | bump of the vault PDA |
| `pool_id` | u8 | seed; lets one admin run several pools |
| `admin` | Pubkey | the creator; the only key that may `update_pool` |
| `mint` | Pubkey | the lent token; never changes |
| `credential`, `schema` | Pubkey ×2 | SAS accounts whose attestations the pool accepts (§0.1: a pool pins the schema version it reads); never change |
| `params.policy_hash` | [u8; 32] | scoring policy the pool requires (§6) |
| `params.tier_limits` | [u64; 3] | largest principal for tier A, B, C in the mint's base units; `0` = the pool doesn't lend to that tier. `A > 0` and `A ≥ B ≥ C` |
| `params.max_age_secs` | u32 | oldest attestation: `now − issued_at` |
| `params.max_window_age_secs` | u32 | oldest statement: `issued_at − window_to` |
| `params.min_window_secs` | u32 | shortest statement: `window_to − window_from` |
| `params.approved_measurements` | [u8; 32] | enclave builds the pool trusts: bit `id` set = registry entry `id` approved (byte `id / 8`, bit `id % 8` from the least significant) |

`params` (`PoolParams`, 100 bytes) is everything `update_pool` replaces.

**`Loan`**, PDA `["loan", pool, borrower]`, 131 bytes. Exists while the loan is
open, so a borrower has at most one per pool:

| Field | Type | Meaning |
|---|---|---|
| `version` | u8 | `1` |
| `bump` | u8 | PDA bump |
| `tier` | u8 | tier of the attestation used (1 = A, 2 = B, 3 = C) |
| `pool`, `borrower` | Pubkey ×2 | the seeds |
| `rent_payer` | Pubkey | who paid this account's rent; `repay` refunds it there |
| `amount` | u64 | principal, base units |
| `borrowed_at` | i64 | unix seconds, Solana clock |
| `attestation_issued_at` | i64 | `issued_at` of the attestation used |

**Vault**: an SPL token account at PDA `["vault", pool]`, mint = `pool.mint`,
authority = the `Pool` PDA, so only `borrow` can move tokens out. It is
funded with a plain token transfer; there is no deposit or withdraw
instruction.

**Instructions:**

| Instruction | Signers | Effect | Errors |
|---|---|---|---|
| `create_pool(pool_id, credential, schema, params)` | `admin` (pays) | creates `Pool` and the vault; event `PoolCreated` | account already in use (system 0), pool or vault not the PDA (2006), `InvalidTierLimits` (6001) |
| `update_pool(params)` | `admin` | replaces `params`; event `PoolUpdated` | pool not initialized (3012), `NotAdmin` (6000), `InvalidTierLimits` (6001) |
| `borrow(amount)` | `payer`, `borrower` | checks below, then sends `amount` from the vault to the borrower's token account and creates `Loan`; event `Borrowed` | see below |
| `repay()` | `borrower` | sends `loan.amount` from the borrower's token account to the vault and closes `Loan` to `rent_payer`; event `Repaid` | loan not initialized (3012; no open loan), `mint` not the pool's (2001), vault or loan not the PDA (2006), token account of another mint / owner (2014 / 2015), `rent_payer` not the stored one (2001), SPL Token insufficient funds (`1`) |

`credential` and `schema` are not checked to be SAS accounts at `create_pool`:
`borrow` derives the attestation address from them and only SAS can own that
address, so a wrong value gives a pool that never lends.

**`borrow`.** Accounts: `payer` (signer, w; pays the `Loan` rent, may be a
relayer), `borrower` (signer), `pool`, `mint`, `vault` (w), `borrower_token`
(w; any token account of `mint` owned by `borrower`, created by the client),
`loan` (w, created here), `attestation` (the SAS PDA
`["attestation", pool.credential, pool.schema, borrower]`, §7),
`enclave_entry` (the oracle's `EnclaveEntry` for the payload's
`measurement_id`, §13), `token_program`, `system_program`.

The borrower must sign and the attestation address is derived from that
key, so a wallet can only borrow on its own attestation.

Check order:

| # | Check | Error |
|---|---|---|
| — | Anchor: account not initialized / owned by another program / wrong type; `borrower` or `payer` not a signer; open loan (`loan` exists); `pool`, `vault`, `loan`, `attestation` not the PDA; `mint` not the pool's; token account of another mint / owner | 3012 / 3007 / 3002; 3010; system 0; 2006; 2001; 2014 / 2015 |
| 1 | `amount > 0` | `ZeroAmount` (6002) |
| 2 | attestation: owner = SAS, 256 bytes, discriminator 2 (also fails when there is no attestation) | `InvalidAttestation` (6003) |
| 3 | stored `signer` = the oracle's PDA `["sas_signer"]` | `WrongAttestationSigner` (6004) |
| 4 | `now < expiry`; an `expiry` of `0` is rejected | `AttestationExpired` (6005) |
| 5 | tier ∈ {1, 2, 3} and its limit > 0 | `TierNotAccepted` (6006) |
| 6 | `amount ≤` the tier's limit | `AmountOverTierLimit` (6007) |
| 7 | payload `policy_hash` = `params.policy_hash` | `PolicyMismatch` (6008) |
| 8 | `now − issued_at ≤ max_age_secs` | `AttestationTooOld` (6009) |
| 9 | `issued_at − window_to ≤ max_window_age_secs` | `WindowTooOld` (6010) |
| 10 | `window_to − window_from ≥ min_window_secs`; a window that ends before it starts fails | `WindowTooShort` (6011) |
| 11 | bit `measurement_id` set in `approved_measurements` | `MeasurementNotApproved` (6012) |
| 12 | `enclave_entry.measurement_id` = payload `measurement_id` | `EnclaveEntryMismatch` (6013) |
| 13 | `enclave_entry.revoked_at == 0` | `EnclaveRevoked` (6014) |

Then the token transfer (a vault short of funds fails in the SPL Token
program with `1`) and the `Loan` account. An open loan is reported by the
system program (`0`, "already in use") when Anchor creates `loan`.

Why each group is there:
- **2–3, the attestation is the oracle's.** SAS lets anyone create
  attestations under their own credential, and a credential's authority can
  add signers. Only the oracle's PDA signs after checking an enclave
  signature (§13), so the pool pins the credential and schema through the
  address and then requires that signer.
- **4, 8–10, freshness.** SAS expiry is `issued_at + 30 days` (§7); the pool's
  own limits can be tighter and also cover the statement window, which stops
  a borrower from reusing an old result or one scored on an old or short
  statement. Arithmetic that overflows fails the rule. An `issued_at` ahead
  of the cluster clock (at most 300 s, §8) passes the age rule.
- **7, the lender's rules.** A tier only means something under the policy
  that produced it.
- **11–13, the enclave build.** The pool approves builds itself (it doesn't
  have to trust every future registration), and the registry can revoke one.
  Revoking an entry stops lending on every attestation it produced;
  borrowers attest again with the new build. Open loans are not affected.

**Not checked, on purpose:**
- Stored `nonce`, `credential`, `schema`: implied by the attestation address,
  because SAS only creates an attestation at the PDA of those three values.
- The stored data length: fixed by the 256-byte account size.
- `proof_type`: the oracle checked it against the registry entry (§13).
- `consent_hash`, `token_account`: not used by a lender.
- The SAS schema's "paused" flag: it stops new attestations, not reads.
- The mint's `freeze_authority`: the pool accepts any classic SPL Token
  mint. Whoever holds a freeze authority can freeze the vault or a
  borrower's token account; `repay` then fails and that loan stays open. No
  tokens can be taken. A lender picks a mint whose freeze authority it
  trusts.

**Limits of the demo.** Principal only: no interest, tenor, liquidation or
withdrawal of vault funds. No admin change, pause or close.

**Cost**, measured on surfpool: `borrow` 23,690 CU in a 526-byte transaction,
`repay` 13,204 CU in 419 bytes (each with one compute-budget instruction).
Both derive PDAs on chain, so the exact number varies with the addresses.

**Token program.** The pool uses the classic SPL Token account types. Moving
to Anchor's `token_interface` types (Token and Token-2022) later is a code
change only: `Pool` and `Loan` store just the mint and the vault address,
and existing vaults stay valid. Token-2022 mints need an explicit decision
per extension first (transfer fee, transfer hook, permanent delegate,
default frozen state).

---

## 15. Sandbox bank HTTP API — FROZEN (demo)

The live mock FIP + AA (`sandbox-bank`, `node src/service/main.ts`). It
speaks ReBIT where ReBIT defines the call (§5) and adds one route,
`/fiu-keys`, that stands in for the Sahamati Central Registry lookup of an
FIU's key. Bodies are JSON (`ver` = §5's version string), at most 64 KiB
(413), read once as exact bytes. Every success reply carries
`x-jws-signature` = the AA's detached JWS (§4) over its exact bytes.

**Deployment invariant.** The bank is reachable only from the gateway
(private network / internal ingress); the gateway is its only client and
owns rate limiting. Two routes need no authentication (`/fiu-keys`,
`/Consent`), and their caps below are sized for that: they bound memory and
RPC cost, not request rate. Exposing the bank publicly breaks this.

| Route | Request | Reply |
|---|---|---|
| `POST /fiu-keys` | `{ fiu_public_jwk, fiu_key_signature_hex }` (`GET /v1/info`'s values, §8.1) | `{ kid, attester: "0x…" }` |
| `POST /Consent` | `{ persona_id }` (`salaried_steady`, `trader_lumpy`, `declining`, `stressed`) | `{ ver, timestamp, consentId, signedConsent }` |
| `POST /FI/request` | §5.1 body, header `x-jws-signature` (FIU detached JWS) | `{ ver, timestamp, txnid, consentId, sessionId }` |
| `POST /FI/fetch` | `{ ver, timestamp, txnid, sessionId }` (ReBIT AA 2.0 shape) | the §5.2 fetch response, AA-signed |
| `GET /health` | — | `{ status: "ok" }` |

- **`/fiu-keys`**: JWK exactly `e, kid, kty: "RSA", n`, RSA ≥ 2048 bits;
  signature 130 hex characters, `v ∈ {0, 1}`, low-s (else `InvalidKey`).
  The recovered address must be the `attester` of an active registry entry
  (`Unauthorized`; registry unreadable → `ServiceUnavailable`). The gateway
  calls it once per enclave boot. The bank keeps the newest 16 keys by `kid`.
- **`/Consent`**: the §5.3 consent, AA-signed (RS256), `status ACTIVE`,
  `fetchType ONETIME`, `consentStart` = now − 60 s, `consentExpiry` = now +
  24 h, `FIDataRange` = [today 00:00 UTC − 366 d, today 00:00 UTC + 1 d]
  (the enclave requests [today − 365 d, today]; the spare day on each side
  covers a session that crosses UTC midnight). Approval by the borrower is
  implied (demo). At most 1024 consents are kept; when full, the oldest
  **unused** one is dropped (a flood can only make a borrower ask again).
- **`/FI/request`** checks, in order: FIU JWS (`kid` registered via
  `/fiu-keys`, signature over the raw bytes; before any RPC read) →
  `SignatureDoesNotMatch`; the key's attester still active →
  `Unauthorized` / `ServiceUnavailable`; body shape → `InvalidRequest`;
  consent known → `InvalidConsentId`, not expired → `InvalidConsentStatus`,
  unused → `InvalidConsentUse`, `Consent.digitalSignature` = the issued
  signature segment → `InvalidConsentDetail`; `FIDataRange` valid §12
  date-times, `from < to`, inside the consent's range → `InvalidDateRange`;
  `KeyMaterial` (§3) → `InvalidKey`. Only then is the consent marked used
  (a refused request never uses it up) and the statement encrypted (§3,
  §5.2: FIP envelope, one `FI[]`, one `data[]`). The persona's statement
  ends on the requested `to` day (or today, if `to` is later), so it lies
  inside the requested window across UTC midnight.
- **`/FI/fetch`**: not FIU-signed (the data is encrypted to the enclave).
  Unknown or expired session (600 s, the enclave's TTL) → `InvalidSessionId`;
  `txnid` ≠ the session's → `InvalidRequest`; second fetch → `DataGone`. At
  most 256 sessions.
- **Registry reads** (§13): `Config`, then every `EnclaveEntry` PDA below
  `next_measurement_id` (`getMultipleAccounts`, batches of 100; account
  `version` must be 1 and `measurement_id` its PDA seed). One snapshot at
  most every 5 s (concurrent misses share one read), each read timed out at
  5 s; a positive answer is cached 30 s per attester, so a revoke takes
  effect within 35 s. A failed read is never cached and never "active".
- **Errors**: ReBIT `ErrorResponse` `{ ver, txnid, timestamp, errorCode,
  errorMsg }`; `txnid` is the request's when its body was read, else `""`;
  `errorMsg` is fixed per code and never repeats request data.

| `errorCode` | HTTP |
|---|---|
| `InvalidRequest`, `SignatureDoesNotMatch`, `InvalidKey`, `InvalidDateRange`, `InvalidConsentId`, `InvalidConsentStatus`, `InvalidConsentDetail`, `InvalidConsentUse`, `InvalidSessionId` | 400 |
| `InvalidRequest` (unknown route) | 404 |
| `InvalidRequest` (body over 64 KiB) | 413 |
| `Unauthorized` | 401 |
| `DataGone` | 410 |
| `InternalError` | 500 |
| `ServiceUnavailable` (registry unreadable, store full) | 503 |

**Keys and config** (environment): `SANDBOX_AA_PRIVATE_JWK`,
`SANDBOX_FIP_PRIVATE_JWK` (the §2 demo keys, JSON text), `SOLANA_RPC_URL`,
`ORACLE_PROGRAM_ID` (default the §13 id), `PORT` (8081), `PINNED_DIR`
(default `enclave/pinned/`). The bank refuses to start if a key is flagged
`private_key_test_only`, is under 2048 bits, or its public half (`e, kid,
kty, n`) differs from the pinned file the enclave compiles in.

---

## 16. Gateway HTTP API — FROZEN (demo)

The gateway (`gateway/`, `node src/main.ts`) is the web's only server. It is
**untrusted** (ARCHITECTURE §2): it carries the enclave's signed FI request
and the AA-signed fetch response as exact bytes, relays the enclave's signed
result on chain and pays the fees. It can delay or drop a session; it can't
read bank data or forge a tier.

| Route | Request | Reply |
|---|---|---|
| `POST /v1/sessions` | `{ wallet, persona_id }` | `{ session_id, intent, intent_expires }` |
| `POST /v1/sessions/{id}/complete` | `{ signature_b58 }` | `text/event-stream` (below) |
| `GET /v1/info` | — | `{ cluster, oracle_program, credential, schema, measurement_id, policy_hash, attester_address }` |
| `GET /health` | — | `{ status: "ok" }` |

- **Bodies** are JSON objects with exactly the members listed (unknown
  members, wrong types, not JSON → `bad_request`), at most 4 KiB
  (`body_too_large`, 413). `wallet`: base58, 32–44 characters.
  `persona_id`: `salaried_steady`, `trader_lumpy`, `declining` or
  `stressed` (the §15 personas). `signature_b58`: base58, at most 88
  characters, the wallet's Ed25519 `signMessage` over the exact `intent`
  string (§9).
- **Create** checks the enclave's FIU key first (below), asks the bank for an
  AA-signed consent for the persona (§15 `/Consent`), and opens an enclave
  session with the configured policy, the wallet, that consent and the
  configured `measurement_id` (§10). `intent` / `intent_expires` are the
  enclave's.
- **Complete** checks the body, then takes the session (single use: any
  complete after that answers `session_not_found`). Errors up to this point
  are JSON with their HTTP status. Then the reply is `200 text/event-stream`:

  | Event | Data |
  |---|---|
  | `stage` | `{"stage": "bind" \| "fi_request" \| "fi_fetch" \| "evaluate" \| "submit"}`, sent as each stage starts, in this order |
  | `result` | `{"tier": "A" \| "B" \| "C", "tx", "attestation", "expiry", "payload_hex"}` or `{"tier": "REJECT"}` (no `submit` stage) |
  | `error` | `{"code", "message", "stage"}`; ends the stream, no `result` |

  `tx` is the relayer's own transaction signature, or `null` when the
  attestation already held exactly this payload from an earlier transaction
  (the gateway never guesses a signature from the account's history).
  `attestation` is the SAS attestation address (§7), `expiry` the §8 message
  expiry, `payload_hex` the 83-byte §7 payload. A `: keep-alive` comment is
  sent every 15 s so proxies don't close a quiet stream. A client that
  disconnects doesn't stop the flow: the attestation may still land.
- **Stages.** `bind`: enclave `/bind` (§10). `fi_request`: the enclave's
  `fi_request_body_b64` bytes and `fi_request_jws`, sent to the bank
  verbatim. `fi_fetch`: bank `/FI/fetch` with the ack's `txnid` and
  `sessionId`. `evaluate`: enclave `/evaluate` with base64 of the exact
  fetched bytes, their JWS and the consent. `submit`: one v0 transaction
  `[SetComputeUnitLimit(60 000), secp256k1 precompile (index 1, §8 layout),
  oracle.submit_attestation]` paid by the relayer (§13).
- **Relay retry rules.** The oracle needs a strictly newer `issued_at` per
  wallet (§13 check 17), so one result can never land twice and re-signing is
  safe. After a failed send: a signature of ours that is `confirmed` or
  `finalized` without error → success (`processed` or an unknown status
  doesn't count); else the attestation already holds this payload →
  success, `tx: null`; else `StaleAttestation` (6026) → `stale_attestation`;
  else `EnclaveRevoked` (6019, revoked after the registry read) →
  `enclave_revoked`;
  else an expired blockhash → one re-sign with a fresh blockhash; else
  `tx_failed`.
- **Errors**: `{ error: { code, message, stage } }`, `stage` ∈ `gateway`,
  `bank`, `enclave`, `chain`. Enclave codes (§10) and ReBIT `errorCode`s
  (§15) pass through unchanged with their stage; an upstream 4xx keeps its
  status, a 5xx answers 502. An upstream code must match
  `^[A-Za-z][A-Za-z0-9_]{0,63}$`, else the reply is `upstream_unavailable`
  (it's logged and returned, so an untrusted upstream can't inject text).
  `message` is a fixed string per gateway code and one generic string for any
  upstream code; it never carries upstream or request text.

| Code | HTTP | Stage |
|---|---|---|
| `bad_request` | 400 | gateway |
| `not_found` (unknown route), `session_not_found` | 404 | gateway |
| `session_expired` | 410 | gateway |
| `body_too_large` | 413 | gateway |
| `rate_limited` | 429 | gateway |
| `internal_error` (any unexpected exception, no detail) | 500 | gateway |
| `too_many_sessions` | 503 | gateway |
| `upstream_unavailable` (network error, 30 s timeout, redirect, reply not JSON / wrong shape / over 64 KiB, fetch reply over 6 MiB, missing `x-jws-signature`) | 502 | bank or enclave |
| `enclave_rotated` (the enclave's attester differs from the one at boot) | 503 | enclave |
| `stale_attestation` | 409 | chain |
| `tx_failed` (any other chain failure, incl. an RPC timeout) | 502 | chain |
| `enclave_not_registered`, `enclave_revoked`, `attester_mismatch` (boot check; the first two also before every submit, which re-reads the registry entry; `enclave_revoked` also when the send fails with 6019) | 503 | chain |

- **Limits.** At most 256 open sessions, TTL 600 s (= the enclave's
  `intent_expires`), single use. Create only is rate-limited: a token bucket
  per client IP (burst 5, 10 per minute) and a global one (burst 20, 60 per
  minute); a request needs a token from both. The client IP is the socket
  address, or with `TRUST_PROXY=1` the **last** `X-Forwarded-For` hop: the one
  our single trusted proxy (the Azure ingress) appended. Earlier hops are
  client-written. Another proxy in front (a CDN) would need a different rule.
  RPC calls time out after 15 s, a send + confirm after 100 s.
- **FIU key.** At boot and before every create the gateway reads the
  enclave's `/v1/info`. A new `kid` (enclave restart) is registered with the
  bank (§15 `/fiu-keys`); a bank `SignatureDoesNotMatch` on `/FI/request`
  forces a re-registration on the next create. A different attester means a
  new registry entry, which needs a new `MEASUREMENT_ID`: `enclave_rotated`
  until the gateway restarts.
- **Boot** (any failure exits 1 before listening): config → enclave
  `/v1/info` → `EnclaveEntry[MEASUREMENT_ID]` exists, is active and holds the
  enclave's attester → FIU key registered with the bank → relayer balance
  (warning below 0.05 SOL) → listen.
- **Config** (environment, a `ConfigError` names the variable and never
  echoes a secret): `ENCLAVE_URL`, `BANK_URL`, `SOLANA_RPC_URL` (http(s)),
  `SOLANA_WS_URL` (ws(s); default the RPC URL as ws(s), port 8899 → 8900),
  `CLUSTER` (reads `deployments/<cluster>.json`; its program ids must equal
  the compiled-in ones), `MEASUREMENT_ID` (0–254), `POLICY_PATH` (default
  `test-vectors/policy/default.json`; the file must be exact JCS with no
  trailing newline, so `policy_hash` = sha256 of its bytes = the §6 hash the
  enclave puts in the payload), `RELAYER_KEYPAIR` (Solana CLI keypair JSON),
  `ALLOWED_ORIGIN` (one exact web origin for CORS, never `*`),
  `TRUST_PROXY` (`1` or unset), `PORT` (8082).
- **Deployment invariant.** The gateway is the bank's only client (§15) and
  the only caller that should drive the enclave; it is the public endpoint
  and owns rate limiting.
