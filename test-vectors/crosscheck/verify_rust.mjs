import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

function b64uDecode(str) {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  return Buffer.from(str, 'base64');
}

const outPath = path.join(import.meta.dirname, 'out/rust_signed.json');
const data = JSON.parse(fs.readFileSync(outPath, 'utf8'));

const pubKey = crypto.createPublicKey({ key: data.public_jwk, format: 'jwk' });
const kid = data.kid;

for (let i = 0; i < data.cases.length; i++) {
  const c = data.cases[i];
  const parts = c.jws.split('.');
  if (parts.length !== 3) {
    console.error(`Case ${i}: invalid parts length ${parts.length}`);
    process.exit(1);
  }
  const headerB64 = parts[0];
  if (parts[1] !== "") {
    console.error(`Case ${i}: expected empty payload segment for detached JWS`);
    process.exit(1);
  }
  const sigB64 = parts[2];
  
  const headerJson = JSON.parse(b64uDecode(headerB64).toString('utf8'));
  const expectedHeader = {
    alg: "RS256",
    kid: kid,
    b64: false,
    crit: ["b64"]
  };
  
  if (JSON.stringify(headerJson) !== JSON.stringify(expectedHeader)) {
    console.error(`Case ${i}: header mismatch`);
    console.error(`Expected: ${JSON.stringify(expectedHeader)}`);
    console.error(`Actual: ${JSON.stringify(headerJson)}`);
    process.exit(1);
  }
  
  const body = b64uDecode(c.body_b64);
  const signingInput = Buffer.concat([Buffer.from(headerB64 + '.'), body]);
  const sig = b64uDecode(sigB64);
  
  const verified = crypto.verify('sha256', signingInput, pubKey, sig);
  if (!verified) {
    console.error(`Case ${i}: signature verification failed`);
    process.exit(1);
  }
  
  // check tampered copy
  const tamperedSig = Buffer.from(sig);
  tamperedSig[0] ^= 1;
  const tamperedVerified = crypto.verify('sha256', signingInput, pubKey, tamperedSig);
  if (tamperedVerified) {
    console.error(`Case ${i}: tampered signature verified successfully (expected failure)`);
    process.exit(1);
  }
}

console.log("verify_rust.mjs: All cases verified successfully");
