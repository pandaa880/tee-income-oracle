# test-vectors

Self-constructed, ReBIT-format test payloads — signed with your own
RSA-2048 keypair, encrypted with your own Curve25519/ECDH-derived session
key. Needed regardless of live AA sandbox access; this is the primary path,
not a fallback (see starter checklist §E).

Plan: three borrower personas with deliberately different FOIR / income-
regularity / liquidity-stress profiles → three different expected tiers.
Each payload gets a matching **tampered** copy (one byte flipped) — the
Rust verifier in `enclave/` must PASS on the real one and FAIL on the
tampered one. Both cases are required tests, not just the happy path.

**Never commit real signing keys here** — see root `.gitignore`
(`test-vectors/*.key`).

Empty for now — no payloads generated yet.
