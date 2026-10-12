# web

Vite + React single-page app, built on `@tio/ui` (`packages/ui`). Three surfaces, one app:

- **Borrower flow** — connect wallet → consent (simulated AA consent UI,
  disclosed as simulated, styled to match the real ReBIT/Sahamati flow) →
  processing → tier result → loan offer → confirmation with explorer link.
- **Loan book** — the view a credit vehicle gets of the loans it funds, per pool: the
  funder's policy (hash, published-default marker, tier limits, freshness rules, approved
  enclave builds), principal outstanding, utilization, open loans, vault, the tier mix, and
  every open loan with the health of the credential behind it. Read-only, from chain.
- **Public verification page** — attestation, timestamp, enclave image id,
  live PASS/FAIL from `verifier/`, explorer link. The judge/regulator-facing proof
  surface.

All three are untrusted clients — no privileged logic lives here.

## Routes

| Route | Page |
|---|---|
| `/` | Landing: the receipts thesis with an example receipt, proof bar, what a funder can check on every loan, how it works (data-path schematic), borrower and lender doors, the pilot ask, live status strip |
| `/borrow[?pool=0\|1]` | Borrower flow: demo wallet → bank account (4 sandbox personas) → consent (signs the exact §9 intent, 10-minute countdown) → live stages → result or REJECT. `?pool=` (from the loan book) is where "Borrow now" goes; default pool 0 |
| `/loan?pool=0\|1` | Loan screen, one tab per pool: borrow up to `min(tier limit, vault)`, the open loan, repay. Reads only the chain, so a reload or a returning wallet lands in the right state |
| `/book?pool=0\|1` | Loan book, one tab per pool: policy card, KPIs, tier mix, every open loan (tier at borrow, amount, time out, tier age, build, credential badge, explorer links), re-read every 30 s (a failed re-read keeps the last book and says when it was read). A badge judges the borrower's current attestation by the pool's own borrow checks (fresh, stale, build retired, old policy, …) |
| `/verify[?wallet=…]` | Verify page: paste a wallet and the browser runs `@tio/verifier`'s seven checks itself (`docs/VERIFY.md`): the attestation facts (address, written by, policy, dates, build), the registered builds with their chain state, the seven PASS/FAIL rows with the library's detail, the verdict, links to the release tag, the archived document and the registry entry, and the equivalent CLI line. No gateway involved |

The borrow, loan, book and verify pages load lazily. `app/config.ts` `features` gates nav
items and CTAs per PR; both flags (`verify`, `book`) are on. `verify` adds the Verify nav item
and the "Anyone can check it" links; `book` adds the Loan book nav item and the lender door's
link (while off, they are hidden and the lender door shows a NEXT badge).

What the pages trust: a tier is shown only once a chain read holds exactly the payload the
gateway reported (until then the page says it is reading the tier back), and its tier, dates,
build and pool limits come from that read. "Registered on Solana" appears only when the
registry entry was read and matches. A dropped stream after the intent was signed polls the
chain for the attestation; a failure before that is a plain error. The loan book trusts the
RPC no more than that: every `getProgramAccounts` row is re-checked (owner, size,
discriminator, pool, the borrower's Loan PDA, no duplicates), a batched read must return one
account per key, an attestation must sit at its borrower's PDA, and one bad row fails the whole
read rather than showing a partial book. A failed background re-read keeps the last good book.

The verify page trusts none of its inputs either: the archived attestation document ships
inside the app (one lazy chunk per file, from the same build as `deployments/devnet.json`) and
is checked against the hash the registry pinned; the compose file is fetched from the public
repository at the build's release tag and only has to reproduce PCR16; the chain is read as raw
accounts and decoded by the verifier's own readers. Everything shown as verified (tier, dates,
"written by", the verdict) comes from the library's report; the deployment file only supplies
links. A wallet without an attestation is an error card, not a FAIL. A re-check that fails
(a refocus after the result went stale) keeps the result on screen with a warning that says
when the checks ran, like the loan book's failed re-read.

## Layout

Four layers, dependencies pointing inward (`docs/CODING-GUIDELINES.md` §3; enforced by
`src/architecture.test.ts`):

| Folder | What |
|---|---|
| `src/domain/` | Pure rules: credential status (the pool's borrow checks, in order), the loan book (rows, KPIs, tier mix), the verify view (report → rows, headline, links) and build rows, the §9 intent check, loan-transaction builders, the flow reducer, amounts, error messages, tones |
| `src/adapters/` | One module per outside system: gateway (live SSE), relay, Solana RPC (429 backoff, `getMultipleAccounts` in chunks of 100, decoded or raw, `getProgramAccounts` for a pool's Loans), confirmation polling, storage, the demo wallet, the verifier's sources (bundled archived documents, compose at a tag) and its chain reader over the RPC port |
| `src/app/` | Config (incl. the deployment file as the verifier reads it), deps, one hook per use case (`use-borrow-flow`, `use-credential`, `use-pool`, `use-loan`, `use-book`, `use-verification`, `use-builds`, `use-status`, `use-countdown`) |
| `src/pages/`, `src/routes/` | Composition only: `pages/layout`, `pages/home`, `pages/borrow`, `pages/loan`, `pages/book`, `pages/verify` |

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
- `connect-src` also allows `https://raw.githubusercontent.com`: the verify page reads
  `enclave/docker-compose.yml` at the build's release tag from there (nothing else).
