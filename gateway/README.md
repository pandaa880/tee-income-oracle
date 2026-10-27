# gateway

A Node/TypeScript service. **Untrusted by design:** it carries bytes it can't
read or forge. It is the web app's only server, and it runs on our own
server, not on the enclave host.

The HTTP API (routes, SSE events, error codes, limits, config) is in
`docs/FORMATS.md` §16.

## What it does

- **Runs a session.**
  1. `POST /v1/sessions` gets an AA-signed consent from the bank and opens an
     enclave session.
  2. The borrower's wallet signs the returned intent.
  3. `POST /v1/sessions/{id}/complete` binds the wallet, carries the FI
     request and fetch response, and evaluates. It streams each stage over
     SSE.
- **Carries only signed or encrypted bytes,** exactly as received, so nothing
  re-serializes them. It can delay or drop them, but it can't read or forge
  them.
- **Relays the result** as one v0 transaction:
  `[compute limit, secp256k1 precompile, oracle.submit_attestation]`. The
  relayer keypair pays. The program checks the enclave's signature, not the
  payer. A resend can't land twice, because the oracle needs a strictly newer
  `issued_at` per wallet.
- **Sponsors loans** (next section).
- **Keeps no bank data and no borrower database.** Open sessions live in
  memory for 600 s. Logs carry only the session id, stage and error code.
- **Later, for the live Finvu path:** the AA client and the public FIU
  notification endpoints. A notification is only a hint to poll; it is never
  trusted directly.

## Sponsored loans

`POST /v1/loans/relay` takes a borrower-signed v0 transaction with the
relayer as fee payer. The gateway co-signs it only if it passes all 11 shape
rules (FORMATS §16 → Relay). In short:

- it is exactly a demo-pool `borrow` (with the borrower's ATA creation) or a
  `repay`;
- it targets a listed pool;
- every account is pinned to the borrower's own PDAs;
- the relayer appears only where it pays.

Then the gateway simulates the transaction with signature verification,
sends it and confirms it. A failed simulation costs nothing, and the borrower
pays no fees.

The rent of the borrower's token account is the one cost a borrower could
make the relayer pay again and again. So the gateway funds it only:

- for an address with no transaction history. A closed account keeps its
  history, so this is once per wallet, even across restarts;
- for up to 20 wallets per hour. After that it returns
  `sponsorship_exhausted`.

## Build

The Docker build context is the repo root. Secrets come only from the
environment.

```text
docker build -f gateway/Dockerfile -t tio-gateway:dev .
```

Azure Container Apps runs `linux/amd64`. An image built on Apple Silicon is
arm64 by default, so build the deployed image with
`docker buildx build --platform linux/amd64 …`.

## Run

```text
ENCLAVE_URL=http://127.0.0.1:8080 BANK_URL=http://127.0.0.1:8081 \
SOLANA_RPC_URL=http://127.0.0.1:8899 CLUSTER=localnet MEASUREMENT_ID=0 \
RELAYER_KEYPAIR="$(cat relayer.json)" ALLOWED_ORIGIN=http://localhost:3000 \
pnpm --filter @tio/gateway start
```

Boot refuses to start (exit 1) unless:

- the enclave answers;
- the registry entry `MEASUREMENT_ID` is active and holds the enclave's
  attester;
- the bank accepts the enclave's FIU key.

When the bank isn't on a private network, set the same `BANK_TOKEN` on both
services. The gateway sends it as `authorization: Bearer …` on every bank
call.

- All variables: FORMATS §16 → Config, and `.env.example`.
- Deploying to devnet (Oyster + Azure Container Apps): `docs/DEPLOY.md`.

## Test

```sh
pnpm --filter @tio/gateway test
```

- **Unit tests** use fakes, with one negative test per relay shape rule.
- **Surfpool suites** cover the relayer, the registry and the loan relay. Run
  `anchor build` first. The loan-relay suite sponsors a real borrow and repay
  for a wallet with 0 SOL. It also shows a `policy_hash` switch ending in
  `simulation_failed` 6008.
- **Local end to end** (`src/e2e.local.test.ts`) runs only with `TIO_E2E=1`.
  It starts:
  - the real enclave container (`tio-enclave:dev`, or `TIO_ENCLAVE_IMAGE`);
  - the bank process, with the demo keys;
  - surfnet, with the oracle, SAS and demo-pool;
  - the gateway, on a real port.

  Four personas go through the API, and a tier A wallet borrows.

## Layout

| File | Role |
|---|---|
| `src/main.ts` | Boot order, serve |
| `src/config.ts` | Env validation (`ConfigError`), deployment ids, JCS policy + hash |
| `src/app.ts` | Hono routes, CORS, body cap, rate limit, SSE `complete` |
| `src/flow.ts` | The session flow over injected clients |
| `src/upstream.ts` | Enclave (§10) and bank (§15) HTTP clients |
| `src/fiu-key.ts` | Keeps the bank's copy of the enclave FIU key current |
| `src/relayer.ts`, `src/chain.ts` | The attestation transaction and its retry rules; the chain ports (`Chain`, `RelayChain`) + kit adapter |
| `src/loan-relay.ts` | The sponsored-loan shape check (pure, rules 1–11) |
| `src/loan-relay-flow.ts` | Co-sign → simulate → send → confirm, with the per-wallet in-flight lock and the chain-history check on the borrower's token account |
| `src/sponsorship.ts` | The hourly rent budget |
| `src/registry.ts` | Reads this enclave's registry entry |
| `src/sessions.ts`, `src/rate-limit.ts`, `src/errors.ts`, `src/timeouts.ts` | Session store, token buckets, error bodies, time budgets |

Where the chain code comes from:

- Oracle instructions, PDAs and the registry account: the generated Codama
  client `@tio/oracle-client`.
- Demo-pool instructions: `@tio/demo-pool-client`.
- ATA helpers: `@solana-program/token`.
- The §8 message, the secp256k1 precompile and the SAS reader: the
  hand-written `@tio/oracle-client/attest`.

## Gotchas

- The generated client doesn't load under plain Node. So the gateway runs
  with `node --import tsx`: in `pnpm start`, and in the image's `CMD` from
  `/app/gateway`. See `AGENTS.md` → Gotchas.
