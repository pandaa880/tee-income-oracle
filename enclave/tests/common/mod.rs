//! Shared helpers for the enclave integration tests. They read the committed
//! `test-vectors/` tree and the pinned demo keys, and re-derive secp256k1
//! addresses and recoveries with `k256` directly (not with the code under
//! test), so a bug in `tio_enclave::attester` can't cancel itself out.

// Each test crate uses a different subset of these helpers.
#![allow(dead_code)]
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::indexing_slicing,
    clippy::panic
)]

use std::{fs, path::Path, path::PathBuf};

use k256::ecdsa::{RecoveryId, Signature, SigningKey as SecpSigningKey, VerifyingKey};
use rand_core::{impls, CryptoRng, RngCore};
use serde_json::Value;
use sha3::{Digest, Keccak256};
use tio_core::{FiDataRange, KeyMode, Nonce, Policy, SessionKeyPair};

pub fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("..")
}

pub fn vectors_dir() -> PathBuf {
    repo_root().join("test-vectors")
}

pub fn read_bytes(path: &Path) -> Vec<u8> {
    fs::read(path).unwrap_or_else(|e| panic!("read {}: {e}", path.display()))
}

pub fn read_text(path: &Path) -> String {
    fs::read_to_string(path).unwrap_or_else(|e| panic!("read {}: {e}", path.display()))
}

pub fn load_json(path: &Path) -> Value {
    serde_json::from_slice(&read_bytes(path))
        .unwrap_or_else(|e| panic!("parse {}: {e}", path.display()))
}

pub fn test_key_bytes(name: &str) -> Vec<u8> {
    read_bytes(
        &vectors_dir()
            .join("keys")
            .join(format!("{name}.public.jwk.json")),
    )
}

pub fn pinned_demo_bytes(name: &str) -> Vec<u8> {
    read_bytes(
        &Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("pinned")
            .join(format!("{name}.jwk.json")),
    )
}

pub fn jwk_kid(jwk: &[u8]) -> String {
    let v: Value = serde_json::from_slice(jwk).expect("jwk json");
    v["kid"].as_str().expect("kid").to_owned()
}

pub fn policy_bytes() -> Vec<u8> {
    read_bytes(&vectors_dir().join("policy").join("default.json"))
}

pub fn default_policy() -> Policy {
    Policy::from_json(&policy_bytes()).expect("default policy")
}

/// A fixed 32-byte value from a base58 string.
pub fn b58_32(text: &str) -> [u8; 32] {
    let bytes = bs58::decode(text).into_vec().expect("base58");
    bytes.try_into().expect("32 bytes")
}

pub fn hex32(text: &str) -> [u8; 32] {
    hex::decode(text)
        .expect("hex")
        .try_into()
        .expect("32 bytes")
}

/// `test-vectors/keys/enclave.test-private.json` member as bytes.
pub fn enclave_test_secret(member: &str) -> [u8; 32] {
    let json = load_json(&vectors_dir().join("keys").join("enclave.test-private.json"));
    hex32(json[member].as_str().expect("member"))
}

// --- Deterministic RNGs ------------------------------------------------------

/// Always yields the same fixed bytes, so `SessionKeyPair::generate`
/// reproduces the committed enclave Curve25519 test key.
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

/// A seeded splitmix64 stream: deterministic, well mixed, TEST ONLY.
pub struct SeededRng(pub u64);

impl RngCore for SeededRng {
    fn next_u32(&mut self) -> u32 {
        impls::next_u32_via_fill(self)
    }
    fn next_u64(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }
    fn fill_bytes(&mut self, dest: &mut [u8]) {
        impls::fill_bytes_via_next(self, dest);
    }
    fn try_fill_bytes(&mut self, dest: &mut [u8]) -> Result<(), rand_core::Error> {
        self.fill_bytes(dest);
        Ok(())
    }
}

impl CryptoRng for SeededRng {}

// --- secp256k1 reference helpers (independent of `tio_enclave::attester`) -----

pub fn keccak256(data: &[u8]) -> [u8; 32] {
    Keccak256::digest(data).into()
}

/// Ethereum address of a secp256k1 secret scalar, derived with `k256` only.
pub fn eth_address_of(secret: &[u8; 32]) -> [u8; 20] {
    let key = SecpSigningKey::from_slice(secret).expect("valid scalar");
    let point = key.verifying_key().to_encoded_point(false);
    let hash = keccak256(&point.as_bytes()[1..]);
    hash[12..].try_into().expect("20 bytes")
}

/// Recovers the signer's address from `r ‖ s ‖ v` over keccak256(`message`).
pub fn recover_address(message: &[u8], sig65: &[u8]) -> [u8; 20] {
    assert_eq!(sig65.len(), 65, "signature must be 65 bytes");
    let signature = Signature::from_slice(&sig65[..64]).expect("r ‖ s");
    let recovery = RecoveryId::from_byte(sig65[64]).expect("v must be 0 or 1");
    let key = VerifyingKey::recover_from_prehash(&keccak256(message), &signature, recovery)
        .expect("recoverable");
    let point = key.to_encoded_point(false);
    let hash = keccak256(&point.as_bytes()[1..]);
    hash[12..].try_into().expect("20 bytes")
}

pub fn address_hex(address: &[u8; 20]) -> String {
    format!("0x{}", hex::encode(address))
}

// --- Vector sessions ---------------------------------------------------------

/// One vector directory's `session.json` plus its artefact files.
pub struct VectorCase {
    pub id: String,
    pub dir: PathBuf,
    pub session: Value,
}

impl VectorCase {
    pub fn load(dir: PathBuf) -> Self {
        let session = load_json(&dir.join("session.json"));
        let id = session["case_id"].as_str().expect("case_id").to_owned();
        Self { id, dir, session }
    }

    pub fn str_field(&self, key: &str) -> &str {
        self.session[key].as_str().expect("string member")
    }

    pub fn session_id(&self) -> &str {
        self.str_field("session_id")
    }

    pub fn now(&self) -> i64 {
        self.session["now_unix"].as_i64().expect("now_unix")
    }

    pub fn expiry(&self) -> i64 {
        self.session["attest"]["expiry_unix"]
            .as_i64()
            .expect("expiry")
    }

    pub fn wallet(&self) -> [u8; 32] {
        b58_32(self.str_field("wallet"))
    }

    pub fn measurement_id(&self) -> u8 {
        u8::try_from(
            self.session["attest"]["measurement_id"]
                .as_i64()
                .expect("mid"),
        )
        .expect("fits u8")
    }

    pub fn file(&self, name: &str) -> Vec<u8> {
        read_bytes(&self.dir.join(name))
    }

    pub fn text(&self, name: &str) -> String {
        read_text(&self.dir.join(name))
    }

    pub fn expected(&self) -> Value {
        load_json(&self.dir.join("expected.json"))
    }

    pub fn key_mode(&self) -> KeyMode {
        match self.str_field("mode") {
            "wei25519" => KeyMode::Wei25519,
            "x25519" => KeyMode::X25519,
            other => panic!("unknown key mode {other}"),
        }
    }

    pub fn range(&self) -> FiDataRange {
        let r = &self.session["fi_data_range"];
        let ts = |k: &str| {
            tio_core::parse_rebit_timestamp(r[k].as_str().expect("range member")).expect("ts")
        };
        FiDataRange::new(ts("from"), ts("to")).expect("range")
    }
}

/// `(case, expected error code)` for the manifest's negative cases, or the
/// plain case list of the positive ones when `positive` is true.
pub fn manifest_cases(kind: &str) -> Vec<(VectorCase, Value)> {
    let manifest = load_json(&vectors_dir().join("manifest.json"));
    manifest["cases"]
        .as_array()
        .expect("cases")
        .iter()
        .filter(|c| c["kind"] == kind)
        .map(|c| {
            let dir = vectors_dir().join(c["dir"].as_str().expect("dir"));
            (VectorCase::load(dir), c["expected"].clone())
        })
        .collect()
}

pub fn enclave_key_pair(mode: KeyMode) -> SessionKeyPair {
    SessionKeyPair::generate(
        mode,
        &mut FixedRng(enclave_test_secret("curve25519_scalar_hex")),
    )
}

pub fn nonce_of(case: &VectorCase) -> Nonce {
    Nonce::from_base64(case.str_field("enclave_nonce_b64")).expect("nonce")
}
