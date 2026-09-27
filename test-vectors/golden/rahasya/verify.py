"""Stdlib-only verifier for the rahasya golden vectors: python3 verify.py"""
import base64
import hashlib
import hmac
import json
import os
import re

p = 2**255 - 19
A_M = 486662
A3 = A_M * pow(3, -1, p) % p
a_W = 0x2aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa984914a144
b_W = 0x7b425ed097b425ed097b425ed097b425ed097b425ed097b4260b5e9c7710c864
Gx_W = 0x2aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaad245a
n = 2**252 + 27742317777372353535851937790883648493
X25519_SPKI_PREFIX = bytes.fromhex('302a300506032b656e032100')


class VectorError(Exception):
    """A golden vector failed a check. Raised instead of `assert` (-O safe)."""


def require(condition, message):
    """Raises VectorError(message) unless condition holds."""
    if not condition:
        raise VectorError(message)

# ---------------- DER ----------------
def tlv(b, i):
    t = b[i]; l = b[i + 1]; i += 2
    if l & 0x80:
        k = l & 0x7f; l = int.from_bytes(b[i:i + k], 'big'); i += k
    return t, b[i:i + l], i + l

def children(b):
    out, i = [], 0
    while i < len(b):
        t, v, i = tlv(b, i); out.append((t, v))
    return out

def pem_der(pem):
    return base64.b64decode(re.sub(r'-----[A-Z ]+-----', '', pem))

def parse_params(v):
    ver, fid, curve, base, order, cof = children(v)
    _, prime = children(fid[1])
    ca, cb = children(curve[1])[:2]
    G = base[1]
    return dict(version=int.from_bytes(ver[1], 'big'), p=int.from_bytes(prime[1], 'big'),
                a=int.from_bytes(ca[1], 'big'), b=int.from_bytes(cb[1], 'big'),
                G=(int.from_bytes(G[1:33], 'big'), int.from_bytes(G[33:65], 'big')), G_prefix=G[0],
                n=int.from_bytes(order[1], 'big'), h=int.from_bytes(cof[1], 'big'),
                curve_seq_len=len(children(curve[1])))

def parse_spki(der):
    (_, seq), = children(der)
    alg, bits = children(seq)
    oid, params = children(alg[1])
    pt = bits[1][1:]  # skip unused-bits byte
    return parse_params(params[1]), pt

def parse_pkcs8(der):
    (_, seq), = children(der)
    ver, alg, pk = children(seq)
    inner = children(children(pk[1])[0][1])  # ECPrivateKey SEQUENCE
    d_bytes = inner[1][1]
    pub = None
    for t, v in inner[2:]:
        if t == 0xa1: pub = children(v)[0][1][1:]
    return d_bytes, pub

# ---------------- Weierstrass ----------------
def w_add(P, Q):
    if P is None: return Q
    if Q is None: return P
    (x1, y1), (x2, y2) = P, Q
    if x1 == x2 and (y1 + y2) % p == 0: return None
    if P == Q: l = (3 * x1 * x1 + a_W) * pow(2 * y1, -1, p) % p
    else: l = (y2 - y1) * pow(x2 - x1, -1, p) % p
    x3 = (l * l - x1 - x2) % p
    return (x3, (l * (x1 - x3) - y1) % p)

def w_mul(k, P):
    R = None
    while k:
        if k & 1: R = w_add(R, P)
        P = w_add(P, P); k >>= 1
    return R

def on_curve(P):
    x, y = P
    return (y * y - (x ** 3 + a_W * x + b_W)) % p == 0

# ---------------- Montgomery ladder (RFC 7748, clamping optional) ----------------
def ladder(k, u, bits=255):
    x1, x2, z2, x3, z3, swap = u, 1, 0, u, 1, 0
    a24 = 121665
    for t in reversed(range(bits)):
        kt = (k >> t) & 1
        swap ^= kt
        if swap: x2, x3, z2, z3 = x3, x2, z3, z2
        swap = kt
        A = (x2 + z2) % p; AA = A * A % p; B = (x2 - z2) % p; BB = B * B % p
        E = (AA - BB) % p; C = (x3 + z3) % p; D = (x3 - z3) % p
        DA = D * A % p; CB = C * B % p
        x3 = (DA + CB) ** 2 % p; z3 = x1 * (DA - CB) ** 2 % p
        x2 = AA * BB % p; z2 = E * (AA + a24 * E) % p
    if swap: x2, x3, z2, z3 = x3, x2, z3, z2
    return x2 * pow(z2, p - 2, p) % p

def clamp(kb):
    k = bytearray(kb); k[0] &= 248; k[31] &= 127; k[31] |= 64
    return int.from_bytes(k, 'little')

def x25519(kb, ub):
    u = int.from_bytes(ub, 'little') & ((1 << 255) - 1)
    return ladder(clamp(kb), u).to_bytes(32, 'little')

# ---------------- HKDF ----------------
def hkdf(ikm, salt, info=b'', L=32):
    prk = hmac.new(salt, ikm, hashlib.sha256).digest()
    okm, t, c = b'', b'', 1
    while len(okm) < L:
        t = hmac.new(prk, t + info + bytes([c]), hashlib.sha256).digest(); okm += t; c += 1
    return okm[:L]

# ---------------- AES-256 + GCM ----------------
SBOX = [0] * 256
def _init_sbox():
    pp = q = 1
    while True:
        pp = pp ^ ((pp << 1) & 0xff) ^ (0x1b if pp & 0x80 else 0)
        q ^= q << 1; q ^= q << 2; q ^= q << 4; q &= 0xff
        if q & 0x80: q ^= 0x09
        x = q ^ ((q << 1) | (q >> 7)) & 0xff ^ ((q << 2) | (q >> 6)) & 0xff ^ ((q << 3) | (q >> 5)) & 0xff ^ ((q << 4) | (q >> 4)) & 0xff
        SBOX[pp] = (x ^ 0x63) & 0xff
        if pp == 1: break
    SBOX[0] = 0x63
_init_sbox()

def xt(a): return ((a << 1) ^ 0x1b) & 0xff if a & 0x80 else a << 1

def expand(key):
    Nk, Nr = 8, 14
    w = [list(key[4 * i:4 * i + 4]) for i in range(Nk)]
    rcon = 1
    for i in range(Nk, 4 * (Nr + 1)):
        t = list(w[i - 1])
        if i % Nk == 0:
            t = t[1:] + t[:1]; t = [SBOX[x] for x in t]; t[0] ^= rcon; rcon = xt(rcon)
        elif i % Nk == 4:
            t = [SBOX[x] for x in t]
        w.append([w[i - Nk][j] ^ t[j] for j in range(4)])
    return [sum(w[4 * r:4 * r + 4], []) for r in range(Nr + 1)]

def aes_block(rk, blk):
    s = [b ^ k for b, k in zip(blk, rk[0])]
    for r in range(1, 15):
        s = [SBOX[x] for x in s]
        s = [s[(i + 4 * (i % 4)) % 16] for i in range(16)]  # ShiftRows (column-major)
        if r != 14:
            ns = []
            for c in range(4):
                a = s[4 * c:4 * c + 4]
                ns += [xt(a[0]) ^ xt(a[1]) ^ a[1] ^ a[2] ^ a[3], a[0] ^ xt(a[1]) ^ xt(a[2]) ^ a[2] ^ a[3],
                       a[0] ^ a[1] ^ xt(a[2]) ^ xt(a[3]) ^ a[3], xt(a[0]) ^ a[0] ^ a[1] ^ a[2] ^ xt(a[3])]
            s = ns
        s = [b ^ k for b, k in zip(s, rk[r])]
    return bytes(s)

def gmul(x, y):
    R = 0xe1 << 120; z = 0
    for i in range(127, -1, -1):
        if (y >> i) & 1: z ^= x
        x = (x >> 1) ^ R if x & 1 else x >> 1
    return z

def ghash(H, aad, c):
    def blocks(b):
        b = b + b'\0' * (-len(b) % 16)
        return [int.from_bytes(b[i:i + 16], 'big') for i in range(0, len(b), 16)]
    y = 0
    for blk in blocks(aad) + blocks(c) + [(len(aad) * 8 << 64) | (len(c) * 8)]:
        y = gmul(y ^ blk, H)
    return y

def gcm(key, iv, data, decrypt=False, aad=b''):
    rk = expand(key)
    H = int.from_bytes(aes_block(rk, b'\0' * 16), 'big')
    J0 = iv + b'\0\0\0\1'
    if decrypt: data, tag = data[:-16], data[-16:]
    out = b''
    for i in range(0, len(data), 16):
        ctr = iv + (2 + i // 16).to_bytes(4, 'big')
        ks = aes_block(rk, ctr)
        out += bytes(x ^ y for x, y in zip(data[i:i + 16], ks))
    c = data if decrypt else out
    t = (ghash(H, aad, c) ^ int.from_bytes(aes_block(rk, J0), 'big')).to_bytes(16, 'big')
    if decrypt:
        if not hmac.compare_digest(t, tag): raise ValueError('GCM tag mismatch')
        return out
    return out + t

def xor_nonce(ours, remote):  # mirrors CipherService.xor (len = len(ours), remote indexed mod len)
    return bytes(ours[i] ^ remote[i % len(remote)] for i in range(len(ours)))

def session(shared, n1, n2):
    xn = xor_nonce(n1, n2)
    return hkdf(shared, xn[:20], b'', 32), xn[20:32]

def self_test():
    """Checks the crypto code against published NIST/RFC test vectors."""
    # AES/GCM: NIST GCM test case 16 (AES-256, 60B pt, 20B AAD)
    K = bytes.fromhex('feffe9928665731c6d6a8f9467308308feffe9928665731c6d6a8f9467308308')
    IV = bytes.fromhex('cafebabefacedbaddecaf888')
    P = bytes.fromhex('d9313225f88406e5a55909c5aff5269a86a7a9531534f7da2e4c303d8a318a721c3c0c95956809532fcf0e2449a6b525b16aedf5aa0de657ba637b39')
    AAD = bytes.fromhex('feedfacedeadbeeffeedfacedeadbeefabaddad2')
    ct = gcm(K, IV, P, aad=AAD)
    require(ct.hex() == '522dc1f099567d07f47f37a32a84427d643a8cdcbfe5c0c97598a2bd2555d1aa8cb08e48590dbb3da7b08b1056828838c5f61e6393ba7a0abcc9f662' + '76fc6ece0f4e1768cddf8853bb2d551b', 'self-test: AES-GCM encrypt')
    require(gcm(K, IV, ct, True, AAD) == P, 'self-test: AES-GCM decrypt')
    # RFC 7748 X25519 test vector 1
    k = bytes.fromhex('a546e36bf0527c9d3b16154b82465edd62144c0ac1fc5a18506a2244ba449ac4')
    u = bytes.fromhex('e6db6867583030db3594c1a424b15f7c726624ec26b3353b10a903a6d0ab1c4c')
    require(x25519(k, u).hex() == 'c3da55379de9c6908e94ea4df28d084f32eccf03491c71f754b4075577a28552', 'self-test: X25519')
    # RFC 5869 HKDF test case 1
    require(hkdf(bytes.fromhex('0b' * 22), bytes.fromhex('000102030405060708090a0b0c'), bytes.fromhex('f0f1f2f3f4f5f6f7f8f9'), 42).hex() == '3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865', 'self-test: HKDF')
    print('self-tests OK (NIST GCM TC16, RFC7748 TV1, RFC5869 TC1)')


# ---------------- vector checks ----------------
def check_ec_public_key(params, point, who):
    """Checks an EC public key is on Curve25519 in Weierstrass form.

    Args:
      params: Curve parameters parsed from the key's SPKI (see parse_spki).
      point: The uncompressed public point, 04 || X || Y (65 bytes).
      who: Label for error messages, e.g. 'fip'.

    Raises:
      VectorError: wrong curve parameters, bad encoding, or point off curve.
    """
    expected = (p, a_W, b_W, Gx_W, n, 8)
    actual = (params['p'], params['a'], params['b'], params['G'][0],
              params['n'], params['h'])
    require(actual == expected, f'{who}: curve parameters are not Curve25519')
    require(params['G_prefix'] == 0x04 and on_curve(params['G']),
            f'{who}: generator is not uncompressed or not on the curve')
    require(len(point) == 65 and point[0] == 0x04,
            f'{who}: public point is not 65-byte uncompressed (04||X||Y)')
    x, y = point_xy(point)
    require(x < p and y < p, f'{who}: public point coordinate is not < p')
    require(on_curve((x, y)), f'{who}: public point is not on the curve')


def point_xy(point):
    """Splits an uncompressed point 04 || X || Y into integer (x, y)."""
    return (int.from_bytes(point[1:33], 'big'),
            int.from_bytes(point[33:65], 'big'))


def load_ec_party(party, who):
    """Parses and checks one ECC party. Returns (private scalar, public xy)."""
    key_value = party['key_material']['DHPublicKey']['KeyValue']
    params, point = parse_spki(pem_der(key_value))
    check_ec_public_key(params, point, who)
    d_bytes = parse_pkcs8(pem_der(party['private_key_pem']))[0]
    d = int.from_bytes(d_bytes, 'big')
    return d, point_xy(point)


def check_session(shared, v):
    """Checks nonce XOR -> HKDF key/IV and decrypts the stored ciphertext.

    Raises:
      VectorError: derived key/IV differ from the vector, or decryption fails.
    """
    key, iv = session(shared, base64.b64decode(v['fip_nonce_b64']),
                      base64.b64decode(v['fiu_nonce_b64']))
    require((key.hex(), iv.hex()) == (v['aes_key_hex'], v['iv_hex']),
            'derived AES key / IV do not match the vector')
    try:
        plain = gcm(key, iv, base64.b64decode(v['ciphertext_b64']), True)
    except ValueError as e:  # GCM tag mismatch: ciphertext was tampered
        raise VectorError(f'decryption failed: {e}') from e
    require(plain == v['plaintext'].encode(), 'decrypted plaintext differs')


def check_ecc_vector(v):
    """Checks one rahasya ECC (Weierstrass Curve25519) vector end to end.

    Raises:
      VectorError: on the first check that fails.
    """
    d_fip, q_fip = load_ec_party(v['fip'], 'fip')
    d_fiu, q_fiu = load_ec_party(v['fiu'], 'fiu')
    s = w_mul(d_fip, q_fiu)
    require(s is not None and s == w_mul(d_fiu, q_fip),
            'ECDH shared point differs between the two sides')
    shared = s[0].to_bytes(32, 'big')
    require(shared.hex() == v['shared_secret_hex'], 'shared secret differs')
    # Same secret via the unclamped Montgomery ladder (x_W = u + A/3).
    montgomery_x = (ladder(d_fip, (q_fiu[0] - A3) % p) + A3) % p
    require(montgomery_x == s[0], 'Montgomery mapping gives a different secret')
    check_session(shared, v)


def check_x25519_party(party, who):
    """Checks a party's public key matches its private key and SPKI."""
    priv = bytes.fromhex(party['private_key_raw_hex'])
    pub = bytes.fromhex(party['public_key_raw_hex'])
    require(x25519(priv, (9).to_bytes(32, 'little')) == pub,
            f'{who}: public key does not match private key')
    spki = bytes.fromhex(party['public_key_spki_hex'])
    require(spki == X25519_SPKI_PREFIX + pub,
            f'{who}: SPKI does not wrap the raw public key')
    return priv, pub


def check_x25519_vector(x):
    """Checks the RFC 7748 X25519 vector in both ECDH directions.

    Raises:
      VectorError: on the first check that fails.
    """
    fip_priv, fip_pub = check_x25519_party(x['fip'], 'fip')
    fiu_priv, fiu_pub = check_x25519_party(x['fiu'], 'fiu')
    shared = x25519(fip_priv, fiu_pub)
    require(shared == x25519(fiu_priv, fip_pub),
            'X25519 shared secret differs between the two sides')
    require(shared.hex() == x['shared_secret_hex'], 'shared secret differs')
    check_session(shared, x)


def load_json(name):
    """Loads a vector file that sits next to this script."""
    here = os.path.dirname(os.path.abspath(__file__))
    with open(os.path.join(here, name), encoding='utf-8') as f:
        return json.load(f)


def main():
    """Runs self-tests and checks every stored vector. Returns an exit code."""
    try:
        self_test()
        for v in load_json('ecc.json')['vectors']:
            check_ecc_vector(v)
            print('ecc', v['name'], 'OK')
        check_x25519_vector(load_json('x25519.json'))
        print('x25519 OK')
    except VectorError as e:
        print(f'FAIL: {e}')
        return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
