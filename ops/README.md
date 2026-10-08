# ops

Admin scripts, run by the admin wallet. Outside the trust boundary: they only
create public on-chain configuration, and the programs check everything that
matters. They run with `node --import tsx` (the package scripts do this),
because they use the Codama-generated clients.

Order for a fresh cluster (after `anchor deploy` of both programs):

1. `oracle:init`: the oracle's registry config.
2. `sas:setup`: the SAS credential and schema.
3. `pool:setup`: the demo mint, pool and vault.
4. `enclave:rotate`: register the running enclave, approve it in the pools.
5. `e2e:devnet`: drive the deployed gateway end to end.

Every script first checks the RPC's genesis hash, so a `localnet` run can't
touch devnet, testnet or mainnet, and a `devnet` run only accepts devnet. Only
the HTTP RPC is checked: point `SOLANA_WS_URL` at the same cluster, or
confirmation never arrives. A re-run sends nothing when the chain already
matches; a mismatch fails and changes nothing (fixing it is a human decision).

They write `deployments/<cluster>.json` by merging their own keys into it
(`docs/FORMATS.md` §7 → Deployment file).

## Environment

The variables come from the process environment; the scripts don't read
`.env` themselves. To use the repo's `.env` (which interpolates
`${HELIUS_API_KEY}`), load it through the shell: `set -a; . ./.env; set +a`.

| Env | Meaning |
|---|---|
| `SOLANA_RPC_URL` | `http(s)://` RPC |
| `SOLANA_WS_URL` | `ws(s)://` RPC subscriptions |
| `ORACLE_PROGRAM_ID` | the oracle program id (`Anchor.toml`) |
| `ADMIN_KEYPAIR` | admin keypair file, default `~/.config/solana/tee-income-oracle.json`; pays, and is the oracle admin, the credential authority and the pool admin |

Errors print only a message (never env values or key material) and exit 1.

## `oracle:init`: registry config

Creates the oracle `Config` (`docs/FORMATS.md` §13) with the admin wallet as
registry admin. The program only accepts its upgrade authority as signer, so
`ADMIN_KEYPAIR` must be the wallet that deployed the program. An existing
config with another admin fails (`admin_mismatch`).

```sh
pnpm --filter @tio/ops oracle:init --cluster devnet
```

## `sas:setup`: SAS credential and schema

Creates the Solana Attestation Service credential and schema the oracle
writes to (`docs/FORMATS.md` §7), once per cluster:

1. Derive the oracle's SAS signer, PDA `["sas_signer"]` of `ORACLE_PROGRAM_ID`.
2. Credential `tee-income-oracle`: create it with the admin as authority and
   the SAS signer as the **only** authorized signer, or check an existing one.
3. Schema `tio-income-tier` v1: create it with the §7 layout and field names,
   or check an existing one (layout, field names, not paused).
4. Write the addresses to `deployments/<cluster>.json`.

```sh
SOLANA_RPC_URL=http://127.0.0.1:8899 \
SOLANA_WS_URL=ws://127.0.0.1:8900 \
ORACLE_PROGRAM_ID=HZyMtqfwXMbqDUwWe9GVSvfZTaXaJZuKAMtJ1i6xwNG8 \
pnpm --filter @tio/ops sas:setup --cluster localnet
```

A local validator needs the SAS program loaded at its real address:

```sh
solana-test-validator --reset \
  --bpf-program 22zoJMtdu4tQc2PzL74ZUT7FrwgB1Udec8DdW4yw4BdG test-fixtures/sas/sas.20261004.so
```

## `pool:setup`: demo mint, pool and vault

One transaction: a new classic SPL mint (6 decimals, mint authority = admin,
**no freeze authority**, so nobody can freeze the vault or a borrower's
account and block `repay`), pool 0 (`docs/FORMATS.md` §14) and 1 000 000
tokens minted into the vault. Parameters: the default policy hash
(`test-vectors/policy/default.hash`), tier limits A 5 000 / B 2 000 / C 500
tokens, `max_age` 30 days, `max_window_age` 45 days, `min_window` 180 days, and
the registry entries active at setup time as approved enclaves. Writes `mint`,
`demo_pool_program`, and adds pool 0 to `pools` (other pools listed there stay:
`enclave:rotate` keeps approving every listed pool). Entries are matched by
address; after a program or admin change, remove the old pool's entry by hand
(`enclave:rotate` stops with `pool_missing` on a pool that no longer exists).

A re-run with an equal pool is a no-op; another policy, limit or window fails
(`pool_mismatch`). The approved-enclave bitmap is ignored on re-runs:
`enclave:rotate` owns it.

```sh
pnpm --filter @tio/ops pool:setup --cluster devnet
```

## `enclave:rotate`: register the running enclave

Run after every Oyster deploy or restart (the attester key is new on every
boot). Needs `oyster-cvm` (5.0.1; its log lines are parsed) on `PATH` and the
enclave reachable on `:1301` (Oyster attestation server) and `:8080`.

```sh
pnpm --filter @tio/ops enclave:rotate --cluster devnet --enclave-ip <ipv4>
```

1. Refuse the template `enclave/docker-compose.yml` (placeholder digest), then
   compute the image id from it (`oyster-cvm compute-image-id`).
2. Fetch the attestation document once (`/attestation/hex`) into its own
   `deployments/<cluster>/attestation-pending-<uuid>.hex`, and verify **that file**
   with `oyster-cvm verify --attestation-hex-file … --image-id <computed>`
   (AWS Nitro root, freshness, image id). Any missing line, ERROR line or
   non-zero exit stops the run.
3. Derive the attester's eth address from the attested public key, and require
   the enclave's `/v1/info` to report the same one.
4. In one transaction: `register_enclave` (kind 1, image id, attester,
   `sha256` of the document), `update_pool` for every pool in `pools` (approve
   the new id, clear the ids being revoked; other params unchanged), then
   `revoke_enclave` for every other active entry.
5. Rename the document to `attestation-<id>.hex`, add the entry to `enclaves`,
   and print the `az containerapp update … MEASUREMENT_ID=<id>` command that
   points the gateway at the new entry.

The archive is the evidence behind an on-chain hash, so it is never
overwritten. Only one rotation runs at a time: the run holds
`deployments/<cluster>/.rotate.lock` (created exclusively, deleted at the end;
a second run fails with `rotation_in_progress`, and after a crash you delete
the file). A run that registered but failed before archiving leaves its
pending file; the next run promotes every pending file whose `sha256` is an
entry's `attestation_doc_hash` before fetching a new one, and leaves the
others alone. A record in `enclaves` that names another enclave under the id
about to be used fails the run before sending (`deployment_conflict`). A run
that fails before sending deletes its own pending file. The lock, pending and
temporary files are gitignored; only `attestation-<id>.hex` and
`<cluster>.json` are committed.
An archive that already exists for an id about to be registered fails the run
before anything is sent (`archive_conflict`). Re-running for an enclave that is
already registered and approved sends nothing.

## `e2e:devnet`: end to end against the deployed gateway

Local only, never in CI. One fresh wallet per sandbox persona
(`salaried_steady` → A, `trader_lumpy` → B, `declining` → C, `stressed` →
REJECT) goes through `POST /v1/sessions`, signs the intent, reads the
`complete` SSE stream, and for lent tiers checks the SAS attestation holds the
returned payload. The tier A wallet then borrows one token from the first pool
and repays it (the admin pays fees and the token account). Prints a PASS/FAIL
row per step; exit 1 if any fails.

```sh
pnpm --filter @tio/ops e2e:devnet --cluster devnet --gateway https://<gateway host>
```

## Tests

`pnpm --filter @tio/ops test` runs the unit tests and an offline surfpool
suite (`@solana/surfpool`, embedded `Surfnet`) that loads the SAS binary from
`test-fixtures/sas/` (see `SOURCE.md` there for where it came from).

`pnpm --filter @tio/ops test:programs` (after `anchor build`) runs
`oracle:init`, `pool:setup` and `enclave:rotate` against the real oracle,
demo-pool, SAS and SPL Token programs; Oyster is replaced by fake ports that
print `oyster-cvm` 5.0.1-style output. In CI it runs in the `programs` job.
