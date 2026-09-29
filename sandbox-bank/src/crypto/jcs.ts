/**
 * RFC 8785 JSON Canonicalization Scheme, restricted to what our canonical
 * objects use (FORMATS §0): strings, integers, booleans, null, arrays and
 * objects. Floats are rejected, so number serialization can't diverge
 * between implementations.
 */

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | readonly JsonValue[]
  | { readonly [k: string]: JsonValue };

/** Canonical JSON text of `value`. */
export function canonicalize(value: JsonValue): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    // JCS string and literal serialization is ECMAScript JSON.stringify.
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) {
      throw new Error(`JCS: only safe integers are allowed, got ${value}`);
    }
    return JSON.stringify(value);
  }
  if (isArray(value)) {
    return `[${value.map(canonicalize).join(',')}]`;
  }
  // Default sort compares UTF-16 code units, which is what RFC 8785 requires.
  const members = Object.keys(value)
    .toSorted()
    .map((k) => `${JSON.stringify(k)}:${canonicalize(value[k] ?? null)}`);
  return `{${members.join(',')}}`;
}

function isArray(value: JsonValue): value is readonly JsonValue[] {
  return Array.isArray(value);
}
