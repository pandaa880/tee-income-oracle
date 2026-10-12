import { parseDeployment } from '@tio/verifier/deployment';
import { describe, expect, it } from 'vitest';
import devnet from '../../../deployments/devnet.json';
import { buildRows, buildTone } from './builds.ts';
import { entry } from '../test-support/fixtures.ts';

const [RECORD_0, RECORD_1] = parseDeployment(devnet).enclaves;
if (RECORD_0 === undefined || RECORD_1 === undefined)
  throw new Error('devnet.json lists no builds');

// The fixture entry registers at 1_790_000_000.
const REGISTERED = 1_790_000_000n;
const REVOKED = 1_790_000_100n;

describe('buildRows', () => {
  it('marks an entry without a revocation as active, with its registration time', () => {
    const [row] = buildRows([RECORD_1], [entry({ measurementId: 1 })]);
    expect(row).toMatchObject({
      id: 1,
      status: 'active',
      registeredAt: REGISTERED,
      revokedAt: null,
    });
  });

  it('marks a revoked entry as revoked, with the revocation time', () => {
    const [row] = buildRows([RECORD_0], [entry({ measurementId: 0, revokedAt: REVOKED })]);
    expect(row).toMatchObject({
      id: 0,
      status: 'revoked',
      registeredAt: REGISTERED,
      revokedAt: REVOKED,
    });
  });

  it('marks a build with no entry on chain as unknown, with no times', () => {
    const [row] = buildRows([RECORD_1], [null]);
    expect(row).toMatchObject({ id: 1, status: 'unknown', registeredAt: null, revokedAt: null });
  });

  it('shows the attester the chain entry holds, in full with its 0x prefix', () => {
    // The fixture entry carries 0xc3…c3; the record says 0xb6dd…: the chain value wins.
    const [row] = buildRows([RECORD_1], [entry({ measurementId: 1 })]);
    expect(row?.attester).toBe(`0x${'c3'.repeat(20)}`);
  });

  it('falls back to the attester of the deployment record only when the chain has no entry', () => {
    const [row] = buildRows([RECORD_1], [null]);
    expect(row?.attester).toBe('0xb6dda6eed87322334ba37809bd451a852ae6574c');
  });

  it('maps each status to its own tone', () => {
    expect(buildTone('active')).toBe('positive');
    expect(buildTone('revoked')).toBe('neutral');
    expect(buildTone('unknown')).toBe('caution');
  });

  it('lists the newest build first, whatever order the records come in', () => {
    const entries = [entry({ measurementId: 0, revokedAt: REVOKED }), entry({ measurementId: 1 })];
    const rows = buildRows([RECORD_0, RECORD_1], entries);
    expect(rows.map((r) => [r.id, r.status])).toEqual([
      [1, 'active'],
      [0, 'revoked'],
    ]);
  });

  it('pairs each entry with the record at the same position, also when the input is newest first', () => {
    const entries = [entry({ measurementId: 1 }), entry({ measurementId: 0, revokedAt: REVOKED })];
    const rows = buildRows([RECORD_1, RECORD_0], entries);
    expect(rows.map((r) => [r.id, r.status])).toEqual([
      [1, 'active'],
      [0, 'revoked'],
    ]);
  });

  it('keeps one build unknown without touching the status of the others', () => {
    const rows = buildRows([RECORD_0, RECORD_1], [entry({ measurementId: 0 }), null]);
    expect(rows.map((r) => [r.id, r.status])).toEqual([
      [1, 'unknown'],
      [0, 'active'],
    ]);
  });

  it('is empty for a deployment without builds', () => {
    expect(buildRows([], [])).toEqual([]);
  });
});
