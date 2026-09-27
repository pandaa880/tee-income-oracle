#!/usr/bin/env python3
"""Replay the stored ECC golden vectors against a live rahasya server.

This is a black-box check: it does no cryptography itself. It sends each
stored decrypt request (FIU private key + FIP key material + ciphertext) to
the reference implementation and checks the reference returns the stored
plaintext, and that it computes the stored shared secret from both sides.
If so, the vectors really came from rahasya.

Typical usage:

    docker run --platform linux/amd64 --rm -d -p 8080:8080 \
        --name rahasya gsasikumar/forwardsecrecy:V1.2
    python3 replay_against_rahasya.py            # default http://localhost:8080
    docker stop rahasya

Standard library only.
"""
import base64
import binascii
import copy
import datetime
import json
import os
import sys
import urllib.error
import urllib.request

DEFAULT_BASE_URL = "http://localhost:8080"
HERE = os.path.dirname(os.path.abspath(__file__))
KEY_LIFETIME = datetime.timedelta(hours=24)


class ReplayError(Exception):
    """The reference server rejected a request or returned an unusable reply."""


def rahasya_timestamp(moment):
    """Formats a datetime like rahasya does: yyyy-MM-ddTHH:mm:ss.SSSZ (UTC)."""
    utc = moment.astimezone(datetime.timezone.utc)
    millis = utc.microsecond // 1000
    return utc.strftime("%Y-%m-%dT%H:%M:%S.") + f"{millis:03d}Z"


def build_decrypt_request(v, now):
    """Builds the /ecc/v1/decrypt body for a stored vector.

    rahasya rejects remote key material whose `expiry` is in the past, and
    the stored vectors' keys expired a day after generation. `expiry` is a
    policy field, not part of the cryptography, so refreshing it doesn't
    change what the replay proves.

    Args:
      v: One vector from ecc.json. Not modified.
      now: Current time (timezone-aware).

    Returns:
      The JSON body for the decrypt call.
    """
    key_material = copy.deepcopy(v["fip"]["key_material"])
    expiry = rahasya_timestamp(now + KEY_LIFETIME)
    key_material["DHPublicKey"]["expiry"] = expiry
    return {
        "base64YourNonce": v["fiu_nonce_b64"],
        "base64RemoteNonce": v["fip_nonce_b64"],
        "ourPrivateKey": v["fiu"]["private_key_pem"],
        "remoteKeyMaterial": key_material,
        "base64Data": v["ciphertext_b64"],
    }


def extract_plaintext(resp):
    """Reads the plaintext from rahasya's CipherResponse{base64Data, errorInfo}.

    Raises:
      ReplayError: the response carries an error or no data.
    """
    raise_on_error_info(resp)
    data = resp.get("base64Data")
    if not data:
        raise ReplayError("response has no base64Data")
    try:
        return base64.b64decode(data, validate=True).decode("utf-8")
    except (binascii.Error, UnicodeDecodeError) as e:
        raise ReplayError(f"base64Data is not base64 UTF-8: {e}") from e


def raise_on_error_info(resp):
    """Raises ReplayError if a rahasya response carries errorInfo."""
    if resp.get("errorInfo") is not None:
        raise ReplayError(f"server error: {resp['errorInfo']}")


def post(base_url, path, body):
    """POSTs JSON and returns the JSON reply.

    Raises:
      ReplayError: HTTP error status (message includes the server's reply).
    """
    req = urllib.request.Request(
        base_url + path,
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            return json.loads(resp.read())
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", "replace")[:200]
        raise ReplayError(f"{path} -> HTTP {e.code}: {detail}") from e
    except (TimeoutError, json.JSONDecodeError) as e:
        raise ReplayError(f"{path} -> no usable reply: {e}") from e


def shared_secret_matches(base_url, v):
    """True if rahasya derives the stored shared secret from both sides."""
    want = base64.b64encode(bytes.fromhex(v["shared_secret_hex"])).decode()
    for ours, theirs in (("fip", "fiu"), ("fiu", "fip")):
        remote_key = v[theirs]["key_material"]["DHPublicKey"]["KeyValue"]
        resp = post(base_url, "/ecc/v1/getSharedKey", {
            "ourPrivateKey": v[ours]["private_key_pem"],
            "remotePublicKey": remote_key,
        })
        raise_on_error_info(resp)
        if resp.get("key") != want:
            return False
    return True


def replay_vector(base_url, v, now):
    """Replays one vector. Returns (decrypt_ok, shared_secret_ok)."""
    decrypted = extract_plaintext(
        post(base_url, "/ecc/v1/decrypt", build_decrypt_request(v, now)))
    return decrypted == v["plaintext"], shared_secret_matches(base_url, v)


def main():
    """Replays every ECC vector.

    Returns:
      0 if all pass, 1 on any FAIL, 2 if the server is unreachable.
    """
    base_url = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_BASE_URL
    with open(os.path.join(HERE, "ecc.json"), encoding="utf-8") as f:
        vectors = json.load(f)["vectors"]
    now = datetime.datetime.now(datetime.timezone.utc)
    all_ok = True
    for v in vectors:
        try:
            dec_ok, ss_ok = replay_vector(base_url, v, now)
        except ReplayError as e:
            print(f"{v['name']}: FAIL: {e}")
            all_ok = False
            continue
        except urllib.error.URLError as e:
            print(f"FAIL: rahasya not reachable at {base_url} ({e.reason})")
            return 2
        print(f"{v['name']}: decrypt {'PASS' if dec_ok else 'FAIL'}, "
              f"shared secret {'PASS' if ss_ok else 'FAIL'}")
        all_ok = all_ok and dec_ok and ss_ok
    return 0 if all_ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
