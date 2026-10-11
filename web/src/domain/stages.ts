// What each §16 stage means to the borrower, and where the data travels while it runs.
import type { Stage } from './types.ts';

export const STAGE_COPY: Record<Stage, { title: string; note: string }> = {
  bind: {
    title: 'Session bound to your wallet',
    note: 'Your signature ties this session to your address, so the tier can only land there.',
  },
  fi_request: {
    title: 'Bank asked for your statement',
    note: 'The enclave signs the request itself; the gateway only carries it.',
  },
  fi_fetch: {
    title: 'Encrypted statement received',
    note: "Encrypted to the enclave by the bank, signed by the AA; the gateway can't read it.",
  },
  evaluate: {
    title: 'Policy run blind inside the enclave',
    note: "AA signature checked, decrypted, the pool's eligibility criteria applied, plaintext wiped.",
  },
  submit: {
    title: 'Tier written to Solana',
    note: 'One tier, the policy hash and the enclave build. No transactions, no balances.',
  },
};

export type DataNode = { id: string; label: string; x: number; y: number };

/** Hub and spokes on the square drawing: the gateway in the middle carries everything. */
export const DATA_NODES: readonly DataNode[] = [
  { id: 'bank', label: 'Bank & AA', x: 15, y: 20 },
  { id: 'browser', label: 'Browser', x: 15, y: 80 },
  { id: 'gateway', label: 'Gateway', x: 50, y: 50 },
  { id: 'enclave', label: 'Enclave', x: 85, y: 20 },
  { id: 'chain', label: 'Solana', x: 85, y: 80 },
];

type Edge = { from: string; to: string };
const edge = (from: string, to: string): Edge => ({ from, to });

const EDGES: Record<Stage, readonly Edge[]> = {
  bind: [edge('browser', 'gateway'), edge('gateway', 'enclave')],
  fi_request: [edge('enclave', 'gateway'), edge('gateway', 'bank')],
  fi_fetch: [edge('bank', 'gateway'), edge('gateway', 'enclave')],
  evaluate: [edge('gateway', 'enclave')],
  submit: [edge('gateway', 'chain')],
};

const PATHS: Record<Stage, { path: string; carries: string }> = {
  bind: {
    path: 'Browser → Gateway → Enclave',
    carries: 'Your wallet signature over the consent text. No bank data.',
  },
  fi_request: {
    path: 'Enclave → Gateway → Bank',
    carries: "The enclave's signed request for one statement.",
  },
  fi_fetch: {
    path: 'Bank → Gateway → Enclave',
    carries: 'Ciphertext: encrypted to the enclave, signed by the AA.',
  },
  evaluate: {
    path: 'Inside the enclave',
    carries: 'Plaintext exists only here, for this session, then it is wiped.',
  },
  submit: {
    path: 'Gateway → Solana',
    carries: 'A signed tier, the policy hash and the enclave build.',
  },
};

/** The edges that light up while `stage` runs. */
export function activeEdges(stage: Stage): readonly Edge[] {
  return EDGES[stage];
}

export function dataPath(stage: Stage): { path: string; carries: string } {
  return PATHS[stage];
}
