# programs/demo-pool

A minimal Anchor lending pool that lends test tokens against the oracle's SAS
attestation. It exists to show how a lender checks the SAS attestation. It is
not a real protocol: principal only, with no interest, tenor or liquidation.

Layouts, error codes and the exact check order are in `docs/FORMATS.md` §14.

## What it does

| Instruction | Who | What |
|---|---|---|
| `create_pool` | Anyone (the caller becomes admin) | Creates a pool and its token vault: mint, SAS credential + schema, policy hash, tier limits, freshness limits, approved enclave builds |
| `update_pool` | Admin | Replaces the lending rules (not the mint, credential or schema) |
| `borrow` | Borrower (a relayer may pay) | Checks the SAS attestation, sends up to the tier's limit, and opens the borrower's one loan in this pool |
| `repay` | Borrower | Returns the principal and closes the loan |

One program serves many pools. A pool is the PDA
`["pool", admin, [pool_id]]`. Two pools with different rules can lend on the
same SAS attestation, and nothing is verified twice.

## What `borrow` checks

The pool does **not** CPI to read the SAS attestation. The account is passed
into `borrow` and read there. (Only `programs/oracle` uses CPI, to *write*
to SAS.)

`borrow` checks that:

- the account is the SAS attestation of the signing borrower, under the
  pool's credential and schema. The address is derived from those. The
  account must be owned by SAS, with the expected size and type;
- the oracle's SAS signer wrote it. Anyone can create SAS attestations under
  their own credential, so this check matters;
- it hasn't expired, and it is within the pool's own limits for attestation
  age, statement age and statement length;
- its tier has a limit in this pool, and the amount is within that limit;
- its `policy_hash` is the one the pool requires;
- the enclave build that produced it is approved by the pool **and** still
  active in the oracle registry.

The layout code comes from the oracle crate (`oracle::sas::parse_attestation`,
`oracle::attest::parse_payload`, `oracle::state::EnclaveEntry`). This program
uses that crate as a library (`features = ["cpi"]`).

## Token program

- The pool supports classic SPL Token mints only (`anchor_spl::token`).
- `anchor-spl`'s `token_2022` feature is on only because Anchor's `init` for
  a token account needs it.
- Supporting Token-2022 later is a code change with no account migration
  (FORMATS §14 → Token program). First decide how to treat each mint
  extension.
- The pool doesn't look at a mint's freeze authority. Pick a mint whose
  freeze authority you trust.

## A real lender

No existing Solana lending program can make a borrow depend on an outside
attestation without a code change. A production lender would add the checks
above to its own borrow path. marginfi-v2 (Apache-2.0, Anchor) is the kind of
program this is written for.

## Build

```sh
anchor build                                   # target/deploy/demo_pool.so + target/idl/demo_pool.json
pnpm --filter @tio/demo-pool-client generate   # clients/ts/demo-pool/src/generated (committed)
```

Codama generates the TypeScript client from the IDL. CI fails if the
committed client differs.

## Test

```sh
cargo test -p demo-pool                        # the lending rules as pure functions
pnpm --filter @tio/demo-pool-tests test        # surfpool: real oracle + SAS binary + SPL Token
anchor test                                    # oracle and demo-pool suites
```

The surfpool tests (`tests/`) reuse the oracle test harness
(`@tio/oracle-tests`). Every SAS attestation they borrow on goes through the
real oracle program first.
