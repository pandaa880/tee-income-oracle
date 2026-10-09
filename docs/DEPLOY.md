# Deploy

How the demo runs on Solana devnet: the two programs, the enclave on Marlin
Oyster (AWS Nitro), and the gateway and sandbox bank on Azure Container Apps.
Byte formats are in [`FORMATS.md`](FORMATS.md), the ops scripts in
[`ops/README.md`](../ops/README.md).

The live ids (programs, SAS credential and schema, mint, pool, registered
enclaves) are in [`deployments/devnet.json`](../deployments/devnet.json).
Each registry entry's attestation document is archived next to it as
`deployments/devnet/attestation-<measurement_id>.hex`; its SHA-256 is the
`attestation_doc_hash` stored on chain.

## What runs where

| Component | Where | Reached by |
|---|---|---|
| `oracle`, `demo_pool` programs | Solana devnet | everyone |
| enclave | Marlin Oyster, arm64 `c6g.large`, `ap-south-1` | the gateway (`:8080`), verifiers (`:1301` attestation) |
| gateway | Azure Container Apps, external ingress | the web app, `ops e2e:devnet` |
| sandbox bank | Azure Container Apps | the gateway only, with a bearer token (below) |

## Secrets

None of these are ever committed, logged or passed on a command line that
gets echoed. Keep each key file outside the repo with mode `600`.

| Secret | Used by |
|---|---|
| admin keypair (upgrade authority, oracle admin, SAS authority, pool admin) | `anchor`/`solana` CLI, every `ops` script |
| relayer keypair (pays for `submit_attestation`, ~0.5 SOL) | gateway `RELAYER_KEYPAIR` |
| `BANK_TOKEN` (`openssl rand -hex 32`) | gateway and bank, same value |
| AA + FIP demo private JWKs (FORMATS §2) | bank `SANDBOX_AA_PRIVATE_JWK`, `SANDBOX_FIP_PRIVATE_JWK` |
| Solana RPC URL with an API key | gateway, bank, `ops` (`SOLANA_RPC_URL`, `SOLANA_WS_URL`) |
| Oyster wallet key (Arbitrum One, USDC + a little ETH) | `oyster-cvm` |

## 1. Programs and on-chain setup

```sh
anchor build
solana program deploy target/deploy/oracle.so --program-id target/deploy/oracle-keypair.json \
  --keypair <admin> --upgrade-authority <admin> -u devnet
solana program deploy target/deploy/demo_pool.so --program-id target/deploy/demo_pool-keypair.json \
  --keypair <admin> --upgrade-authority <admin> -u devnet

pnpm --filter @tio/ops oracle:init -- --cluster devnet
pnpm --filter @tio/ops sas:setup   -- --cluster devnet   # writes deployments/devnet.json
pnpm --filter @tio/ops pool:setup  -- --cluster devnet
pnpm --filter @tio/ops pool:setup  -- --cluster devnet --pool-id 1 --tier-limits 3000,1000,0  # second pool, same mint
```

Rent: about 1.32 SOL (oracle) + 1.23 SOL (demo_pool). A later upgrade needs a
temporary buffer of the same size, refunded after. Every `ops` script is
idempotent: a re-run with equal state sends nothing.

## 2. Images

```sh
enclave/scripts/build-image.sh --push docker.io/<user>/tio-enclave   # clean tree; builds twice, compares
# paste the digest into enclave/docker-compose.yml, then:
oyster-cvm compute-image-id --docker-compose enclave/docker-compose.yml --arch arm64

docker buildx build --platform linux/amd64 -f gateway/Dockerfile \
  -t docker.io/<user>/tio-gateway:<version> --push .
docker buildx build --platform linux/amd64 -f sandbox-bank/Dockerfile \
  -t docker.io/<user>/tio-sandbox-bank:<version> --push .
```

The gateway image bakes in `deployments/`, so build it after step 1. Pin
every app by digest (`@sha256:…`), never by tag.

The Oyster image id hashes the compose file's exact bytes, comments included.
Anyone can recompute it from the repo with the `compute-image-id` command
above and compare it with the registry entry and the release notes.

## 3. Enclave on Oyster

```sh
oyster-cvm deploy --wallet-file <oyster-key> --docker-compose enclave/docker-compose.yml \
  --arch arm64 --duration-in-minutes 60 --bandwidth 100 --job-name tio-enclave
oyster-cvm deposit --wallet-file <oyster-key> --job-id <job> --amount <usdc × 10^6>
oyster-cvm list --address <oyster-wallet-address>    # balance and time left
```

- Never pass `--debug true` to a deployment you register: debug zeroes the
  PCRs, and `oyster-cvm verify --image-id` then fails with `image id
  mismatch` (that is the check working).
- Measured cost (2026-10): 0.085 USDC/h for `c6g.large` + `--bandwidth 100`
  (≈ 2.04 USDC/day). The default bandwidth (10 KB/s) makes a 67 KB statement
  upload take seconds.
- Start with a short duration, check the enclave works, then `deposit` to
  cover the period you need, before the first duration runs out.

Then register it:

```sh
pnpm --filter @tio/ops enclave:rotate -- --cluster devnet --enclave-ip <ip>
```

`enclave:rotate` fetches one attestation document from `:1301`, checks it
with `oyster-cvm verify` (Nitro root chain + image id), checks the attested
key against the enclave's `/v1/info`, then in one transaction registers the
next `measurement_id`, approves it in every pool and revokes the old entries.

## 4. Gateway and bank on Azure Container Apps

The environment this subscription gets is an **express** environment (no
switch for it in the CLI). Express has no private networking: an
"internal" app still answers on its public URL, and insecure HTTP isn't
supported. So the bank is protected by `BANK_TOKEN` (FORMATS §15), and the
gateway reaches it over HTTPS.

Never type a secret on the command line: it lands in shell history. Put
these commands in a script that reads each secret from its mode-`600` file
or the environment at run time (for example `bank-token="$(cat <file>)"`),
so the values never appear in history or in the script itself (they do
reach `az`'s arguments for the moment it runs, so run it on your own
machine, not a shared one). Key Vault
references, the usual alternative, aren't supported on express
environments. The `…` below stand for those reads.

```sh
az containerapp env create -g <rg> -n <env> -l <region> --logs-destination none

az containerapp create -g <rg> -n bank --environment <env> \
  --image docker.io/<user>/tio-sandbox-bank@sha256:<digest> \
  --ingress internal --target-port 8081 \
  --min-replicas 1 --max-replicas 1 --cpu 0.25 --memory 0.5Gi \
  --secrets aa-jwk=… fip-jwk=… rpc-url=… bank-token=… \
  --env-vars SANDBOX_AA_PRIVATE_JWK=secretref:aa-jwk SANDBOX_FIP_PRIVATE_JWK=secretref:fip-jwk \
             SOLANA_RPC_URL=secretref:rpc-url BANK_TOKEN=secretref:bank-token

az containerapp create -g <rg> -n gateway --environment <env> \
  --image docker.io/<user>/tio-gateway@sha256:<digest> \
  --ingress external --target-port 8082 \
  --min-replicas 1 --max-replicas 1 --cpu 0.25 --memory 0.5Gi \
  --secrets relayer-key=… rpc-url=… ws-url=… bank-token=… \
  --env-vars CLUSTER=devnet MEASUREMENT_ID=<id> ENCLAVE_URL=http://<enclave ip>:8080 \
             BANK_URL=https://<bank fqdn> ALLOWED_ORIGIN=<web origin> TRUST_PROXY=1 \
             RELAYER_KEYPAIR=secretref:relayer-key SOLANA_RPC_URL=secretref:rpc-url \
             SOLANA_WS_URL=secretref:ws-url BANK_TOKEN=secretref:bank-token
```

Check the bank refuses the public internet: a `POST /Consent` without the
token must get `401 Unauthorized`; `GET /health` stays open.

The gateway only starts listening after its boot checks pass (registry entry
active, FIU key registered with the bank using the token, relayer balance),
so `GET /health` = `ok` means all of them passed. Azure's CLI log streaming
doesn't work on express environments.

## 5. Check end to end

```sh
pnpm --filter @tio/ops e2e:devnet -- --cluster devnet --gateway https://<gateway fqdn>
```

Four personas (A, B, C, REJECT) attest on chain, then the tier A wallet
borrows and repays. Expect `PASS` on every row.

## 6. Enclave restart

A restart gives the enclave a new attester key: the old registry entry is
dead and every pool must approve the new one.

1. Restart the enclave. `oyster-cvm update` with an **unchanged** compose
   file doesn't restart it; changing the metadata does (to rehearse, set
   `--debug true` then `--debug false`; only the second boot gets
   registered).
2. Wait until `/v1/info` shows a new `attester_address`.
3. `pnpm --filter @tio/ops enclave:rotate -- --cluster devnet --enclave-ip <ip>`.
4. Point the gateway at the new `MEASUREMENT_ID`. On express, `az containerapp
   update --set-env-vars` changes the config but doesn't replace the
   running replica, and `revision restart` isn't available: delete the
   gateway app and create it again (same name, same FQDN). Until then the
   gateway refuses new sessions with `enclave_rotated`.
5. Run `e2e:devnet` again.

Borrowers attested by the old entry must attest again (FORMATS §13).

## 7. Stop paying

```sh
oyster-cvm withdraw --wallet-file <oyster-key> --job-id <job> --max
oyster-cvm stop --wallet-file <oyster-key> --job-id <job>
az containerapp delete -g <rg> -n gateway --yes
az containerapp delete -g <rg> -n bank --yes
```
