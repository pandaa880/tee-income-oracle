# web

Vite + React single-page app, built on `@tio/ui` (`packages/ui`). Three surfaces, one app:

- **Borrower flow** — connect wallet → consent (simulated AA consent UI,
  disclosed as simulated, styled to match the real ReBIT/Sahamati flow) →
  processing → tier result → loan offer → confirmation with explorer link.
- **Loan book** — incoming attestations, loans issued, pool stats.
  Reads the chain via RPC.
- **Public verification page** — attestation, timestamp, enclave image id,
  live PASS/FAIL from `verifier/`, explorer link. The judge/regulator-facing proof
  surface.

All three are untrusted clients — no privileged logic lives here.

Not yet implemented; `packages/ui` is the component library it will use.
