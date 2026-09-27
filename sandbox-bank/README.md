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

Not yet implemented. The generator is part of build step 1; the service is
build step 4.
