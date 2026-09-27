# enclave

The trusted part: a thin Rust HTTP server around `tio-core`, running inside an
**AWS Nitro enclave on Marlin Oyster**. Raw bank data exists in decrypted form
only here, in memory, for one session.

Per session:
1. Generate the Curve25519 session key and nonce. The private half never
   leaves.
2. Sign the FI request with the enclave's own FIU RSA key, so the untrusted
   gateway can't swap in its own key.
3. Verify the AA signature over the raw fetch response.
4. Verify the consent.
5. ECDH → HKDF → AES-256-GCM decrypt.
6. Verify the FIP signature.
7. Parse, score against the lender's policy, and build the 83-byte payload.
8. Sign it with the attested **secp256k1** key.
9. Wipe all secrets from memory (zeroize).

The exact steps and error codes are in `docs/FORMATS.md` and
`docs/ARCHITECTURE.md`.

- **Build:** Docker image pinned by digest, deployed with `oyster-cvm deploy
  --docker-compose`. Not part of the Cargo workspace. The **image id** is this
  build's identity: every change creates a new one, which must be registered
  on chain.
- **Keys:** FIP/AA *public* keys are compiled in (`pinned/`). Demo keys only,
  never test-vector keys; the enclave refuses to start otherwise. The
  attester key comes from Oyster (`/app/ecdsa.sec`).
- **Rules:** no outbound calls, no filesystem writes, and no logging of
  payload data (only the session id, stage and error code).

Not yet implemented. Build step 4.
