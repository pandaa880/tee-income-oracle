import { describe, expect, it } from 'vitest';
import { STAGE_ORDER } from './flow.ts';
import { DATA_NODES, dataPath, litPath, STAGE_COPY } from './stages.ts';

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

describe('DATA_NODES on the drawing', () => {
  it('puts the gateway in the middle and every other place on its own spoke', () => {
    const slots = DATA_NODES.map((n) => n.slot);
    expect(slots).toEqual(['top', 'left', 'center', 'right', 'bottom']);
    expect(DATA_NODES.find((n) => n.slot === 'center')?.id).toBe('gateway');
  });

  it('seals only the enclave, and says what each place sees', () => {
    expect(DATA_NODES.filter((n) => n.sealed === true).map((n) => n.id)).toEqual(['enclave']);
    for (const node of DATA_NODES) expect(node.note.length).toBeGreaterThan(0);
  });
});

describe('litPath and dataPath', () => {
  const ids = new Set(DATA_NODES.map((n) => n.id));

  it.each(STAGE_ORDER)(
    '%s lights known nodes through the gateway, never its own spoke',
    (stage) => {
      const { nodes, spokes } = litPath(stage);
      expect(nodes).toContain('gateway');
      expect(nodes.every((id) => ids.has(id))).toBe(true);
      expect(spokes.length).toBeGreaterThan(0);
      expect(spokes).not.toContain('gateway');
      expect(spokes.every((id) => nodes.includes(id))).toBe(true);
    },
  );

  it('lights the fetch path bank → gateway → enclave', () => {
    expect(litPath('fi_fetch')).toEqual({
      nodes: ['bank', 'gateway', 'enclave'],
      spokes: ['bank', 'enclave'],
    });
  });

  it.each(STAGE_ORDER)('%s says what travels and over which path', (stage) => {
    const { path, carries } = dataPath(stage);
    expect(path.length).toBeGreaterThan(0);
    expect(carries.length).toBeGreaterThan(0);
  });
});
