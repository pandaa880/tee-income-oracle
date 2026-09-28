# sandbox-bank

Node/TS mock **FIP + AA** that speaks the real ReBIT protocol with test data:
"simulated bank, real protocol". When a real AA replaces it, the enclave code
doesn't change; only the pinned keys and the base URL do.

- Serves three borrower personas (DEPOSIT schema, 6–12 months): salaried/steady,
  lumpy trader, stressed.
- On `POST /FI/request`: verifies the enclave's FIU signature, signs the FI
  JSON with the FIP key, encrypts it to the enclave's session key (Curve25519
  `wei25519` → HKDF → AES-256-GCM), and signs the fetch response with the AA
  key. Also issues the consent artefact.
- **Keys:** the running service uses **demo keys that are never committed**
  (`.env` / secret store). Only their public halves are pinned in the enclave.
- The same crypto module is the **test-vector generator**. It writes
  `test-vectors/` with fixed test keys, including the negative cases (one
  broken layer each; see `docs/FORMATS.md` §11).

**Status:** the generator works (build step 1c); the HTTP service is build
step 4.

```
src/crypto/    encoding, JCS, wei25519, ECDH, AES-GCM session cipher, JWS
               (node:crypto only; no runtime dependencies)
src/rebit/     KeyMaterial, FI request, fetch response + FIP envelope, consent
src/vectors/   personas, policy, test keys, case builder, TS check pipeline,
               generator CLIs (gen-keys.ts, gen-vectors.ts)
```

```bash
pnpm --filter @tio/sandbox-bank test          # vitest
pnpm --filter @tio/sandbox-bank typecheck     # tsc
pnpm --filter @tio/sandbox-bank lint          # oxlint --type-aware
pnpm --filter @tio/sandbox-bank format:check  # oxfmt
pnpm gen:vectors                              # rewrite test-vectors/ (deterministic)
```

Runs on Node 24 with native TypeScript type stripping (no build step).
