//! Shared fixture loading for `tests/vectors.rs` and
//! `tests/evaluate_boundaries.rs` (`docs/FORMATS.md` §11).
//!
//! This module only reads a case directory of the TypeScript-generated
//! `test-vectors/` tree and hands the pieces to `tio_core::evaluate`. It
//! reimplements no pipeline step: every check under test lives in `tio-core`.

// Each test crate uses a different subset of these helpers.
#![allow(dead_code)]

use std::{fs, path::Path, path::PathBuf};

use rand_core::{impls, CryptoRng, RngCore};
use serde_json::Value;
use tio_core::{
    evaluate, parse_rebit_timestamp, verify_compact, AttestContext, Clock, ErrorCode,
    EvaluateError, EvaluateInput, Evaluation, FiDataRange, KeyMode, Nonce, PinnedKey, PinnedKeys,
    Policy, ProofType, Session, SessionKeyPair,
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

/// The shared default policy (`test-vectors/policy/default.json`).
pub fn default_policy() -> Policy {
    let path = test_vectors_dir().join("policy").join("default.json");
    let bytes = fs::read(&path).unwrap_or_else(|e| panic!("read {}: {e}", path.display()));
    Policy::from_json(&bytes).unwrap_or_else(|e| panic!("parse {}: {e:?}", path.display()))
}

fn read_text(path: &Path) -> String {
    fs::read_to_string(path).unwrap_or_else(|e| panic!("read {}: {e}", path.display()))
}

fn str_member<'a>(value: &'a Value, key: &str, what: &str) -> &'a str {
    value
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or_else(|| panic!("{what}: missing string member {key}"))
}

fn int_member(value: &Value, key: &str, what: &str) -> i64 {
    value
        .get(key)
        .and_then(Value::as_i64)
        .unwrap_or_else(|| panic!("{what}: missing integer member {key}"))
}

fn timestamp_member(value: &Value, key: &str, what: &str) -> i64 {
    parse_rebit_timestamp(str_member(value, key, what))
        .unwrap_or_else(|e| panic!("{what}: bad timestamp in {key}: {e:?}"))
}

/// A 32-byte value from a base58 string (wallet, program ids).
pub fn base58_32(text: &str) -> [u8; 32] {
    let bytes = bs58::decode(text)
        .into_vec()
        .unwrap_or_else(|e| panic!("bad base58 {text:?}: {e}"));
    bytes
        .try_into()
        .unwrap_or_else(|v: Vec<u8>| panic!("base58 {text:?} is {} bytes, not 32", v.len()))
}

/// Values a test may swap in for the loaded `Session` / `Clock` fields.
/// Everything left `None` keeps the case's own value.
#[derive(Default, Clone)]
pub struct Overrides {
    pub txnid: Option<String>,
    pub consent_id: Option<String>,
    pub range: Option<FiDataRange>,
    pub clock: Option<Clock>,
}

/// One case directory, loaded and owning everything `evaluate` borrows.
pub struct CaseFixture {
    pub fetch_response: Vec<u8>,
    pub fetch_response_jws: String,
    pub consent_jws: String,
    pub key_pair: SessionKeyPair,
    pub nonce: Nonce,
    pub txnid: String,
    pub consent_id: String,
    pub range: FiDataRange,
    pub policy: Policy,
    pub wallet: [u8; 32],
    pub aa: Vec<PinnedKey>,
    pub fip: Vec<PinnedKey>,
    pub attest: AttestContext,
    pub clock: Clock,
}

impl CaseFixture {
    /// Loads `dir`'s files.
    ///
    /// # Panics
    /// On a missing file or a `session.json` that lacks a member the
    /// generator promises (fixture bugs, not outcomes under test).
    pub fn load(dir: &Path) -> Self {
        let what = dir.display().to_string();
        let session = load_json(&dir.join("session.json"));
        let mode = key_mode(str_member(&session, "mode", &what));
        let attest = &session["attest"];
        let range = &session["fi_data_range"];
        let from = timestamp_member(range, "from", &what);
        let to = timestamp_member(range, "to", &what);
        let proof_type = match int_member(attest, "proof_type", &what) {
            1 => ProofType::TeeNitroOyster,
            other => panic!("{what}: unknown proof_type {other}"),
        };
        Self {
            fetch_response: fs::read(dir.join("fetch_response.body"))
                .unwrap_or_else(|e| panic!("read {what}/fetch_response.body: {e}")),
            fetch_response_jws: read_text(&dir.join("fetch_response.jws")),
            consent_jws: read_text(&dir.join("consent.jws")),
            key_pair: enclave_key_pair(mode),
            nonce: Nonce::from_base64(str_member(&session, "enclave_nonce_b64", &what))
                .unwrap_or_else(|e| panic!("{what}: bad enclave_nonce_b64: {e:?}")),
            txnid: str_member(&session, "txnid", &what).to_owned(),
            consent_id: str_member(&session, "consent_id", &what).to_owned(),
            range: FiDataRange::new(from, to)
                .unwrap_or_else(|e| panic!("{what}: bad fi_data_range: {e:?}")),
            policy: default_policy(),
            wallet: base58_32(str_member(&session, "wallet", &what)),
            aa: vec![pinned_key("aa")],
            fip: vec![pinned_key("fip")],
            attest: AttestContext {
                oracle_program_id: base58_32(str_member(attest, "oracle_program_id", &what)),
                sas_credential: base58_32(str_member(attest, "sas_credential", &what)),
                sas_schema: base58_32(str_member(attest, "sas_schema", &what)),
                proof_type,
                measurement_id: u8::try_from(int_member(attest, "measurement_id", &what))
                    .unwrap_or_else(|_| panic!("{what}: measurement_id does not fit u8")),
            },
            clock: Clock {
                now: int_member(&session, "now_unix", &what),
                expiry: int_member(attest, "expiry_unix", &what),
            },
        }
    }

    /// Runs `tio_core::evaluate` on the case as generated.
    pub fn evaluate(&self) -> Result<Evaluation, EvaluateError> {
        self.evaluate_with(&Overrides::default())
    }

    /// Runs `tio_core::evaluate` with some `Session` / `Clock` fields swapped.
    /// The signed artefacts are never touched, so nothing needs re-signing.
    pub fn evaluate_with(&self, overrides: &Overrides) -> Result<Evaluation, EvaluateError> {
        let session = Session {
            key_pair: &self.key_pair,
            nonce: &self.nonce,
            txnid: overrides.txnid.as_deref().unwrap_or(&self.txnid),
            consent_id: overrides.consent_id.as_deref().unwrap_or(&self.consent_id),
            range: overrides.range.unwrap_or(self.range),
            policy: &self.policy,
            wallet: self.wallet,
        };
        let keys = PinnedKeys {
            aa: &self.aa,
            fip: &self.fip,
        };
        let input = EvaluateInput {
            fetch_response: &self.fetch_response,
            fetch_response_jws: &self.fetch_response_jws,
            consent_jws: &self.consent_jws,
        };
        evaluate(
            &session,
            &keys,
            &input,
            &self.attest,
            overrides.clock.unwrap_or(self.clock),
        )
    }

    /// The consent's `consentStart` and `consentExpiry` (unix seconds), read
    /// from the AA-signed payload.
    pub fn consent_times(&self) -> (i64, i64) {
        let payload = verify_compact(&self.consent_jws, &self.aa)
            .unwrap_or_else(|e| panic!("consent.jws must verify: {e:?}"));
        let consent: Value = serde_json::from_slice(&payload)
            .unwrap_or_else(|e| panic!("consent payload is not JSON: {e}"));
        (
            timestamp_member(&consent, "consentStart", "consent"),
            timestamp_member(&consent, "consentExpiry", "consent"),
        )
    }
}

/// Runs the real pipeline on one case directory; the error is the stable
/// code (`docs/FORMATS.md` §10).
pub fn run_case(dir: &Path) -> Result<Evaluation, &'static str> {
    CaseFixture::load(dir).evaluate().map_err(|e| e.code())
}
