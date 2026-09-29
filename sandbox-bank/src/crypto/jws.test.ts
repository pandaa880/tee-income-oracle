import { createPrivateKey, generateKeyPairSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { b64urlDecode, b64urlEncode, utf8 } from './encoding.ts';
import {
  encodeCompact,
  encodeDetached,
  rsaSigner,
  signCompact,
  signDetached,
  verifyCompact,
  verifyDetached,
  type JwsHeader,
  type PinnedKey,
  type RsaKey,
} from './jws.ts';

interface Rfc7515A2 {
  readonly jwk: Record<string, string>;
  readonly signing_input: string;
  readonly signature_b64: string;
}

function readGoldenJson(relativePath: string): unknown {
  const url = new URL(`../../../test-vectors/golden/${relativePath}`, import.meta.url);
  return JSON.parse(readFileSync(url, 'utf8'));
}

function makeRsaKey(kid: string): RsaKey {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return { kid, privateKey, publicKey };
}

function pinnedOf(key: RsaKey): PinnedKey {
  return { kid: key.kid, publicKey: key.publicKey };
}

const KEY = makeRsaKey('11111111-1111-4111-8111-111111111111');
const PINNED = pinnedOf(KEY);

describe('golden anchor: RFC 7515 Appendix A.2', () => {
  it('rsaSigner reproduces the exact RS256 signature', () => {
    const a2 = readGoldenJson('rfc7515/a2.json') as Rfc7515A2;
    const privateKey = createPrivateKey({ key: a2.jwk, format: 'jwk' });

    const signature = rsaSigner(privateKey, 'RS256')(utf8(a2.signing_input));

    expect(signature).toEqual(b64urlDecode(a2.signature_b64));
  });
});

describe('signDetached / verifyDetached round trip', () => {
  it('verifies a genuine RS256 detached signature', () => {
    const body = utf8('detached body bytes');
    const jws = signDetached(body, KEY);
    expect(verifyDetached(jws, body, [PINNED])).toEqual({ ok: true, value: null });
  });

  it('verifies a genuine RS512 detached signature', () => {
    const body = utf8('detached body bytes, rs512');
    const jws = signDetached(body, KEY, 'RS512');
    expect(verifyDetached(jws, body, [PINNED])).toEqual({ ok: true, value: null });
  });
});

describe('signCompact / verifyCompact round trip', () => {
  it('verifies a genuine RS256 compact signature and returns the exact payload', () => {
    const payload = utf8('{"consentId":"abc-123","status":"ACTIVE"}');
    const jws = signCompact(payload, KEY);
    expect(verifyCompact(jws, [PINNED])).toEqual({ ok: true, value: payload });
  });

  it('verifies a genuine RS512 compact signature', () => {
    const payload = utf8('{"consentId":"abc-123","status":"ACTIVE"}');
    const jws = signCompact(payload, KEY, 'RS512');
    expect(verifyCompact(jws, [PINNED])).toEqual({ ok: true, value: payload });
  });
});

describe('verifyDetached / verifyCompact: FORMATS §4 check order and codes', () => {
  const body = utf8('negative-case body');
  const sign = rsaSigner(KEY.privateKey, 'RS256');

  function detachedHeader(overrides: Partial<JwsHeader> = {}): JwsHeader {
    return { alg: 'RS256', kid: KEY.kid, b64: false, crit: ['b64'], ...overrides };
  }

  function compactHeader(overrides: Partial<JwsHeader> = {}): JwsHeader {
    return { alg: 'RS256', kid: KEY.kid, ...overrides };
  }

  it('rejects a flipped body byte as bad_signature', () => {
    const jws = signDetached(body, KEY);
    const tampered = new Uint8Array(body);
    tampered[0] = (tampered[0] ?? 0) ^ 0x01;

    expect(verifyDetached(jws, tampered, [PINNED])).toEqual({ ok: false, code: 'bad_signature' });
  });

  it.each(['none', 'HS256'] as const)(
    'rejects alg %s as bad_alg, even with an unknown kid',
    (alg) => {
      const header: JwsHeader = { alg, kid: 'not-pinned-kid', b64: false, crit: ['b64'] };
      const jws = encodeDetached(header, body, sign);

      expect(verifyDetached(jws, body, [PINNED])).toEqual({ ok: false, code: 'bad_alg' });
    },
  );

  it('rejects a detached header missing crit as bad_header', () => {
    const header: JwsHeader = { alg: 'RS256', kid: KEY.kid, b64: false };
    const jws = encodeDetached(header, body, sign);

    expect(verifyDetached(jws, body, [PINNED])).toEqual({ ok: false, code: 'bad_header' });
  });

  it('rejects a detached header with b64 true as bad_header', () => {
    const jws = encodeDetached(detachedHeader({ b64: true }), body, sign);

    expect(verifyDetached(jws, body, [PINNED])).toEqual({ ok: false, code: 'bad_header' });
  });

  it('rejects a compact header carrying b64 as bad_header', () => {
    const payload = utf8('compact payload');
    const jws = encodeCompact(compactHeader({ b64: false }), payload, sign);

    expect(verifyCompact(jws, [PINNED])).toEqual({ ok: false, code: 'bad_header' });
  });

  it('rejects a header missing kid as bad_header', () => {
    const header: JwsHeader = { alg: 'RS256', b64: false, crit: ['b64'] };
    const jws = encodeDetached(header, body, sign);

    expect(verifyDetached(jws, body, [PINNED])).toEqual({ ok: false, code: 'bad_header' });
  });

  it('rejects an unknown kid as unknown_kid', () => {
    const jws = encodeDetached(detachedHeader({ kid: 'not-pinned-kid' }), body, sign);

    expect(verifyDetached(jws, body, [PINNED])).toEqual({ ok: false, code: 'unknown_kid' });
  });

  it('rejects a header carrying jwk as bad_header', () => {
    const jws = encodeDetached(detachedHeader({ jwk: {} }), body, sign);

    expect(verifyDetached(jws, body, [PINNED])).toEqual({ ok: false, code: 'bad_header' });
  });

  it('rejects a 2-segment JWS as bad_jws', () => {
    const jws = signDetached(body, KEY);
    const [header] = jws.split('.');
    expect(verifyDetached(`${header}.`, body, [PINNED])).toEqual({ ok: false, code: 'bad_jws' });
  });

  it('rejects a 4-segment JWS as bad_jws', () => {
    const jws = signDetached(body, KEY);
    expect(verifyDetached(`${jws}.extra`, body, [PINNED])).toEqual({ ok: false, code: 'bad_jws' });
  });

  it('rejects a non-empty detached middle segment as bad_jws', () => {
    const jws = signDetached(body, KEY);
    const parts = jws.split('.');
    const header = parts[0];
    const signature = parts[2];
    if (header === undefined || signature === undefined) {
      throw new Error('expected a 3-segment detached JWS');
    }
    expect(verifyDetached(`${header}.not-empty.${signature}`, body, [PINNED])).toEqual({
      ok: false,
      code: 'bad_jws',
    });
  });

  it('rejects a padded signature segment as bad_jws', () => {
    const jws = signDetached(body, KEY);
    expect(verifyDetached(`${jws}==`, body, [PINNED])).toEqual({ ok: false, code: 'bad_jws' });
  });
});

/** Validly signed detached JWS over exact header bytes (JSON.stringify can't emit duplicates). */
function rawDetached(headerBytes: Uint8Array, body: Uint8Array): string {
  const h = b64urlEncode(headerBytes);
  const input = new Uint8Array([...utf8(`${h}.`), ...body]);
  return `${h}..${b64urlEncode(rsaSigner(KEY.privateKey, 'RS256')(input))}`;
}

describe('header parsing mirrors tio-core serde Header', () => {
  const body = utf8('body');
  const kid = KEY.kid;
  const tail = `"kid":"${kid}","b64":false,"crit":["b64"]`;

  it('accepts the raw-header baseline', () => {
    const jws = rawDetached(utf8(`{"alg":"RS256",${tail}}`), body);
    expect(verifyDetached(jws, body, [PINNED])).toEqual({ ok: true, value: null });
  });

  it('rejects a repeated alg member as bad_header', () => {
    const jws = rawDetached(utf8(`{"alg":"HS256","alg":"RS256",${tail}}`), body);
    expect(verifyDetached(jws, body, [PINNED])).toEqual({ ok: false, code: 'bad_header' });
  });

  it('rejects a repeat spelled with an escaped name as bad_header', () => {
    const jws = rawDetached(utf8(`{"alg":"HS256","\\u0061lg":"RS256",${tail}}`), body);
    expect(verifyDetached(jws, body, [PINNED])).toEqual({ ok: false, code: 'bad_header' });
  });

  it('ignores an acted-on name nested inside an unknown member', () => {
    const jws = rawDetached(utf8(`{"alg":"RS256","ext":{"alg":1},${tail}}`), body);
    expect(verifyDetached(jws, body, [PINNED])).toEqual({ ok: true, value: null });
  });

  it('reports a wrongly typed kid as bad_header even when alg is also bad', () => {
    const jws = rawDetached(utf8('{"alg":"HS256","kid":5,"b64":false,"crit":["b64"]}'), body);
    expect(verifyDetached(jws, body, [PINNED])).toEqual({ ok: false, code: 'bad_header' });
  });

  it('rejects invalid UTF-8 inside an unknown member as bad_header', () => {
    const prefix = utf8(`{"alg":"RS256",${tail},"x":"`);
    const header = new Uint8Array([...prefix, 0xff, ...utf8('"}')]);
    const jws = rawDetached(header, body);
    expect(verifyDetached(jws, body, [PINNED])).toEqual({ ok: false, code: 'bad_header' });
  });
});
