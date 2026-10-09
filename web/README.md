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

Today the app is a placeholder home page composed from `@tio/ui` (its sample seal is
labelled as an example); the surfaces above are not built yet.

## Run

```sh
pnpm --filter @tio/web dev          # http://localhost:5173
pnpm --filter @tio/web build        # → web/dist
pnpm --filter @tio/web preview      # serve the build
pnpm --filter @tio/web typecheck && pnpm --filter @tio/web lint \
  && pnpm --filter @tio/web format:check && pnpm --filter @tio/web test
```

Styles: `src/styles.css` imports `@tio/ui/fonts.css` first (a remote `@import` must lead),
then Tailwind, the tokens and the theme, and points `@source` at `packages/ui/src`.

## Deploy (Vercel)

Static build on Vercel; `vercel.json` holds the SPA rewrite (missing `/assets/*` stay 404) and
security headers. Project settings that can't live in `vercel.json`:

- Root directory `web`, framework Vite, "Include files outside the root directory" on
  (the build needs `packages/ui` and the root lockfile).
- `ENABLE_EXPERIMENTAL_COREPACK=1`, so Vercel uses the repo's `packageManager` (pnpm 12)
  instead of picking pnpm 9/10 from the lockfile version.
- Node.js 24.x.
- `VITE_*` variables are compiled into the public bundle: never put a secret or a keyed
  RPC URL in them.
