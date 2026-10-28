# Verify a tier yourself

Anyone can check, without an account with us and without trusting our servers,
that a wallet's income tier was produced by an AWS Nitro enclave running the
published code of this repo. One command does it; this page says what it proves.

## The idea

The deployed enclave is always a **release tag**, never the newest commit. Three
things must line up: the **source at the tag**, the **image id** the hardware
attested, and the **key** that signs tiers on chain.

```text
GitHub release vX.Y.Z ──► enclave/docker-compose.yml at the tag ──► PCR16 ──┐
                                                                              ├─► image id (recomputed)
Marlin base image (pinned PCR0–2) ────────────────────────────────────────────┘        │ must equal
running enclave ──► attestation document, signed by AWS Nitro ──► image id (attested) ◄┘
                                          └─► attester public key ──► must equal the on-chain registry entry
```

## Run it

From a clone of the repo (Node 24, pnpm):

```sh
pnpm install
pnpm --filter @tio/verifier verify -- <borrower wallet> --cluster devnet
```

No wallet at hand? Two devnet test borrowers from our own runs (verdicts as run on
2026-10-13; a PASS holds only while the build that attested the wallet is active, a
retired build fails for good):

```sh
# tier A, attested by build #1: VERDICT PASS, exit 0
pnpm --filter @tio/verifier verify -- 8Z6Fa1j6WChXyAgxu6bCyPPUVi9mnuPgWTxM7W8cngAp --cluster devnet
# attested by build #0, retired at an enclave restart: "Entry is active" FAIL, exit 1
pnpm --filter @tio/verifier verify -- 9BhCFK5bmPCswYp13r84tBduvZzeEuRa9Wh4kCy9LpPS --cluster devnet
```

Output: the attestation facts (address, tier, dates, which enclave build signed
it), then seven `PASS` / `FAIL` lines, then `VERDICT PASS` or `VERDICT FAIL`.
Exit code 0 only on PASS. The command reads only public data: the Solana RPC,
`deployments/devnet.json`, the archived attestation document in
`deployments/devnet/` and the compose file at the build's release tag.

## What each line proves

| Check | What it proves |
|---|---|
| Signed by AWS Nitro hardware | The document's COSE signature verifies with a certificate chain that ends at the AWS Nitro root compiled into the verifier (SHA-256 `641a0321a3e244efe456463195d606317ed7cdcc3c1756e09893f3c68f79bb5b`, published by AWS). Real Nitro hardware produced it, not a script. |
| Marlin's published base image, not debug mode | PCR0–2 equal Marlin Oyster's blue v3.0.0 arm64 image. A debug enclave (readable console, no attestation of the code) has all-zero PCRs and fails here. |
| Runs our published code | PCR16 is the enclave's commitment to the docker-compose file it booted with. Recomputed from `enclave/docker-compose.yml` at the release tag, which pins the enclave image by digest. |
| Image id matches the registry | The image id derived from the attested PCRs equals the `measurement` the oracle registry stores for this build. |
| Enclave key = on-chain attester | The secp256k1 key in the attestation document, as an Ethereum-style address, equals the registry entry's `attester`: the only key whose signatures the oracle accepts for this build. |
| Same document the registry recorded | The SHA-256 of the archived document equals the hash the registry entry pinned at registration. |
| Entry is active | The entry is not revoked and its kind matches the attestation. Every enclave restart gets a new key, a new entry, and the old one is revoked. |

Besides the seven lines, the verdict needs the attestation to have been written by
the oracle program's `sas_signer` (shown as "written by"). Only the oracle writes
through that signer, after checking the enclave's signature in the same
transaction, so an attestation by any other signer is FAIL whatever its payload.

## What it does not prove

- **That the code is correct.** Attestation proves *which* code ran. The audit
  targets are named in `docs/ARCHITECTURE.md`; nothing has been audited yet.
- **That the registration was honest.** An admin key registers each build after
  checking it off-chain (`ops enclave:rotate`). The checker re-runs that check, and
  every registration is a public event, but a compromised admin could register a
  key whose document would still pass. Beyond the demo the admin should be a
  multisig; later, the chain itself should verify the document.
- **That a lender would accept the tier today.** PASS is about where the tier
  came from, not whether it is still usable. The attestation expires 30 days
  after it was issued (the `tier` line shows the date, and `(EXPIRED)` from the
  expiry second on), and each pool adds its own age, policy and build rules
  (`docs/FORMATS.md` §14).
- **That the bank data was real.** The hackathon bank is a sandbox speaking the
  real ReBIT protocol with demo keys (`docs/ARCHITECTURE.md` §2).

## Trust root

AWS Nitro (the root certificate and the hardware), Marlin's base image, and the
enclave code at the tag. The verifier pins the AWS root and the base-image PCRs;
everything else it derives from public data. To cross-check with Marlin's tool:
`oyster-cvm verify --attestation-hex-file deployments/devnet/attestation-<id>.hex --image-id <image id> --arch arm64`
(what `ops` runs at every rotation, `docs/DEPLOY.md`).

## In the browser

The live app has the same check as a page: `/verify?wallet=<borrower wallet>` on
https://tee-income-oracle-web.vercel.app/. Paste a wallet and the browser runs
`@tio/verifier` itself: it reads the attestation and the registry entry from the
public devnet RPC, takes the archived document from a copy bundled with the page
(the live enclave serves it over plain HTTP, which an HTTPS page cannot fetch; the
document is signed by AWS and its hash is on chain, so who carries it does not
matter), and fetches `enclave/docker-compose.yml` at the build's release tag from
the public repository. The page shows the attestation facts, every registered
build with its chain state, the seven lines with the library's detail, the verdict,
and links to the release, the archived file and the registry entry. Nothing goes
through our gateway. The CLI above does the same from a clone.

Without a wallet, click one of the example borrowers under the box (the two above
and a tier-C one). Try it:
https://tee-income-oracle-web.vercel.app/verify?wallet=8Z6Fa1j6WChXyAgxu6bCyPPUVi9mnuPgWTxM7W8cngAp

The "Enclave source: release vX.Y.Z" link under the checks is the **enclave
build's** release tag (the compose file at that tag produced the running image),
not the app's version in the footer. The two diverge until a new enclave build is
registered.

`verifier/README.md` lists the library's entry points.
