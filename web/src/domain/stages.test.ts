import { describe, expect, it } from 'vitest';
import { STAGE_ORDER } from './flow.ts';
import { activeEdges, DATA_NODES, dataPath, STAGE_COPY } from './stages.ts';

describe('STAGE_COPY', () => {
  it('uses the copy-deck titles', () => {
    expect(STAGE_ORDER.map((s) => STAGE_COPY[s].title)).toEqual([
      'Session bound to your wallet',
      'Bank asked for your statement',
      'Encrypted statement received',
      'Policy run blind inside the enclave',
      'Tier written to Solana',
    ]);
  });

  it.each(STAGE_ORDER)('has a note for %s', (stage) => {
    expect(STAGE_COPY[stage].note.length).toBeGreaterThan(0);
  });
});

describe('DATA_NODES', () => {
  it('are the five places the data travels, in order', () => {
    expect(DATA_NODES.map((n) => n.id)).toEqual(['bank', 'browser', 'gateway', 'enclave', 'chain']);
  });
});

describe('activeEdges and dataPath', () => {
  const ids = new Set(DATA_NODES.map((n) => n.id));

  it.each(STAGE_ORDER)('%s lights at least one edge between known nodes', (stage) => {
    const edges = activeEdges(stage);
    expect(edges.length).toBeGreaterThan(0);
    for (const edge of edges) {
      expect(ids.has(edge.from)).toBe(true);
      expect(ids.has(edge.to)).toBe(true);
    }
  });

  it.each(STAGE_ORDER)('%s says what travels and over which path', (stage) => {
    const { path, carries } = dataPath(stage);
    expect(path.length).toBeGreaterThan(0);
    expect(carries.length).toBeGreaterThan(0);
  });
});
