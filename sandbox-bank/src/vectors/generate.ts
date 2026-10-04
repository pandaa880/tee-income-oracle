/**
 * Everything under test-vectors/ except keys/ and golden/, as a map from
 * relative path to bytes. Pure: same keys in, same bytes out.
 */

import { utf8 } from '../crypto/encoding.ts';
import type { KeyMode } from '../crypto/ecdh.ts';
import type { JsonValue } from '../crypto/jcs.ts';
import type { Alg } from '../crypto/jws.ts';
import { buildCase, jsonBytes, NEGATIVE_CASES, type CaseOptions } from './cases.ts';
import type { TestKeys } from './keys.ts';
import { buildPersonas, type Persona, type PersonaId } from './personas.ts';
import { policyBytes, policyHashHex } from './policy.ts';

/** Bump on any vector file-format change (FORMATS §0.1). */
export const GENERATOR_VERSION = 1;

/** Output directories owned by the generator (wiped and rewritten by gen:vectors). */
export const GENERATED_PATHS = [
  'personas',
  'policy',
  'vectors',
  'negative',
  'manifest.json',
] as const;

interface CaseDef {
  readonly id: string;
  readonly personaId: PersonaId;
  readonly mode: KeyMode;
  readonly aaAlg: Alg;
}

const POSITIVE_CASES: readonly CaseDef[] = [
  { id: 'salaried_steady', personaId: 'salaried_steady', mode: 'wei25519', aaAlg: 'RS256' },
  { id: 'trader_lumpy', personaId: 'trader_lumpy', mode: 'wei25519', aaAlg: 'RS256' },
  { id: 'declining', personaId: 'declining', mode: 'wei25519', aaAlg: 'RS256' },
  { id: 'stressed', personaId: 'stressed', mode: 'wei25519', aaAlg: 'RS256' },
  { id: 'rs512_aa', personaId: 'salaried_steady', mode: 'wei25519', aaAlg: 'RS512' },
  { id: 'x25519_mode', personaId: 'salaried_steady', mode: 'x25519', aaAlg: 'RS256' },
];

export function generateAll(keys: TestKeys): ReadonlyMap<string, Uint8Array> {
  const personas = buildPersonas();
  const out = new Map<string, Uint8Array>();
  const manifest: JsonValue[] = [];
  for (const p of personas) {
    out.set(`personas/${p.persona_id}.json`, jsonBytes(p));
  }
  out.set('policy/default.json', policyBytes());
  out.set('policy/default.hash', utf8(policyHashHex()));
  for (const c of POSITIVE_CASES) {
    const opts: CaseOptions = { mode: c.mode, aaAlg: c.aaAlg };
    addCase(out, manifest, `vectors/${c.id}`, c.id, persona(personas, c.personaId), keys, opts);
  }
  for (const n of NEGATIVE_CASES) {
    const opts: CaseOptions = { mode: 'wei25519', aaAlg: 'RS256', negative: n.id };
    addCase(
      out,
      manifest,
      `negative/${n.id}`,
      n.id,
      persona(personas, 'salaried_steady'),
      keys,
      opts,
    );
  }
  out.set('manifest.json', jsonBytes({ generator_version: GENERATOR_VERSION, cases: manifest }));
  return out;
}

function addCase(
  out: Map<string, Uint8Array>,
  manifest: JsonValue[],
  dir: string,
  id: string,
  p: Persona,
  keys: TestKeys,
  opts: CaseOptions,
): void {
  const files = buildCase(id, p, keys, opts);
  for (const [name, bytes] of files) {
    out.set(`${dir}/${name}`, bytes);
  }
  const expected: unknown = JSON.parse(
    Buffer.from(files.get('expected.json') ?? []).toString('utf8'),
  );
  manifest.push({
    id,
    kind: opts.negative === undefined ? 'positive' : 'negative',
    dir,
    persona_id: p.persona_id,
    expected: toJson(expected),
  });
}

function persona(personas: readonly Persona[], id: PersonaId): Persona {
  const p = personas.find((x) => x.persona_id === id);
  if (p === undefined) {
    throw new Error(`no persona ${id}`);
  }
  return p;
}

/** Narrows parsed JSON back to JsonValue (it came from our own jsonBytes). */
function toJson(value: unknown): JsonValue {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(toJson);
  }
  if (typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, toJson(v)]));
  }
  throw new Error('not JSON');
}
