// One wallet's verification: the verifier library runs in the browser over the chain port, the
// bundled archived document and the compose file at the build's release tag.
import type { Address } from '@solana/kit';
import { skipToken, useQuery } from '@tanstack/react-query';
import { findEnclaveEntryPda } from '@tio/oracle-client';
import { verifyWallet } from '@tio/verifier';
import { type EnclaveRecord, enclaveRecordOf } from '@tio/verifier/deployment';
import { VerifierError } from '@tio/verifier/errors';
import { chainReader } from '../adapters/verifier-chain.ts';
import { toAppError } from '../domain/errors.ts';
import type { AppError } from '../domain/types.ts';
import { type VerifyView, verifyView } from '../domain/verify-view.ts';
import { type Deps, realDeps } from './deps.ts';
import { queryKeys } from './query-keys.ts';
import { GITHUB_URL, RELEASE } from './release.ts';

/** Two chain reads, a GitHub fetch and a P-384 chain: more than the usual 15 s read. */
const DEADLINE_MS = 30_000;

const TIMEOUT: AppError = { code: 'timeout' };

/** @throws VerifierError `deployment_malformed` when the file lists no record for the build. */
function recordOf(deps: Deps, measurementId: number): EnclaveRecord {
  const record = enclaveRecordOf(deps.config.verifier, measurementId);
  if (record === undefined) {
    throw new VerifierError(
      'deployment_malformed',
      `no enclaves[] record for measurement id ${measurementId}`,
    );
  }
  return record;
}

export async function fetchVerification(
  deps: Deps,
  wallet: Address,
  signal: AbortSignal,
): Promise<VerifyView> {
  const deployment = deps.config.verifier;
  const report = await verifyWallet({
    chain: chainReader(deps.chain, signal),
    deployment,
    wallet,
    // Both depend on the attestation's measurement id, so they load once it is known.
    document: (id) => deps.sources.archivedDocument(recordOf(deps, id)),
    composeBytes: (id) => deps.sources.composeAtTag(recordOf(deps, id), signal),
  });
  const [entryAddress] = await findEnclaveEntryPda(
    { measurementId: report.attestation.measurementId },
    { programAddress: deployment.oracleProgram },
  );
  return verifyView(report, {
    deployment,
    cluster: deps.config.cluster,
    release: RELEASE,
    entryAddress,
    repoUrl: GITHUB_URL,
    nowSeconds: BigInt(Math.floor(Date.now() / 1000)),
  });
}

/**
 * `work` with a signal that aborts after `ms` or when the caller's `signal` does. Past the
 * deadline the answer is `timeout` whatever `work` does next (a source that ignores its signal
 * cannot hang the page), and a read the deadline cut short is `timeout`, not `cancelled`: the
 * reader did not cancel, the clock did.
 */
export async function withinDeadline<T>(
  signal: AbortSignal,
  ms: number,
  work: (deadline: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  if (signal.aborted) controller.abort();
  signal.addEventListener('abort', onAbort, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(TIMEOUT);
    }, ms);
  });
  try {
    return await Promise.race([work(controller.signal), expiry]);
  } catch (thrown) {
    // Defensive: the race normally settles on `expiry` first; this covers a work rejection that
    // the deadline's abort caused ("cancelled") arriving in the same tick.
    throw controller.signal.aborted && !signal.aborted ? TIMEOUT : thrown;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', onAbort);
  }
}

/** A verifier stop is `verify_failed` with its reason; a chain or stray failure keeps its own code. */
function asAppError(thrown: unknown): AppError {
  if (thrown instanceof VerifierError) return { code: 'verify_failed', reason: thrown.code };
  return toAppError(thrown);
}

/** Runs once per wallet; nothing is read without one. No automatic retry: a FAIL is an answer. */
export function useVerification(wallet: Address | undefined, deps: Deps = realDeps()) {
  return useQuery<VerifyView, AppError>({
    queryKey: queryKeys.verify(deps.config.cluster, wallet ?? null),
    queryFn:
      wallet === undefined
        ? skipToken
        : ({ signal }) =>
            withinDeadline(signal, DEADLINE_MS, (deadline) =>
              fetchVerification(deps, wallet, deadline),
            ).catch((thrown: unknown) => {
              throw asAppError(thrown);
            }),
    staleTime: 60_000,
    retry: false,
  });
}
