# rahasya golden vectors

All private keys here are **TEST ONLY**.

## How to verify these vectors (no crypto knowledge needed)

Run from this folder. Each check is PASS/FAIL.

1. **Self-consistency** (no Docker). The script first checks its own crypto
   code against official NIST/RFC test cases, then re-derives every stored
   value and decrypts the stored ciphertext.
   ```bash
   python3 verify.py
   # self-tests OK (NIST GCM TC16, RFC7748 TV1, RFC5869 TC1)
   # ecc basic OK
   # ecc shared_secret_leading_zero OK
   # x25519 OK
   ```
2. **Authenticity** (the strongest check). This replays the stored requests
   against the real reference implementation and does no crypto itself. If
   rahasya decrypts our ciphertext and computes the same shared secret from
   both sides, the vectors genuinely came from it. The stored keys' `expiry`
   is refreshed automatically at request time. rahasya rejects expired keys,
   and expiry isn't part of the cryptography.
   ```bash
   docker run --platform linux/amd64 --rm -d -p 8080:8080 --name rahasya gsasikumar/forwardsecrecy:V1.2
   until curl -s -o /dev/null localhost:8080/v2/api-docs; do sleep 3; done   # slow start under emulation
   python3 replay_against_rahasya.py
   # basic: decrypt PASS, shared secret PASS
   # shared_secret_leading_zero: decrypt PASS, shared secret PASS
   docker stop rahasya
   ```
3. **The checker can fail** (tamper test). One ciphertext byte is flipped in
   memory (files untouched), and the script confirms it changed. The checker
   must reject it.
   ```bash
   python3 tamper_test.py
   # basic: tamper test PASS (rejected: decryption failed: GCM tag mismatch)
   # shared_secret_leading_zero: tamper test PASS (rejected: decryption failed: GCM tag mismatch)
   ```
4. **Unit tests** covering all of the above, plus wrong curve parameters,
   off-curve points, mismatched X25519 keys and running under `python3 -O`.
   The live replay test runs only when rahasya is up.
   ```bash
   python3 -m unittest -v test_golden.py
   ```

The `x25519.json` vector is only covered by check 1, because rahasya V1.2
has no X25519 path.

## How they were generated (2026-09-26)

- Image: `gsasikumar/forwardsecrecy:V1.2`, digest `sha256:5689b80b853e950fcd4fbf75729694fa1d4493fe5d4746e98e4bed7229e0b0cc` (image created 2020-04-10, linux/amd64, run under emulation on arm64). It bundles `bcprov-jdk15on-1.64`, Java package `io.yaazhi.forwardsecrecy`.
- `docker run -p 8080:8080`. Endpoints come from `/v2/api-docs`. V1.2 has **only** these:
  - `GET  /ecc/v1/generateKey` returns `{privateKey, KeyMaterials, errorInfo}`
  - `POST /ecc/v1/getSharedKey` takes `{ourPrivateKey, remotePublicKey}` and returns `{key: base64(raw ECDH secret)}`
  - `POST /ecc/v1/encrypt` and `POST /ecc/v1/decrypt` take `{base64YourNonce, base64RemoteNonce, ourPrivateKey, remoteKeyMaterial, base64Data}`
- The encryptor is FIP and the decryptor is FIU. Nonces are 32 random bytes each.
- `verify.py` is a stdlib-only re-derivation. It covers the DER parse, Weierstrass math, an unclamped Montgomery ladder, RFC 7748 X25519, HKDF-SHA256 and a pure-Python AES-256-GCM. Self-tests run against NIST GCM TC16, RFC 7748 TV1 and RFC 5869 TC1. Run it with `python3 verify.py`.

## Files

- `ecc.json` holds two vectors produced by rahasya: `basic`, and `shared_secret_leading_zero`, where the shared secret starts with `0x00`.
- `verify.py`: standard-library re-derivation and self-tests (check 1).
- `replay_against_rahasya.py`: black-box replay against a running rahasya (check 2).
- `tamper_test.py`: one-byte tamper must be rejected (check 3).
- `test_golden.py`: unit tests for all checks (check 4).
- `x25519.json` is **not produced by rahasya**, because V1.2 has no X25519 endpoints. Keys and the shared secret come from OpenSSL 3.6.4 and were cross-checked with `verify.py`. KDF and GCM are applied the same way as in the ECC path. `key_material_synthesized` is a guess at the shape, not an observed value.

## Findings in plain words

What the reference implementation taught us. Each item is a trap that would
otherwise break interop with real Account Aggregators. The rules themselves
live in `docs/FORMATS.md` §3; this section is the evidence behind them.

- **Keys use an older, generic format** for Curve25519, not the modern
  X25519 one. Our code must read and write that format.
- **Other parties' private keys aren't "clamped"**, so the standard X25519
  function gives the wrong answer for them. Tests and sandbox-bank must use
  the raw calculation.
- **The shared secret is always 32 bytes, including leading zeros.** About 1
  run in 256 starts with `00`. Drop it and that run fails.
- **Public keys must be sent as single-line PEM.** Normal line-wrapped PEM is
  rejected.
- **Expired keys are rejected**, so we always send a future `expiry`.
- **Both nonces must be 32 bytes.** Otherwise the key derivation silently
  changes.

Details for implementers follow.

## Findings in detail (ECC path, from javap of the shipped jar and observed behaviour)

1. **Curve.** The SPKI carries explicit parameters, with no named OID. Values: p = 2^255-19, a = `2aaa…984914a144`, b = `7b42…7710c864`, uncompressed G with Gx = `2aaa…ad245a`, n = 2^252+2774…, and h = 8. The curve SEQUENCE has no seed. These values match the Montgomery→Weierstrass map: a = (3-A²)/3, b = (2A³-9A)/27, Gx = 9 + A/3.
2. **Shared secret.** BC `KeyAgreement("ECDH","BC").generateSecret()` returns x_W(d·Q) as **32 bytes, big-endian, leading zeros kept**. Across 202 keypairs the length was always 32. `x_W = u + A/3 mod p`, where u is the output of an **unclamped** Montgomery ladder on `u_peer = x_W,peer - A/3`.
3. **Scalars are not clamped.** BC picks d uniformly in [1, n-1]. Examples: d%8 = 6, d%8 = 1, bit length 250 to 252. A standard X25519 function (which clamps) gives the wrong result. You need the raw scalar mult, for example curve25519-dalek `MontgomeryPoint * Scalar` (not `mul_clamped`), or Weierstrass/Edwards math. In PKCS#8, d is always a 32-byte big-endian OCTET STRING, zero-padded. One observed key had first byte `0x00`.
4. **KDF.** HKDF IKM is the raw 32-byte secret. `getSharedSecret` base64-encodes it, and `CipherService` base64-decodes it again. The XOR nonce length is the length of `yourNonce`, and `remoteNonce` is indexed mod its own length. salt = xn[0:20], info = null, L = 32, iv = xn[20:32], GCM tag = 128 bits, no AAD.
5. **encrypt/decrypt asymmetry.**
   - The `/encrypt` field `base64Data` is **not base64-decoded**. It is plaintext and goes through `String.getBytes()` (platform default charset; UTF-8 in the container).
   - `/decrypt` base64-decodes the ciphertext and returns **base64(plaintext)**.
6. **PEM format.** Keys come as `-----BEGIN PUBLIC KEY-----<base64>-----END PUBLIC KEY-----` with **no newlines**.
   - A 64-column newline-wrapped PEM is **rejected** (HTTP 500).
   - Bare base64 with no header or footer is accepted.
   - An X25519 SPKI (`302a300506032b656e032100…`) is rejected on `/ecc`.
   - The SPKI DER is 309 bytes: a 66-byte BIT STRING holding the uncompressed 65-byte point. The PKCS#8 DER is 587 bytes: ECPrivateKey v1, with the explicit params repeated in `[0]` and the public key in `[1]`.
7. **KeyMaterial.** `{"cryptoAlg":"ECDH","curve":"curve25519","params":"","DHPublicKey":{"expiry":"yyyy-MM-dd'T'HH:mm:ss.SSS'Z'","Parameter":"","KeyValue":…}}`. Key expiry is 24h. Encrypt and decrypt **reject a remote KeyMaterial whose expiry is in the past** ("Expired Key").
