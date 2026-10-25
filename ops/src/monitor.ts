/**
 * Health of the deployed devnet demo (pure): probe results in, checks out.
 * `monitor-cli.ts` gathers the probes; the `monitor` workflow turns a report
 * that isn't ok into a GitHub issue.
 */
import { checkCluster } from './cluster.ts';

export type Status = 'ok' | 'warn' | 'fail';

export type Check = { id: string; title: string; status: Status; detail: string };

/** What a probe returned, or why it couldn't (probes never throw). */
export type Probed<T> = { ok: true; value: T } | { ok: false; error: string };

/** The Oyster market's `jobs(bytes32)` view of one job (USDC has 6 decimals). */
export type OysterJob = { owner: string; rate: bigint; balance: bigint; lastSettled: bigint };

export type GatewayInfo = { measurementId: number; attester: string; relayer: string };

export type Probes = {
  /** The Solana RPC's genesis hash, so a wrong cluster is named as such. */
  solanaGenesis: Probed<string>;
  gatewayHealth: Probed<null>;
  session: Probed<null>;
  gatewayInfo: Probed<GatewayInfo>;
  enclaveAttester: Probed<string>;
  /** The registry entry at the gateway's `measurement_id`; null when there is none. */
  registryEntry: Probed<{ attester: string; revoked: boolean } | null>;
  relayerLamports: Probed<bigint>;
  /** Null when the market has no such job. */
  oysterJob: Probed<OysterJob | null>;
  /** Age in seconds of the block Marlin's indexer has synced to. */
  indexerLagSecs: Probed<number>;
};

const DAY_SECS = 86_400n;
const LAMPORTS_PER_SOL = 1_000_000_000n;
/** `rate` carries 12 extra decimals on top of USDC's 6 (MarketV1 `EXTRA_DECIMALS`). */
const RATE_SCALE = 10n ** 12n;

export const THRESHOLDS = {
  runwayFailSecs: 1n * DAY_SECS,
  runwayWarnSecs: 7n * DAY_SECS,
  relayerFailLamports: LAMPORTS_PER_SOL / 20n,
  relayerWarnLamports: LAMPORTS_PER_SOL / 2n,
  indexerWarnSecs: 2 * 3600,
} as const;

const ZERO_ADDRESS = `0x${'0'.repeat(40)}`;
const WORD_HEX = 64;
/** A runway this long reads as "years": `Date` can't format the end of an absurd balance. */
const LONG_RUNWAY_SECS = 3650n * DAY_SECS;
/** Longest detail a report row carries; probe errors can be long. */
const DETAIL_MAX = 240;

/**
 * Decodes the static head of a `jobs(bytes32)` return value: metadata offset,
 * owner, provider, rate, balance, lastSettled. A job that doesn't exist comes
 * back with a zero owner.
 *
 * @throws Error when the hex is shorter than the six head words.
 */
export function decodeJob(resultHex: string): OysterJob | null {
  const hex = resultHex.replace(/^0x/, '');
  if (hex.length < 6 * WORD_HEX) throw new Error('jobs() result is shorter than its head');
  const word = (i: number): string => hex.slice(i * WORD_HEX, (i + 1) * WORD_HEX);
  const owner = `0x${word(1).slice(24)}`;
  if (owner === ZERO_ADDRESS) return null;
  return {
    owner,
    rate: BigInt(`0x${word(3)}`),
    balance: BigInt(`0x${word(4)}`),
    lastSettled: BigInt(`0x${word(5)}`),
  };
}

/** Unix seconds the job's balance lasts to at its current rate; null at rate 0 (a closing job). */
export function paidUntil(job: OysterJob): bigint | null {
  if (job.rate === 0n) return null;
  return job.lastSettled + (job.balance * RATE_SCALE) / job.rate;
}

const sameAddress = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

const iso = (secs: bigint): string => new Date(Number(secs) * 1000).toISOString();

const sol = (lamports: bigint): string => (Number(lamports) / Number(LAMPORTS_PER_SOL)).toFixed(3);

const check = (id: string, title: string, status: Status, detail: string): Check => ({
  id,
  title,
  status,
  detail,
});

/** Every check, in the order the report lists them. `owner` is the wallet that should own the job. */
export function evaluate(probes: Probes, nowSecs: bigint, owner: string): Check[] {
  return [
    solanaCluster(probes.solanaGenesis),
    reachable('gateway_health', 'Gateway answers /health', probes.gatewayHealth),
    reachable('session', 'A session starts (gateway → enclave → bank)', probes.session),
    reachable('enclave_info', 'Enclave answers /v1/info', probes.enclaveAttester),
    attesterMatch(probes),
    registryEntry(probes),
    oysterRunway(probes.oysterJob, nowSecs, owner),
    relayerBalance(probes.relayerLamports),
    indexerLag(probes.indexerLagSecs),
  ];
}

/** The registry and relayer checks only mean something on devnet. */
function solanaCluster(probe: Probed<string>): Check {
  const title = 'Solana RPC serves devnet';
  if (!probe.ok) return check('solana_cluster', title, 'fail', probe.error);
  const result = checkCluster('devnet', probe.value);
  return result.ok
    ? check('solana_cluster', title, 'ok', 'devnet genesis hash')
    : check('solana_cluster', title, 'fail', result.error.message);
}

function reachable<T>(id: string, title: string, probe: Probed<T>): Check {
  return probe.ok ? check(id, title, 'ok', 'answered') : check(id, title, 'fail', probe.error);
}

/** After an enclave restart the gateway still holds the old attester until it is recreated. */
function attesterMatch({ gatewayInfo, enclaveAttester }: Probes): Check {
  const title = 'Gateway and enclave agree on the attester';
  if (!gatewayInfo.ok) return check('attester_match', title, 'fail', gatewayInfo.error);
  if (!enclaveAttester.ok) return check('attester_match', title, 'fail', enclaveAttester.error);
  const { attester } = gatewayInfo.value;
  return sameAddress(attester, enclaveAttester.value)
    ? check('attester_match', title, 'ok', attester)
    : check(
        'attester_match',
        title,
        'fail',
        `gateway has ${attester}, enclave has ${enclaveAttester.value}: rotate the enclave and recreate the gateway`,
      );
}

function registryEntry({ gatewayInfo, registryEntry: probe }: Probes): Check {
  const title = 'Registry entry is active and names the attester';
  if (!probe.ok) return check('registry_entry', title, 'fail', probe.error);
  if (!gatewayInfo.ok) return check('registry_entry', title, 'fail', gatewayInfo.error);
  const { measurementId, attester } = gatewayInfo.value;
  const entry = probe.value;
  if (entry === null) {
    return check('registry_entry', title, 'fail', `no entry at measurement_id ${measurementId}`);
  }
  if (entry.revoked) {
    return check('registry_entry', title, 'fail', `measurement_id ${measurementId} is revoked`);
  }
  return sameAddress(entry.attester, attester)
    ? check('registry_entry', title, 'ok', `measurement_id ${measurementId}`)
    : check(
        'registry_entry',
        title,
        'fail',
        `measurement_id ${measurementId} names ${entry.attester}, gateway has ${attester}`,
      );
}

function oysterRunway(probe: Probed<OysterJob | null>, nowSecs: bigint, owner: string): Check {
  const title = 'Oyster job is funded';
  if (!probe.ok) return check('oyster_runway', title, 'fail', probe.error);
  const job = probe.value;
  if (job === null) return check('oyster_runway', title, 'fail', 'no such job on the market');
  // The report becomes a public issue: name the problem, never the wallets.
  if (!sameAddress(job.owner, owner)) {
    return check('oyster_runway', title, 'fail', 'the job is owned by another wallet');
  }
  const until = paidUntil(job);
  if (until === null)
    return check('oyster_runway', title, 'fail', 'job rate is 0: it is being closed');
  const left = until - nowSecs;
  if (left >= LONG_RUNWAY_SECS)
    return check('oyster_runway', title, 'ok', 'paid for over 10 years');
  const detail = `paid until ${iso(until)} (${(Number(left) / Number(DAY_SECS)).toFixed(1)} days)`;
  if (left < THRESHOLDS.runwayFailSecs) return check('oyster_runway', title, 'fail', detail);
  if (left < THRESHOLDS.runwayWarnSecs) return check('oyster_runway', title, 'warn', detail);
  return check('oyster_runway', title, 'ok', detail);
}

function relayerBalance(probe: Probed<bigint>): Check {
  const title = 'Relayer has devnet SOL';
  if (!probe.ok) return check('relayer_balance', title, 'fail', probe.error);
  const lamports = probe.value;
  const detail = `${sol(lamports)} SOL`;
  if (lamports < THRESHOLDS.relayerFailLamports)
    return check('relayer_balance', title, 'fail', detail);
  if (lamports < THRESHOLDS.relayerWarnLamports)
    return check('relayer_balance', title, 'warn', detail);
  return check('relayer_balance', title, 'ok', detail);
}

/** Marlin's indexer is theirs, not ours: a lag only warns. Its 2026-10 stall stopped our job. */
function indexerLag(probe: Probed<number>): Check {
  const title = "Marlin's Oyster indexer is current";
  if (!probe.ok) return check('marlin_indexer', title, 'warn', probe.error);
  const detail = `synced to a block ${(probe.value / 3600).toFixed(1)} h old`;
  return probe.value > THRESHOLDS.indexerWarnSecs
    ? check('marlin_indexer', title, 'warn', `${detail}: deposits may not reach the operator`)
    : check('marlin_indexer', title, 'ok', detail);
}

const RANK: Record<Status, number> = { ok: 0, warn: 1, fail: 2 };

/** The worst status among the checks. */
export function overall(checks: Check[]): Status {
  return checks.reduce<Status>(
    (worst, c) => (RANK[c.status] > RANK[worst] ? c.status : worst),
    'ok',
  );
}

/** One table cell: whitespace collapsed, pipes escaped, at most DETAIL_MAX characters. */
function cell(text: string): string {
  const line = text.replaceAll(/\s+/g, ' ').trim();
  const short = line.length > DETAIL_MAX ? `${line.slice(0, DETAIL_MAX - 1)}…` : line;
  return short.replaceAll('|', '\\|');
}

/** Markdown for the issue body and the job summary. */
export function renderReport(checks: Check[], nowSecs: bigint): string {
  const rows = checks.map((c) => `| ${c.status.toUpperCase()} | ${c.title} | ${cell(c.detail)} |`);
  return [
    `**Devnet demo: ${overall(checks).toUpperCase()}** at ${iso(nowSecs)}`,
    '',
    '| Status | Check | Detail |',
    '| --- | --- | --- |',
    ...rows,
    '',
  ].join('\n');
}
