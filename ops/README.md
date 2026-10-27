# ops

Admin scripts, run by the admin wallet. **Outside the trust boundary:** they
only create public on-chain configuration, and the programs check everything
that matters.

## What it does

Order for a fresh cluster, after `anchor deploy` of both programs:

1. `oracle:init`: the oracle's registry config.
2. `sas:setup`: the SAS credential and schema.
3. `pool:setup`: the demo mint, pool 0 and its vault. Add `--pool-id 1` for a
   second pool on the same mint.
4. `enclave:rotate`: register the running enclave and approve it in the
   pools.
5. `e2e:devnet`: drive the deployed gateway end to end.

`monitor:devnet` is the exception to "admin". It only reads, needs no key,
and runs in CI on a schedule.

Every script follows the same safety rules:

- **Right cluster only.** Each script first checks the RPC's genesis hash. A
  `localnet` run can't touch devnet, testnet or mainnet, and a `devnet` run
  accepts only devnet. Only the HTTP RPC is checked, so point
  `SOLANA_WS_URL` at the same cluster, or confirmation never arrives.
- **Idempotent.** A re-run sends nothing when the chain already matches. A
  mismatch fails and changes nothing; fixing it is a human decision.
- **Safe writes to `deployments/<cluster>.json`.** Each script merges its own
  keys into the file (`docs/FORMATS.md` §7 → Deployment file). A write holds
  `deployments/<cluster>.json.lock` for the whole read-merge-write, so two
  scripts running at once can't drop each other's keys. A writer waits up to
  5 s, then fails with `deployment_locked`. If a crash left the lock behind,
  delete the file.
- **No secrets in errors.** An error prints only a message, never env values
  or key material, and exits 1.

## Environment

The scripts read variables from the process environment, not from `.env`.
To use the repo's `.env` (which interpolates `${HELIUS_API_KEY}`), load it
through the shell: `set -a; . ./.env; set +a`.

| Env | Meaning |
|---|---|
| `SOLANA_RPC_URL` | `http(s)://` RPC |
| `SOLANA_WS_URL` | `ws(s)://` RPC subscriptions |
| `ORACLE_PROGRAM_ID` | The oracle program id (`Anchor.toml`) |
| `ADMIN_KEYPAIR` | Admin keypair file, default `~/.config/solana/tee-income-oracle.json`. It pays, and it is the oracle admin, the credential authority and the pool admin |

## `oracle:init`: registry config

Creates the oracle `Config` (`docs/FORMATS.md` §13), with the admin wallet as
registry admin.

- The program accepts only its upgrade authority as signer. So
  `ADMIN_KEYPAIR` must be the wallet that deployed the program.
- An existing config with another admin fails (`admin_mismatch`).

```sh
pnpm --filter @tio/ops oracle:init --cluster devnet
```

## `sas:setup`: SAS credential and schema

Creates the Solana Attestation Service credential and schema that the oracle
writes to (`docs/FORMATS.md` §7), once per cluster:

1. Derive the oracle's SAS signer: the PDA `["sas_signer"]` of
   `ORACLE_PROGRAM_ID`.
2. Credential `tee-income-oracle`: create it with the admin as authority and
   the SAS signer as the **only** authorized signer, or check an existing
   one.
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

## `pool:setup`: demo mint, pools and vaults

One transaction per pool. It creates:

1. **On the first run only, a mint:** a new classic SPL mint with 6 decimals.
   The admin is the mint authority. It has **no freeze authority**, so nobody
   can freeze the vault or a borrower's account and block `repay`.
2. **The pool** (`docs/FORMATS.md` §14).
3. **1 000 000 tokens** minted into the pool's vault.

Every pool of a deployment shares the recorded `mint`. A run for a new pool
reuses that mint, and creates one only when the file has none.

| Parameter | Value |
|---|---|
| Policy hash | The default, from `test-vectors/policy/default.hash` |
| `--pool-id <0–255>` | Default 0 |
| `--tier-limits <a,b,c>` | In whole tokens; default `5000,2000,500`. Must have `a > 0` and `a ≥ b ≥ c`; 0 means the tier isn't accepted (same rules as the program's `check_params`) |
| `max_age` | 30 days |
| `max_window_age` | 45 days |
| `min_window` | 180 days |
| Approved enclaves | The registry entries active at setup time |

It writes `mint` and `demo_pool_program`, and adds the pool to `pools`.

- Other pools already listed in `pools` stay. `enclave:rotate` keeps
  approving every listed pool.
- Entries are matched by address. After a program or admin change, remove the
  old pool's entry by hand. Otherwise `enclave:rotate` stops with
  `pool_missing` on a pool that no longer exists.
- A re-run with an equal pool is a no-op. A different policy, limit or window
  fails (`pool_mismatch`).
- Re-runs ignore the approved-enclave bitmap: `enclave:rotate` owns it.

```sh
pnpm --filter @tio/ops pool:setup --cluster devnet
pnpm --filter @tio/ops pool:setup --cluster devnet --pool-id 1 --tier-limits 3000,1000,0
```

## `enclave:rotate`: register the running enclave

Run it after every Oyster deploy or restart, because the attester key is new
on every boot.

It needs:

- `oyster-cvm` 5.0.1 on `PATH` (the script parses its log lines);
- the enclave reachable on `:1301` (Oyster attestation server) and `:8080`.

```sh
pnpm --filter @tio/ops enclave:rotate --cluster devnet --enclave-ip <ipv4> --release <tag> [--keep-active <id>[,<id>…]]
```

**`--keep-active`** lists active registry ids to leave active and approved,
instead of revoking them. Use it when the old instance is gone but not
compromised. Its attester key existed only inside that enclave, so nobody can
sign with it again. Its SAS attestations keep lending and keep passing the
verifier. An id that isn't an active entry fails the run before anything is
sent.

The steps:

1. **Compute the image id.** Refuse the template `enclave/docker-compose.yml`
   (placeholder digest). Then compute the image id from it with
   `oyster-cvm compute-image-id`.
2. **Fetch and verify the Nitro attestation document.** Fetch it once
   (`/attestation/hex`) into its own
   `deployments/<cluster>/attestation-pending-<uuid>.hex`. Verify **that
   file** with
   `oyster-cvm verify --attestation-hex-file … --image-id <computed>`: AWS
   Nitro root, freshness, image id. Any missing line, ERROR line or non-zero
   exit stops the run.
3. **Match the attester.** Derive the attester's eth address from the
   attested public key (`@tio/verifier/eth-address`). The enclave's
   `/v1/info` must report the same address.
4. **Record the release.** `--release` must be the `vX.Y.Z` tag whose
   `enclave/docker-compose.yml` was deployed. The record stores it with the
   attestation endpoint (`http://<ip>:1301`). The verifier uses both to
   recompute PCR16 (`docs/VERIFY.md`).
5. **Register, in one transaction:**
   - `register_enclave`: kind 1, image id, attester, `sha256` of the
     document;
   - `update_pool` for every pool in `pools`: approve the new id and clear
     the ids being revoked, with other params unchanged;
   - `revoke_enclave` for every other active entry not listed in
     `--keep-active`.
6. **Archive.** Rename the document to `attestation-<id>.hex`, and add the
   entry to `enclaves`.
7. **Point the gateway at the new entry.** The script prints the
   `az containerapp update … MEASUREMENT_ID=<id>` command. On an Azure
   Container Apps express environment, that update doesn't replace the
   running replica: recreate the gateway app instead (`docs/DEPLOY.md` §6).

### Archive safety

The archive is the evidence behind an on-chain hash, so it is never
overwritten.

- **One rotation at a time.** A run holds
  `deployments/<cluster>/.rotate.lock`, created exclusively and deleted at
  the end. A second run fails with `rotation_in_progress`. After a crash,
  delete the file.
- **Leftover pending files.** A run that registered but failed before
  archiving leaves its pending file. The next run first promotes every
  pending file whose `sha256` is an entry's `attestation_doc_hash`, then
  fetches a new document. It leaves other pending files alone.
- **Clean failures.** A run that fails before sending deletes its own
  pending file.
- **Conflicts stop the run before anything is sent:**
  - a record in `enclaves` names another enclave under the id about to be
    used (`deployment_conflict`);
  - an archive already exists for the id about to be registered
    (`archive_conflict`).
- **Re-runs.** Re-running for an enclave that is already registered and
  approved sends nothing.
- **What is committed.** The lock, pending and temporary files are
  gitignored. Only `attestation-<id>.hex` and `<cluster>.json` are committed.

## `e2e:devnet`: end to end against the deployed gateway

Local only, never in CI.

1. One fresh wallet per sandbox persona goes through `POST /v1/sessions`,
   signs the intent, and reads the `complete` SSE stream. The personas are
   `salaried_steady` → A, `trader_lumpy` → B, `declining` → C and
   `stressed` → REJECT.
2. The script checks the chain:
   - for a tier that lends, the SAS attestation must hold exactly the
     returned payload, *and* the payload's tier byte must be the expected
     tier;
   - a REJECT wallet must have no SAS attestation.
3. The tier A wallet borrows 2 001 tokens from the first pool, then repays.
   2 001 is above tier B's limit of 2 000, so only an on-chain tier A SAS
   attestation passes the pool's check. The admin pays the fees and the
   token account.

It prints a PASS/FAIL row per step, and exits 1 if any step fails.

```sh
pnpm --filter @tio/ops e2e:devnet --cluster devnet --gateway https://<gateway host>
```

## `monitor:devnet`: is the deployed demo up?

Read-only, with no keys. The `monitor` workflow runs it every 30 minutes.

```sh
pnpm --filter @tio/ops monitor:devnet --gateway https://<gateway host> --enclave-ip <ipv4> \
  --oyster-job 0x<job id> --owner 0x<job owner wallet> [--out <dir>]
```

| Check | Fails when | Warns when |
|---|---|---|
| Gateway `/health` | No 200 | |
| Session | `POST /v1/sessions` (gateway → enclave → bank) isn't 200 | |
| Enclave `/v1/info` | No 200 | |
| Attester match | The enclave's attester isn't the gateway's: a restart the gateway hasn't caught up with | |
| Registry entry | The gateway's `measurement_id` has no entry, is revoked or names another attester | |
| Oyster runway | The job is missing, owned by another wallet, or paid for less than 1 day | Less than 7 days |
| Relayer SOL | Below 0.05 SOL | Below 0.5 SOL |
| Marlin's indexer | | Its newest block is over 2 h old (in 2026-10, a stalled indexer stopped our funded job) |

- The paid-until time comes from the market's `jobs(bytes32)` on Arbitrum
  One, not from Marlin's indexer.
- It prints a Markdown report. With `--out`, it also writes `report.md` and
  `status` (`ok`, `warn` or `fail`).
- It exits 1 on `fail`.
- Optional env: `SOLANA_RPC_URL` (default: public devnet),
  `ARBITRUM_RPC_URL`, `OYSTER_INDEXER_URL`.

## Test

```sh
pnpm --filter @tio/ops test             # unit tests + offline surfpool suite
pnpm --filter @tio/ops test:programs    # after anchor build: against the real programs
```

- `test` runs the unit tests and an offline surfpool suite
  (`@solana/surfpool`, embedded `Surfnet`). The suite loads the SAS binary
  from `test-fixtures/sas/`; `SOURCE.md` there says where it came from.
- `test:programs` runs `oracle:init`, `pool:setup` and `enclave:rotate`
  against the real oracle, demo-pool, SAS and SPL Token programs. Fake ports
  replace Oyster and print `oyster-cvm` 5.0.1-style output. In CI it runs in
  the `programs` job.

## Gotchas

- The scripts run with `node --import tsx` (the package scripts do this),
  because they use the Codama-generated clients.
