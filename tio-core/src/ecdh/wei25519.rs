//! Curve25519 in short-Weierstrass form, as written by BouncyCastle
//! (`docs/FORMATS.md` §3, "How `wei25519` is computed").
//!
//! Short-Weierstrass and Montgomery Curve25519 are the same group under
//! `x_W = u + A/3 (mod p)`, `y_W = v`. The secret scalar multiplication stays
//! in curve25519-dalek; this module only translates coordinates. It uses
//! crypto-bigint, whose modular arithmetic is constant-time, because the last
//! step (`shared = s + A/3`) runs on the shared secret. Known residual: its
//! `U256`/`Residue` temporaries in `shared_from_u` are not zeroized.

use crypto_bigint::{impl_modulus, modular::constant_mod::ResidueParams, Encoding, U256};
use curve25519_dalek::montgomery::MontgomeryPoint;

use super::KeyError;

impl_modulus!(
    P25519,
    U256,
    "7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffed"
);

type Fe = crypto_bigint::modular::constant_mod::Residue<P25519, { U256::LIMBS }>;

/// A/3 mod p, with Montgomery A = 486662.
const A_OVER_3: U256 =
    U256::from_be_hex("2aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaad2451");
/// Weierstrass a = (3 − A²)/3.
const CURVE_A: U256 =
    U256::from_be_hex("2aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa984914a144");
/// Weierstrass b = (2A³ − 9A)/27.
const CURVE_B: U256 =
    U256::from_be_hex("7b425ed097b425ed097b425ed097b425ed097b425ed097b4260b5e9c7710c864");
/// (p + 3) / 8, the square-root exponent for p ≡ 5 (mod 8).
const SQRT_EXP: U256 =
    U256::from_be_hex("0ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe");
/// (p − 1) / 4; 2 raised to it is a square root of −1.
const SQRT_M1_EXP: U256 =
    U256::from_be_hex("1ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffb");

const SPKI_LEN: usize = 309;

/// Everything in a BouncyCastle Curve25519 SPKI before the point coordinates:
/// SEQUENCE, id-ecPublicKey, the explicit curve parameters (p, a, b, G, n,
/// h = 8, no seed), and the BIT STRING header plus the uncompressed-point
/// tag `04`. Identical for every key (checked across 202 rahasya keys).
/// Comparing it whole validates the algorithm and every curve parameter at
/// once, with no DER parser in the trusted code.
pub(crate) const SPKI_PREFIX: [u8; 245] = [
    0x30, 0x82, 0x01, 0x31, 0x30, 0x81, 0xea, 0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01,
    0x30, 0x81, 0xde, 0x02, 0x01, 0x01, 0x30, 0x2b, 0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x01,
    0x01, 0x02, 0x20, 0x7f, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
    0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
    0xff, 0xff, 0xed, 0x30, 0x44, 0x04, 0x20, 0x2a, 0xaa, 0xaa, 0xaa, 0xaa, 0xaa, 0xaa, 0xaa, 0xaa,
    0xaa, 0xaa, 0xaa, 0xaa, 0xaa, 0xaa, 0xaa, 0xaa, 0xaa, 0xaa, 0xaa, 0xaa, 0xaa, 0xaa, 0xaa, 0xaa,
    0xaa, 0xaa, 0x98, 0x49, 0x14, 0xa1, 0x44, 0x04, 0x20, 0x7b, 0x42, 0x5e, 0xd0, 0x97, 0xb4, 0x25,
    0xed, 0x09, 0x7b, 0x42, 0x5e, 0xd0, 0x97, 0xb4, 0x25, 0xed, 0x09, 0x7b, 0x42, 0x5e, 0xd0, 0x97,
    0xb4, 0x26, 0x0b, 0x5e, 0x9c, 0x77, 0x10, 0xc8, 0x64, 0x04, 0x41, 0x04, 0x2a, 0xaa, 0xaa, 0xaa,
    0xaa, 0xaa, 0xaa, 0xaa, 0xaa, 0xaa, 0xaa, 0xaa, 0xaa, 0xaa, 0xaa, 0xaa, 0xaa, 0xaa, 0xaa, 0xaa,
    0xaa, 0xaa, 0xaa, 0xaa, 0xaa, 0xaa, 0xaa, 0xaa, 0xaa, 0xad, 0x24, 0x5a, 0x20, 0xae, 0x19, 0xa1,
    0xb8, 0xa0, 0x86, 0xb4, 0xe0, 0x1e, 0xdd, 0x2c, 0x77, 0x48, 0xd1, 0x4c, 0x92, 0x3d, 0x4d, 0x7e,
    0x6d, 0x7c, 0x61, 0xb2, 0x29, 0xe9, 0xc5, 0xa2, 0x7e, 0xce, 0xd3, 0xd9, 0x02, 0x20, 0x10, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x14, 0xde,
    0xf9, 0xde, 0xa2, 0xf7, 0x9c, 0xd6, 0x58, 0x12, 0x63, 0x1a, 0x5c, 0xf5, 0xd3, 0xed, 0x02, 0x01,
    0x08, 0x03, 0x42, 0x00, 0x04,
];

/// Parses a 309-byte wei25519 SPKI into the Montgomery u of the point.
///
/// Checks the fixed prefix, both coordinates below p, and that the point is
/// on the curve. The on-curve check is what stops invalid-curve and twist
/// points: an x-only ladder alone would accept an x from the wrong curve.
pub(crate) fn parse_spki(der: &[u8]) -> Result<MontgomeryPoint, KeyError> {
    if der.len() != SPKI_LEN {
        return Err(KeyError::UnsupportedKey);
    }
    let (prefix, coords) = der
        .split_at_checked(SPKI_PREFIX.len())
        .ok_or(KeyError::UnsupportedKey)?;
    if prefix != SPKI_PREFIX {
        return Err(KeyError::UnsupportedKey);
    }
    let (x_bytes, y_bytes) = coords
        .split_at_checked(32)
        .ok_or(KeyError::UnsupportedKey)?;
    let x = field_element(x_bytes)?;
    let y = field_element(y_bytes)?;
    if y.square() != curve_rhs(&x) {
        return Err(KeyError::InvalidPoint);
    }
    let u = x - Fe::new(&A_OVER_3);
    Ok(MontgomeryPoint(u.retrieve().to_le_bytes()))
}

/// Encodes a Montgomery u as a 309-byte wei25519 SPKI. Either square root
/// works for y: only x-coordinates reach the shared secret.
pub(crate) fn encode_spki(u: &MontgomeryPoint) -> Result<Vec<u8>, KeyError> {
    let x = Fe::new(&U256::from_le_bytes(u.to_bytes())) + Fe::new(&A_OVER_3);
    let y = sqrt(&curve_rhs(&x)).ok_or(KeyError::InvalidPoint)?;
    let mut der = Vec::with_capacity(SPKI_LEN);
    der.extend_from_slice(&SPKI_PREFIX);
    der.extend_from_slice(&x.retrieve().to_be_bytes());
    der.extend_from_slice(&y.retrieve().to_be_bytes());
    Ok(der)
}

/// Shared-secret bytes: big-endian x_W = u + A/3, leading zeros kept, as
/// BouncyCastle's `ECDH` returns them.
pub(crate) fn shared_from_u(u: &MontgomeryPoint) -> [u8; 32] {
    let x = Fe::new(&U256::from_le_bytes(u.to_bytes())) + Fe::new(&A_OVER_3);
    x.retrieve().to_be_bytes()
}

/// A 32-byte big-endian coordinate that must be below p. `Fe::new` would
/// silently reduce it, so the range check is explicit.
fn field_element(bytes: &[u8]) -> Result<Fe, KeyError> {
    let bytes: [u8; 32] = bytes.try_into().map_err(|_| KeyError::UnsupportedKey)?;
    let n = U256::from_be_bytes(bytes);
    if n >= P25519::MODULUS {
        return Err(KeyError::InvalidPoint);
    }
    Ok(Fe::new(&n))
}

/// x³ + a·x + b.
fn curve_rhs(x: &Fe) -> Fe {
    x.square() * x + Fe::new(&CURVE_A) * x + Fe::new(&CURVE_B)
}

/// Square root mod p for p ≡ 5 (mod 8) (Atkin): r = z^((p+3)/8); if r² = −z,
/// multiply by √−1. `None` if z is not a square.
fn sqrt(z: &Fe) -> Option<Fe> {
    let r = z.pow(&SQRT_EXP);
    if r.square() == *z {
        return Some(r);
    }
    if r.square() == -*z {
        let sqrt_m1 = Fe::new(&U256::from_u8(2)).pow(&SQRT_M1_EXP);
        return Some(r * sqrt_m1);
    }
    None
}

#[cfg(test)]
mod tests;
