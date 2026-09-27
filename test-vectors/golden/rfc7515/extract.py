"""Extracts JWS/JWK golden vectors from the published RFC 7515 / 7520 text.

Pulls RFC 7515 Appendix A.2 (an RSASSA-PKCS1-v1_5 SHA-256 JWS example) and
RFC 7520 Section 3.4 (a second RSA private key) out of the RFCs' plain-text
bodies and writes them as JSON fixtures for `tio-core`'s JWS tests. Every key
here is public IETF example text, `private_key_test_only`: never pin it in a
deployed enclave (docs/FORMATS.md Section 2).

Run: python3 extract.py
Regenerate: delete a2.json / rfc7520.json and re-run; both RFCs are frozen
documents, so the output should never change.
"""

from __future__ import annotations

import base64
import json
import re
import urllib.request
from pathlib import Path

RFC7515_URL = "https://www.rfc-editor.org/rfc/rfc7515.txt"
RFC7520_URL = "https://www.rfc-editor.org/rfc/rfc7520.txt"
OUT_DIR = Path(__file__).resolve().parent

# Running headers/footers ("...[Page 12]", "RFC 7515 ... May 2015") that
# rfc-editor.org's plain-text renderer repeats on every page.
_PAGE_BOILERPLATE_RE = re.compile(
    r"^.*\[Page \d+\]\s*$|^RFC \d{4} .*\d{4}\s*$", re.MULTILINE
)


class ExtractError(Exception):
    """Raised when the downloaded RFC text doesn't match what we expect."""


def fetch(url: str) -> str:
    """Downloads an RFC's plain-text body.

    Args:
        url: The rfc-editor.org `.txt` URL.

    Returns:
        The decoded document text.

    Raises:
        ExtractError: If the download fails.
    """
    try:
        with urllib.request.urlopen(url, timeout=30) as response:
            return response.read().decode("ascii")
    except OSError as exc:
        raise ExtractError(f"could not download {url}: {exc}") from exc


def _strip_page_boilerplate(text: str) -> str:
    """Removes repeated running headers and footers."""
    return _PAGE_BOILERPLATE_RE.sub("", text)


def _find_heading(text: str, heading: str) -> int:
    """Finds a section heading's own line, skipping Table-of-Contents hits.

    RFC section titles appear twice: once in the ToC, with dot leaders and a
    page number after them ("A.2.1.  Encoding .......... 38"), and once as
    the section's own heading line, with nothing else on the line. Anchoring
    to end-of-line skips the ToC copy.

    Args:
        text: The text to search.
        heading: The exact heading text (no leading/trailing whitespace).

    Returns:
        The index of the start of the heading's line.

    Raises:
        ExtractError: If no bare heading line is found.
    """
    pattern = re.compile(
        r"^[ \t]*" + re.escape(heading) + r"[ \t]*$", re.MULTILINE
    )
    match = pattern.search(text)
    if match is None:
        raise ExtractError(f"heading not found: {heading!r}")
    return match.start()


def _extract_between(text: str, start_heading: str, end_heading: str) -> str:
    """Returns the text of the section between two headings (exclusive).

    Args:
        text: The text to search.
        start_heading: The wanted section's own heading line.
        end_heading: The next section's heading line.

    Raises:
        ExtractError: If either heading is missing.
    """
    start = _find_heading(text, start_heading)
    end = _find_heading(text[start:], end_heading) + start
    return text[start:end]


def _extract_json_object(text: str, after: str) -> dict:
    """Extracts the first `{...}` JSON object appearing after `after`.

    The RFCs wrap long base64url values across lines, indented for
    readability. None of the wire values here contain literal whitespace, so
    every whitespace character inside the braces can be dropped before
    parsing.

    Args:
        text: The text to search.
        after: A substring that must appear before the JSON object.

    Returns:
        The parsed JSON object.

    Raises:
        ExtractError: If `after` or a balanced `{...}` isn't found.
    """
    anchor = text.find(after)
    if anchor == -1:
        raise ExtractError(f"marker not found: {after!r}")
    brace_start = text.find("{", anchor)
    if brace_start == -1:
        raise ExtractError(f"no '{{' found after {after!r}")

    depth = 0
    for i in range(brace_start, len(text)):
        if text[i] == "{":
            depth += 1
        elif text[i] == "}":
            depth -= 1
            if depth == 0:
                compact = re.sub(r"\s+", "", text[brace_start : i + 1])
                return json.loads(compact)
    raise ExtractError("unterminated JSON object")


def _extract_octet_bytes(text: str, after: str) -> bytes:
    """Extracts a bracketed, comma-separated list of decimal byte values.

    RFC 7515 Appendix A.2 gives the signing input and the signature as
    "[101, 121, ...]" octet lists rather than wrapped base64url text, which
    avoids re-joining line-wrapped base64.

    Args:
        text: The text to search.
        after: A substring that must appear immediately before the list.

    Raises:
        ExtractError: If `after` or a bracketed list isn't found.
    """
    anchor = text.find(after)
    if anchor == -1:
        raise ExtractError(f"marker not found: {after!r}")
    open_bracket = text.find("[", anchor)
    close_bracket = text.find("]", open_bracket) if open_bracket != -1 else -1
    if open_bracket == -1 or close_bracket == -1:
        raise ExtractError(f"no bracketed octet list after {after!r}")
    numbers = text[open_bracket + 1 : close_bracket].split(",")
    try:
        return bytes(int(n) for n in numbers)
    except ValueError as err:
        raise ExtractError(f"bad octet list after {after!r}: {err}") from err


def _b64url(data: bytes) -> str:
    """Base64url, no padding."""
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def extract_rfc7515_a2(rfc7515_text: str) -> dict:
    """Builds the RFC 7515 Appendix A.2 fixture.

    Args:
        rfc7515_text: The full RFC 7515 plain-text body.

    Returns:
        A JSON-serializable dict: the JWK, the signing input, the signature
        and the reassembled compact JWS.

    Raises:
        ExtractError: If an expected anchor or value is missing or malformed.
    """
    text = _strip_page_boilerplate(rfc7515_text)
    section = _extract_between(text, "A.2.1.  Encoding", "A.2.2.  Validating")

    signing_input_bytes = _extract_octet_bytes(
        section, "is the following octet sequence:"
    )
    signing_input = signing_input_bytes.decode("ascii")
    parts = signing_input.split(".")
    if len(parts) != 2:
        raise ExtractError(
            f"expected header.payload, got {len(parts)} segments"
        )
    header_b64, payload_b64 = parts

    jwk = _extract_json_object(section, "This example uses the RSA key")

    signature_bytes = _extract_octet_bytes(
        section, "The result of the digital signature is an octet sequence"
    )
    signature_b64 = _b64url(signature_bytes)

    return {
        "source": f"{RFC7515_URL} Appendix A.2 "
        "(Example JWS Using RSASSA-PKCS1-v1_5 SHA-256)",
        "private_key_test_only": True,
        "jwk": jwk,
        "header_b64": header_b64,
        "payload_b64": payload_b64,
        "signing_input": signing_input,
        "signature_b64": signature_b64,
        "compact_jws": f"{header_b64}.{payload_b64}.{signature_b64}",
    }


def extract_rfc7520_3_4(rfc7520_text: str) -> dict:
    """Builds the RFC 7520 Section 3.4 RSA private key fixture.

    Args:
        rfc7520_text: The full RFC 7520 plain-text body.

    Returns:
        A JSON-serializable dict wrapping the key's JWK.

    Raises:
        ExtractError: If an expected anchor or value is missing or malformed.
    """
    text = _strip_page_boilerplate(rfc7520_text)
    section = _extract_between(
        text,
        "3.4.  RSA Private Key",
        "3.5.  Symmetric Key (MAC Computation)",
    )
    jwk = _extract_json_object(
        section, "Note that whitespace is added for readability"
    )
    return {
        "source": f"{RFC7520_URL} Section 3.4 (RSA Private Key, Figure 4)",
        "private_key_test_only": True,
        "jwk": jwk,
    }


def main() -> None:
    """Downloads both RFCs and writes `a2.json` and `rfc7520.json`."""
    a2 = extract_rfc7515_a2(fetch(RFC7515_URL))
    (OUT_DIR / "a2.json").write_text(json.dumps(a2, indent=2) + "\n")
    print(f"wrote {OUT_DIR / 'a2.json'}")

    rfc7520 = extract_rfc7520_3_4(fetch(RFC7520_URL))
    (OUT_DIR / "rfc7520.json").write_text(json.dumps(rfc7520, indent=2) + "\n")
    print(f"wrote {OUT_DIR / 'rfc7520.json'}")


if __name__ == "__main__":
    try:
        main()
    except ExtractError as exc:
        raise SystemExit(f"extract.py: {exc}")
