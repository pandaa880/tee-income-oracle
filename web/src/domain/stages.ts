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

export type DataNode = {
  id: string;
  label: string;
  /** Place on the plus-shaped drawing (the `Schematic` slots). */
  slot: 'top' | 'left' | 'center' | 'right' | 'bottom';
  /** What this place sees of the data. */
  note: string;
  /** The one trusted place. */
  sealed?: boolean;
};

/** The hub every path runs through: it carries everything and reads none of it. */
const HUB = 'gateway';

/** Hub and spokes: the gateway in the middle, the bank above, the chain below. */
export const DATA_NODES: readonly DataNode[] = [
  { id: 'bank', label: 'Bank & AA', slot: 'top', note: 'encrypts · AA signs' },
  { id: 'browser', label: 'Browser', slot: 'left', note: 'consent only' },
  { id: HUB, label: 'Gateway', slot: 'center', note: 'relays, can’t read' },
  { id: 'enclave', label: 'Enclave', slot: 'right', note: 'plaintext only here', sealed: true },
  { id: 'chain', label: 'Solana', slot: 'bottom', note: 'tier + hashes' },
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

/** What lights up while `stage` runs: every node on its edges, and the spokes they travel. */
export function litPath(stage: Stage): { nodes: string[]; spokes: string[] } {
  const ids = [...new Set(EDGES[stage].flatMap((e) => [e.from, e.to]))];
  return { nodes: ids, spokes: ids.filter((id) => id !== HUB) };
}

export function dataPath(stage: Stage): { path: string; carries: string } {
  return PATHS[stage];
}
