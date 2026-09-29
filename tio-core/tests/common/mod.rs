//! Shared harness for `tests/vectors.rs`: replays the enclave's outside-in
//! verification pipeline (`docs/FORMATS.md` §11, §10) against the
//! TypeScript-generated `test-vectors/` tree.

use std::{fs, path::Path, path::PathBuf};

use base64::{engine::general_purpose::STANDARD, Engine};
use rand_core::{impls, CryptoRng, RngCore};
use serde_json::Value;
use tio_core::{
    decrypt, derive_session_key, verify_compact, verify_detached, ErrorCode, JwsError, KeyMaterial,
    KeyMode, Nonce, PinnedKey, SessionKeyPair,
};

/// `test-vectors/`, resolved relative to this crate (`tio-core/`).
pub fn test_vectors_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("test-vectors")
}

/// Reads and parses a JSON file, panicking with the path on any failure:
/// these are fixture-loading helpers, not part of the behaviour under test.
pub fn load_json(path: &Path) -> Value {
    let bytes = fs::read(path).unwrap_or_else(|e| panic!("read {}: {e}", path.display()));
    serde_json::from_slice(&bytes).unwrap_or_else(|e| panic!("parse {}: {e}", path.display()))
}

/// Loads `test-vectors/keys/<name>.public.jwk.json` as a pinned key.
pub fn pinned_key(name: &str) -> PinnedKey {
    let path = test_vectors_dir()
        .join("keys")
        .join(format!("{name}.public.jwk.json"));
    let bytes = fs::read(&path).unwrap_or_else(|e| panic!("read {}: {e}", path.display()));
    PinnedKey::from_jwk(&bytes)
        .unwrap_or_else(|e| panic!("parse pinned key {}: {e:?}", path.display()))
}

/// The fixed enclave Curve25519 scalar (`docs/FORMATS.md` §2), the only
/// private key committed to the repo, TEST ONLY.
fn enclave_scalar() -> [u8; 32] {
    let path = test_vectors_dir()
        .join("keys")
        .join("enclave.test-private.json");
    let json = load_json(&path);
    let hex_str = json
        .get("curve25519_scalar_hex")
        .and_then(Value::as_str)
        .unwrap_or_else(|| panic!("{}: missing curve25519_scalar_hex", path.display()));
    let bytes = hex::decode(hex_str).unwrap_or_else(|e| panic!("{}: bad hex: {e}", path.display()));
    bytes.try_into().unwrap_or_else(|v: Vec<u8>| {
        panic!("curve25519_scalar_hex must be 32 bytes, got {}", v.len())
    })
}

/// Maps `session.json`'s `mode` string to [`KeyMode`].
pub fn key_mode(mode: &str) -> KeyMode {
    match mode {
        "wei25519" => KeyMode::Wei25519,
        "x25519" => KeyMode::X25519,
        other => panic!("unknown key mode {other:?}"),
    }
}

/// A test-only RNG that always yields the same fixed bytes, so
/// [`SessionKeyPair::generate`] reproduces the committed enclave test key
/// without any change to the trusted `tio-core` API (no test-only
/// constructor is added to the real key type).
pub struct FixedRng(pub [u8; 32]);

impl RngCore for FixedRng {
    fn next_u32(&mut self) -> u32 {
        impls::next_u32_via_fill(self)
    }

    fn next_u64(&mut self) -> u64 {
        impls::next_u64_via_fill(self)
    }

    fn fill_bytes(&mut self, dest: &mut [u8]) {
        let n = dest.len().min(self.0.len());
        dest[..n].copy_from_slice(&self.0[..n]);
        for byte in &mut dest[n..] {
            *byte = 0;
        }
    }

    fn try_fill_bytes(&mut self, dest: &mut [u8]) -> Result<(), rand_core::Error> {
        self.fill_bytes(dest);
        Ok(())
    }
}

impl CryptoRng for FixedRng {}

/// Rebuilds the enclave's per-session key pair from the committed test
/// scalar. Deterministic: the same `mode` always yields the same key pair,
/// so callers can rebuild it to check what the generator claims it used.
pub fn enclave_key_pair(mode: KeyMode) -> SessionKeyPair {
    let mut rng = FixedRng(enclave_scalar());
    SessionKeyPair::generate(mode, &mut rng)
}

/// A [`JwsError::BadSignature`] becomes the layer-specific code
/// (`docs/FORMATS.md` §10); every other JWS error keeps its own code.
fn jws_layer_code(err: JwsError, layer_code: &'static str) -> &'static str {
    match err {
        JwsError::BadSignature => layer_code,
        other => other.code(),
    }
}

/// Replays the enclave's outside-in check order for one test-vector case
/// directory and returns the decrypted FI bytes, or the stable error code of
/// whichever layer failed first.
///
/// # Panics
/// If a fixture file is missing or not the JSON shape the generator
/// promises: those are fixture bugs, not outcomes under test.
pub fn run_case(dir: &Path) -> Result<Vec<u8>, &'static str> {
    let aa = pinned_key("aa");
    let fip = pinned_key("fip");

    let fetch_body = fs::read(dir.join("fetch_response.body"))
        .unwrap_or_else(|e| panic!("read {}/fetch_response.body: {e}", dir.display()));
    let fetch_jws = fs::read_to_string(dir.join("fetch_response.jws"))
        .unwrap_or_else(|e| panic!("read {}/fetch_response.jws: {e}", dir.display()));
    verify_detached(&fetch_jws, &fetch_body, std::slice::from_ref(&aa))
        .map_err(|e| jws_layer_code(e, "bad_aa_signature"))?;

    let consent_jws = fs::read_to_string(dir.join("consent.jws"))
        .unwrap_or_else(|e| panic!("read {}/consent.jws: {e}", dir.display()));
    let consent_payload = verify_compact(&consent_jws, std::slice::from_ref(&aa))
        .map_err(|e| jws_layer_code(e, "bad_consent_signature"))?;
    let consent: Value = serde_json::from_slice(&consent_payload)
        .unwrap_or_else(|e| panic!("{}/consent.jws: payload is not JSON: {e}", dir.display()));
    if consent.get("status").and_then(Value::as_str) != Some("ACTIVE") {
        return Err("consent_invalid");
    }

    let fetch: Value = serde_json::from_slice(&fetch_body)
        .unwrap_or_else(|e| panic!("{}/fetch_response.body: not JSON: {e}", dir.display()));
    let fi_entry = fetch
        .get("FI")
        .and_then(|fi| fi.get(0))
        .unwrap_or_else(|| panic!("{}: fetch_response.body has no FI[0]", dir.display()));
    let key_material: KeyMaterial = serde_json::from_value(
        fi_entry
            .get("KeyMaterial")
            .cloned()
            .unwrap_or_else(|| panic!("{}: FI[0] has no KeyMaterial", dir.display())),
    )
    .unwrap_or_else(|e| panic!("{}: bad KeyMaterial: {e}", dir.display()));
    let peer = key_material.peer_public_key().map_err(|e| e.code())?;
    let their_nonce = key_material.nonce().map_err(|e| e.code())?;

    let session = load_json(&dir.join("session.json"));
    let mode = key_mode(
        session
            .get("mode")
            .and_then(Value::as_str)
            .unwrap_or_else(|| panic!("{}/session.json: missing mode", dir.display())),
    );
    let pair = enclave_key_pair(mode);
    let shared = pair.shared_secret(&peer).map_err(|e| e.code())?;

    let enclave_nonce_b64 = session
        .get("enclave_nonce_b64")
        .and_then(Value::as_str)
        .unwrap_or_else(|| panic!("{}/session.json: missing enclave_nonce_b64", dir.display()));
    let enclave_nonce = Nonce::from_base64(enclave_nonce_b64).map_err(|e| e.code())?;

    let session_key =
        derive_session_key(&shared, &enclave_nonce, &their_nonce).map_err(|e| e.code())?;

    let encrypted_fi = fi_entry
        .get("data")
        .and_then(|d| d.get(0))
        .and_then(|d| d.get("encryptedFI"))
        .and_then(Value::as_str)
        .unwrap_or_else(|| panic!("{}: FI[0].data[0].encryptedFI missing", dir.display()));
    let plaintext = decrypt(&session_key, encrypted_fi).map_err(|e| e.code())?;

    let envelope: Value = serde_json::from_slice(&plaintext)
        .unwrap_or_else(|e| panic!("{}: decrypted plaintext is not JSON: {e}", dir.display()));
    let fi_b64 = envelope
        .get("fi")
        .and_then(Value::as_str)
        .unwrap_or_else(|| panic!("{}: envelope missing fi", dir.display()));
    let fip_jws = envelope
        .get("jws")
        .and_then(Value::as_str)
        .unwrap_or_else(|| panic!("{}: envelope missing jws", dir.display()));
    let fi_bytes = STANDARD
        .decode(fi_b64)
        .unwrap_or_else(|e| panic!("{}: envelope.fi is not valid base64: {e}", dir.display()));
    verify_detached(fip_jws, &fi_bytes, std::slice::from_ref(&fip))
        .map_err(|e| jws_layer_code(e, "bad_fip_signature"))?;

    Ok(fi_bytes)
}
