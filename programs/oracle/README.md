# programs/oracle

Anchor program. The on-chain trust anchor.

- Config account holds `authorized_attester` — the Nitro enclave's public key.
  Admin can rotate it after a new attestation is independently verified.
- `submit_attestation` instruction: checks the enclave's signature over the
  incoming result, then writes it as a Solana Attestation Service (SAS)
  record (schema: tier, proof_type, measurement_id, policy_hash, consent_hash,
  issued_at, window_from/to — see technical overview §6c).
- Nothing personal ever goes into this program's accounts — no amounts, no
  account numbers, no transaction data. Just a tier and some hashes.

Generated with `anchor new` (Anchor 1.2.0) and reduced to an empty skeleton: `declare_id!` plus an empty `#[program]` module. The real instructions arrive in build step 3.
