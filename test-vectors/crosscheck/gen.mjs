import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const a2Str = fs.readFileSync(path.join(import.meta.dirname, '../golden/rfc7515/a2.json'), 'utf8');
const rfc7520Str = fs.readFileSync(path.join(import.meta.dirname, '../golden/rfc7515/rfc7520.json'), 'utf8');
const a2 = JSON.parse(a2Str).jwk;
const rfc7520 = JSON.parse(rfc7520Str).jwk;

const a2Kid = "11111111-1111-4111-8111-111111111111";

const a2Key = crypto.createPrivateKey({ key: a2, format: 'jwk' });
const rfc7520Key = crypto.createPrivateKey({ key: rfc7520, format: 'jwk' });

const a2PubKeyPem = crypto.createPublicKey(a2Key).export({ type: 'spki', format: 'pem' });

function b64u(buf) {
  if (typeof buf === 'string') buf = Buffer.from(buf);
  return buf.toString('base64url');
}

function sign(header, body, key, alg) {
  const headerB64 = b64u(JSON.stringify(header));
  let signingInput;
  let bodyB64 = "";
  let form = "detached";

  if (header.b64 === false) {
    // detached
    signingInput = Buffer.concat([Buffer.from(headerB64 + '.'), body]);
    bodyB64 = b64u(body);
  } else {
    // compact
    form = "compact";
    bodyB64 = b64u(body);
    signingInput = Buffer.from(headerB64 + '.' + bodyB64);
  }

  let sig;
  if (alg === 'HS256') {
    const hmac = crypto.createHmac('sha256', a2PubKeyPem);
    hmac.update(signingInput);
    sig = hmac.digest();
  } else if (alg === 'none') {
    sig = Buffer.alloc(0);
  } else {
    const hash = alg === 'RS256' ? 'sha256' : 'sha512';
    const signer = crypto.createSign(hash);
    signer.update(signingInput);
    sig = signer.sign(key);
  }

  return {
    form,
    jws: headerB64 + '..' + b64u(sig),
    jwsCompact: headerB64 + '.' + bodyB64 + '.' + b64u(sig),
    bodyB64,
    signingInput,
    sig
  };
}

const cases = [];

function addCase(name, expect, form, jws, bodyB64 = "") {
  cases.push({ name, expect, form, jws, bodyB64 });
}

const detachedHeaderRs256 = { alg: "RS256", kid: a2Kid, b64: false, crit: ["b64"] };
const detachedHeaderRs512 = { alg: "RS512", kid: a2Kid, b64: false, crit: ["b64"] };
const compactHeaderRs256 = { alg: "RS256", kid: a2Kid };
const compactHeaderRs512 = { alg: "RS512", kid: a2Kid };
const defaultBody = Buffer.from("hello world");

// 1. detached RS256 ok
const c1 = sign(detachedHeaderRs256, defaultBody, a2Key, 'RS256');
addCase("detached RS256 ok", "ok", c1.form, c1.jws, c1.bodyB64);

// 2. detached RS512 ok
const c2 = sign(detachedHeaderRs512, defaultBody, a2Key, 'RS512');
addCase("detached RS512 ok", "ok", c2.form, c2.jws, c2.bodyB64);

// 3. compact RS256 ok
const c3 = sign(compactHeaderRs256, defaultBody, a2Key, 'RS256');
addCase("compact RS256 ok", "ok", c3.form, c3.jwsCompact);

// 4. compact RS512 ok
const c4 = sign(compactHeaderRs512, defaultBody, a2Key, 'RS512');
addCase("compact RS512 ok", "ok", c4.form, c4.jwsCompact);

// 5. empty body ok
const c5 = sign(detachedHeaderRs256, Buffer.alloc(0), a2Key, 'RS256');
addCase("empty body ok", "ok", c5.form, c5.jws, c5.bodyB64);

// 6. body containing '.' and non-UTF8 bytes ok
const bodyWithDotAndNonUtf8 = Buffer.from([0x68, 0x65, 0x2e, 0x6c, 0x80, 0xff]);
const c6 = sign(detachedHeaderRs256, bodyWithDotAndNonUtf8, a2Key, 'RS256');
addCase("body containing . and non-UTF8 bytes ok", "ok", c6.form, c6.jws, c6.bodyB64);

// 7. flipped body byte -> bad_signature
const c7 = sign(detachedHeaderRs256, defaultBody, a2Key, 'RS256');
let flippedBody = Buffer.from(defaultBody);
flippedBody[0] ^= 1;
addCase("flipped body byte", "bad_signature", c7.form, c7.jws, b64u(flippedBody));

// 8. flipped signature byte -> bad_signature
const c8 = sign(detachedHeaderRs256, defaultBody, a2Key, 'RS256');
let sigCopy = Buffer.from(c8.sig);
sigCopy[0] ^= 1;
const parts8 = c8.jws.split('.');
addCase("flipped signature byte", "bad_signature", c8.form, parts8[0] + '..' + b64u(sigCopy), c8.bodyB64);

// 9. RS512 signature under RS256 header -> bad_signature
const c9_sig = sign(detachedHeaderRs512, defaultBody, a2Key, 'RS512').sig;
addCase("RS512 signature under RS256 header", "bad_signature", "detached", b64u(JSON.stringify(detachedHeaderRs256)) + ".." + b64u(c9_sig), b64u(defaultBody));

// 10. RFC 7520 key under A.2 kid -> bad_signature
const c10 = sign(detachedHeaderRs256, defaultBody, rfc7520Key, 'RS256');
addCase("RFC 7520 key under A.2 kid", "bad_signature", c10.form, c10.jws, c10.bodyB64);

// 11. RFC 7520 kid unpinned -> unknown_kid
const headerUnknownKid = { alg: "RS256", kid: "bilbo.baggins@hobbiton.example", b64: false, crit: ["b64"] };
const c11 = sign(headerUnknownKid, defaultBody, rfc7520Key, 'RS256');
addCase("RFC 7520 kid unpinned", "unknown_kid", c11.form, c11.jws, c11.bodyB64);

// 12. alg HS256 -> bad_alg
const headerHS256 = { alg: "HS256", kid: a2Kid, b64: false, crit: ["b64"] };
const c12 = sign(headerHS256, defaultBody, a2Key, 'HS256');
addCase("alg HS256", "bad_alg", c12.form, c12.jws, c12.bodyB64);

// 13. alg none -> bad_alg
const headerNone = { alg: "none", kid: a2Kid, b64: false, crit: ["b64"] };
const c13 = sign(headerNone, defaultBody, a2Key, 'none');
addCase("alg none", "bad_alg", c13.form, c13.jws, c13.bodyB64);

// 14. missing crit -> bad_header
const headerMissingCrit = { alg: "RS256", kid: a2Kid, b64: false };
const c14 = sign(headerMissingCrit, defaultBody, a2Key, 'RS256');
addCase("missing crit", "bad_header", c14.form, c14.jws, c14.bodyB64);

// 15. jwk header -> bad_header
const headerJwk = { alg: "RS256", kid: a2Kid, b64: false, crit: ["b64"], jwk: a2 };
const c15 = sign(headerJwk, defaultBody, a2Key, 'RS256');
addCase("jwk header", "bad_header", c15.form, c15.jws, c15.bodyB64);

// 16. padded signature -> bad_jws
const c16 = sign(detachedHeaderRs256, defaultBody, a2Key, 'RS256');
const paddedSigB64 = c16.sig.toString('base64'); // with padding '='
const parts16 = c16.jws.split('.');
addCase("padded signature", "bad_jws", c16.form, parts16[0] + '..' + paddedSigB64, c16.bodyB64);

fs.writeFileSync(path.join(import.meta.dirname, 'node_vectors.json'), JSON.stringify(cases, null, 2));
