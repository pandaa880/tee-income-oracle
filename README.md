# TEE Income Oracle

A borrower consents via India's Account Aggregator rail. Signed bank data is
decrypted, verified, and scored inside an AWS Nitro Enclave — no plaintext
ever exists outside it. The enclave emits a signed risk-tier attestation,
written to Solana via the Solana Attestation Service, that any lending
program can read.

Full docs: pitch, architecture, milestones, licensing — see `docs/`.

## Layout

```
programs/oracle/       Anchor program — holds authorized_attester, writes SAS records.
programs/demo-pool/    Anchor program — reads + verifies an attestation, issues a testnet loan.
enclave/                Rust, runs inside the Nitro enclave. Decrypt, verify, score, sign.
proxy/                  Node/TS, untrusted host. Relays ciphertext to/from the enclave.
verifier/               Node/TS, off-chain. Parses and checks the Nitro attestation document.
web/                    Next.js. Borrower flow, lender dashboard, public verification page.
docs/                   Pitch, milestones, technical overview, licensing.
test-vectors/           Self-signed ReBIT-format test payloads for the verifier's tests.
```

## Tooling (locked 2026-09-24)
- Anchor 1.2.0
- Solana/Agave CLI 4.3.0
- pnpm 12.6.0 (via corepack — `packageManager` field in `package.json`)
- Rust 1.98.0

Two separate build worlds, on purpose:
- **Rust/Anchor** (`programs/*`) — a Cargo workspace, see root `Cargo.toml`.
- **Node/TS** (`proxy/`, `verifier/`, `web/`) — a pnpm workspace, see `pnpm-workspace.yaml`.

`enclave/` is Rust but deliberately **not** in the Cargo workspace — it builds
via Docker + `nitro-cli build-enclave` into a `.eif`, a different pipeline
than `anchor build`.

## Status
Scaffolding only — directory structure and tooling config, no program/service
code yet. See `docs/HACKATHON-STARTER-CHECKLIST-tee-income-oracle.md` for the
next steps (Nitro hello-world, self-signed test payload + Rust JWS verifier).
