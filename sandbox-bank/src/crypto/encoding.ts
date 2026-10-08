/**
 * The shared byte encodings (`@tio/encoding`), plus `jsonBytes`, which needs
 * the bank's JCS types.
 */
import { utf8 } from '@tio/encoding';
import type { JsonValue } from './jcs.ts';

export * from '@tio/encoding';

/** Compact (indent 0) for signed bodies; 2-space for human-read files. No trailing newline. */
export function jsonBytes(value: JsonValue, indent = 2): Uint8Array {
  return utf8(JSON.stringify(value, null, indent));
}
