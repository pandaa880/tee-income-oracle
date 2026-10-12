// Local end-to-end (TIO_E2E=1): real enclave container + real sandbox-bank process + surfnet with
// the real oracle, SAS and demo-pool programs, and the gateway on a real HTTP port. Four personas go
// through the gateway API; tiers land in SAS and a tier A wallet borrows from a pool.
//
// Needs: docker image `tio-enclave:dev` (or $TIO_ENCLAVE_IMAGE); demo keys in $TIO_SECRETS_DIR (default: the repo's
// sandbox-bank/.secrets); the ops admin wallet ~/.config/solana/tee-income-oracle.json.
import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { serve } from '@hono/node-server';
import {
  type Address,
  type KeyPairSigner,
  address,
  createKeyPairSignerFromBytes,
  generateKeyPairSigner,
  getBase58Decoder,
  createSignableMessage,
} from '@solana/kit';
import { DEMO_POOL_PROGRAM_ADDRESS } from '@tio/demo-pool-client';
import { ORACLE_PROGRAM_ADDRESS } from '@tio/oracle-client';
import { SAS_PROGRAM_ID, SAS_SO_PATH } from '@tio/ops/sas-schema';
import { runSasSetup } from '@tio/ops/sas-setup';
import {
  attestationAddress,
  enclaveKey,
  fetchRaw,
  readAttestation,
} from '@tio/oracle-tests/attest';
import {
  type Harness,
  initializeOracle,
  registerIx,
  send,
  startHarness,
  validEnclave,
} from '@tio/oracle-tests/harness';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  type PoolFixture,
  approve,
  borrow,
  createPool,
  fundVault,
} from '../../programs/demo-pool/tests/src/pool-fixture.ts';
import { createAta, createMint, tokenBalance } from '../../programs/demo-pool/tests/src/token.ts';
import { createApp } from './app.ts';
import { kitChain } from './chain.ts';
import { createFiuKeyManager } from './fiu-key.ts';
import { createRateLimiter } from './rate-limit.ts';
import { checkEnclaveEntry } from './registry.ts';
import { createRelayer } from './relayer.ts';
import { fakeLoanRelay } from './testing/fake-relay.ts';
import { createSessionStore } from './sessions.ts';
import { parseSse, stageNames } from './testing/sse.ts';
import { createBankClient, createEnclaveClient } from './upstream.ts';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const LAMPORTS = 1_000_000_000;
const ENCLAVE_PORT = 18180;
const BANK_PORT = 18191;
const ENCLAVE = `http://127.0.0.1:${ENCLAVE_PORT}`;
const BANK = `http://127.0.0.1:${BANK_PORT}`;
const CONTAINER = 'tio-enclave-gateway-e2e';
const MEASUREMENT_ID = 0;
const TEN_YEARS_SECS = 315_360_000;

const EXPECTED = {
  salaried_steady: 'A',
  trader_lumpy: 'B',
  declining: 'C',
  stressed: 'REJECT',
} as const;

function secretsDir(): string {
  const fromEnv = process.env['TIO_SECRETS_DIR'];
  if (fromEnv !== undefined) return fromEnv;
  const inCheckout = join(ROOT, 'sandbox-bank/.secrets');
  if (existsSync(inCheckout)) return inCheckout;
  // A git worktree lives at <main>/.claude/worktrees/<name>.
  return join(ROOT, '../../../sandbox-bank/.secrets');
}

async function waitFor(url: string, ms = 60_000): Promise<void> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(`timed out waiting for ${url}`);
}

function fromHex(s: string): Uint8Array {
  return new Uint8Array(Buffer.from(s.replace(/^0x/, ''), 'hex'));
}

function numberArray(value: unknown): number[] {
  if (!Array.isArray(value) || !value.every((n) => typeof n === 'number')) {
    throw new Error('expected a JSON array of numbers');
  }
  return value;
}

async function jsonObject(res: Response): Promise<Record<string, unknown>> {
  const parsed: unknown = await res.json();
  if (typeof parsed !== 'object' || parsed === null) throw new Error('expected a JSON object');
  return Object.fromEntries(Object.entries(parsed));
}

function unixNow(): number {
  return Math.floor(Date.now() / 1000);
}

describe.skipIf(process.env['TIO_E2E'] !== '1')('gateway end to end (local)', () => {
  let h: Harness;
  let bank: ChildProcess | undefined;
  let closeServer: (() => void) | undefined;
  let gateway = '';
  let credential: Address;
  let schema: Address;
  let policyHashHex = '';
  const bankLog: string[] = [];
  const winners = new Map<string, { wallet: KeyPairSigner; tx: string }>();

  beforeAll(async () => {
    // Chain: oracle + SAS (credential and schema from the ops admin, so they equal the enclave's
    // compiled-in ids) + demo-pool.
    h = await startHarness();
    h.surfnet.deploy({ programId: SAS_PROGRAM_ID, soPath: SAS_SO_PATH });
    h.surfnet.deploy({
      programId: DEMO_POOL_PROGRAM_ADDRESS,
      soPath: join(ROOT, 'target/deploy/demo_pool.so'),
    });
    const opsAdmin = await createKeyPairSignerFromBytes(
      new Uint8Array(
        numberArray(
          JSON.parse(
            readFileSync(join(homedir(), '.config/solana/tee-income-oracle.json'), 'utf8'),
          ),
        ),
      ),
    );
    h.surfnet.fundSol(opsAdmin.address, 100 * LAMPORTS);
    const { deployment } = await runSasSetup({
      rpc: h.rpc,
      rpcSubscriptions: h.rpcSubscriptions,
      admin: opsAdmin,
      oracleProgramId: ORACLE_PROGRAM_ADDRESS,
      cluster: 'localnet',
    });
    credential = address(deployment.credential);
    schema = address(deployment.schema);
    await initializeOracle(h);

    // Enclave container with a fresh attester key.
    const keyFile = join(tmpdir(), `tio-gw-e2e-ecdsa-${process.pid}.sec`);
    writeFileSync(keyFile, randomBytes(32), { mode: 0o600 });
    try {
      execFileSync('docker', ['rm', '-f', CONTAINER], { stdio: 'ignore' });
    } catch {
      // none running
    }
    execFileSync('docker', [
      'run',
      '-d',
      '--name',
      CONTAINER,
      '-p',
      `${ENCLAVE_PORT}:8080`,
      '-v',
      `${keyFile}:/app/ecdsa.sec:ro`,
      process.env['TIO_ENCLAVE_IMAGE'] ?? 'tio-enclave:dev',
    ]);
    await waitFor(`${ENCLAVE}/v1/info`);
    const enclave = createEnclaveClient(ENCLAVE);
    const info = await enclave.info();
    await send(h, h.admin, [
      await registerIx(
        h,
        MEASUREMENT_ID,
        validEnclave({ attester: fromHex(info.attester_address) }),
      ),
    ]);

    // Bank process against the surfnet.
    const secrets = secretsDir();
    bank = spawn('node', [join(ROOT, 'sandbox-bank/src/service/main.ts')], {
      env: {
        ...process.env,
        SANDBOX_AA_PRIVATE_JWK: readFileSync(join(secrets, 'aa.demo-private.jwk.json'), 'utf8'),
        SANDBOX_FIP_PRIVATE_JWK: readFileSync(join(secrets, 'fip.demo-private.jwk.json'), 'utf8'),
        SOLANA_RPC_URL: h.surfnet.rpcUrl,
        PORT: String(BANK_PORT),
        PINNED_DIR: join(ROOT, 'enclave/pinned'),
        BANK_ALLOW_NO_TOKEN: '1', // local bank, reached only by this test
      },
    });
    bank.stdout?.on('data', (d: Buffer) => bankLog.push(d.toString()));
    bank.stderr?.on('data', (d: Buffer) => bankLog.push(d.toString()));
    await waitFor(`${BANK}/health`);

    // The gateway, in process, with the real clients and relayer, on a real port.
    await checkEnclaveEntry(h.rpc, MEASUREMENT_ID, info.attester_address);
    const bankClient = createBankClient(BANK);
    const fiuKey = createFiuKeyManager({
      enclave,
      bank: bankClient,
      expectedAttester: info.attester_address,
    });
    await fiuKey.ensureFresh();
    const policy: unknown = JSON.parse(
      readFileSync(join(ROOT, 'test-vectors/policy/default.json'), 'utf8'),
    );
    policyHashHex = readFileSync(join(ROOT, 'test-vectors/policy/default.hash'), 'utf8').trim();
    const app = createApp({
      enclave,
      bank: bankClient,
      relayer: createRelayer({
        chain: kitChain(h.rpc, h.rpcSubscriptions),
        payer: h.attacker,
        deployment: {
          oracleProgram: ORACLE_PROGRAM_ADDRESS,
          credential,
          schema,
          sasProgram: SAS_PROGRAM_ID,
          pools: [],
        },
        measurementId: MEASUREMENT_ID,
      }),
      // Loan relay is covered by loan-relay.surfpool.test.ts; this E2E exercises the session flow.
      loanRelay: fakeLoanRelay(),
      sessions: createSessionStore({ now: unixNow }),
      fiuKey,
      policy,
      measurementId: MEASUREMENT_ID,
      now: unixNow,
      rateLimiter: createRateLimiter({ now: () => Date.now() }),
      config: {
        allowedOrigin: 'http://localhost:3000',
        trustProxy: false,
        info: {
          cluster: 'localnet',
          oracle_program: ORACLE_PROGRAM_ADDRESS,
          credential,
          schema,
          measurement_id: MEASUREMENT_ID,
          policy_hash: policyHashHex,
          attester_address: info.attester_address,
          relayer: h.attacker.address,
        },
      },
    });
    const port = await new Promise<number>((resolve) => {
      const server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }, (listening) => {
        resolve(listening.port);
      });
      closeServer = () => {
        server.close();
      };
    });
    gateway = `http://127.0.0.1:${port}`;
  }, 300_000);

  afterAll(() => {
    closeServer?.();
    bank?.kill('SIGTERM');
    try {
      execFileSync('docker', ['rm', '-f', CONTAINER], { stdio: 'ignore' });
    } catch {
      // already gone
    }
    h?.surfnet.stop();
    if (bankLog.length > 0) console.error(`bank log:\n${bankLog.join('')}`);
  });

  it('serves /v1/info with the policy hash of the default policy', async () => {
    const res = await fetch(`${gateway}/v1/info`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      cluster: 'localnet',
      measurement_id: MEASUREMENT_ID,
      policy_hash: policyHashHex,
    });
  });

  it.each(Object.entries(EXPECTED))(
    '%s: create, sign the intent, complete over SSE gives tier %s',
    async (persona, tier) => {
      const wallet = await generateKeyPairSigner();
      const created = await fetch(`${gateway}/v1/sessions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ wallet: wallet.address, persona_id: persona }),
      });
      expect({ status: created.status, body: await created.clone().text() }).toMatchObject({
        status: 200,
      });
      const session = await jsonObject(created);
      const [signed] = await wallet.signMessages([
        createSignableMessage(new TextEncoder().encode(String(session['intent']))),
      ]);
      const signature = signed?.[wallet.address];
      if (signature === undefined) throw new Error('wallet did not sign the intent');

      const completed = await fetch(
        `${gateway}/v1/sessions/${String(session['session_id'])}/complete`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ signature_b58: getBase58Decoder().decode(signature) }),
        },
      );
      expect(completed.status).toBe(200);
      expect(completed.headers.get('content-type')).toContain('text/event-stream');
      const events = parseSse(await completed.text());
      const last = events.at(-1);

      if (tier === 'REJECT') {
        expect(stageNames(events)).toEqual(['bind', 'fi_request', 'fi_fetch', 'evaluate']);
        expect(last).toEqual({ event: 'result', data: { tier: 'REJECT' } });
        const at = await attestationAddress(credential, schema, wallet.address);
        expect(await fetchRaw(h, at)).toBeUndefined();
        return;
      }

      expect(stageNames(events)).toEqual(['bind', 'fi_request', 'fi_fetch', 'evaluate', 'submit']);
      expect(last?.event).toBe('result');
      expect(last?.data).toMatchObject({ tier });
      const data = last?.data;
      const payloadHex = String(Reflect.get(Object(data), 'payload_hex'));
      const stored = await readAttestation(
        h,
        await attestationAddress(credential, schema, wallet.address),
      );
      expect(stored?.data).toEqual(fromHex(payloadHex));
      winners.set(tier, { wallet, tx: String(Reflect.get(Object(data), 'tx')) });
    },
    180_000,
  );

  it('a tier A wallet borrows from a demo pool that pins the default policy and enclave id 0', async () => {
    const winner = winners.get('A');
    if (winner === undefined) throw new Error('the tier A persona test must run first');
    const mintAuthority = await generateKeyPairSigner();
    const f: PoolFixture = {
      h,
      relayer: h.attacker,
      credential,
      schema,
      key: enclaveKey(1),
      entryId: MEASUREMENT_ID,
      mintAuthority,
      mint: await createMint(h, mintAuthority.address),
    };
    const pool = await createPool(f, {
      params: {
        policyHash: fromHex(policyHashHex),
        approvedMeasurements: approve(MEASUREMENT_ID),
        maxAgeSecs: TEN_YEARS_SECS,
      },
    });
    await fundVault(f, pool, 100_000_000n);
    h.surfnet.fundSol(winner.wallet.address, 10 * LAMPORTS);
    const token = await createAta(h, winner.wallet, winner.wallet.address, f.mint);
    const borrower = { signer: winner.wallet, token, entryId: MEASUREMENT_ID, now: 0n };
    await borrow(f, { pool, borrower, amount: 1_000_000n });
    expect(await tokenBalance(h, token)).toBe(1_000_000n);
  }, 180_000);
});
