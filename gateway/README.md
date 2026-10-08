# gateway

Node/TS service, **untrusted by design**. It runs on our own server, not the
enclave host, and is the web's only server. The HTTP API (routes, SSE events,
error codes, limits, config) is `docs/FORMATS.md` §16.

- **Orchestrates a session**: `POST /v1/sessions` gets an AA-signed consent
  from the bank and opens an enclave session; the borrower's wallet signs the
  returned intent; `POST /v1/sessions/{id}/complete` then binds, carries the
  FI request and fetch response, evaluates, and streams each stage over SSE.
- **Carries only signed or encrypted bytes**, as the exact bytes, so nothing
  re-serializes them. It can delay or drop them, but it can't read or forge
  them.
- **Relays the result**: one v0 transaction `[compute limit, secp256k1
  precompile, oracle.submit_attestation]` paid by the relayer keypair. The
  program checks the enclave signature, not the payer. Idempotent: the oracle
  needs a strictly newer `issued_at` per wallet, so a resend can't land twice.
- Holds no bank data and no borrower database (open sessions live in memory
  for 600 s). Logs the session id, stage and error code only.
- Later (live Finvu path): the AA client plus the public FIU notification
  endpoints. A notification is a hint to poll, never trusted directly.

## Run

```text
ENCLAVE_URL=http://127.0.0.1:8080 BANK_URL=http://127.0.0.1:8081 \
SOLANA_RPC_URL=http://127.0.0.1:8899 CLUSTER=localnet MEASUREMENT_ID=0 \
RELAYER_KEYPAIR="$(cat relayer.json)" ALLOWED_ORIGIN=http://localhost:3000 \
pnpm --filter @tio/gateway start
```

Boot refuses to start (exit 1) unless the enclave answers, its registry entry
`MEASUREMENT_ID` is active with the enclave's attester, and the bank accepts
the enclave's FIU key. When the bank isn't on a private network, set the same
`BANK_TOKEN` on both: the gateway sends it as `authorization: Bearer …` on
every bank call. All variables: FORMATS §16 → Config, and `.env.example`.
Deploying to devnet (Oyster + Azure Container Apps): `docs/DEPLOY.md`.

Docker (context = repo root; secrets only from the environment):

```text
docker build -f gateway/Dockerfile -t tio-gateway:dev .
```

Azure Container Apps runs `linux/amd64`: an image built on Apple Silicon is
arm64 by default, so build the deployed one with
`docker buildx build --platform linux/amd64 …`.

## Code

| File | Role |
|---|---|
| `src/main.ts` | boot order, serve |
| `src/config.ts` | env validation (`ConfigError`), deployment ids, JCS policy + hash |
| `src/app.ts` | Hono routes, CORS, body cap, rate limit, SSE `complete` |
| `src/flow.ts` | the session flow over injected clients |
| `src/upstream.ts` | enclave (§10) and bank (§15) HTTP clients |
| `src/fiu-key.ts` | keeps the bank's copy of the enclave FIU key current |
| `src/relayer.ts`, `src/chain.ts` | the attestation transaction and its retry rules; the chain port + kit adapter |
| `src/registry.ts` | reads this enclave's registry entry |
| `src/sessions.ts`, `src/rate-limit.ts`, `src/errors.ts`, `src/timeouts.ts` | session store, token buckets, error bodies, time budgets |

Oracle instructions, PDAs and the registry account come from the generated
Codama client (`@tio/oracle-client`); the §8 message, the secp256k1
precompile and the SAS reader from the hand-written
`@tio/oracle-client/attest`. The generated client doesn't load under plain
Node, so the gateway runs with `node --import tsx` (`pnpm start`, and the
image's `CMD` from `/app/gateway`; see AGENTS.md Gotchas).

## Tests

`pnpm --filter @tio/gateway test`: unit tests with fakes, plus relayer and
registry suites on an embedded surfpool (run `anchor build` first). The local
end-to-end test (`src/e2e.local.test.ts`) runs only with `TIO_E2E=1`: the
real enclave container (`tio-enclave:dev`, or `TIO_ENCLAVE_IMAGE`), the bank
process with the demo keys, surfnet with the oracle, SAS and demo-pool, and
the gateway on a real port; four personas go through the API and a tier A
wallet borrows.
