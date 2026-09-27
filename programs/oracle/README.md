# programs/oracle

Anchor program. The on-chain trust anchor.

- **Registry:** `EnclaveEntry[measurement_id]` maps an enclave **image id** to its
  **secp256k1 attester address**. The admin registers or revokes entries
  after checking the attestation off-chain with `verifier/`.
- **`submit_attestation`** (anyone can relay):
  - requires a secp256k1 precompile instruction in the same transaction,
    whose offsets point at that instruction itself;
  - checks the signer is an active registry entry, the signed message is the
    one defined in FORMATS §8, and the times are within the Solana clock
    window;
  - then CPIs SAS `create_attestation`, signing as the oracle's PDA
    `["sas_signer"]`, the credential's only authorized signer.
  - Refreshing an existing attestation closes it first (SAS rejects a
    duplicate nonce).
- Payload: the 83-byte layout in `docs/FORMATS.md` §7. Nothing personal:
  just a tier, ids, hashes and timestamps.

Generated with `anchor new` (Anchor 1.2.0) and reduced to an empty skeleton: `declare_id!` plus an empty `#[program]` module. The real instructions arrive in build step 3.
