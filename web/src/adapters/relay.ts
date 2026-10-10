// `POST /v1/loans/relay` (FORMATS §16): the gateway's relayer co-signs a borrower-signed loan tx.
import { isSignature } from '@solana/kit';
import { z } from 'zod';
import { requestJson } from './http.ts';
import type { RelayPort } from '../domain/ports.ts';

/** A base58 64-byte signature; anything else is a protocol error, never something we poll. */
const replySchema = z.object({ signature: z.string().refine(isSignature) });

export function createRelay(baseUrl: string): RelayPort {
  return {
    relay: (txB64, signal) =>
      requestJson(
        `${baseUrl}/v1/loans/relay`,
        { method: 'POST', body: { tx_b64: txB64 } },
        replySchema,
        (r) => r.signature,
        signal,
      ),
  };
}
