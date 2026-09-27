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

Three personas, fixed: `salaried_steady` → A, `trader_lumpy` → B,
`stressed` → C or Reject (decide when the policy is final). 6–12 months of
transactions each.

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
- an optional root wrapper `Account` / `account`;
- element keys in any case (`Transactions` / `transactions`) — Setu-style
  lowercase JSON exists in the ecosystem;
- `Holder` and `Transaction` as object **or** array;
- `type` case-insensitive (`DEPOSIT` / `deposit`);
- money as JSON number **or** string. Parse from the raw JSON text into
  integer **paise** (`i64`); never through `f64`. More than 2 decimals → reject.

Reject: unknown enum values, missing required fields the scorer uses
(`type`, `mode`, `amount`, `currentBalance`, `transactionTimestamp`),
more than 20,000 transactions.

---

## 2. Keys and pinned keys — FROZEN

| Key | Format | Location |
|---|---|---|
| FIP signing key (test) | RSA-2048 JWK, `kid` UUIDv4 | private: `test-vectors/keys/fip.test-private.jwk.json` |
| AA signing key (test) | RSA-2048 JWK, `kid` UUIDv4 | private: `test-vectors/keys/aa.test-private.jwk.json` |
| Pinned public keys | RSA public JWK (`kty`,`n`,`e`,`kid`) | `enclave/pinned/*.jwk.json`, compiled in with `include_bytes!` |
| FIU request key | RSA-2048, generated in the enclave at boot | public JWK exposed by `GET /v1/info` |
| Enclave attester key | secp256k1, provided by Oyster at `/app/ecdsa.sec` | eth address exposed by `GET /v1/info` |
| Test enclave keys | Curve25519 scalar (used in both §3 modes) + secp256k1, fixed | `test-vectors/keys/enclave.test-private.json` |

### Two key sets: committed test keys vs secret demo keys

| Key set | Committed? | Used by | Pinned in a deployed enclave? |
|---|---|---|---|
| **Test-vector keys** (`test-vectors/keys/*.test-private.*`, golden-vector keys flagged `private_key_test_only`) | **Yes**, on purpose, so anyone can reproduce the vectors | offline unit tests only | **Never** |
| **Demo sandbox-bank keys** (FIP + AA signing keys for the running sandbox bank) | **Never.** Private halves live only in `sandbox-bank`'s `.env` / secret store | the live sandbox bank | Public halves only, in `enclave/pinned/` |

Why two sets: a committed private key is public. If the deployed enclave
pinned a committed key, anyone could forge "signed bank data" and the enclave
would attest to it. That defeats the provenance claim (G1).

Rules:
- A test key is generated only for tests and never reused anywhere else.
- `enclave/pinned/` holds **only** demo (or, later, real FIP/AA) public keys.
  Test-vector public keys stay in `test-vectors/` and reach unit tests as
  inputs.
- **Startup guard:** the enclave keeps a compiled-in deny-list of every
  test-key `kid` and SPKI hash from `test-vectors/`. At boot it refuses to
  start (exit non-zero, `test_key_pinned`) if any pinned key matches.
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
- Field arithmetic here touches only public values (points, not `d`), so it
  doesn't need to be constant-time. The secret-dependent step is inside
  `x25519-dalek`.

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

We **sign** with RS256 only. We **verify** RS256 and RS512 (Finvu's sample
header decodes to RS512).

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

**FIP signature (our sandbox; OPEN (a) for real FIPs):** the plaintext inside
`encryptedFI` is a JSON envelope:

```json
{ "fi": "<base64 of the FI JSON bytes>", "jws": "<detached JWS by the FIP key over those bytes>" }
```

The enclave checks the FIP JWS over the decoded `fi` bytes. If real FIPs turn
out not to sign, this envelope becomes optional and step 6 of the evaluate
pipeline is skipped for them.

### 5.3 Consent artefact — compact JWS by the AA key

Payload (subset we rely on):
```json
{ "consentId": "<uuid>", "status": "ACTIVE", "consentStart": "...", "consentExpiry": "...",
  "consentMode": "VIEW", "fetchType": "ONETIME", "consentTypes": ["TRANSACTIONS"],
  "fiTypes": ["DEPOSIT"], "FIDataRange": { "from": "...", "to": "..." },
  "DataLife": { "unit": "DAY", "value": 0 } }
```
- `window_from` / `window_to` come from `FIDataRange` (floor to UTC day, `u32` unix seconds).
- `consent_hash = sha256(ASCII bytes of the whole compact JWS string)`.

---

## 6. Scoring policy — FROZEN (format), OPEN (threshold values)

Canonical JSON (JCS). `policy_hash = sha256(JCS(policy))`.

```json
{
  "v": 1,
  "recurrence": { "amount_tol_bps": 1000, "day_tol": 5, "min_occurrences": 3 },
  "tiers": [
    { "tier": "A", "foir_max_bps": 4000, "cv_max_bps": 1500, "bounces_max": 0 },
    { "tier": "B", "foir_max_bps": 5500, "cv_max_bps": 3000, "bounces_max": 1 },
    { "tier": "C", "foir_max_bps": 7000, "cv_max_bps": 3000, "bounces_max": 3 }
  ],
  "reject_if": { "od_days_min": 30 }
}
```
- Integers only (basis points, days, counts). Tiers are evaluated in order; first match wins; else Reject.
- Unknown keys → reject the policy (no silent ignore).

---

## 7. Attestation payload — FROZEN

83 bytes, little-endian. Stored as SAS attestation `data`.

| Offset | Size | Field | Type | Values |
|---|---|---|---|---|
| 0 | 1 | `tier` | u8 | 1=A, 2=B, 3=C. Reject is never written |
| 1 | 1 | `proof_type` | u8 | 1 = `tee_nitro_oyster` |
| 2 | 1 | `measurement_id` | u8 | index into the oracle registry |
| 3 | 32 | `policy_hash` | bytes | section 6 |
| 35 | 32 | `consent_hash` | bytes | section 5.3 |
| 67 | 8 | `issued_at` | i64 | unix seconds, enclave clock (checked on-chain) |
| 75 | 4 | `window_from` | u32 | unix seconds |
| 79 | 4 | `window_to` | u32 | unix seconds |

SAS schema layout (SAS has no fixed-size arrays; each 32-byte hash is two U128s):
`[U8, U8, U8, U128, U128, U128, U128, I64, U32, U32]`
Field names: `tier, proof_type, measurement_id, policy_hash_lo, policy_hash_hi,
consent_hash_lo, consent_hash_hi, issued_at, window_from, window_to`.
The raw bytes are the same either way; `_lo` = bytes 0..16 of the hash.

SAS attestation account total: 256 bytes.

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
| `GET /v1/info` | — | `{ app_version, attester_address, fiu_public_jwk, pinned_kids: [..] }` |
| `POST /v1/sessions` | `{ policy, fi_data_range: {from,to} }` | `{ session_id, key_material, fi_request_body_b64, fi_request_jws, intent, intent_expires }` |
| `POST /v1/sessions/{id}/bind` | `{ wallet, signature_b58 }` | `{ status: "bound" }` |
| `POST /v1/sessions/{id}/evaluate` | `{ fetch_response_b64, fetch_response_jws, consent_jws }` | `{ tier, payload_hex, signature_hex, expiry }` or `{ tier: "REJECT" }` |

- Bodies that are signed travel as base64 of the **exact bytes** (`*_b64`), so
  nothing in between can re-serialize them and break the signature.
- Errors: `{ error: { code, message } }` with stable `code` strings
  (`session_not_found`, `session_expired`, `bad_aa_signature`,
  `bad_fip_signature`, `bad_consent_signature`, `decrypt_failed`, …). Each
  signature layer has its own code, so a failure names the check that caught it.
  Messages never contain payload data.

---

## 11. Test vector layout — FROZEN

```
test-vectors/
  keys/                     *.test-private.* — TEST ONLY
  personas/<persona_id>.json
  policy/default.json       + default.hash (hex)
  vectors/<persona_id>/
    session.json            fixed enclave X25519 key ref, nonce, session_id, wallet, timestamps
    fi_request.body         exact bytes
    fi_request.jws
    fetch_response.body     exact bytes
    fetch_response.jws
    consent.jws
    expected.json           { tier, features, policy_hash, payload_hex, msg_hex }
  negative/<case>/          same files, one thing broken; expected.json = { error_code }
  manifest.json             list of all cases + generator version
```

**Layering rule.** The enclave checks layers from the outside in: AA
signature → consent → decrypt (AES-GCM tag) → FIP signature. A negative case
must break exactly **one** layer. The generator then re-applies every layer
*outside* it with valid keys, so the broken layer is the one that fails.
Without this, an outer check fires first, and the inner check is never tested.

Required negative cases:

| Case | How the generator builds it | Expected code |
|---|---|---|
| Fetch response byte flipped | flip a byte of `fetch_response.body`, **don't** re-sign | `bad_aa_signature` |
| Ciphertext byte flipped | flip a byte of `encryptedFI`, then **re-sign the fetch response with the AA key** | `decrypt_failed` |
| FI plaintext changed | change the FI JSON, keep the old FIP JWS, **re-encrypt and re-sign** the fetch response | `bad_fip_signature` |
| Consent tampered | flip a byte of the consent payload, don't re-sign | `bad_consent_signature` |
| Consent not ACTIVE | validly signed consent with `status` ≠ `ACTIVE` | `consent_invalid` |
| Unpinned key | fetch response validly signed by a key whose `kid` isn't pinned | `unknown_kid` |
| `alg: none` / `alg: HS256` | header algorithm swapped | `bad_alg` |
| Detached JWS without `crit` | `crit` removed from the header | `bad_header` |

Plus one positive RS512 case.

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
| Response timestamps | `2020-04-09T11:05:49.059+0000` | Accept `+0000` |
| `FIDataRange.from/to` | `2018-10-31T04:10:12.898` (no zone) | **OPEN:** UTC or IST? Treat as UTC until Finvu confirms; we emit `Z` |
| `valueDate` | full datetime in Finvu sample, `xs:date` in XSD | Accept both; use the date part |
| FI `type` | `DEPOSIT` (XSD fixes `deposit`) | Case-insensitive |
| FI `version` | `1.1` in Finvu sample | Record, don't reject |
| `amount` | JSON number; balances as strings | Accept number or string, parse to paise without floats |
| Decrypted FI format | Finvu sample shows JSON | **OPEN:** some FIPs may send XML. MVP is JSON-only; XML → reject with `unsupported_fi_format` |

