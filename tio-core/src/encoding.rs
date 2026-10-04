//! Byte encodings shared by the ReBIT-facing modules.

use serde::{
    de::{DeserializeOwned, Error as _},
    Deserialize, Deserializer,
};
use serde_json::value::RawValue;

use base64::{
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
    Engine,
};

/// Error for any malformed PEM / base64 input.
#[derive(Debug, PartialEq, Eq)]
pub(crate) struct BadEncoding;

const BEGIN_PUBLIC_KEY: &str = "-----BEGIN PUBLIC KEY-----";
const END_PUBLIC_KEY: &str = "-----END PUBLIC KEY-----";

/// Decodes a `KeyValue`: strips any PEM armour and all whitespace, then
/// base64-decodes (standard alphabet). Lenient on form because peers differ
/// (single-line, wrapped, bare base64); the key is validated afterwards.
pub(crate) fn pem_to_der(key_value: &str) -> Result<Vec<u8>, BadEncoding> {
    let compact: String = key_value.chars().filter(|c| !c.is_whitespace()).collect();
    let body = strip_armour(&compact).ok_or(BadEncoding)?;
    STANDARD.decode(body).map_err(|_| BadEncoding)
}

/// Encodes DER as single-line PEM, the only armoured form rahasya accepts
/// (`docs/FORMATS.md` §3).
pub(crate) fn der_to_single_line_pem(der: &[u8]) -> String {
    format!("{BEGIN_PUBLIC_KEY}{}{END_PUBLIC_KEY}", STANDARD.encode(der))
}

/// Decodes base64url without padding (JWS segments, JWK members). Strict:
/// rejects `=` padding and non-canonical trailing bits, so each value has
/// exactly one accepted encoding.
pub(crate) fn b64url_decode(s: &str) -> Result<Vec<u8>, BadEncoding> {
    URL_SAFE_NO_PAD.decode(s).map_err(|_| BadEncoding)
}

/// Encodes base64url without padding.
pub(crate) fn b64url_encode(bytes: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(bytes)
}

/// Returns the base64 body of `compact` (whitespace already removed), with
/// or without `-----BEGIN <label>-----` / `-----END <label>-----` armour.
fn strip_armour(compact: &str) -> Option<&str> {
    if !compact.starts_with("-----") {
        return Some(compact);
    }
    let after_begin = compact.strip_prefix("-----BEGIN")?;
    let label_end = after_begin.find("-----")?;
    let rest = after_begin.get(label_end + "-----".len()..)?;
    let footer = rest.rfind("-----END")?;
    if !rest.ends_with("-----") {
        return None;
    }
    rest.get(..footer)
}

/// Deserializes `bytes` only if the JSON value is an object. serde's derived
/// struct visitor also accepts an array (members by position), which no other
/// implementation does: an input only we accept is a parser differential.
pub(crate) fn from_json_object<T: DeserializeOwned>(bytes: &[u8]) -> Option<T> {
    if bytes.trim_ascii_start().first() != Some(&b'{') {
        return None;
    }
    serde_json::from_slice(bytes).ok()
}

/// Nested structs must be JSON objects too. Derived visitors also accept a
/// positional array (`"window":[7,180]`), which JCS of the input would keep
/// as an array while our re-serialized bytes have an object: two different
/// hashes for one policy. So each nested value is read raw and re-parsed
/// object-only.
pub(crate) fn object<'de, D: Deserializer<'de>, T: DeserializeOwned>(
    deserializer: D,
) -> Result<T, D::Error> {
    let raw = Box::<RawValue>::deserialize(deserializer)?;
    from_json_object(raw.get().as_bytes()).ok_or_else(|| D::Error::custom("expected a JSON object"))
}

/// [`object`] for each element of an array.
pub(crate) fn objects<'de, D: Deserializer<'de>, T: DeserializeOwned>(
    deserializer: D,
) -> Result<Vec<T>, D::Error> {
    Vec::<Box<RawValue>>::deserialize(deserializer)?
        .iter()
        .map(|raw| {
            from_json_object(raw.get().as_bytes())
                .ok_or_else(|| D::Error::custom("expected a JSON object"))
        })
        .collect()
}

#[cfg(test)]
mod tests;
