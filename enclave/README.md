# enclave

Rust code that runs **inside** the AWS Nitro Enclave. The privacy boundary —
the one place raw bank data ever exists in decrypted form.

Pipeline: derive the Curve25519/ECDH session key (generated *inside* the
enclave — the private half never leaves) → decrypt the AA payload → verify
the detached JWS (RFC 7797, `b64:false`, signature over raw body bytes) →
parse and classify transactions → score (FOIR, income regularity, liquidity
stress) against a lender-supplied policy → sign the result with the
enclave's own key → emit a remote-attestation document.

Builds via Docker + `nitro-cli build-enclave` into a `.eif` — **not** part of
the root Cargo workspace, since this is a different target/toolchain than
the Anchor programs.

No network, no persistence inside the boundary — anything this code needs
must either be baked into the image (covered by the PCR0 measurement) or
arrive via `proxy/` carrying a signature this code can verify.

Not yet scaffolded — no `Cargo.toml` or source yet. This README is a
placeholder.
