import { describe, expect, it } from 'vitest';
import { hasMeasurementBit, setMeasurementBit } from './bitmap.ts';
import { type EntryView, type NewEnclave, type PoolView, planRotate } from './rotate-plan.ts';

const ACTIVE = 0n;
const REVOKED = 1_790_000_000n;

const imageId = (n: number) => new Uint8Array(32).fill(n);
const attester = (n: number) => new Uint8Array(20).fill(n);

const enclave = (n: number): NewEnclave => ({
  imageId: imageId(n),
  attester: attester(n),
  docHash: new Uint8Array(32).fill(0xdd),
});

function entry(id: number, n: number, revokedAt = ACTIVE): EntryView {
  return { measurementId: id, measurement: imageId(n), attester: attester(n), revokedAt };
}

function bitmap(...ids: number[]): Uint8Array {
  return ids.reduce((acc, id) => setMeasurementBit(acc, id), new Uint8Array(32));
}

function pool(address: string, ...ids: number[]): PoolView {
  return { address, approvedMeasurements: bitmap(...ids) };
}

function plan(o: {
  next: number;
  entries?: EntryView[];
  pools?: PoolView[];
  enclave?: NewEnclave;
}) {
  return planRotate({
    nextMeasurementId: o.next,
    entries: o.entries ?? [],
    pools: o.pools ?? [],
    enclave: o.enclave ?? enclave(1),
  });
}

describe('planRotate', () => {
  it('first_rotation_registers_id_zero_and_revokes_nothing', () => {
    expect(plan({ next: 0 })).toEqual({
      measurementId: 0,
      register: true,
      poolUpdates: [],
      revoke: [],
    });
  });

  it('first_rotation_sets_bit_zero_in_an_empty_pool', () => {
    const result = plan({ next: 0, pools: [pool('P')] });
    expect(result.poolUpdates).toEqual([{ address: 'P', approvedMeasurements: bitmap(0) }]);
  });

  it('second_rotation_registers_id_one_revokes_zero_and_moves_the_pool_bit', () => {
    const result = plan({
      next: 1,
      entries: [entry(0, 1)],
      pools: [pool('P', 0)],
      enclave: enclave(2),
    });
    expect(result.measurementId).toBe(1);
    expect(result.register).toBe(true);
    expect(result.revoke).toEqual([0]);
    expect(result.poolUpdates).toEqual([{ address: 'P', approvedMeasurements: bitmap(1) }]);
  });

  it('rerun_after_full_success_changes_nothing', () => {
    const result = plan({
      next: 2,
      entries: [entry(0, 1, REVOKED), entry(1, 2)],
      pools: [pool('P', 1)],
      enclave: enclave(2),
    });
    expect(result).toEqual({ measurementId: 1, register: false, poolUpdates: [], revoke: [] });
  });

  it('rerun_after_partial_failure_reuses_the_entry_and_finishes_the_rest', () => {
    // Registered as id 1, the pool still approves 0, and 0 is still active.
    const result = plan({
      next: 2,
      entries: [entry(0, 1), entry(1, 2)],
      pools: [pool('P', 0)],
      enclave: enclave(2),
    });
    expect(result.measurementId).toBe(1);
    expect(result.register).toBe(false);
    expect(result.revoke).toEqual([0]);
    expect(result.poolUpdates).toEqual([{ address: 'P', approvedMeasurements: bitmap(1) }]);
  });

  it('registers_a_new_id_when_the_active_entry_has_the_same_attester_but_another_image', () => {
    const existing: EntryView = { ...entry(0, 1), measurement: imageId(9) };
    const result = plan({ next: 1, entries: [existing], enclave: enclave(1) });
    expect(result.register).toBe(true);
    expect(result.measurementId).toBe(1);
    expect(result.revoke).toEqual([0]);
  });

  it('registers_a_new_id_when_the_active_entry_has_the_same_image_but_another_attester', () => {
    const existing: EntryView = { ...entry(0, 1), attester: attester(9) };
    const result = plan({ next: 1, entries: [existing], enclave: enclave(1) });
    expect(result.register).toBe(true);
    expect(result.measurementId).toBe(1);
    expect(result.revoke).toEqual([0]);
  });

  it('does_not_reuse_a_matching_entry_that_is_revoked', () => {
    const result = plan({ next: 1, entries: [entry(0, 1, REVOKED)], enclave: enclave(1) });
    expect(result.register).toBe(true);
    expect(result.measurementId).toBe(1);
  });

  it('ignores_revoked_entries_when_choosing_what_to_revoke', () => {
    const result = plan({
      next: 3,
      entries: [entry(0, 1, REVOKED), entry(1, 2, REVOKED), entry(2, 3)],
      enclave: enclave(4),
    });
    expect(result.revoke).toEqual([2]);
  });

  it('revokes_every_other_active_entry_in_ascending_order', () => {
    const result = plan({
      next: 4,
      entries: [entry(2, 3), entry(0, 1), entry(3, 4), entry(1, 2, REVOKED)],
      pools: [pool('P', 0, 2, 3)],
      enclave: enclave(5),
    });
    expect(result.revoke).toEqual([0, 2, 3]);
    expect(result.poolUpdates).toEqual([{ address: 'P', approvedMeasurements: bitmap(4) }]);
  });

  it('omits_pools_that_already_match', () => {
    const result = plan({
      next: 2,
      entries: [entry(0, 1), entry(1, 2)],
      pools: [pool('done', 1), pool('todo', 0)],
      enclave: enclave(2),
    });
    expect(result.poolUpdates.map((u) => u.address)).toEqual(['todo']);
  });

  it('leaves_bits_of_unrelated_ids_alone', () => {
    // Bit 5 belongs to no entry the plan touches.
    const result = plan({
      next: 1,
      entries: [entry(0, 1)],
      pools: [pool('P', 0, 5)],
      enclave: enclave(2),
    });
    expect(result.poolUpdates).toEqual([{ address: 'P', approvedMeasurements: bitmap(1, 5) }]);
  });

  it('keeps_pool_order_in_the_updates', () => {
    const result = plan({ next: 0, pools: [pool('b'), pool('a'), pool('c')] });
    expect(result.poolUpdates.map((u) => u.address)).toEqual(['b', 'a', 'c']);
  });

  it('does_not_mutate_its_input_bitmaps', () => {
    const p = pool('P', 0);
    const before = new Uint8Array(p.approvedMeasurements);
    plan({ next: 1, entries: [entry(0, 1)], pools: [p], enclave: enclave(2) });
    expect(p.approvedMeasurements).toEqual(before);
  });

  it.each([7, 8, 254])('sets_the_right_bit_for_id_%i', (id) => {
    const result = plan({ next: id, pools: [pool('P')] });
    expect(result.measurementId).toBe(id);
    const update = result.poolUpdates[0];
    expect(update).toBeDefined();
    const updated = update?.approvedMeasurements ?? new Uint8Array(0);
    expect(hasMeasurementBit(updated, id)).toBe(true);
    expect(updated[Math.floor(id / 8)]).toBe(1 << (id % 8));
  });

  it.each([7, 8, 254])('clears_the_right_bit_for_revoked_id_%i', (id) => {
    const newId = 100;
    const result = plan({
      next: newId,
      entries: [entry(id, 1)],
      pools: [pool('P', id)],
      enclave: enclave(2),
    });
    expect(result.revoke).toEqual([id]);
    expect(result.poolUpdates).toEqual([{ address: 'P', approvedMeasurements: bitmap(newId) }]);
  });

  it('registers_at_254_the_last_usable_id', () => {
    expect(plan({ next: 254 }).measurementId).toBe(254);
  });

  it('throws_registry_full_when_a_new_entry_would_need_id_255', () => {
    expect(() => plan({ next: 255 })).toThrow(/registry full/);
  });

  it('does_not_throw_at_255_when_an_existing_entry_is_reused', () => {
    const result = plan({
      next: 255,
      entries: [entry(254, 1)],
      enclave: enclave(1),
    });
    expect(result.register).toBe(false);
    expect(result.measurementId).toBe(254);
  });
});
