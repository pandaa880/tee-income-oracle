# proxy

Node/TS service. Runs on the untrusted Nitro EC2 host — deliberately dumb.

- Makes every HTTPS call to the AA (Finvu / Setu / Ink AA) — the enclave has
  no network stack, only a `vsock` channel to this process.
- Relays opaque ciphertext bytes in and out over vsock. **Never decrypts.**
  If this process ever needs plaintext, the design is broken.
- Exposes the public FIU notification endpoints Finvu POSTs to
  (`/Consent/Notification`, `/FI/Notification`, `/Account/link/Notification`)
  behind a real domain + TLS. A notification is only a hint to poll — never
  trusted directly; this process re-fetches from the AA itself before acting.
- Manages IAM/token refresh (Sahamati Central Registry, if used).
- Near-stateless — no borrower database exists anywhere.

Not yet scaffolded — no `package.json` or source yet. This README is a
placeholder.
