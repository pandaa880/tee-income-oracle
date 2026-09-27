//! JWS verification and signing, RS256/RS512 only (`docs/FORMATS.md` §4).
//!
//! Two forms: detached with an unencoded payload (RFC 7797, API bodies) and
//! compact (the consent artefact). Signatures are checked over the bytes as
//! received, before the caller parses any payload, and only against pinned
//! keys chosen by `kid`: nothing in the header can supply a key.

mod key;

pub use key::{FiuSigningKey, PinnedKey};

use serde::{
    de::{DeserializeOwned, IgnoredAny},
    Deserialize, Deserializer, Serialize,
};

use crate::{
    encoding::{b64url_decode, b64url_encode},
    ErrorCode,
};
use key::{verify_signature, Alg};

/// JWS errors. Each maps to one stable code.
#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum JwsError {
    /// Wrong segment count, bad base64url, non-empty detached payload or
    /// empty compact payload.
    #[error("malformed jws")]
    Malformed,
    /// Header is not a JSON object, repeats a member we act on, lacks `kid`,
    /// breaks a `b64`/`crit` rule, or carries `jwk`/`jku`/`x5u`/`x5c`.
    #[error("bad jws header")]
    BadHeader,
    /// `alg` is not `RS256` or `RS512`.
    #[error("jws algorithm not allowed")]
    BadAlg,
    /// `kid` is not one of the pinned keys.
    #[error("unknown kid")]
    UnknownKid,
    /// The signature does not verify.
    #[error("bad signature")]
    BadSignature,
    /// A pinned JWK is not a valid RSA public key of at least 2048 bits.
    #[error("bad pinned key")]
    BadPinnedKey,
    /// Key generation or signing failed.
    #[error("signing failed")]
    SignFailed,
}

impl ErrorCode for JwsError {
    fn code(&self) -> &'static str {
        match self {
            Self::Malformed => "bad_jws",
            Self::BadHeader => "bad_header",
            Self::BadAlg => "bad_alg",
            Self::UnknownKid => "unknown_kid",
            Self::BadSignature => "bad_signature",
            Self::BadPinnedKey => "bad_pinned_key",
            Self::SignFailed => "sign_failed",
        }
    }
}

/// The protected header members we act on. Derived `Deserialize` rejects a
/// repeated declared member (two `alg`s), so a verifier and a parser can't
/// disagree on which one counts. Unknown members (`typ`, `x5t`, …) are
/// ignored. Members under a "must not appear" rule are read with
/// [`present`], so `null` counts as present: `Some(_)` means the member
/// was there, whatever its value. The key-carrying members are declared
/// only so their presence can be refused.
#[derive(Deserialize)]
struct Header {
    alg: String,
    kid: Option<String>,
    #[serde(default, deserialize_with = "present")]
    b64: Option<Option<bool>>,
    #[serde(default, deserialize_with = "present")]
    crit: Option<Option<Vec<String>>>,
    #[serde(default, deserialize_with = "present")]
    jwk: Option<IgnoredAny>,
    #[serde(default, deserialize_with = "present")]
    jku: Option<IgnoredAny>,
    #[serde(default, deserialize_with = "present")]
    x5u: Option<IgnoredAny>,
    #[serde(default, deserialize_with = "present")]
    x5c: Option<IgnoredAny>,
}

/// `deserialize_with` that records presence: an absent member stays `None`
/// (via `#[serde(default)]`), any value, `null` included, becomes `Some`.
/// Plain `Option<T>` reads `null` as absent.
fn present<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    T::deserialize(deserializer).map(Some)
}

/// Deserializes `bytes` only if the JSON value is an object. serde's derived
/// struct visitor also accepts an array (members by position), which no JOSE
/// implementation does: a header only we accept is a parser differential.
fn from_json_object<T: DeserializeOwned>(bytes: &[u8]) -> Option<T> {
    if bytes.trim_ascii_start().first() != Some(&b'{') {
        return None;
    }
    serde_json::from_slice(bytes).ok()
}

/// The header we emit for detached signatures. Field order is the byte
/// order on the wire.
#[derive(Serialize)]
struct DetachedHeader<'a> {
    alg: &'static str,
    kid: &'a str,
    b64: bool,
    crit: [&'static str; 1],
}

#[derive(Clone, Copy)]
enum Form {
    Detached,
    Compact,
}

/// The three `.`-separated segments; header and payload still encoded.
struct Segments<'a> {
    header: &'a str,
    payload: &'a str,
    signature: Vec<u8>,
}

/// Verifies a detached (RFC 7797, `b64:false`) JWS over `body`, the raw
/// bytes as received.
///
/// # Errors
/// Any [`JwsError`] except `BadPinnedKey` / `SignFailed`.
pub fn verify_detached(jws: &str, body: &[u8], keys: &[PinnedKey]) -> Result<(), JwsError> {
    let segments = split(jws)?;
    if !segments.payload.is_empty() {
        return Err(JwsError::Malformed);
    }
    let signing_input = detached_signing_input(segments.header, body);
    verify_segments(&segments, Form::Detached, &signing_input, keys)
}

/// Verifies a compact JWS and returns its decoded payload. The payload is
/// decoded only after the signature verifies; the caller parses it after.
///
/// # Errors
/// Any [`JwsError`] except `BadPinnedKey` / `SignFailed`.
pub fn verify_compact(jws: &str, keys: &[PinnedKey]) -> Result<Vec<u8>, JwsError> {
    let segments = split(jws)?;
    if segments.payload.is_empty() {
        return Err(JwsError::Malformed);
    }
    let signing_input = format!("{}.{}", segments.header, segments.payload);
    verify_segments(&segments, Form::Compact, signing_input.as_bytes(), keys)?;
    b64url_decode(segments.payload).map_err(|_| JwsError::Malformed)
}

fn split(jws: &str) -> Result<Segments<'_>, JwsError> {
    let mut parts = jws.split('.');
    match (parts.next(), parts.next(), parts.next(), parts.next()) {
        (Some(header), Some(payload), Some(signature), None) => Ok(Segments {
            header,
            payload,
            signature: b64url_decode(signature).map_err(|_| JwsError::Malformed)?,
        }),
        _ => Err(JwsError::Malformed),
    }
}

/// Header checks in a fixed order, then the signature. `alg` is checked
/// before `kid`, so a swapped algorithm reports `bad_alg` (FORMATS §11).
fn verify_segments(
    segments: &Segments<'_>,
    form: Form,
    signing_input: &[u8],
    keys: &[PinnedKey],
) -> Result<(), JwsError> {
    let header_bytes = b64url_decode(segments.header).map_err(|_| JwsError::Malformed)?;
    let header: Header = from_json_object(&header_bytes).ok_or(JwsError::BadHeader)?;
    let alg = Alg::from_name(&header.alg)?;
    check_form(&header, form)?;
    let kid = header.kid.as_deref().ok_or(JwsError::BadHeader)?;
    let key = keys
        .iter()
        .find(|k| k.kid() == kid)
        .ok_or(JwsError::UnknownKid)?;
    verify_signature(key.key(), alg, signing_input, &segments.signature)
}

/// `b64`/`crit` rules and the no-embedded-key rule.
///
/// Detached: `b64` must be exactly `false` and `crit` exactly `["b64"]`
/// (RFC 7797 §6). A verifier that ignored `b64` would hash the body as if
/// it were base64url, so both sides must agree it is unencoded. Compact:
/// neither may appear; we understand no other critical extension, and RFC
/// 7515 §4.1.11 says to reject what we don't understand.
fn check_form(header: &Header, form: Form) -> Result<(), JwsError> {
    let carries_key = header.jwk.is_some()
        || header.jku.is_some()
        || header.x5u.is_some()
        || header.x5c.is_some();
    let form_ok = match form {
        Form::Detached => {
            header.b64 == Some(Some(false)) && header.crit == Some(Some(vec!["b64".to_owned()]))
        }
        Form::Compact => header.b64.is_none() && header.crit.is_none(),
    };
    if carries_key || !form_ok {
        return Err(JwsError::BadHeader);
    }
    Ok(())
}

/// `ASCII(header segment) ‖ "." ‖ body` (RFC 7797 §3).
fn detached_signing_input(header_b64: &str, body: &[u8]) -> Vec<u8> {
    [header_b64.as_bytes(), b".", body].concat()
}

/// base64url of our detached header for `kid`. serde_json escapes `kid`.
fn detached_header_b64(kid: &str) -> Result<String, JwsError> {
    let header = DetachedHeader {
        alg: "RS256",
        kid,
        b64: false,
        crit: ["b64"],
    };
    let json = serde_json::to_vec(&header).map_err(|_| JwsError::SignFailed)?;
    Ok(b64url_encode(&json))
}

#[cfg(test)]
mod tests;
