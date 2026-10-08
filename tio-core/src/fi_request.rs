//! `POST /FI/request` body (`docs/FORMATS.md` §5.1), built by the enclave.
//!
//! The bytes are signed with the FIU key and carried verbatim by the
//! gateway, so they are built once here. Member order follows the TypeScript
//! generator (`sandbox-bank/src/rebit/fi-request.ts`), and the vectors pin
//! the two byte for byte.

use serde::Serialize;

use crate::{
    evaluate::ConsentRef, key_material::KeyMaterial, time::format_iso_utc, ErrorCode, FiDataRange,
};

/// ReBIT API version we emit (§5).
pub const REBIT_VERSION: &str = "1.1.3";

/// Everything that goes into one FI request.
pub struct FiRequest<'a> {
    pub txnid: &'a str,
    /// Request `timestamp`, unix seconds (emitted as ISO-8601 UTC).
    pub now: i64,
    pub consent: &'a ConsentRef,
    pub range: FiDataRange,
    pub key_material: &'a KeyMaterial,
}

/// The body could not be serialized.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
#[error("FI request could not be built")]
pub struct FiRequestError;

impl ErrorCode for FiRequestError {
    fn code(&self) -> &'static str {
        "internal_error"
    }
}

/// Builds the exact request bytes.
///
/// # Errors
/// [`FiRequestError`] if serialization fails.
pub fn build_fi_request(request: &FiRequest<'_>) -> Result<Vec<u8>, FiRequestError> {
    let body = Body {
        ver: REBIT_VERSION,
        timestamp: format_iso_utc(request.now),
        txnid: request.txnid,
        consent: ConsentField {
            id: &request.consent.id,
            digital_signature: &request.consent.signature,
        },
        range: RangeField {
            from: format_iso_utc(request.range.from()),
            to: format_iso_utc(request.range.to()),
        },
        key_material: request.key_material,
    };
    serde_json::to_vec(&body).map_err(|_| FiRequestError)
}

// Field order is the wire order (serde serializes in declaration order).
#[derive(Serialize)]
struct Body<'a> {
    ver: &'static str,
    timestamp: String,
    txnid: &'a str,
    #[serde(rename = "Consent")]
    consent: ConsentField<'a>,
    #[serde(rename = "FIDataRange")]
    range: RangeField,
    #[serde(rename = "KeyMaterial")]
    key_material: &'a KeyMaterial,
}

#[derive(Serialize)]
struct ConsentField<'a> {
    id: &'a str,
    #[serde(rename = "digitalSignature")]
    digital_signature: &'a str,
}

#[derive(Serialize)]
struct RangeField {
    from: String,
    to: String,
}
