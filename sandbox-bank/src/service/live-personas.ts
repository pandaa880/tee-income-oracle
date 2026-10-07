/**
 * Persona statements for the live bank, re-anchored every day. The bank
 * passes the enclave's requested `FIDataRange.to` (today 00:00 UTC by the
 * enclave's clock, FORMATS §10), so the statement ends on that day and
 * lies inside the requested window even across UTC midnight.
 */

import type { JsonValue } from '../crypto/jcs.ts';
import { buildPersonas, type PersonaId } from '../vectors/personas.ts';

const DAY = 86_400;

/** Only today's set is kept: building one takes a few milliseconds. */
let cached: { readonly day: number; readonly fi: ReadonlyMap<PersonaId, JsonValue> } | undefined;

/** The persona's FI JSON ending on the UTC day of `anchorUnix`; the same object all day. */
export function personaFi(id: PersonaId, anchorUnix: number): JsonValue {
  const day = anchorUnix - (anchorUnix % DAY);
  if (cached?.day !== day) {
    cached = { day, fi: new Map(buildPersonas(day).map((p) => [p.persona_id, p.fi])) };
  }
  const fi = cached.fi.get(id);
  if (fi === undefined) {
    throw new Error(`unknown persona ${id}`);
  }
  return fi;
}
