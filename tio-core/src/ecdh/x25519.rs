//! RFC 7748 X25519 SubjectPublicKeyInfo (OID 1.3.101.110).

use curve25519_dalek::montgomery::MontgomeryPoint;

use super::KeyError;

/// DER of `SEQUENCE { SEQUENCE { OID 1.3.101.110 }, BIT STRING (33 bytes) }`
/// up to the 32-byte little-endian u.
const SPKI_PREFIX: [u8; 12] = [
    0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x6e, 0x03, 0x21, 0x00,
];
const SPKI_LEN: usize = 44;

/// Parses a 44-byte X25519 SPKI. Small-order points are rejected later, on
/// the ladder output (`finish_shared`), as RFC 7748 §6.1 recommends.
pub(crate) fn parse_spki(der: &[u8]) -> Result<MontgomeryPoint, KeyError> {
    if der.len() != SPKI_LEN {
        return Err(KeyError::UnsupportedKey);
    }
    let (prefix, u) = der
        .split_at_checked(SPKI_PREFIX.len())
        .ok_or(KeyError::UnsupportedKey)?;
    if prefix != SPKI_PREFIX {
        return Err(KeyError::UnsupportedKey);
    }
    let u: [u8; 32] = u.try_into().map_err(|_| KeyError::UnsupportedKey)?;
    Ok(MontgomeryPoint(u))
}

/// Encodes a Montgomery u as a 44-byte X25519 SPKI.
pub(crate) fn encode_spki(u: &MontgomeryPoint) -> Vec<u8> {
    let mut der = Vec::with_capacity(SPKI_LEN);
    der.extend_from_slice(&SPKI_PREFIX);
    der.extend_from_slice(u.as_bytes());
    der
}
