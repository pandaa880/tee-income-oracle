# programs/oracle

The Anchor program that is the on-chain trust anchor. It keeps a registry of
approved enclave builds. It writes a wallet's SAS attestation only after it
checks an enclave's signature.

Account layouts, instructions and error codes are in `docs/FORMATS.md` §13.
The 83-byte payload is in §7. Nothing personal goes on chain: only a tier,
ids, hashes and timestamps.

## Registry

| Instruction | Who | What |
|---|---|---|
| `initialize(admin)` | The program's upgrade authority only | Creates the registry config. The `program_data` account must be this program's own ProgramData. Because only the upgrade authority can call it, nobody can front-run the deployment and make themselves admin. |
| `register_enclave` | Admin | Records an enclave build. The admin first checks the build's Nitro attestation document off chain with `verifier/`. |
| `revoke_enclave` | Admin | Sets `revoked_at`. One-way. |
| `propose_admin`, `accept_admin` | Admin, then the new admin | Two-step admin change. The new key must sign to take over, so the registry can't be handed to a key nobody controls. |

Each `EnclaveEntry[measurement_id]` holds:

- a platform-neutral `measurement: [u8; 32]`;
- a `measurement_kind`: Oyster image id or AWS PCR0 hash;
- the **secp256k1 attester address**;
- the hash of the Nitro attestation document. With it, an auditor can
  re-verify a build after the enclave is gone.

**Ids are append-only.** The entry address is keyed by the id, and the
counter only goes up, so a revoked id is never reassigned. Otherwise a
revoked enclave's SAS attestations would silently validate against a new
entry. An enclave restart gets a new attester key, so it is a new entry.

**Id budget:** a deployment can make 255 registrations in its life. Ids are
never reused, and every enclave restart takes one. Running out needs a
migration (FORMATS §13 → Id budget).

**Admin key recovery:**

- **Compromised or retiring key:** the admin proposes a new key (ideally a
  Squads multisig), and the new key accepts.
- **Lost key:** no admin action is possible, so the only fix is a program
  upgrade. Keep the program upgradeable, with its upgrade authority stored
  safely, until `admin` is a multisig.

## `submit_attestation`

Anyone can relay this instruction. It takes no arguments: everything comes
from the signed §8 message. The check order and errors 6011–6027 are in
FORMATS §13; the precompile layout and clock rules are in §8.

It checks that:

- the secp256k1 precompile instruction comes directly before it, with exactly
  the 329-byte layout. Every offset must point at that precompile
  instruction itself;
- the message names this program, the credential, the schema and the
  attestation address passed in;
- the payload's registry entry is active, holds the signing key and matches
  the proof type;
- the tier is 1–3;
- `issued_at` and `expiry` fit the Solana clock: 300 s skew, 600 s lifetime.

Then it CPIs SAS `create_attestation`, signing as the oracle's PDA
`["sas_signer"]`. That PDA is the credential's only authorized signer. The
SAS `expiry` is `issued_at` + 30 days.

**Refresh:** a strictly newer `issued_at` replaces an existing SAS
attestation for the same wallet. That stops replays and older signatures. The
instruction calls SAS `close_attestation`, then creates the new one, in the
same instruction. The old rent goes to this transaction's payer.

**Cost on surfpool:** 17,575 CU to create, 22,968 CU to refresh. The
transaction is 882 bytes.

## Reading the SAS attestation from another program

Programs that read the SAS attestation use this crate as a library
(`features = ["cpi"]`). `sas::parse_attestation` and `attest::parse_payload`
are the only code that knows the stored layout. `programs/demo-pool` uses
them.

## Build

```sh
anchor build -p oracle                      # target/deploy/oracle.so + target/idl/oracle.json
pnpm --filter @tio/oracle-client generate   # clients/ts/oracle/src/generated (committed)
```

Codama generates the TypeScript client (`clients/ts/oracle`) from the IDL.
Regenerate it after every IDL change; CI fails if the committed client
differs.

## Test

```sh
anchor test                                 # oracle and demo-pool suites
pnpm --filter @tio/oracle-tests test        # this program only
cargo test -p oracle                        # Rust unit tests: byte layouts, clock rules
```

- The tests (`programs/oracle/tests`, vitest) run on an embedded, offline
  surfpool (`@solana/surfpool`). They deploy `target/deploy/oracle.so` and
  set its upgrade authority with the `surfnet_setProgramAuthority`
  cheatcode.
- Every check has a negative test that asserts its error code.
- The `submit_attestation` suites also deploy the dumped SAS binary
  (`test-fixtures/sas/`). They create the credential and schema with
  `@tio/ops`'s `runSasSetup`.
- Those suites sign with `@noble/curves` secp256k1 and build the precompile
  instruction by hand (`tests/src/attest.ts`). They move the clock with
  `surfnet_timeTravel` (milliseconds, forward only).

## Gotchas

- The SAS instructions are built by hand (`src/sas.rs`), because the
  published Rust client pins solana-program 2.x.
