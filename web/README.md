# web

Next.js frontend. Three surfaces, one app:

- **Borrower flow** — connect wallet → consent (simulated AA consent UI,
  disclosed as simulated, styled to match the real ReBIT/Sahamati flow) →
  processing → tier result → loan offer → confirmation with explorer link.
- **Lender dashboard** — incoming attestations, loans issued, pool stats.
  Reads the chain via RPC.
- **Public verification page** — attestation hash, timestamp, enclave
  measurement, PASS badge, explorer link. The judge/regulator-facing proof
  surface.

All three are untrusted clients — no privileged logic lives here.

Not yet scaffolded — no `package.json` or source yet. This README is a
placeholder.
