// The library's own code must load and run with no Node globals: the verify page imports
// it in a browser. `Buffer` is removed before the modules are (re)loaded; the fixtures are
// read beforehand.
//
// Scope: the entrypoints that don't pull `@solana/kit` (nitro, sources, eth-address, report).
// Under vitest, kit resolves to its Node build (`ws`, `Buffer`), while a bundler picks its
// browser build; that build is what the web app already runs on. The source rule in
// `package-rules.test.ts` (no `node:`, no `process.`, no `Buffer`) covers every library file.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const repoFile = (path: string): string => fileURLToPath(new URL(`../../${path}`, import.meta.url));
const documentHex = readFileSync(repoFile('deployments/devnet/attestation-1.hex'), 'utf8').trim();
const compose = new Uint8Array(readFileSync(repoFile('enclave/docker-compose.yml')));
const IMAGE_ID_HEX = '7dd33d974511a825c871f267ebdc6b34fb9cdc2c63210e27a31a8c7cfb96daff';
const ATTESTER_HEX = '0xb6dda6eed87322334ba37809bd451a852ae6574c';

beforeAll(() => {
  vi.resetModules();
  vi.stubGlobal('Buffer', undefined);
});

afterAll(() => {
  vi.unstubAllGlobals();
});

describe('without Node globals', () => {
  it('has_no_buffer', () => {
    expect(globalThis.Buffer).toBeUndefined();
  });

  it('imports_the_kit_free_entrypoints_and_the_encoding_module', async () => {
    await expect(
      Promise.all([
        import('./nitro/index.ts'),
        import('./sources.ts'),
        import('./eth-address.ts'),
        import('./report.ts'),
        import('@tio/encoding'),
      ]),
    ).resolves.toHaveLength(5);
  });

  it('parses_verifies_and_hashes_an_archived_document_with_browser_codecs_only', async () => {
    const { parseHexDocument } = await import('./sources.ts');
    const {
      parseAttestation,
      verifyChain,
      verifyEs384,
      imageId,
      pcr16FromCompose,
      AWS_NITRO_ROOT_DER,
    } = await import('./nitro/index.ts');
    const { ethAddressFromPublicKey, toEthHex } = await import('./eth-address.ts');
    const { toHex } = await import('@tio/encoding');
    const bytes = parseHexDocument(documentHex);
    const { cose, document } = parseAttestation(bytes);
    const leaf = verifyChain({
      leaf: document.certificate,
      cabundle: document.cabundle,
      pinnedRoot: AWS_NITRO_ROOT_DER,
      atMs: document.timestampMs,
    });
    expect(verifyEs384(leaf.publicKey, cose)).toBe(true);
    expect(toHex(imageId(document.pcrs))).toBe(IMAGE_ID_HEX);
    expect(toHex(pcr16FromCompose(compose))).toBe(toHex(document.pcrs.get(16) ?? new Uint8Array()));
    expect(toEthHex(ethAddressFromPublicKey(document.publicKey ?? new Uint8Array()))).toBe(
      ATTESTER_HEX,
    );
  });

  it('round_trips_the_encoding_module_without_buffer', async () => {
    const { b64Decode, b64Encode, b64urlDecode, b64urlEncode, fromHex, toHex, utf8 } =
      await import('@tio/encoding');
    const bytes = Uint8Array.from({ length: 300 }, (_, i) => (i * 7) & 0xff);
    expect(b64Decode(b64Encode(bytes))).toEqual(bytes);
    expect(b64urlDecode(b64urlEncode(bytes))).toEqual(bytes);
    expect(fromHex(toHex(bytes))).toEqual(bytes);
    expect(utf8('é')).toEqual(Uint8Array.of(0xc3, 0xa9));
  });
});
