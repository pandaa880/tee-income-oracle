# ops

Admin scripts, run by the admin wallet. Outside the trust boundary: they only
create public on-chain configuration, and the programs check everything that
matters.

## `sas:setup`: SAS credential and schema

Creates the Solana Attestation Service credential and schema the oracle
writes to (`docs/FORMATS.md` §7), once per cluster:

1. Derive the oracle's SAS signer, PDA `["sas_signer"]` of `ORACLE_PROGRAM_ID`.
2. Credential `tee-income-oracle`: create it with the admin as authority and
   the SAS signer as the **only** authorized signer, or check an existing one.
3. Schema `tio-income-tier` v1: create it with the §7 layout and field names,
   or check an existing one (layout, field names, not paused).
4. Write the addresses to `deployments/<cluster>.json`.

A re-run sends nothing and prints `ok`. If an existing account doesn't match
(other authority, extra signer, other layout, paused), it fails and changes
nothing: fixing that is a human decision.

Before reading or sending anything it checks the RPC's genesis hash, so a
`localnet` run can't write to devnet, testnet or mainnet, and a `devnet` run
only accepts devnet. Only the HTTP RPC is checked: point `SOLANA_WS_URL` at
the same cluster, or confirmation never arrives.

The variables come from the process environment; the script doesn't read
`.env` itself. To use the repo's `.env` (which interpolates
`${HELIUS_API_KEY}`), load it through the shell: `set -a; . ./.env; set +a`.

```sh
SOLANA_RPC_URL=http://127.0.0.1:8899 \
SOLANA_WS_URL=ws://127.0.0.1:8900 \
ORACLE_PROGRAM_ID=HZyMtqfwXMbqDUwWe9GVSvfZTaXaJZuKAMtJ1i6xwNG8 \
pnpm --filter @tio/ops sas:setup --cluster localnet
```

| Env | Meaning |
|---|---|
| `SOLANA_RPC_URL` | `http(s)://` RPC |
| `SOLANA_WS_URL` | `ws(s)://` RPC subscriptions |
| `ORACLE_PROGRAM_ID` | the oracle program id (`Anchor.toml`) |
| `ADMIN_KEYPAIR` | admin keypair file, default `~/.config/solana/tee-income-oracle.json`; pays and becomes the credential authority |

A local validator needs the SAS program loaded at its real address:

```sh
solana-test-validator --reset \
  --bpf-program 22zoJMtdu4tQc2PzL74ZUT7FrwgB1Udec8DdW4yw4BdG test-fixtures/sas/sas.20261004.so
```

## Tests

`pnpm --filter @tio/ops test` runs unit tests and an offline surfpool suite
(`@solana/surfpool`, embedded `Surfnet`) that loads the SAS binary from
`test-fixtures/sas/` (see `SOURCE.md` there for where it came from).
