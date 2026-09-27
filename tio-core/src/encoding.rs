//! Byte encodings shared by the ReBIT-facing modules.

use base64::{engine::general_purpose::STANDARD, Engine};

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

#[cfg(test)]
mod tests;
