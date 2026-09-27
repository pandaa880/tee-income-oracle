"""Unit tests for the golden-vector checkers.

Covers `verify.py` (curve/key/point checks, both ECDH paths, tamper
rejection, -O safety) and `replay_against_rahasya.py` (request building and
response parsing, plus a live replay when rahasya runs on localhost:8080).

Run from this directory: `python3 -m unittest -v test_golden.py`.
The stored JSON vectors are never written to; every test that needs to
tamper with a vector works on a value freshly loaded from disk.
"""
import base64
import copy
import datetime
import json
import os
import subprocess
import sys
import unittest
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

import verify  # noqa: E402  (path must be set up first)
import replay_against_rahasya as replay  # noqa: E402

RAHASYA_BASE_URL = "http://localhost:8080"


# --------------------------- fixture helpers ---------------------------

def _read_json(filename: str) -> dict:
    """Loads a fixture fresh from disk. Never writes back to it.

    Args:
        filename: File name inside this directory, e.g. "ecc.json".

    Returns:
        The parsed JSON document as a new object tree.
    """
    with open(os.path.join(HERE, filename), encoding="utf-8") as f:
        return json.load(f)


def load_ecc_vectors() -> list:
    """Returns a freshly parsed copy of ecc.json's "vectors" list."""
    return _read_json("ecc.json")["vectors"]


def load_x25519_vector() -> dict:
    """Returns a freshly parsed copy of x25519.json."""
    return _read_json("x25519.json")


def flip_byte(data: bytes, index: int = 0) -> bytes:
    """Returns a copy of data with one byte's low bit flipped."""
    mutated = bytearray(data)
    mutated[index] ^= 0x01
    return bytes(mutated)


def rebuild_pem(der: bytes) -> str:
    """Re-armours DER bytes as a single-line PEM, matching the vector files.

    The stored KeyValue PEMs have no line breaks between the armour tags
    and the base64 body, so this mirrors that exact shape.
    """
    return ("-----BEGIN PUBLIC KEY-----" + base64.b64encode(der).decode()
            + "-----END PUBLIC KEY-----")


def tamper_curve_a(der: bytes) -> bytes:
    """Flips one byte of the curve coefficient `a` inside an SPKI DER blob.

    The 32-byte big-endian value of `a` appears verbatim in the DER, so we
    can locate and mutate it without a full ASN.1 rewrite.

    Raises:
        ValueError: if the coefficient can't be found (fixture broke).
    """
    target = verify.a_W.to_bytes(32, "big")
    idx = der.find(target)
    if idx == -1:
        raise ValueError("curve coefficient 'a' not found in DER")
    tampered = bytearray(der)
    tampered[idx + 31] ^= 0x01
    return bytes(tampered)


def tamper_x25519_fiu_pubkey(x: dict) -> dict:
    """Returns a deep copy of x with fiu's public key changed consistently.

    Both `public_key_raw_hex` and the trailing bytes of
    `public_key_spki_hex` are updated to the same wrong key, so a checker
    that only inspects one encoding can't be fooled.
    """
    x = copy.deepcopy(x)
    fiu = x["fiu"]
    old_raw_hex = fiu["public_key_raw_hex"]
    new_raw = flip_byte(bytes.fromhex(old_raw_hex), index=-1)
    new_raw_hex = new_raw.hex()
    prefix = fiu["public_key_spki_hex"][: -len(old_raw_hex)]
    fiu["public_key_raw_hex"] = new_raw_hex
    fiu["public_key_spki_hex"] = prefix + new_raw_hex
    return x


def rahasya_reachable() -> bool:
    """True if a rahasya server answers on RAHASYA_BASE_URL."""
    try:
        with urllib.request.urlopen(
            RAHASYA_BASE_URL + "/v2/api-docs", timeout=1
        ) as resp:
            return resp.status == 200
    except (urllib.error.URLError, OSError, TimeoutError):
        return False


# ------------------------------- verify.py -------------------------------

class TestEccVectors(unittest.TestCase):
    """F4/F5: check_ecc_vector must validate both keys and both points."""

    def test_ecc_vectors_pass(self):
        for v in load_ecc_vectors():
            with self.subTest(vector=v.get("name")):
                verify.check_ecc_vector(v)  # must not raise

    def test_rejects_bad_fiu_curve_param(self):
        # Proves the FIU key is checked, not just the FIP key.
        v = copy.deepcopy(load_ecc_vectors()[0])
        original_der = verify.pem_der(
            v["fiu"]["key_material"]["DHPublicKey"]["KeyValue"]
        )
        tampered_der = tamper_curve_a(original_der)
        self.assertNotEqual(tampered_der, original_der)
        v["fiu"]["key_material"]["DHPublicKey"]["KeyValue"] = rebuild_pem(
            tampered_der
        )
        with self.assertRaisesRegex(verify.VectorError,
                                    "fiu: curve parameters"):
            verify.check_ecc_vector(v)

    def test_rejects_bad_point_prefix(self):
        v = load_ecc_vectors()[0]
        params, point = verify.parse_spki(
            verify.pem_der(v["fiu"]["key_material"]["DHPublicKey"]["KeyValue"])
        )
        self.assertEqual(point[0], 0x04)
        bad_point = b"\x05" + point[1:]
        with self.assertRaisesRegex(verify.VectorError,
                                    "not 65-byte uncompressed"):
            verify.check_ec_public_key(params, bad_point, "fiu")

    def test_rejects_bad_generator(self):
        v = load_ecc_vectors()[0]
        params, point = verify.parse_spki(
            verify.pem_der(v["fiu"]["key_material"]["DHPublicKey"]["KeyValue"])
        )
        gx, gy = params["G"]
        for bad in ({"G_prefix": 0x02}, {"G": (gx, (gy + 1) % params["p"])}):
            with self.subTest(change=sorted(bad)):
                with self.assertRaisesRegex(verify.VectorError, "generator"):
                    verify.check_ec_public_key({**params, **bad}, point, "fiu")

    def test_rejects_off_curve_point(self):
        v = load_ecc_vectors()[0]
        params, point = verify.parse_spki(
            verify.pem_der(v["fiu"]["key_material"]["DHPublicKey"]["KeyValue"])
        )
        x = point[1:33]
        y = int.from_bytes(point[33:65], "big")
        bad_y = (y + 1) % params["p"]
        bad_point = b"\x04" + x + bad_y.to_bytes(32, "big")
        with self.assertRaisesRegex(verify.VectorError, "not on the curve"):
            verify.check_ec_public_key(params, bad_point, "fiu")

    def test_rejects_non_canonical_coordinate(self):
        # x + p is the same point mod p, so on_curve alone would accept it.
        v = load_ecc_vectors()[0]
        params, point = verify.parse_spki(
            verify.pem_der(v["fiu"]["key_material"]["DHPublicKey"]["KeyValue"])
        )
        x = int.from_bytes(point[1:33], "big") + params["p"]
        bad_point = b"\x04" + x.to_bytes(32, "big") + point[33:65]
        with self.assertRaisesRegex(verify.VectorError, "not < p"):
            verify.check_ec_public_key(params, bad_point, "fiu")

    def test_tampered_ciphertext_rejected(self):
        v = copy.deepcopy(load_ecc_vectors()[0])
        original = base64.b64decode(v["ciphertext_b64"])
        tampered = flip_byte(original, index=0)
        tampered_b64 = base64.b64encode(tampered).decode()
        self.assertNotEqual(tampered_b64, v["ciphertext_b64"])
        v["ciphertext_b64"] = tampered_b64
        with self.assertRaisesRegex(verify.VectorError, "decryption failed"):
            verify.check_ecc_vector(v)


class TestX25519Vector(unittest.TestCase):
    """F6: both ECDH directions and both public keys must be checked."""

    def test_x25519_passes_both_directions(self):
        verify.check_x25519_vector(load_x25519_vector())  # must not raise

    def test_x25519_rejects_mismatched_pubkey(self):
        # The FIU public key must be tied to the FIU private key. A checker
        # that only derives FIU_priv x FIP_pub would never look at it.
        bad_x = tamper_x25519_fiu_pubkey(load_x25519_vector())
        with self.assertRaisesRegex(verify.VectorError,
                                    "fiu: public key does not match"):
            verify.check_x25519_vector(bad_x)


class TestNoAssertReliance(unittest.TestCase):
    """Validation must not rely on `assert`, which -O strips."""

    def test_fails_under_python_O(self):
        script = f"""
import base64, copy, json, os, sys
sys.path.insert(0, {HERE!r})
import verify

with open(os.path.join({HERE!r}, "ecc.json"), encoding="utf-8") as f:
    vectors = json.load(f)["vectors"]
v = copy.deepcopy(vectors[0])
# Only a require() guards this field (no gcm/ValueError path), so the test
# fails if validation ever goes back to `assert`, which -O strips.
v["shared_secret_hex"] = "00" * 32
try:
    verify.check_ecc_vector(v)
except verify.VectorError:
    sys.exit(0)
else:
    sys.exit(1)
"""
        result = subprocess.run(
            [sys.executable, "-O", "-c", script],
            capture_output=True,
            text=True,
            timeout=30,
        )
        self.assertEqual(
            result.returncode,
            0,
            f"tampered vector was not rejected under -O; "
            f"stdout={result.stdout!r} stderr={result.stderr!r}",
        )


# ------------------------ replay_against_rahasya.py ------------------------

class TestBuildDecryptRequest(unittest.TestCase):
    """F2: the replayed decrypt request must carry a non-expired key."""

    def test_decrypt_request_has_future_expiry(self):
        v = load_ecc_vectors()[0]
        original_expiry = v["fip"]["key_material"]["DHPublicKey"]["expiry"]
        now = datetime.datetime(2030, 1, 1, tzinfo=datetime.timezone.utc)

        req = replay.build_decrypt_request(v, now)

        expiry = req["remoteKeyMaterial"]["DHPublicKey"]["expiry"]
        self.assertEqual(expiry, "2030-01-02T00:00:00.000Z")
        self.assertEqual(req["base64YourNonce"], v["fiu_nonce_b64"])
        self.assertEqual(req["base64RemoteNonce"], v["fip_nonce_b64"])
        self.assertEqual(req["ourPrivateKey"], v["fiu"]["private_key_pem"])
        self.assertEqual(req["base64Data"], v["ciphertext_b64"])
        # The stored vector must be untouched.
        self.assertEqual(
            v["fip"]["key_material"]["DHPublicKey"]["expiry"], original_expiry
        )


class TestExtractPlaintext(unittest.TestCase):
    """F3: extract_plaintext must read base64Data and fail closed."""

    def test_extract_plaintext_decodes_base64_data(self):
        plaintext = "hello rahasya"
        resp = {
            "base64Data": base64.b64encode(plaintext.encode()).decode(),
            "errorInfo": None,
        }
        self.assertEqual(replay.extract_plaintext(resp), plaintext)

    def test_extract_plaintext_raises_on_error_info(self):
        resp = {
            "base64Data": None,
            "errorInfo": {"errorCode": "ERR-01", "errorMsg": "bad request"},
        }
        with self.assertRaisesRegex(replay.ReplayError, "server error"):
            replay.extract_plaintext(resp)

    def test_extract_plaintext_raises_on_missing_data(self):
        resp = {"errorInfo": None}
        with self.assertRaisesRegex(replay.ReplayError, "no base64Data"):
            replay.extract_plaintext(resp)

    def test_extract_plaintext_raises_on_empty_data(self):
        resp = {"base64Data": "", "errorInfo": None}
        with self.assertRaisesRegex(replay.ReplayError, "no base64Data"):
            replay.extract_plaintext(resp)


@unittest.skipUnless(
    rahasya_reachable(), "rahasya not reachable on localhost:8080"
)
class TestReplayLive(unittest.TestCase):
    """Full black-box replay against a running rahasya reference server."""

    def test_replay_live(self):
        now = datetime.datetime.now(datetime.timezone.utc)
        for v in load_ecc_vectors():
            with self.subTest(vector=v.get("name")):
                decrypt_ok, shared_ok = replay.replay_vector(
                    RAHASYA_BASE_URL, v, now)
                self.assertTrue(decrypt_ok, "rahasya decrypted differently")
                self.assertTrue(shared_ok, "rahasya shared secret differs")


if __name__ == "__main__":
    unittest.main()
