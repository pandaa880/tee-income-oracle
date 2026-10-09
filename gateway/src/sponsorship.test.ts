import { type Address, address } from '@solana/kit';
import { describe, expect, it } from 'vitest';

import { ATA_SPONSOR_BURST, ATA_SPONSOR_PER_HOUR, createSponsorshipBudget } from './sponsorship.ts';

const A = address('3gJtuaoBxuAMTvphyRx1KXDHKg2FQfbHCWsvQ4rMgSND');
const B = address('F8K44XAxQ66GWjtpnnTidox81YHcr2VN5ogFofFViCP7');

function setup(burst = 2, perHour = 2) {
  const clock = { t: 1_000_000 };
  const budget = createSponsorshipBudget({ now: () => clock.t, burst, perHour });
  return { clock, budget };
}

describe('createSponsorshipBudget', () => {
  it('funds a wallet once', () => {
    const { budget } = setup();
    expect(budget.available(A)).toBe(true);
    budget.spend(A);
    expect(budget.available(A)).toBe(false);
    expect(budget.available(B)).toBe(true);
  });

  it('caps all wallets at burst, then refills at perHour', () => {
    const { clock, budget } = setup(2, 2); // one token every 30 min
    budget.spend(A);
    budget.spend(B);
    const c: Address = address('991nZUZr63g1pZJ7VQ8GQWk5fVbP7WsuX7crsY5q8qKV');
    expect(budget.available(c)).toBe(false);
    clock.t += 29 * 60_000;
    expect(budget.available(c)).toBe(false);
    clock.t += 60_000;
    expect(budget.available(c)).toBe(true);
  });

  it('never gains tokens from a clock that steps backwards', () => {
    const { clock, budget } = setup(1, 60);
    budget.spend(A);
    clock.t -= 3_600_000;
    expect(budget.available(B)).toBe(false);
  });

  it('exports the production defaults', () => {
    expect(ATA_SPONSOR_BURST).toBe(20);
    expect(ATA_SPONSOR_PER_HOUR).toBe(20);
  });
});
