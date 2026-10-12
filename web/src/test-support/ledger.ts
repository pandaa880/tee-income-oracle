// Reads a `LedgerList` row the way a user does: the value shown next to a label. Not a test file.
import { screen } from '@testing-library/react';

/** The text of the `dd` that follows the `dt` with this label (case-insensitive, exact). */
export function ledgerValue(label: string): string | null {
  const wanted = label.toLowerCase();
  const term = screen
    .queryAllByText((_, el) => el?.tagName === 'DT' && el.textContent?.toLowerCase() === wanted)
    .at(0);
  return term?.nextElementSibling?.textContent ?? null;
}
