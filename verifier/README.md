# verifier

Node/TS service, off-chain. Independently checks the Nitro Enclave's remote
attestation document — the proof that the enclave ran the exact code it
claims to.

- Parses the COSE_Sign1-signed attestation document.
- Verifies the PCR measurements and the certificate chain up to AWS's own
  Nitro root.
- Confirms the enclave's public key (embedded in the document) is bound to
  the expected PCR0 code measurement.
- Prints PASS / FAIL. This is shown live on stage — "it's in a TEE" is a
  claim until this runs; after, it's proof.

Later: the one-command public verifier (`npx @project/verify <wallet>`) is
a small standalone package in this spirit — reads devnet, derives the PDA,
checks the signer, prints the result, with no backend of ours involved.

Not yet scaffolded — no `package.json` or source yet. This README is a
placeholder.
