# RFC 7515 / RFC 7520 golden vectors — TEST ONLY

`a2.json` and `rfc7520.json` are extracted from two published IETF RFCs, not
hand-typed. Both keys are public example text from the RFCs themselves:
anyone can read them from the RFC. `private_key_test_only: true` on both
files means the same thing it does everywhere else in `test-vectors/`
(`docs/FORMATS.md` Section 2) — never pin one of these keys in a deployed
enclave.

## Where they came from

- `a2.json` — RFC 7515 (JSON Web Signature), Appendix A.2, "Example JWS Using
  RSASSA-PKCS1-v1_5 SHA-256": the RSA JWK, the exact JWS Signing Input and
  signature (RFC 7515 gives both as octet arrays, byte-for-byte, not
  wrapped base64 text), and the compact JWS reassembled from them.
- `rfc7520.json` — RFC 7520 (JOSE Cookbook), Section 3.4, "RSA Private Key"
  (Figure 4): the RSA JWK used by the Section 4.1 RS256 signing example. We
  only need the key here, not the RS256 example itself.

`tio-core`'s tests use `a2.json` for a byte-exact `sign_rs256` golden test
and as one pinned key, and `rfc7520.json`'s key (different `kid`) as a second
pinned key for cross-key negative tests (wrong key, unpinned kid).

## How to regenerate

```sh
python3 extract.py
```

Downloads both RFCs from `rfc-editor.org` and rewrites `a2.json` and
`rfc7520.json`. Both RFCs are frozen (no errata that change these figures),
so the output should never change; regenerating is only useful to double
check the extraction script itself, not to refresh the data.
