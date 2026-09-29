# programs/demo-pool

Anchor program. A minimal lending pool built only to prove composability
— not a real protocol, designed so a real one could replace it.

- `borrow` instruction: takes the SAS attestation account as input, verifies
  it inline:
  - owner is SAS; the PDA matches `[attestation, credential, schema, borrower]`;
  - the signer is the oracle's SAS signer PDA;
  - not expired, and within `max_age`;
  - enclave `measurement_id` approved *and* still active in the oracle registry;
  - `policy_hash` matches what this pool requires.

  Then it transfers testnet tokens up to the tier's limit. One open loan per
  borrower.
- Does **not** CPI to read the attestation — it deserializes an account
  passed into its own instruction. CPI is only used by `programs/oracle` to
  *write* to SAS.
- "Pool B" (a second instance proving portability — reads the same
  attestation Pool A used, zero re-verification) can be the same program
  code, just deployed/configured twice. No separate crate needed.

Generated with `anchor new` (Anchor 1.2.0) and reduced to an empty skeleton: `declare_id!` plus an empty `#[program]` module. The real instructions arrive in build step 3.
