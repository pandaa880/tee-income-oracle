/**
 * `e2e:devnet`: drives a deployed gateway (FORMATS §16) end to end, the way
 * the web will: one fresh wallet per sandbox persona, the §9 intent signed
 * by that wallet, the SSE stream read to its `result`. For lent tiers it then
 * checks the SAS attestation on chain, and the tier A wallet borrows from the
 * demo pool and repays. Local only, never CI: it spends devnet SOL from the
 * admin wallet (fees, ATA and loan rent) and needs the live services.
 *
 * Wallets need no SOL: the gateway's relayer pays for the attestation and
 * the admin pays the borrow/repay fees.
 */
import {
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstructionAsync,
} from '@solana-program/token';
import { TOKEN_PROGRAM_ADDRESS, fetchToken } from '@solana-program/token';
import {
  type Address,
  type KeyPairSigner,
  createSignableMessage,
  generateKeyPairSigner,
  getBase58Decoder,
} from '@solana/kit';
import { getBorrowInstructionAsync, getRepayInstructionAsync } from '@tio/demo-pool-client';
import { findEnclaveEntryPda } from '@tio/oracle-client';
import { attestationAddress, parseSasAttestation } from '@tio/oracle-client/attest';
import { b64Decode, toHex } from '@tio/encoding';
import { type Cluster, assertCluster } from './cluster.ts';
import { isRecord } from './deployments.ts';
import { type ChainClients, sendInstructions } from './send.ts';
import { type SseEvent, parseSse } from './sse.ts';

export type Persona = 'salaried_steady' | 'trader_lumpy' | 'declining' | 'stressed';
export type Tier = 'A' | 'B' | 'C' | 'REJECT';

/** What each sandbox persona scores under the default policy (test-vectors/manifest.json). */
export const EXPECTED_TIERS: Record<Persona, Tier> = {
  salaried_steady: 'A',
  trader_lumpy: 'B',
  declining: 'C',
  stressed: 'REJECT',
};

const PERSONAS: readonly Persona[] = ['salaried_steady', 'trader_lumpy', 'declining', 'stressed'];

/** One base unit is 10⁻⁶ token; the borrow is one whole token. */
/**
 * 2 001 tokens (6 decimals): above the demo pool's tier B limit (2 000) and within
 * tier A's (5 000), so the pool's own check proves the wallet holds a tier A
 * attestation on chain, not just that the gateway said "A".
 */
export const BORROW_AMOUNT = 2_001n * 10n ** 6n;
/** The complete stream covers bank, enclave and a confirmed transaction; create is one hop. */
const CREATE_TIMEOUT_MS = 30_000;
const COMPLETE_TIMEOUT_MS = 180_000;
/** Payload bytes (FORMATS §7): `tier` (1 = A, 2 = B, 3 = C) and `measurement_id`. */
const PAYLOAD_TIER = 0;
const PAYLOAD_MEASUREMENT_ID = 2;
const TIER_BY_BYTE: Partial<Record<number, Tier>> = { 1: 'A', 2: 'B', 3: 'C' };

/** The tier a stored §7 payload encodes, or undefined for any other byte. */
export function tierOfPayload(payload: Uint8Array): Tier | undefined {
  return TIER_BY_BYTE[payload[PAYLOAD_TIER] ?? 0];
}

/**
 * Whether the chain holds what the persona should have: nothing for REJECT;
 * otherwise exactly the payload the gateway reported, encoding the expected
 * tier. Comparing bytes alone isn't enough: a wrong tier reported and stored
 * consistently would still match.
 */
export function checkStoredAttestation(
  expected: Tier,
  stored: Uint8Array | undefined,
  payloadHex: string | undefined,
): boolean {
  if (expected === 'REJECT') return stored === undefined;
  return stored !== undefined && toHex(stored) === payloadHex && tierOfPayload(stored) === expected;
}

export type Outcome =
  | { ok: true; tier: string; tx: string | null; attestation?: string; payloadHex?: string }
  | { ok: false; stage: string; code: string };

const field = (data: unknown, key: string): unknown => (isRecord(data) ? data[key] : undefined);

/** The session's outcome from its SSE events: the last `result`, or the `error`. */
export function outcomeOf(events: SseEvent[]): Outcome {
  const error = events.find((e) => e.event === 'error');
  if (error !== undefined) {
    return {
      ok: false,
      stage: String(field(error.data, 'stage')),
      code: String(field(error.data, 'code')),
    };
  }
  const result = events.findLast((e) => e.event === 'result');
  if (result === undefined) return { ok: false, stage: 'stream', code: 'no_result' };
  const { data } = result;
  const tx = field(data, 'tx');
  const attestation = field(data, 'attestation');
  const payloadHex = field(data, 'payload_hex');
  return {
    ok: true,
    tier: String(field(data, 'tier')),
    tx: typeof tx === 'string' ? tx : null,
    ...(typeof attestation === 'string' ? { attestation } : {}),
    ...(typeof payloadHex === 'string' ? { payloadHex } : {}),
  };
}

export type E2eInput = ChainClients & {
  cluster: Cluster;
  gatewayUrl: string;
  /** Pays the borrow/repay fees and the borrower's token account. */
  admin: KeyPairSigner;
  credential: Address;
  schema: Address;
  pool: Address;
  mint: Address;
  log: (line: string) => void;
};

/** Runs every persona, then a tier A borrow + repay. Resolves true only if all pass. */
export async function runE2e(input: E2eInput): Promise<boolean> {
  // The admin wallet pays real fees below: never on a cluster other than the one named.
  await assertCluster(input);
  let allPassed = true;
  let tierA: KeyPairSigner | undefined;
  for (const persona of PERSONAS) {
    const expected = EXPECTED_TIERS[persona];
    const wallet = await generateKeyPairSigner();
    const outcome = await runSession(input.gatewayUrl, wallet, persona).catch(clientFailure);
    const passed =
      outcome.ok &&
      outcome.tier === expected &&
      (await onChainMatches(input, wallet, expected, outcome).catch(() => false));
    allPassed &&= passed;
    if (passed && expected === 'A') tierA = wallet;
    input.log(
      `${passed ? 'PASS' : 'FAIL'} ${persona}: expected ${expected}, got ${describe(outcome)}`,
    );
  }
  if (tierA === undefined) {
    input.log('SKIP borrow: no tier A wallet');
    return false;
  }
  const borrowed = await borrowAndRepay(input, tierA).catch((error: unknown) => {
    input.log(`borrow error: ${errorText(error)}`);
    return false;
  });
  input.log(`${borrowed ? 'PASS' : 'FAIL'} tier A borrow + repay`);
  return allPassed && borrowed;
}

const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** A failure of this client (timeout, non-JSON body) becomes a FAIL row, not an abort. */
const clientFailure = (error: unknown): Outcome => ({
  ok: false,
  stage: 'client',
  code: errorText(error),
});

function describe(outcome: Outcome): string {
  return outcome.ok
    ? `${outcome.tier} (tx ${outcome.tx ?? 'none'})`
    : `${outcome.stage}/${outcome.code}`;
}

/** Create → sign the intent → complete; the SSE body is read whole (it ends after `result`). */
async function runSession(
  gatewayUrl: string,
  wallet: KeyPairSigner,
  persona: Persona,
): Promise<Outcome> {
  const created = await postJson(`${gatewayUrl}/v1/sessions`, {
    wallet: wallet.address,
    persona_id: persona,
  });
  const sessionId = String(field(created.body, 'session_id'));
  const intent = field(created.body, 'intent');
  if (!created.ok || typeof intent !== 'string') {
    return {
      ok: false,
      stage: 'create',
      code: String(field(field(created.body, 'error'), 'code')),
    };
  }
  const [signatures] = await wallet.signMessages([
    createSignableMessage(new TextEncoder().encode(intent)),
  ]);
  const signature = signatures?.[wallet.address];
  if (signature === undefined) return { ok: false, stage: 'sign', code: 'no_signature' };
  const response = await fetch(`${gatewayUrl}/v1/sessions/${sessionId}/complete`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ signature_b58: getBase58Decoder().decode(signature) }),
    signal: AbortSignal.timeout(COMPLETE_TIMEOUT_MS),
  });
  if (!response.ok) {
    // Refused before the stream started: a JSON `{ error: { code, … } }` body.
    const code = field(field(await jsonBody(response), 'error'), 'code');
    return {
      ok: false,
      stage: 'complete',
      code: typeof code === 'string' ? code : `http_${response.status}`,
    };
  }
  return outcomeOf(parseSse(await response.text()));
}

async function postJson(url: string, body: unknown): Promise<{ ok: boolean; body: unknown }> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(CREATE_TIMEOUT_MS),
  });
  return { ok: response.ok, body: await jsonBody(response) };
}

/** What the chain holds for this wallet matches the persona (see `checkStoredAttestation`). */
async function onChainMatches(
  input: E2eInput,
  wallet: KeyPairSigner,
  expected: Tier,
  outcome: Outcome,
): Promise<boolean> {
  if (!outcome.ok) return false;
  const stored = await readAttestation(input, wallet.address);
  return checkStoredAttestation(expected, stored, outcome.payloadHex);
}

async function readAttestation(input: E2eInput, wallet: Address): Promise<Uint8Array | undefined> {
  const at = await attestationAddress(input.credential, input.schema, wallet);
  const { value } = await input.rpc.getAccountInfo(at, { encoding: 'base64' }).send();
  if (value === null) return undefined;
  return parseSasAttestation(value.owner, b64Decode(value.data[0])).payload;
}

async function borrowAndRepay(input: E2eInput, borrower: KeyPairSigner): Promise<boolean> {
  const payload = await readAttestation(input, borrower.address);
  const measurementId = payload?.[PAYLOAD_MEASUREMENT_ID];
  if (measurementId === undefined) return false;
  const [borrowerToken] = await findAssociatedTokenPda({
    owner: borrower.address,
    mint: input.mint,
    tokenProgram: TOKEN_PROGRAM_ADDRESS,
  });
  const common = { borrower, pool: input.pool, mint: input.mint, borrowerToken };
  await sendInstructions(input, input.admin, [
    await getCreateAssociatedTokenIdempotentInstructionAsync({
      payer: input.admin,
      owner: borrower.address,
      mint: input.mint,
    }),
    await getBorrowInstructionAsync({
      ...common,
      payer: input.admin,
      attestation: await attestationAddress(input.credential, input.schema, borrower.address),
      enclaveEntry: (await findEnclaveEntryPda({ measurementId }))[0],
      amount: BORROW_AMOUNT,
    }),
  ]);
  const lent = (await fetchToken(input.rpc, borrowerToken)).data.amount === BORROW_AMOUNT;
  await sendInstructions(input, input.admin, [
    await getRepayInstructionAsync({ ...common, rentPayer: input.admin.address }),
  ]);
  const repaid = (await fetchToken(input.rpc, borrowerToken)).data.amount === 0n;
  return lent && repaid;
}

async function jsonBody(response: Response): Promise<unknown> {
  const body: unknown = await response.json();
  return body;
}
