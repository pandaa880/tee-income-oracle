import { describe, expect, it } from 'vitest';

import { gatewayError } from './errors.ts';
import { createFiuKeyManager } from './fiu-key.ts';
import { expectRejected } from './testing/expect-rejected.ts';

const ATTESTER = '0x' + 'ab'.repeat(20);

type InfoState = { kid: string; attester: string; sig: string };

function setup(initial: Partial<InfoState> = {}, expectedAttester = ATTESTER) {
  const state: InfoState = { kid: 'fiu-1', attester: ATTESTER, sig: '11'.repeat(65), ...initial };
  const registered: { fiu_public_jwk: { kid: string }; fiu_key_signature_hex: string }[] = [];
  const counts = { info: 0 };
  const failure: { next: Error | undefined } = { next: undefined };
  const enclave = {
    info: async () => {
      counts.info += 1;
      return {
        app_version: '0.1.0',
        attester_address: state.attester,
        fiu_public_jwk: { kid: state.kid, kty: 'RSA', e: 'AQAB', n: 'abc' },
        fiu_key_signature_hex: state.sig,
        pinned_kids: ['aa-1', 'fip-1'],
      };
    },
  };
  const bank = {
    registerFiuKey: async (body: {
      fiu_public_jwk: { kid: string };
      fiu_key_signature_hex: string;
    }) => {
      if (failure.next !== undefined) throw failure.next;
      registered.push(body);
      return { kid: body.fiu_public_jwk.kid, attester: state.attester };
    },
  };
  const manager = createFiuKeyManager({ enclave, bank, expectedAttester });
  return { state, registered, counts, failure, manager };
}

describe('createFiuKeyManager', () => {
  it('registers the enclave FIU key with the bank on the first call, with info values unchanged', async () => {
    const t = setup();
    await t.manager.ensureFresh();
    expect(t.registered).toHaveLength(1);
    expect(t.registered[0]?.fiu_public_jwk.kid).toBe('fiu-1');
    expect(t.registered[0]?.fiu_key_signature_hex).toBe('11'.repeat(65));
  });

  it('asks the enclave for its info on every call but registers once while the kid is unchanged', async () => {
    const t = setup();
    await t.manager.ensureFresh();
    await t.manager.ensureFresh();
    await t.manager.ensureFresh();
    expect(t.counts.info).toBe(3);
    expect(t.registered).toHaveLength(1);
  });

  it('re-registers when the kid changes', async () => {
    const t = setup();
    await t.manager.ensureFresh();
    t.state.kid = 'fiu-2';
    t.state.sig = '22'.repeat(65);
    await t.manager.ensureFresh();
    expect(t.registered.map((r) => r.fiu_public_jwk.kid)).toEqual(['fiu-1', 'fiu-2']);
    await t.manager.ensureFresh();
    expect(t.registered).toHaveLength(2);
  });

  it('compares the attester case-insensitively', async () => {
    const t = setup({ attester: '0x' + 'AB'.repeat(20) });
    await t.manager.ensureFresh();
    expect(t.registered).toHaveLength(1);
  });

  it('fails with enclave_rotated 503 (stage enclave) when the attester differs, and registers nothing', async () => {
    const t = setup({ attester: '0x' + 'cd'.repeat(20) });
    await expectRejected(t.manager.ensureFresh(), {
      code: 'enclave_rotated',
      stage: 'enclave',
      status: 503,
    });
    expect(t.registered).toEqual([]);
  });

  it('fails with enclave_rotated when the attester changes after a successful registration', async () => {
    const t = setup();
    await t.manager.ensureFresh();
    t.state.attester = '0x' + 'cd'.repeat(20);
    await expectRejected(t.manager.ensureFresh(), {
      code: 'enclave_rotated',
      stage: 'enclave',
      status: 503,
    });
  });

  it('markStale forces a re-register on the next call even with the same kid', async () => {
    const t = setup();
    await t.manager.ensureFresh();
    t.manager.markStale();
    await t.manager.ensureFresh();
    expect(t.registered).toHaveLength(2);
    await t.manager.ensureFresh();
    expect(t.registered).toHaveLength(2);
  });

  it('passes a bank registration failure through and retries on the next call', async () => {
    const t = setup();
    t.failure.next = gatewayError('Unauthorized', 'bank', 401);
    await expectRejected(t.manager.ensureFresh(), {
      code: 'Unauthorized',
      stage: 'bank',
      status: 401,
    });
    t.failure.next = undefined;
    await t.manager.ensureFresh();
    expect(t.registered).toHaveLength(1);
  });

  it('passes an enclave info failure through', async () => {
    const t = setup();
    const failing = createFiuKeyManager({
      enclave: {
        info: async () => {
          throw gatewayError('upstream_unavailable', 'enclave', 502);
        },
      },
      bank: { registerFiuKey: async () => ({ kid: 'x', attester: ATTESTER }) },
      expectedAttester: ATTESTER,
    });
    await expectRejected(failing.ensureFresh(), {
      code: 'upstream_unavailable',
      stage: 'enclave',
      status: 502,
    });
    expect(t.registered).toEqual([]);
  });
});
