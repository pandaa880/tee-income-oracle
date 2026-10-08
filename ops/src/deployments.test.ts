import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mergeDeployment, readDeployment, writeDeployment } from './deployments.ts';

// The nine keys `sas:setup` writes (see `Deployment` in sas-setup.ts).
const SAS_KEYS = {
  cluster: 'localnet',
  sas_program: 'sas',
  oracle_program: 'oracle',
  sas_signer: 'signer',
  authority: 'authority',
  credential: 'credential',
  schema: 'schema',
  schema_name: 'tio-income-tier',
  schema_version: 1,
};

describe('mergeDeployment', () => {
  it('returns_the_update_when_there_is_no_existing_file', () => {
    expect(mergeDeployment(null, { a: 1 })).toEqual({ a: 1 });
  });

  it('keeps_existing_keys_the_update_does_not_mention', () => {
    expect(mergeDeployment({ pools: [{ address: 'p' }], a: 1 }, { a: 2 })).toEqual({
      pools: [{ address: 'p' }],
      a: 2,
    });
  });

  it('lets_the_update_win_on_conflict', () => {
    expect(mergeDeployment({ a: 1 }, { a: 2 })).toEqual({ a: 2 });
  });

  it('is_shallow_so_an_updated_array_replaces_the_old_one', () => {
    expect(mergeDeployment({ pools: [1, 2] }, { pools: [3] })).toEqual({ pools: [3] });
  });

  it('does_not_mutate_its_inputs', () => {
    const existing = { a: 1 };
    const update = { b: 2 };
    mergeDeployment(existing, update);
    expect(existing).toEqual({ a: 1 });
    expect(update).toEqual({ b: 2 });
  });

  it('sas_setup_keys_merged_onto_a_file_with_pools_keep_pools', () => {
    const existing = { ...SAS_KEYS, pools: [{ address: 'pool', pool_id: 0 }], mint: 'mint' };
    const merged = mergeDeployment(existing, { ...SAS_KEYS, credential: 'credential2' });
    expect(merged['pools']).toEqual([{ address: 'pool', pool_id: 0 }]);
    expect(merged['mint']).toBe('mint');
    expect(merged['credential']).toBe('credential2');
  });
});

describe('readDeployment / writeDeployment', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'deployments-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('reads_null_when_the_file_is_missing', async () => {
    expect(await readDeployment(join(dir, 'nope.json'))).toBeNull();
  });

  it('round_trips_a_value', async () => {
    const path = join(dir, 'devnet.json');
    await writeDeployment(path, { a: 1, nested: { b: [1, 2] } });
    expect(await readDeployment(path)).toEqual({ a: 1, nested: { b: [1, 2] } });
  });

  it('writes_two_space_json_with_a_trailing_newline', async () => {
    const path = join(dir, 'devnet.json');
    await writeDeployment(path, { a: 1 });
    expect(await readFile(path, 'utf8')).toBe('{\n  "a": 1\n}\n');
  });

  it('creates_missing_parent_directories', async () => {
    const path = join(dir, 'deep', 'er', 'x.json');
    await writeDeployment(path, { a: 1 });
    expect(await readDeployment(path)).toEqual({ a: 1 });
  });

  it('overwrites_an_existing_file', async () => {
    const path = join(dir, 'x.json');
    await writeFile(path, '{"old":true}\n');
    await writeDeployment(path, { fresh: true });
    expect(await readDeployment(path)).toEqual({ fresh: true });
  });

  it('writes_through_a_temporary_file_and_leaves_none_behind', async () => {
    const path = join(dir, 'devnet.json');
    await writeFile(path, '{"old":true}\n');
    await writeDeployment(path, { fresh: true });
    expect(await readdir(dir)).toEqual(['devnet.json']);
  });

  it('rejects_a_file_that_is_not_json_instead_of_treating_it_as_missing', async () => {
    const path = join(dir, 'bad.json');
    await writeFile(path, 'not json');
    await expect(readDeployment(path)).rejects.toThrow(SyntaxError);
  });
});
