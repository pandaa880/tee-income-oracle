// `checkEnclaveEntry` against the real oracle program on an embedded surfnet.
import {
  type Harness,
  bytes,
  initializeOracle,
  registerIx,
  revokeIx,
  send,
  startHarness,
  validEnclave,
} from '@tio/oracle-tests/harness';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { checkEnclaveEntry } from './registry.ts';
import { expectRejected } from './testing/expect-rejected.ts';

const ATTESTER = bytes(20, 0xbb);
const ATTESTER_HEX = '0x' + 'bb'.repeat(20);
const OTHER_HEX = '0x' + 'cc'.repeat(20);
const ACTIVE_ID = 0;
const REVOKED_ID = 1;
const MISSING_ID = 9;

describe('checkEnclaveEntry (surfpool)', { timeout: 120_000 }, () => {
  let h: Harness;

  beforeAll(async () => {
    h = await startHarness();
    await initializeOracle(h);
    await send(h, h.admin, [
      await registerIx(
        h,
        ACTIVE_ID,
        validEnclave({ measurement: bytes(32, 1), attester: ATTESTER }),
      ),
    ]);
    await send(h, h.admin, [
      await registerIx(
        h,
        REVOKED_ID,
        validEnclave({ measurement: bytes(32, 2), attester: ATTESTER }),
      ),
    ]);
    await send(h, h.admin, [await revokeIx(h, REVOKED_ID)]);
  });

  afterAll(() => {
    h.surfnet.stop();
  });

  it('resolves for an active entry whose attester matches', async () => {
    await expect(checkEnclaveEntry(h.rpc, ACTIVE_ID, ATTESTER_HEX)).resolves.toBeUndefined();
  });

  it('compares the attester case-insensitively', async () => {
    await expect(
      checkEnclaveEntry(h.rpc, ACTIVE_ID, '0x' + 'BB'.repeat(20)),
    ).resolves.toBeUndefined();
  });

  it('rejects enclave_not_registered (chain) for an id with no entry', async () => {
    await expectRejected(checkEnclaveEntry(h.rpc, MISSING_ID, ATTESTER_HEX), {
      code: 'enclave_not_registered',
      stage: 'chain',
    });
  });

  it('rejects enclave_revoked (chain) for a revoked entry', async () => {
    await expectRejected(checkEnclaveEntry(h.rpc, REVOKED_ID, ATTESTER_HEX), {
      code: 'enclave_revoked',
      stage: 'chain',
    });
  });

  it('rejects attester_mismatch (chain) when the entry holds another attester', async () => {
    await expectRejected(checkEnclaveEntry(h.rpc, ACTIVE_ID, OTHER_HEX), {
      code: 'attester_mismatch',
      stage: 'chain',
    });
  });
});
