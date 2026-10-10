// Solana JSON-RPC for the browser: a small client so 429s can back off and every reply is
// validated before any decoder sees it. Account bytes are checked for owner, length and
// discriminator here; the generated decoders check neither (gateway/src/registry.ts).
import { type Address, address, blockhash, getBase64Encoder } from '@solana/kit';
import {
  DEMO_POOL_PROGRAM_ADDRESS,
  LOAN_DISCRIMINATOR,
  POOL_DISCRIMINATOR,
  getLoanDecoder,
  getLoanSize,
  getPoolDecoder,
  getPoolSize,
} from '@tio/demo-pool-client';
import {
  ENCLAVE_ENTRY_DISCRIMINATOR,
  getEnclaveEntryDecoder,
  getEnclaveEntrySize,
} from '@tio/oracle-client';
import { ORACLE_PROGRAM_ID, SAS_PROGRAM_ID, parseSasAttestation } from '@tio/oracle-client/attest';
import { z } from 'zod';
import { fetchFailure, protocolError } from './http.ts';
import { sleep } from './sleep.ts';
import type { ChainPort } from '../domain/ports.ts';
import type { AppError, ChainAccount, Result } from '../domain/types.ts';

/** Waits before retry 2 and 3 of a rate-limited call; then the RPC is "busy". */
const BACKOFF_MS = [250, 500];

const envelopeSchema = z.union([
  z.object({ result: z.unknown() }),
  z.object({ error: z.object({ code: z.number(), message: z.string().optional() }) }),
]);

/** JSON-RPC error codes nodes answer with when they want us to slow down. */
const BUSY_CODES = new Set([-32005, -32429]);

const accountSchema = z
  .object({ owner: z.string(), data: z.tuple([z.string(), z.literal('base64')]) })
  .nullable();

class BadAccount extends Error {}

const startsWith = (data: Uint8Array, prefix: ArrayLike<number>): boolean =>
  Array.prototype.every.call(prefix, (byte: number, i: number) => data[i] === byte);

function checked(data: Uint8Array, size: number, discriminator: ArrayLike<number>): Uint8Array {
  if (data.length !== size || !startsWith(data, discriminator)) throw new BadAccount();
  return data;
}

/** Throws `BadAccount` for anything we don't read; the caller turns it into protocol_error. */
function decodeAccount(owner: Address, data: Uint8Array): ChainAccount {
  if (owner === SAS_PROGRAM_ID) {
    return { kind: 'attestation', attestation: parseSasAttestation(owner, data) };
  }
  if (owner === ORACLE_PROGRAM_ID) {
    const bytes = checked(data, getEnclaveEntrySize(), ENCLAVE_ENTRY_DISCRIMINATOR);
    return { kind: 'enclave_entry', entry: getEnclaveEntryDecoder().decode(bytes) };
  }
  if (owner === DEMO_POOL_PROGRAM_ADDRESS) {
    if (startsWith(data, POOL_DISCRIMINATOR)) {
      return {
        kind: 'pool',
        pool: getPoolDecoder().decode(checked(data, getPoolSize(), POOL_DISCRIMINATOR)),
      };
    }
    if (startsWith(data, LOAN_DISCRIMINATOR)) {
      return {
        kind: 'loan',
        loan: getLoanDecoder().decode(checked(data, getLoanSize(), LOAN_DISCRIMINATOR)),
      };
    }
  }
  throw new BadAccount();
}

type Call = { method: string; params: unknown[] };

async function postOnce(
  url: string,
  call: Call,
  signal: AbortSignal,
): Promise<Response | AppError> {
  try {
    return await fetch(url, {
      method: 'POST',
      signal,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, ...call }),
    });
  } catch (cause) {
    return fetchFailure(cause, signal);
  }
}

/** One JSON-RPC call; 429 backs off twice (250 ms, 500 ms) before giving `rpc_busy`. */
async function rpcCall(url: string, call: Call, signal: AbortSignal): Promise<Result<unknown>> {
  for (let attempt = 0; ; attempt++) {
    const response = await postOnce(url, call, signal);
    if (!(response instanceof Response)) return { ok: false, error: response };
    if (response.status === 429) {
      const wait = BACKOFF_MS[attempt];
      if (wait === undefined) return { ok: false, error: { code: 'rpc_busy' } };
      await sleep(wait, signal);
      if (signal.aborted) return { ok: false, error: { code: 'cancelled' } };
      continue;
    }
    if (!response.ok) return { ok: false, error: { code: 'network' } };
    const body: unknown = await response.json().catch(() => undefined);
    if (signal.aborted) return { ok: false, error: { code: 'cancelled' } };
    const parsed = envelopeSchema.safeParse(body);
    if (!parsed.success) return { ok: false, error: protocolError };
    if ('error' in parsed.data) {
      const busy = BUSY_CODES.has(parsed.data.error.code);
      return { ok: false, error: { code: busy ? 'rpc_busy' : 'network' } };
    }
    return { ok: true, value: parsed.data.result };
  }
}

function parseAccounts(result: unknown): Result<(ChainAccount | null)[]> {
  const parsed = z.object({ value: z.array(accountSchema) }).safeParse(result);
  if (!parsed.success) return { ok: false, error: protocolError };
  const base64 = getBase64Encoder();
  try {
    const accounts = parsed.data.value.map((account) =>
      account === null
        ? null
        : decodeAccount(address(account.owner), Uint8Array.from(base64.encode(account.data[0]))),
    );
    return { ok: true, value: accounts };
  } catch {
    return { ok: false, error: protocolError };
  }
}

const blockhashSchema = z.object({
  value: z.object({ blockhash: z.string(), lastValidBlockHeight: z.number().int() }),
});

const statusSchema = z.object({
  value: z.tuple([
    z
      .object({
        err: z.unknown(),
        confirmationStatus: z.enum(['processed', 'confirmed', 'finalized']),
      })
      .nullable(),
  ]),
});

export function createChain(rpcUrl: string): ChainPort {
  return {
    async accounts(addresses, signal) {
      const reply = await rpcCall(
        rpcUrl,
        {
          method: 'getMultipleAccounts',
          params: [addresses, { encoding: 'base64', commitment: 'confirmed' }],
        },
        signal,
      );
      return reply.ok ? parseAccounts(reply.value) : reply;
    },
    async latestBlockhash(signal) {
      const reply = await rpcCall(
        rpcUrl,
        { method: 'getLatestBlockhash', params: [{ commitment: 'confirmed' }] },
        signal,
      );
      if (!reply.ok) return reply;
      const parsed = blockhashSchema.safeParse(reply.value);
      if (!parsed.success) return { ok: false, error: protocolError };
      const { value } = parsed.data;
      return {
        ok: true,
        value: {
          blockhash: blockhash(value.blockhash),
          lastValidBlockHeight: BigInt(value.lastValidBlockHeight),
        },
      };
    },
    async signatureStatus(signature, signal) {
      const reply = await rpcCall(
        rpcUrl,
        { method: 'getSignatureStatuses', params: [[signature]] },
        signal,
      );
      if (!reply.ok) return reply;
      const parsed = statusSchema.safeParse(reply.value);
      if (!parsed.success) return { ok: false, error: protocolError };
      const [status] = parsed.data.value;
      return {
        ok: true,
        value:
          status === null
            ? null
            : { confirmationStatus: status.confirmationStatus, err: status.err },
      };
    },
  };
}
