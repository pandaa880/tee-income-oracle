import { describe, expect, it } from 'vitest';
import { reduceFi } from './reduce.ts';

// reduceFi reads the FI JSON the generator emitted (FORMATS §1): amounts as
// JSON numbers, balances as strings, narration as free text. Money must come
// from the exact number text, never through a float.

interface RawTxn {
  readonly type?: string;
  readonly amount: string; // JSON number text, kept verbatim
  readonly balance?: string; // string payload, without quotes
  readonly at?: string;
  readonly narration?: string;
}

function txnJson(t: RawTxn): string {
  const fields = [
    `"type":"${t.type ?? 'CREDIT'}"`,
    '"mode":"FT"',
    `"amount":${t.amount}`,
    `"currentBalance":"${t.balance ?? '100.00'}"`,
    `"transactionTimestamp":"${t.at ?? '2026-01-05T10:00:00.000+0000'}"`,
  ];
  if (t.narration !== undefined) {
    fields.push(`"narration":${JSON.stringify(t.narration)}`);
  }
  return `{${fields.join(',')}}`;
}

function fiText(txns: readonly RawTxn[], start = '2026-01-01', end = '2026-03-31'): string {
  return (
    '{"type":"DEPOSIT","version":"2.0",' +
    `"Transactions":{"startDate":"${start}","endDate":"${end}",` +
    `"Transaction":[${txns.map(txnJson).join(',')}]}}`
  );
}

function amountOf(text: string): bigint {
  const first = reduceFi(fiText([{ amount: text }])).txns[0];
  if (first === undefined) {
    throw new Error('expected one transaction');
  }
  return first.amount;
}

function balanceOf(text: string): bigint {
  const first = reduceFi(fiText([{ amount: '1', balance: text }])).txns[0];
  if (first === undefined) {
    throw new Error('expected one transaction');
  }
  return first.balance;
}

function flagsOf(narration: string): { bounce: boolean; emiWord: boolean } {
  const first = reduceFi(fiText([{ amount: '1', type: 'DEBIT', narration }])).txns[0];
  if (first === undefined) {
    throw new Error('expected one transaction');
  }
  return { bounce: first.bounce, emiWord: first.emiWord };
}

describe('reduceFi money', () => {
  it('reads 0.07 as 7 paise (a float would give 7.000000000000001)', () => {
    expect(amountOf('0.07')).toBe(7n);
  });

  it('reads 1234.05 as 123405 paise', () => {
    expect(amountOf('1234.05')).toBe(123_405n);
  });

  it('reads an integer amount as whole rupees', () => {
    expect(amountOf('85000')).toBe(8_500_000n);
  });

  it('reads one decimal digit as tens of paise', () => {
    expect(amountOf('1.5')).toBe(150n);
  });

  it('reads the exponent form 1.2E7 as 1200000000 paise', () => {
    expect(amountOf('1.2E7')).toBe(1_200_000_000n);
  });

  it('reads lowercase and signed exponents', () => {
    expect(amountOf('1e2')).toBe(10_000n);
    expect(amountOf('1.2e+7')).toBe(1_200_000_000n);
    expect(amountOf('1.5e-1')).toBe(15n);
  });

  it('keeps full precision beyond 2^53 paise', () => {
    // 90071992547409.93 rupees = 9007199254740993 paise = 2^53 + 1.
    expect(amountOf('90071992547409.93')).toBe(9_007_199_254_740_993n);
  });

  it('reads a negative balance string exactly', () => {
    expect(balanceOf('-12.05')).toBe(-1205n);
  });

  it('reads positive balance strings exactly', () => {
    expect(balanceOf('175614.64')).toBe(17_561_464n);
    expect(balanceOf('0.00')).toBe(0n);
  });
});

describe('reduceFi transactions', () => {
  it('reads the transaction type ignoring ASCII case (as rebit.rs)', () => {
    expect(reduceFi(fiText([{ amount: '1', type: 'credit' }])).txns[0]?.credit).toBe(true);
    expect(reduceFi(fiText([{ amount: '1', type: 'Debit' }])).txns[0]?.credit).toBe(false);
  });

  it('maps CREDIT to credit true and DEBIT to credit false', () => {
    const fi = reduceFi(
      fiText([
        { type: 'CREDIT', amount: '1' },
        { type: 'DEBIT', amount: '1' },
      ]),
    );
    expect(fi.txns.map((t) => t.credit)).toEqual([true, false]);
  });

  it('keeps transactions in input order', () => {
    const fi = reduceFi(fiText([{ amount: '1' }, { amount: '2' }, { amount: '3' }]));
    expect(fi.txns.map((t) => t.amount)).toEqual([100n, 200n, 300n]);
  });

  it('reads the timestamp as unix seconds', () => {
    const utc = reduceFi(fiText([{ amount: '1', at: '2026-01-05T10:00:00.000+0000' }])).txns[0];
    expect(utc?.at).toBe(1_767_607_200);
  });

  it('converts a +05:30 timestamp to UTC seconds', () => {
    const ist = reduceFi(fiText([{ amount: '1', at: '2026-01-05T10:00:00+05:30' }])).txns[0];
    expect(ist?.at).toBe(1_767_587_400);
  });

  it('reads startDate and endDate as days since 1970-01-01', () => {
    const fi = reduceFi(fiText([{ amount: '1' }]));
    expect(fi.startDay).toBe(20_454);
    expect(fi.endDay).toBe(20_543);
  });

  it('reduces a statement with no transactions to an empty list', () => {
    expect(reduceFi(fiText([])).txns).toEqual([]);
  });
});

describe('reduceFi narration flags (same tokens as tio-core rebit.rs)', () => {
  it('has no flags without a narration', () => {
    const first = reduceFi(fiText([{ amount: '1', type: 'DEBIT' }])).txns[0];
    expect(first?.bounce).toBe(false);
    expect(first?.emiWord).toBe(false);
  });

  it('has no flags for an ordinary narration', () => {
    expect(flagsOf('UPI-GROCERY STORE')).toEqual({ bounce: false, emiWord: false });
  });

  it.each(['EMI', 'LOAN', 'NACH', 'ECS'])('flags the EMI token %s', (token) => {
    expect(flagsOf(`ACH DR ${token} 8841`)).toEqual({ bounce: false, emiWord: true });
  });

  it.each(['RTN', 'RETURN', 'RETURNED', 'BOUNCE', 'INSUFF'])(
    'flags the bounce token %s',
    (token) => {
      expect(flagsOf(`CHRG ${token} 8841`)).toEqual({ bounce: true, emiWord: false });
    },
  );

  it('sets both flags when both kinds of token appear', () => {
    expect(flagsOf('ACH RTN CHRG EMI BOUNCE')).toEqual({ bounce: true, emiWord: true });
  });

  it('matches tokens ignoring case', () => {
    expect(flagsOf('nach debit emi')).toEqual({ bounce: false, emiWord: true });
    expect(flagsOf('Returned cheque')).toEqual({ bounce: true, emiWord: false });
  });

  it('splits tokens on every non-alphanumeric character', () => {
    expect(flagsOf('ACH_D-HOME/LOAN.EMI#12')).toEqual({ bounce: false, emiWord: true });
    expect(flagsOf('UPI/RTN-REFUND')).toEqual({ bounce: true, emiWord: false });
  });

  it('ignores non-ASCII look-alikes that upper-case onto ASCII tokens (as rebit.rs)', () => {
    expect(flagsOf('ACH emı')).toEqual({ bounce: false, emiWord: false }); // dotless i
    expect(flagsOf('CHRG inſuff')).toEqual({ bounce: false, emiWord: false }); // long s
    expect(flagsOf('CHRG INSUﬀ')).toEqual({ bounce: false, emiWord: false }); // ff ligature
  });

  it('matches whole tokens only, not substrings', () => {
    expect(flagsOf('EMIRATES AIRLINE')).toEqual({ bounce: false, emiWord: false });
    expect(flagsOf('LOANS DESK')).toEqual({ bounce: false, emiWord: false });
    expect(flagsOf('RETURNING CUSTOMER')).toEqual({ bounce: false, emiWord: false });
    expect(flagsOf('PREMIUM BOUNCEBACK')).toEqual({ bounce: false, emiWord: false });
  });
});
