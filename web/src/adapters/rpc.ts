// Solana JSON-RPC for the browser: a small client so 429s can back off and every reply is
// validated before any decoder sees it. Account bytes are checked for owner, length and
// discriminator here; the generated decoders check neither (gateway/src/registry.ts).
import { type Address, address, blockhash, getBase58Decoder, getBase64Encoder } from '@solana/kit';
import { TOKEN_PROGRAM_ADDRESS, getTokenDecoder, getTokenSize } from '@solana-program/token';
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
import type { ChainPort, PoolLoan } from '../domain/ports.ts';
import type { AppError, ChainAccount, RawAccount, Result } from '../domain/types.ts';

/** Waits before retry 2 and 3 of a rate-limited call; then the RPC is "busy". */
const BACKOFF_MS = [250, 500];

const envelopeSchema = z.union([
  z.object({ result: z.unknown() }),
  z.object({ error: z.object({ code: z.number(), message: z.string().optional() }) }),
]);

/** JSON-RPC error codes nodes answer with when they want us to slow down. */
const BUSY_CODES = new Set([-32005, -32429]);

const accountShape = z.object({
  owner: z.string(),
  data: z.tuple([z.string(), z.literal('base64')]),
});

const accountSchema = accountShape.nullable();

/** `getMultipleAccounts` takes at most 100 keys per call. */
const MAX_KEYS = 100;

/** `Loan.pool` follows the 8-byte discriminator and three one-byte fields (version, bump, tier). */
const LOAN_POOL_OFFSET = 11;

const LOAN_DISCRIMINATOR_B58 = getBase58Decoder().decode(Uint8Array.from(LOAN_DISCRIMINATOR));

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
  if (owner === TOKEN_PROGRAM_ADDRESS) {
    // SPL token accounts have no discriminator: the length is the only shape check available.
    return { kind: 'token', token: getTokenDecoder().decode(checked(data, getTokenSize(), [])) };
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

/** The reply's accounts as owner + bytes, decoded from base64 and nothing more. */
function parseRawAccounts(result: unknown): Result<(RawAccount | null)[]> {
  const parsed = z.object({ value: z.array(accountSchema) }).safeParse(result);
  if (!parsed.success) return { ok: false, error: protocolError };
  const base64 = getBase64Encoder();
  try {
    const accounts = parsed.data.value.map((account) =>
      account === null
        ? null
        : { owner: address(account.owner), data: Uint8Array.from(base64.encode(account.data[0])) },
    );
    return { ok: true, value: accounts };
  } catch {
    return { ok: false, error: protocolError };
  }
}

function parseAccounts(result: unknown): Result<(ChainAccount | null)[]> {
  const raw = parseRawAccounts(result);
  if (!raw.ok) return raw;
  try {
    return {
      ok: true,
      value: raw.value.map((account) =>
        account === null ? null : decodeAccount(account.owner, account.data),
      ),
    };
  } catch {
    return { ok: false, error: protocolError };
  }
}

const programRowsSchema = z.array(z.object({ pubkey: z.string(), account: accountShape }));

/**
 * The RPC is not trusted to have applied the filters: every row is decoded with the same owner,
 * size and discriminator checks as a single read, and must be a Loan of the asked pool. One bad
 * row fails the whole read, so a partial book is never shown as the book.
 */
function parsePoolLoans(result: unknown, pool: Address): Result<PoolLoan[]> {
  const parsed = programRowsSchema.safeParse(result);
  if (!parsed.success) return { ok: false, error: protocolError };
  const base64 = getBase64Encoder();
  try {
    const loans = parsed.data.map(({ pubkey, account }) => {
      const data = Uint8Array.from(base64.encode(account.data[0]));
      const decoded = decodeAccount(address(account.owner), data);
      if (decoded.kind !== 'loan' || decoded.loan.pool !== pool) throw new BadAccount();
      return { address: address(pubkey), loan: decoded.loan };
    });
    return { ok: true, value: loans };
  } catch {
    return { ok: false, error: protocolError };
  }
}

function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
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

/**
 * `getMultipleAccounts` in chunks of 100, each reply parsed by `parse`. Callers match accounts
 * to keys by index: a short or long reply would hand one borrower another's attestation, so it
 * is a bad reply, not a partial one.
 */
async function readAccounts<T>(
  rpcUrl: string,
  addresses: Address[],
  signal: AbortSignal,
  parse: (result: unknown) => Result<(T | null)[]>,
): Promise<Result<(T | null)[]>> {
  const all: (T | null)[] = [];
  for (const keys of chunks(addresses, MAX_KEYS)) {
    const reply = await rpcCall(
      rpcUrl,
      {
        method: 'getMultipleAccounts',
        params: [keys, { encoding: 'base64', commitment: 'confirmed' }],
      },
      signal,
    );
    const parsed = reply.ok ? parse(reply.value) : reply;
    if (!parsed.ok) return parsed;
    if (parsed.value.length !== keys.length) return { ok: false, error: protocolError };
    all.push(...parsed.value);
  }
  return { ok: true, value: all };
}

export function createChain(rpcUrl: string): ChainPort {
  return {
    accounts: (addresses, signal) => readAccounts(rpcUrl, addresses, signal, parseAccounts),
    rawAccounts: (addresses, signal) => readAccounts(rpcUrl, addresses, signal, parseRawAccounts),
    async poolLoans(pool, signal) {
      const filters = [
        { dataSize: getLoanSize() },
        { memcmp: { offset: 0, bytes: LOAN_DISCRIMINATOR_B58, encoding: 'base58' } },
        { memcmp: { offset: LOAN_POOL_OFFSET, bytes: pool, encoding: 'base58' } },
      ];
      const reply = await rpcCall(
        rpcUrl,
        {
          method: 'getProgramAccounts',
          params: [
            DEMO_POOL_PROGRAM_ADDRESS,
            { encoding: 'base64', commitment: 'confirmed', filters },
          ],
        },
        signal,
      );
      return reply.ok ? parsePoolLoans(reply.value, pool) : reply;
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
