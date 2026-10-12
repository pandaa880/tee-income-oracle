# `@tio/verifier`

TypeScript library + CLI, off-chain, Node and browser. Lets anyone check, with no
account and nothing served by us, that a borrower's tier was signed by an enclave
running the published code. The public walkthrough is `docs/VERIFY.md`.

## What it proves, for a wallet

```text
wallet ─► SAS attestation PDA (owner SAS, 256 B, discriminator 2, 83-byte payload, FORMATS §7)
          │  signer (byte 184) must be the oracle's sas_signer PDA — else the verdict is FAIL
          └─► EnclaveEntry PDA ["enclave", measurement_id] (oracle program, FORMATS §13)
                 └─► Nitro attestation document (archived in deployments/<cluster>/, hash on chain)
```

Seven checks, in the order of the verify page:

| # | id | passes when |
|---|---|---|
| 1 | `nitro_signature` | COSE_Sign1 ES384 verifies with the leaf key; chain leaf ← intermediates ← `cabundle[0]`, which must be byte-equal to the **pinned AWS Nitro root** (SHA-256 `641a0321…8f79bb5b`); every certificate valid at the document's own `timestamp`; CA / keyCertSign / pathLen / ecdsa-with-SHA384 / secp384r1 rules |
| 2 | `base_image` | PCR0–2 equal the pinned Marlin Oyster blue v3.0.0 arm64 values (a `--debug` enclave has zeroed PCRs) |
| 3 | `compose_pcr16` | PCR16 recomputed from `enclave/docker-compose.yml` at the build's release tag equals the attested PCR16 |
| 4 | `image_id` | `sha256(be32(0x00010007) ‖ PCR0 ‖ PCR1 ‖ PCR2 ‖ PCR16)` equals the registry entry's `measurement` |
| 5 | `attester` | `keccak256(public_key)[12..]` equals the entry's `attester` |
| 6 | `doc_hash` | `sha256(document bytes)` equals the entry's `attestation_doc_hash` |
| 7 | `entry_active` | `measurement_kind == proof_type` and `revoked_at == 0` |

Every check runs (no short-circuit); the verdict is `PASS` only if all seven pass and
the attestation was written by the oracle's `sas_signer`. Details carry hex, ids,
dates and this package's own error codes, never text from the document or a server.

The document is checked **at its own timestamp**: the leaf certificate lives three
hours, and the archived document is historical evidence whose hash is on chain.
The enclave's live attestation server (`:1301`) signs a fresh document per request,
so a live document can cross-check the attester and image id but never matches the
archived hash.

## CLI

From a clone of this repo:

```sh
pnpm --filter @tio/verifier verify -- <wallet> --cluster devnet
```

Reads `deployments/devnet.json`, the wallet's attestation and its registry entry
from the public RPC, the archived document named by the deployment record, and the
compose file at the record's `release` tag (`git show <tag>:enclave/docker-compose.yml`).
Options: `--deployment <file>`, `--rpc <url>`, `--doc <hex file>`, `--compose <file>`.
Prints the facts, one `PASS`/`FAIL` line per check and `VERDICT PASS|FAIL`. Exit 0 on
PASS, 1 on FAIL, 2 for a usage, I/O or chain error (`error: <code>: …` on stderr).

## Library

| Entry point | What |
|---|---|
| `@tio/verifier` | `verifyWallet({ chain, deployment, wallet, document, composeBytes? })` → report; `verifyDocument({ document, composeBytes?, entry, proofType })` → the seven checks (pure) |
| `@tio/verifier/nitro` | `parseAttestation`, `decodeCoseSign1`, `verifyEs384`, `verifyChain`, `imageId`, `pcr16FromCompose`, the pinned root and PCRs |
| `@tio/verifier/chain` | `ChainReader` port, `kitChainReader(rpc)`, `readAttestation`, `readEntry` |
| `@tio/verifier/deployment` | `parseDeployment(json)` (zod; program ids must equal the client's constants) |
| `@tio/verifier/sources` | `fetchArchivedDocument`, `fetchComposeAtTag`, `fetchLiveDocument`, `parseHexDocument` (fetch, timeouts) |
| `@tio/verifier/report` | `CHECKS`, `formatReport` |
| `@tio/verifier/eth-address` | `ethAddressFromPublicKey`, `toEthHex` (also used by `ops`) |

Everything outside `src/cli.ts` and `src/node/` is browser-safe (no `node:` imports, no
`process`; enforced by `package-rules.test.ts`). Crypto is `@noble/curves` /
`@noble/hashes` (sync, identical in Node, browser and vitest); CBOR is `cborg`;
X.509 parsing is `@peculiar/asn1-x509`, with signatures checked over the raw TBS bytes.

## Tests

`pnpm --filter @tio/verifier test`: every module against the two real devnet documents
`deployments/devnet/attestation-{0,1}.hex` (one negative per rule, same-length DER
patches, mutation table over the seven checks). `pnpm --filter @tio/verifier test:programs`
(after `anchor build`): `verifyWallet` and the CLI against the real oracle and SAS
programs on an embedded surfnet.

Marlin's `oyster-cvm verify` covers checks 1–4 and stays the cross-check `ops`
runs at rotation (`docs/DEPLOY.md`). Verify against AWS's root, never against a
re-signed summary.
