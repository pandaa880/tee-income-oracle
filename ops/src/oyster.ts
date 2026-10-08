/**
 * Parsers for `oyster-cvm` 5.0.1 output (tracing log lines on stdout, e.g.
 * `2026-10-08T10:00:00Z  INFO oyster_cvm::commands::verify: Image id: …`).
 *
 * They fail closed: registering an enclave on a misread line would put a key
 * on chain that the attestation never vouched for. The format is pinned to
 * 5.0.1 (cli/oyster-cvm/src/commands/{verify,image_id}.rs); a newer CLI that
 * rewords a line makes `enclave:rotate` stop, not guess.
 */

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');
const HEX = /^(?:[0-9a-f]{2})+$/;

function stripAnsi(text: string): string {
  return text.replace(ANSI, '');
}

/** Every value printed after `<label>: ` on a log line. */
function valuesOf(text: string, label: string): string[] {
  const values: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const at = line.indexOf(`: ${label}: `);
    if (at !== -1) values.push(line.slice(at + label.length + 4).trim());
  }
  return values;
}

/** The single value of `label`, decoded from hex to exactly `lengths` bytes. */
function hexValue(text: string, label: string, lengths: number[]): Uint8Array {
  const distinct = [...new Set(valuesOf(text, label))];
  if (distinct.length !== 1) {
    throw new Error(`expected one "${label}" line, found ${distinct.length} distinct values`);
  }
  const value = distinct[0] ?? '';
  if (!HEX.test(value) || !lengths.includes(value.length / 2)) {
    throw new Error(`"${label}" is not ${lengths.join(' or ')} bytes of lowercase hex`);
  }
  return new Uint8Array(Buffer.from(value, 'hex'));
}

/** The 32-byte image id from `oyster-cvm compute-image-id` output. */
export function parseImageId(output: string): Uint8Array {
  return hexValue(stripAnsi(output), 'Image ID', [32]);
}

export type VerifiedAttestation = { enclavePublicKey: Uint8Array; imageId: Uint8Array };

/**
 * The attested public key and image id from `oyster-cvm verify` output.
 *
 * @throws Error unless the success line is present, no ERROR line is, and
 *   both values parse.
 */
export function parseVerifyOutput(output: string): VerifiedAttestation {
  const text = stripAnsi(output);
  if (/^\S+\s+ERROR\s/m.test(text)) throw new Error('oyster-cvm verify logged an ERROR');
  if (!text.includes('Verification successful')) {
    throw new Error('oyster-cvm verify did not report success');
  }
  return {
    enclavePublicKey: hexValue(text, 'Enclave public key', [64, 65]),
    imageId: hexValue(text, 'Image id', [32]),
  };
}

/** True for the committed compose template, which must never be deployed. */
export function isPlaceholderCompose(text: string): boolean {
  return text.includes('REPLACE_ME') || /@sha256:0{64}(?![0-9a-f])/.test(text);
}
