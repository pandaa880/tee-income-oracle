# @tio/ui

Standalone React UI package for `web/`: design tokens (light "paper" and dark "carbon
copy"), shadcn-style primitives on Radix, and the "audit ledger" patterns. It knows
nothing about Solana, tiers or the app: props in, events out. Rules:
`docs/CODING-GUIDELINES.md` §3 "Web (Vite SPA) and `@tio/ui`".

A source package: no build step. The consumer (Vite + Tailwind v4) compiles it.

## Using it

CSS, in this order (a remote `@import` is ignored unless it comes first):

```css
@import '@tio/ui/fonts.css';
@import 'tailwindcss';
@import '@tio/ui/tokens.css';
@import '@tio/ui/theme.css';
@source '../../packages/ui/src';
```

Components, one import path each (no barrel):

```tsx
import { Button } from '@tio/ui/button';
import { Seal } from '@tio/ui/seal';
import type { Tone } from '@tio/ui/tokens';
```

## Tokens

| Export | What |
|---|---|
| `./fonts.css` | Google Fonts import (Newsreader, IBM Plex Sans, IBM Plex Mono) |
| `./tokens.css` | CSS variables: colours, type scale, radii, spacing, motion. Dark via `prefers-color-scheme` or `[data-theme=dark]`; motion zeroed under `prefers-reduced-motion` |
| `./theme.css` | Tailwind v4 `@theme inline` map (`bg-card`, `text-tone-positive`, `font-display`, …), Tailwind's default palette removed, `dark:` variant on `[data-theme=dark]`, the `seal-press` animation |
| `./tokens` | `Tone`, `TONES`, `TONE_TEXT`, `TONE_BORDER` |
| `./cn` | `cn(...classes)`: `clsx` + `tailwind-merge` |

`Tone = 'positive' | 'info' | 'caution' | 'negative' | 'accent' | 'neutral'`. Components
take a tone, never a tier or status; `web/` maps those to tones.

## Primitives

| Import | Components | Notes |
|---|---|---|
| `./button` | `Button` | `variant` `default \| outline \| ghost \| link`, `size` `sm \| md \| lg`, `asChild`; 44 px min height |
| `./card` | `Card`, `CardHeader`, `CardTitle`, `CardDescription`, `CardContent`, `CardFooter` | `CardHeader rule="double"` |
| `./badge` | `Badge` | `variant` `default \| outline`, `tone?` |
| `./dialog` | `Dialog`, `DialogTrigger`, `DialogContent`, `DialogHeader`, `DialogTitle`, `DialogDescription`, `DialogFooter`, `DialogClose` | Radix Dialog, portal + scrim |
| `./tabs` | `Tabs`, `TabsList`, `TabsTrigger`, `TabsContent` | Radix Tabs, ledger-style underline |
| `./toast` | `Toaster`, `toast` | Sonner, themed through its CSS variables |
| `./skeleton` | `Skeleton` | |
| `./table` | `Table`, `TableHeader`, `TableBody`, `TableRow`, `TableHead`, `TableCell` | `TableCell numeric` = right-aligned mono |
| `./input` | `Input`, `Label` | |
| `./accordion` | `Accordion`, `AccordionItem`, `AccordionTrigger`, `AccordionContent` | Radix Accordion |

## Patterns

| Import | Component | Props |
|---|---|---|
| `./ledger` | `LedgerList`, `LedgerRow` | row: `label`, `value` (ReactNode), `mono?`, `tone?`, `strong?` (double rule) |
| `./seal` | `Seal` | `tone`, `label`, `letter?`, `caption?`; pressed-stamp entrance |
| `./stepper` | `Stepper` | `steps: { label, state: 'done' \| 'current' \| 'todo' }[]` |
| `./status-badge` | `StatusBadge` | `tone`, `label` |
| `./schematic` | `Schematic` | `nodes: { id, label, x, y }[]` (x, y in percent), `edges: { from, to, active? }[]`, `width?`, `height?`; square drawing, fills its container without a size |
| `./flow-strip` | `FlowStrip` | `items: { label, note }[]`, `bracket?: { from, to, label }` (inclusive, zero-based) |
| `./proof-bar` | `ProofBar` | `items: { label, href? }[]`; links open with `rel="noopener noreferrer"` |
| `./theme-toggle` | `ThemeToggle` | sets `data-theme` on `<html>`, remembers it in `localStorage` |

Every component takes `className`. List labels (stepper, flow strip, proof bar) must be
unique: they are the React keys.

## Development

```sh
pnpm --filter @tio/ui typecheck
pnpm --filter @tio/ui lint
pnpm --filter @tio/ui format:check
pnpm --filter @tio/ui test
```

Tests run on happy-dom with Testing Library, beside each component. Two guard suites:
`src/rules.test.ts` (no colour literals, no imports from Solana / web / `@tio/*`, one
`exports` entry per component folder, no barrel) and `src/tokens/tokens.test.ts` (WCAG
contrast ≥ 4.5:1 for text and tone pairs in both themes, the two dark blocks equal,
reduced motion). Adding a component: new folder, test beside it, `exports` entry.
