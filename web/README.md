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

## Routes

| Route | Page |
|---|---|
| `/` | Landing: hero, proof bar, how it works (data-path schematic), borrower and lender doors, final CTA, live status strip |
| `/borrow` | Borrower flow: demo wallet → bank account (4 sandbox personas) → consent (signs the exact §9 intent, 10-minute countdown) → live stages → result or REJECT |
| `/loan?pool=0\|1` | Loan screen, one tab per pool: borrow up to `min(tier limit, vault)`, the open loan, repay. Reads only the chain, so a reload or a returning wallet lands in the right state |

The borrow and loan pages load lazily. `app/config.ts` `features` gates what isn't shipped yet:
`verify` (5b) adds the Verify nav item and "Anyone can check it" links, `book` (5c) adds the
Loan book nav item and the lender door's link; while off, they are hidden and the lender door
shows a NEXT badge.

What the pages trust: a tier is shown only once a chain read holds exactly the payload the
gateway reported (until then the page says it is reading the tier back), and its tier, dates,
build and pool limits come from that read. "Registered on Solana" appears only when the
registry entry was read and matches. A dropped stream after the intent was signed polls the
chain for the attestation; a failure before that is a plain error.

## Layout

Four layers, dependencies pointing inward (`docs/CODING-GUIDELINES.md` §3; enforced by
`src/architecture.test.ts`):

| Folder | What |
|---|---|
| `src/domain/` | Pure rules: credential status (the pool's borrow checks, in order), the §9 intent check, loan-transaction builders, the flow reducer, amounts, error messages, tones |
| `src/adapters/` | One module per outside system: gateway (live SSE), relay, Solana RPC (429 backoff), confirmation polling, storage, the demo wallet |
| `src/app/` | Config, deps, one hook per use case (`use-borrow-flow`, `use-credential`, `use-pool`, `use-loan`, `use-status`, `use-countdown`) |
| `src/pages/`, `src/routes/` | Composition only: `pages/layout`, `pages/home`, `pages/borrow`, `pages/loan` |

Two tests (`domain/loan-tx.test.ts`, `app/use-loan.test.tsx`) import `gateway/src/loan-relay.ts`
directly: the relayer's own shape check is the oracle for the transactions the browser builds,
so a change there can fail the web tests on purpose.

The gateway is untrusted: the browser rebuilds the intent before signing, checks the result
against the wallet's attestation PDA and payload, shows it only once the chain holds the same
payload, and confirms a relayed loan by verifying the relayer's signature over its own message
and reading the Loan account.

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

## Local dev

`pnpm --filter @tio/web dev` reads `.env.development` (public values only). The gateway is
reached through the dev proxy `/gw` (`vite.config.ts`), so its CORS origin can stay the Vercel
one; `GATEWAY_PROXY_TARGET` (no `VITE_` prefix, never bundled) points it elsewhere, e.g.
`http://localhost:8082`.

## Browser support

The demo wallet needs WebCrypto Ed25519 and the app uses `AbortSignal.any`: Chrome or Edge
137+, Firefox 129+, Safari 17.4+. Older browsers get an error page instead of a blank one.

## Deploy (Vercel)

Static build on Vercel; `vercel.json` holds the SPA rewrite (missing `/assets/*` stay 404) and
security headers. Project settings that can't live in `vercel.json`:

- Root directory `web`, framework Vite, "Include files outside the root directory" on
  (the build needs `packages/ui` and the root lockfile).
- `ENABLE_EXPERIMENTAL_COREPACK=1`, so Vercel uses the repo's `packageManager` (pnpm 12)
  instead of picking pnpm 9/10 from the lockfile version.
- Node.js 24.x.
- `VITE_*` variables are compiled into the public bundle: never put a secret or a keyed
  RPC URL in them. Production uses `VITE_GATEWAY_URL` (the Azure gateway),
  `VITE_RPC_URL=https://api.devnet.solana.com` and `VITE_CLUSTER=devnet`.
- The gateway URL lives in three places that must agree: `VITE_GATEWAY_URL` on Vercel, the
  `connect-src` of the CSP in `vercel.json`, and the dev proxy default in `vite.config.ts`.
  The gateway's `ALLOWED_ORIGIN` must be exactly the Vercel production origin.
