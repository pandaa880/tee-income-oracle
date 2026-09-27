#!/usr/bin/env python3
"""Shows the checker is not a rubber stamp: a one-byte change must fail.

Flips one byte of a stored ciphertext in memory (files are never touched),
confirms the value really changed, and requires verify.check_ecc_vector to
reject it. AES-GCM's authentication tag is what catches the change.

Typical usage:

    python3 tamper_test.py
"""
import base64
import copy

import verify


def flip_ciphertext_byte(v, index=0):
    """Returns a copy of vector v with one ciphertext byte changed.

    Raises:
      RuntimeError: the ciphertext did not actually change.
    """
    tampered = copy.deepcopy(v)
    raw = bytearray(base64.b64decode(v["ciphertext_b64"]))
    raw[index] ^= 0x01
    tampered["ciphertext_b64"] = base64.b64encode(bytes(raw)).decode()
    if tampered["ciphertext_b64"] == v["ciphertext_b64"]:
        raise RuntimeError("tamper did not change the ciphertext")
    return tampered


EXPECTED_REASON = "decryption failed"


def rejection_reason(v):
    """Returns the VectorError message for v, or None if v is accepted."""
    try:
        verify.check_ecc_vector(v)
    except verify.VectorError as e:
        return str(e)
    return None


def main():
    """Returns 0 if every tampered vector is rejected for the right reason."""
    for v in verify.load_json("ecc.json")["vectors"]:
        # Baseline first: the untouched vector must pass, so a rejection
        # below can only come from our one-byte change.
        baseline = rejection_reason(v)
        if baseline is not None:
            print(f"{v['name']}: FAIL (untampered vector rejected: {baseline})")
            return 1
        reason = rejection_reason(flip_ciphertext_byte(v))
        if reason is None or not reason.startswith(EXPECTED_REASON):
            print(f"{v['name']}: tamper test FAIL (got: {reason})")
            return 1
        print(f"{v['name']}: tamper test PASS (rejected: {reason})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
