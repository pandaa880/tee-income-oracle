# programs/demo-pool

Anchor program. A minimal lending pool built only to prove composability
(rubric §8(e)) — not a real protocol, designed so a real one could replace it.

- `borrow` instruction: takes the SAS attestation account as input, verifies
  it inline (credential/schema/signer match, not expired, enclave measurement
  approved, `policy_hash` matches what this pool requires), then transfers
  testnet tokens if the attested tier clears its threshold.
- Does **not** CPI to read the attestation — it deserializes an account
  passed into its own instruction. CPI is only used by `programs/oracle` to
  *write* to SAS.
- "Pool B" (a second instance proving portability — reads the same
  attestation Pool A used, zero re-verification) can be the same program
  code, just deployed/configured twice. No separate crate needed.

Not yet scaffolded with `anchor init` / no `lib.rs` — this README is a
placeholder for the program that will live here.
