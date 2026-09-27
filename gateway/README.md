# gateway

Node/TS service, **untrusted by design**. It runs on our own server, not the
enclave host, and talks to the enclave over the network (Oyster provides
enclave networking).

- Orchestrates sessions for the web app: create session → borrower signs the
  intent → FI request → fetch → evaluate.
- **Carries only ciphertext or signed bytes**, base64 of the exact bytes so
  nothing re-serializes them. It can delay or drop them, but it can't read or
  forge them.
- Pays Solana fees (relayer keypair). It submits `[secp256k1 precompile,
  oracle.submit_attestation]`; the program checks the enclave signature, not
  the payer.
- Holds no bank data and no borrower database. Logs the session id and stage
  only.
- Later (live Finvu path): the AA client plus the public FIU notification
  endpoints (`/Consent/Notification`, `/FI/Notification`,
  `/Account/link/Notification`). A notification is a hint to poll, never
  trusted directly.

Formerly `proxy/`. Not yet implemented. Build step 4.
