# verifier

TS library + CLI, off-chain. Lets anyone check, without trusting us, that the
enclave ran the published code:

1. Fetch the Nitro attestation document from the enclave (Oyster attestation
   server).
2. Verify the COSE_Sign1 signature (ES384) and the certificate chain up to the
   **pinned AWS Nitro root**. Check freshness.
3. Recompute the **image id** from this repo's `enclave/docker-compose.yml`
   and compare it with the attested one.
4. Derive the eth address from the document's `public_key` and compare it with
   the attester registered on chain for that image id.
5. Print PASS/FAIL per check. The web verify page runs the same library.

Marlin's `oyster-cvm verify` covers steps 1–2 as a cross-check, not a
replacement. Verify against AWS's root, never against a re-signed summary.

Not yet implemented. Build step 5.
