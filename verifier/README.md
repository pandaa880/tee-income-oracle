# `@tio/verifier`

A TypeScript library and CLI that runs off chain, in Node and in the browser.
It lets anyone check that a borrower's tier was signed by an enclave running
the published code. It needs no account and nothing served by us.

**Outside the trust boundary:** it checks the system; the system doesn't
depend on it. The public walkthrough is `docs/VERIFY.md`.

## What it does

For a wallet, it follows this chain:

```text
wallet ─► SAS attestation PDA (owner SAS, 256 B, discriminator 2, 83-byte payload, FORMATS §7)
          │  signer (byte 184) must be the oracle's sas_signer PDA — else the verdict is FAIL
          └─► EnclaveEntry PDA ["enclave", measurement_id] (oracle program, FORMATS §13)
                 └─► Nitro attestation document (archived in deployments/<cluster>/, hash on chain)
```

Then it runs seven checks, in the order the verify page shows them:

| # | id | Passes when |
|---|---|---|
| 1 | `nitro_signature` | COSE_Sign1 ES384 verifies with the leaf key. The chain runs leaf ← intermediates ← `cabundle[0]`, which must be byte-equal to the **pinned AWS Nitro root** (SHA-256 `641a0321…8f79bb5b`). Every certificate is valid at the document's own `timestamp`. CA / keyCertSign / pathLen / ecdsa-with-SHA384 / secp384r1 rules hold |
| 2 | `base_image` | PCR0–2 equal the pinned Marlin Oyster blue v3.0.0 arm64 values. A `--debug` enclave has zeroed PCRs |
| 3 | `compose_pcr16` | PCR16 recomputed from `enclave/docker-compose.yml` at the build's release tag equals the attested PCR16 |
| 4 | `image_id` | `sha256(be32(0x00010007) ‖ PCR0 ‖ PCR1 ‖ PCR2 ‖ PCR16)` equals the registry entry's `measurement` |
| 5 | `attester` | `keccak256(public_key)[12..]` equals the entry's `attester` |
| 6 | `doc_hash` | `sha256(document bytes)` equals the entry's `attestation_doc_hash` |
| 7 | `entry_active` | `measurement_kind == proof_type` and `revoked_at == 0` |

- **Every check runs;** none short-circuits.
- **The verdict is `PASS` only if** all seven checks pass *and* the oracle's
  `sas_signer` wrote the SAS attestation.
- **Details** carry hex, ids, dates and this package's own error codes. They
  never carry text from the document or from a server.

### Why the document is checked at its own timestamp

The leaf certificate lives for three hours. The archived document is
historical evidence, and its hash is on chain. So the verifier checks the
document **at its own timestamp**, not at the current time.

The enclave's live attestation server (`:1301`) signs a fresh document for
each request. A live document can cross-check the attester and the image id.
It never matches the archived hash.

## CLI

From a clone of this repo:

```sh
pnpm --filter @tio/verifier verify -- <wallet> --cluster devnet
```

It reads:

- `deployments/devnet.json`;
- the wallet's SAS attestation and its registry entry, from the public RPC;
- the archived Nitro attestation document named by the deployment record;
- the compose file at the record's `release` tag
  (`git show <tag>:enclave/docker-compose.yml`).

Options: `--deployment <file>`, `--rpc <url>`, `--doc <hex file>`,
`--compose <file>`.

It prints the facts, one `PASS`/`FAIL` line per check, and
`VERDICT PASS|FAIL`.

| Exit code | Meaning |
|---|---|
| 0 | PASS |
| 1 | FAIL |
| 2 | A usage, I/O or chain error (`error: <code>: …` on stderr) |

## Library

| Entry point | What |
|---|---|
| `@tio/verifier` | `verifyWallet({ chain, deployment, wallet, document, composeBytes? })` → report; `verifyDocument({ document, composeBytes?, entry, proofType })` → the seven checks (pure) |
| `@tio/verifier/nitro` | `parseAttestation`, `decodeCoseSign1`, `verifyEs384`, `verifyChain`, `imageId`, `pcr16FromCompose`, the pinned root and PCRs |
| `@tio/verifier/chain` | `ChainReader` port, `kitChainReader(rpc)`, `readAttestation`, `readEntry` |
| `@tio/verifier/deployment` | `parseDeployment(json)` (zod; program ids must equal the client's constants) |
| `@tio/verifier/sources` | `fetchArchivedDocument`, `fetchComposeAtTag`, `fetchLiveDocument`, `parseHexDocument` (fetch, timeouts) |
| `@tio/verifier/report` | `CHECKS`, `formatReport` |
| `@tio/verifier/eth-address` | `ethAddressFromPublicKey`, `toEthHex` (also used by `ops` and the web app's builds aside) |
| `@tio/verifier/errors` | `VerifierError`, `VerifierErrorCode` (the web app maps a thrown one to its `verify_failed` error) |

## Test

```sh
pnpm --filter @tio/verifier test            # every module, against the real devnet documents
pnpm --filter @tio/verifier test:programs   # after anchor build: on an embedded surfnet
```

- `test` checks every module against the two real devnet documents,
  `deployments/devnet/attestation-{0,1}.hex`. It has one negative test per
  rule, same-length DER patches, and a mutation table over the seven checks.
- `test:programs` runs `verifyWallet` and the CLI against the real oracle and
  SAS programs on an embedded surfnet.

## Rules

- **Browser-safe.** Everything outside `src/cli.ts` and `src/node/` has no
  `node:` imports and no `process`. `package-rules.test.ts` enforces this.
- **Crypto:** `@noble/curves` and `@noble/hashes`. They are sync, and behave
  the same in Node, the browser and vitest.
- **Parsing:** CBOR with `cborg`; X.509 with `@peculiar/asn1-x509`.
  Signatures are checked over the raw TBS bytes.
- **Verify against AWS's root,** never against a re-signed summary.

## See also

- Marlin's `oyster-cvm verify` covers checks 1–4. It stays the cross-check
  that `ops` runs at rotation (`docs/DEPLOY.md`).
