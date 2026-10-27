# web

A Vite + React single-page app, built on `@tio/ui` (`packages/ui`).
**Untrusted client:** no privileged logic lives here. It checks what the
gateway reports against the chain before showing it.

## What it does

One app, three surfaces:

- **Borrower flow:** connect a wallet → consent → processing → tier result →
  loan offer → confirmation with an explorer link. The consent screen is a
  simulated AA consent UI. It says it is simulated, and it is styled to match
  the real ReBIT/Sahamati flow.
- **Loan book:** the view a credit vehicle gets of the loans it funds, per
  pool. It shows:
  - the funder's policy: hash, published-default marker, tier limits,
    freshness rules, approved enclave builds;
  - principal outstanding, utilization, open loans, the vault and the tier
    mix;
  - every open loan, with the health of the credential behind it.

  It is read-only, and it reads from chain.
- **Public verification page:** the SAS attestation, timestamp, enclave
  image id, live PASS/FAIL from `verifier/`, and an explorer link. This is
  the proof surface for judges and regulators.

## Routes

| Route | Page |
|---|---|
| `/` | Landing: the receipts thesis with an example receipt, proof bar, what a funder can check on every loan, how it works (data-path schematic), borrower and lender doors, the pilot ask, live status strip |
| `/borrow[?pool=0\|1]` | Borrower flow: demo wallet → bank account (4 sandbox personas) → consent (signs the exact §9 intent, 10-minute countdown) → live stages → result or REJECT. The loan book's "Borrow now" sets `?pool=`; the default is pool 0 |
| `/loan?pool=0\|1` | Loan screen, one tab per pool: borrow up to `min(tier limit, vault)`, the open loan, repay. It reads only the chain, so a reload or a returning wallet lands in the right state |
| `/book?pool=0\|1` | Loan book, one tab per pool: policy card, KPIs, tier mix, and every open loan (tier at borrow, amount, time out, tier age, build, credential badge, explorer links). Re-read every 30 s. A badge judges the borrower's current SAS attestation by the pool's own borrow checks: fresh, stale, build retired, old policy, … |
| `/verify[?wallet=…]` | Verify page: paste a wallet, or click one of three devnet example borrowers (`domain/example-wallets.ts`). The browser runs `@tio/verifier`'s seven checks itself (`docs/VERIFY.md`). It shows the SAS attestation facts (address, written by, policy, dates, build), the registered builds with their chain state, the seven PASS/FAIL rows with the library's detail, the verdict, links (release tag, archived document, registry entry) and the equivalent CLI line. No gateway involved |

- The borrow, loan, book and verify pages load lazily.
- `app/config.ts` `features` gates nav items and CTAs. Both flags (`verify`,
  `book`) are on.
  - `verify` adds the Verify nav item and the "Anyone can check it" links.
  - `book` adds the Loan book nav item and the lender door's link. While it
    is off, both are hidden and the lender door shows a NEXT badge.

## What the pages trust

The gateway is untrusted. The browser:

- rebuilds the intent before the wallet signs it;
- checks the result against the wallet's SAS attestation PDA and payload;
- confirms a relayed loan by verifying the relayer's signature over its own
  message, and by reading the Loan account.

### Borrower flow and loan page

- A tier is shown only once a chain read holds exactly the payload the
  gateway reported. Until then, the page says it is reading the tier back.
- The tier, dates, build and pool limits all come from that chain read.
- "Registered on Solana" appears only when the registry entry was read and
  matches.
- If the stream drops after the intent was signed, the page polls the chain
  for the SAS attestation. A failure before that is a plain error.

### Loan book

The loan book trusts the RPC no more than the gateway:

- every `getProgramAccounts` row is re-checked: owner, size, discriminator,
  pool, the borrower's Loan PDA, no duplicates;
- a batched read must return one account per key;
- a SAS attestation must sit at its borrower's PDA;
- one bad row fails the whole read, rather than showing a partial book;
- a failed background re-read keeps the last good book, and says when it was
  read.

### Verify page

The verify page trusts none of its inputs either:

- **The archived Nitro attestation document** ships inside the app, one lazy
  chunk per file, from the same build as `deployments/devnet.json`. It is
  checked against the hash the registry pinned.
- **The compose file** is fetched from the public repository at the build's
  release tag. It only has to reproduce PCR16.
- **The chain** is read as raw accounts and decoded by the verifier's own
  readers.
- Everything shown as verified (tier, dates, "written by", the verdict) comes
  from the library's report. The deployment file only supplies links.
- A wallet without a SAS attestation gets an error card, not a FAIL.
- If a re-check fails (on a refocus after the result went stale), the result
  stays on screen. A warning says when the checks ran, like the loan book's
  failed re-read.

## Browser support

The demo wallet needs WebCrypto Ed25519, and the app uses `AbortSignal.any`.
That means Chrome or Edge 137+, Firefox 129+, Safari 17.4+. Older browsers get
an error page instead of a blank one.

## Run

```sh
pnpm --filter @tio/web dev          # http://localhost:5173
pnpm --filter @tio/web build        # → web/dist
pnpm --filter @tio/web preview      # serve the build
```

- `dev` reads `.env.development`, which holds public values only.
- The gateway is reached through the dev proxy `/gw` (`vite.config.ts`), so
  the gateway's CORS origin can stay the Vercel one.
- `GATEWAY_PROXY_TARGET` points the proxy elsewhere, e.g.
  `http://localhost:8082`. It has no `VITE_` prefix, so it is never bundled.

## Test

```sh
pnpm --filter @tio/web typecheck && pnpm --filter @tio/web lint \
  && pnpm --filter @tio/web format:check && pnpm --filter @tio/web test
```

Two tests (`domain/loan-tx.test.ts`, `app/use-loan.test.tsx`) import
`gateway/src/loan-relay.ts` directly. The relayer's own shape check is the
reference for the transactions the browser builds, so a change there can
fail the web tests on purpose.

## Deploy (Vercel)

A static build on Vercel. `vercel.json` holds the SPA rewrite (missing
`/assets/*` stay 404) and the security headers.

Project settings that can't live in `vercel.json`:

- Root directory `web`, framework Vite, and "Include files outside the root
  directory" on. The build needs `packages/ui` and the root lockfile.
- `ENABLE_EXPERIMENTAL_COREPACK=1`, so Vercel uses the repo's
  `packageManager` (pnpm 12) instead of picking pnpm 9/10 from the lockfile
  version.
- Node.js 24.x.
- Production variables: `VITE_GATEWAY_URL` (the Azure gateway),
  `VITE_RPC_URL=https://api.devnet.solana.com` and `VITE_CLUSTER=devnet`.

The gateway URL lives in three places, which must agree:

- `VITE_GATEWAY_URL` on Vercel;
- the `connect-src` of the CSP in `vercel.json`;
- the dev proxy default in `vite.config.ts`.

The gateway's `ALLOWED_ORIGIN` must be exactly the Vercel production origin.

`connect-src` also allows `https://raw.githubusercontent.com`. The verify
page reads only `enclave/docker-compose.yml` from there, at the build's
release tag.

## Layout

Four layers, with dependencies pointing inward
(`docs/CODING-GUIDELINES.md` §3). `src/architecture.test.ts` enforces this.

| Folder | What |
|---|---|
| `src/domain/` | Pure rules: credential status (the pool's borrow checks, in order), the loan book (rows, KPIs, tier mix), the verify view (report → rows, headline, links) and build rows, the §9 intent check, loan-transaction builders, the flow reducer, amounts, error messages, tones |
| `src/adapters/` | One module per outside system: gateway (live SSE), relay, Solana RPC (429 backoff, `getMultipleAccounts` in chunks of 100, decoded or raw, `getProgramAccounts` for a pool's Loans), confirmation polling, storage, the demo wallet, the verifier's sources (bundled archived documents, compose at a tag) and its chain reader over the RPC port |
| `src/app/` | Config (incl. the deployment file as the verifier reads it), deps, one hook per use case (`use-borrow-flow`, `use-credential`, `use-pool`, `use-loan`, `use-book`, `use-verification`, `use-builds`, `use-status`, `use-countdown`) |
| `src/pages/`, `src/routes/` | Composition only: `pages/layout`, `pages/home`, `pages/borrow`, `pages/loan`, `pages/book`, `pages/verify` |

## Gotchas

- **CSS order:** `src/styles.css` imports `@tio/ui/fonts.css` first, because
  a remote `@import` must lead. Then come Tailwind, the tokens and the theme.
  `@source` points at `packages/ui/src`.
- **`VITE_*` values are compiled into the public bundle.** Never put a secret
  or a keyed RPC URL in one.
