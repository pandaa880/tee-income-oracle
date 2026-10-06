//! HTTP request and response bodies (FORMATS §10, `snake_case`).
//!
//! Requests reject unknown members. Responses are built only from the
//! fields listed in §10: in particular [`EvaluateResponse`] is made from the
//! outcome and the signed attestation, never from `tio_core::Evaluation`
//! (whose scores must not leave the enclave).

use serde::{Deserialize, Serialize};
use serde_json::value::RawValue;
use tio_core::KeyMaterial;

/// `POST /v1/sessions`.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CreateSessionRequest {
    /// The lender's policy (§6), parsed strictly by `tio-core`.
    pub policy: Box<RawValue>,
    /// Borrower wallet, base58 (32 bytes).
    pub wallet: String,
    /// The AA-signed consent artefact, compact JWS (§5.3).
    pub consent_jws: String,
    /// Registry id of this enclave build (§13), `0..=254`.
    pub measurement_id: u8,
}

/// Response to `POST /v1/sessions`.
#[derive(Debug, Serialize)]
pub struct CreateSessionResponse {
    pub session_id: String,
    pub key_material: KeyMaterial,
    /// Base64 of the exact §5.1 body bytes the FIU JWS covers.
    pub fi_request_body_b64: String,
    /// Detached JWS by the enclave's FIU key.
    pub fi_request_jws: String,
    /// The §9 text the wallet signs.
    pub intent: String,
    pub intent_expires: i64,
}

/// `POST /v1/sessions/{id}/bind`.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BindRequest {
    pub wallet: String,
    pub signature_b58: String,
}

/// Response to bind.
#[derive(Debug, Serialize)]
pub struct BindResponse {
    pub status: &'static str,
}

/// `POST /v1/sessions/{id}/evaluate`.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EvaluateRequest {
    pub fetch_response_b64: String,
    pub fetch_response_jws: String,
    pub consent_jws: String,
}

/// Response to evaluate: exactly these members, nothing else.
#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(untagged)]
pub enum EvaluateResponse {
    /// A tier: the 83-byte payload and its 65-byte signature, hex.
    Tier {
        tier: &'static str,
        payload_hex: String,
        signature_hex: String,
        expiry: i64,
    },
    /// A reject: nothing goes on-chain.
    Reject { tier: &'static str },
}

/// `GET /v1/info`.
#[derive(Debug, Serialize)]
pub struct InfoResponse {
    pub app_version: &'static str,
    /// `0x` + 40 hex of the attester key.
    pub attester_address: String,
    /// The FIU public JWK (`e`, `kid`, `kty`, `n`).
    pub fiu_public_jwk: Box<RawValue>,
    /// §8.1 binding signature by the attester key, 65 bytes hex.
    pub fiu_key_signature_hex: String,
    pub pinned_kids: Vec<String>,
}
