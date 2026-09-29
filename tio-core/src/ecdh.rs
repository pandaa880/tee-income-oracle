//! Per-session Curve25519 key exchange (`docs/FORMATS.md` §3).
//!
//! Why this protects the data: the session secret is created here, inside
//! the enclave, and never leaves. The untrusted gateway only ever carries our
//! public key and the FIP's ciphertext, so it can't derive the AES key.

mod wei25519;
mod x25519;

use curve25519_dalek::montgomery::MontgomeryPoint;
use rand_core::CryptoRngCore;
use subtle::ConstantTimeEq;
use zeroize::Zeroizing;

use crate::ErrorCode;

/// How a Curve25519 public key is encoded on the wire.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KeyMode {
    /// Short-Weierstrass form with explicit params (BouncyCastle / Finvu).
    /// The mode we emit unless a session asks for X25519.
    Wei25519,
    /// RFC 7748 Montgomery form.
    X25519,
}

/// Key-exchange errors.
#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum KeyError {
    /// Not a known SPKI template, wrong curve params, or wrong length.
    #[error("unsupported key encoding")]
    UnsupportedKey,
    /// Our key mode differs from the peer's.
    #[error("key mode mismatch")]
    ModeMismatch,
    /// Coordinate out of range, point off the curve, or small-order point.
    #[error("invalid curve point")]
    InvalidPoint,
}

impl ErrorCode for KeyError {
    fn code(&self) -> &'static str {
        match self {
            Self::UnsupportedKey | Self::ModeMismatch => "bad_key_material",
            Self::InvalidPoint => "invalid_point",
        }
    }
}

/// Our public key.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PublicKey {
    mode: KeyMode,
    u: MontgomeryPoint,
}

impl PublicKey {
    /// Wire mode of this key.
    pub fn mode(&self) -> KeyMode {
        self.mode
    }

    /// SubjectPublicKeyInfo DER: 309 bytes (wei25519) or 44 bytes (x25519).
    ///
    /// # Errors
    /// [`KeyError::InvalidPoint`] if the point has no Weierstrass y (cannot
    /// happen for a key made by [`SessionKeyPair::generate`]).
    pub fn to_spki_der(&self) -> Result<Vec<u8>, KeyError> {
        match self.mode {
            KeyMode::Wei25519 => wei25519::encode_spki(&self.u),
            KeyMode::X25519 => Ok(x25519::encode_spki(&self.u)),
        }
    }

    #[cfg(test)]
    pub(crate) fn montgomery_u(&self) -> &MontgomeryPoint {
        &self.u
    }
}

/// A validated peer public key.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PeerPublicKey {
    mode: KeyMode,
    u: MontgomeryPoint,
}

impl PeerPublicKey {
    /// Parses and validates SPKI DER. The mode is decided by the encoding
    /// alone, never by the `KeyMaterial` labels (`docs/FORMATS.md` §3).
    ///
    /// # Errors
    /// [`KeyError::UnsupportedKey`] or [`KeyError::InvalidPoint`].
    pub fn from_spki_der(der: &[u8]) -> Result<Self, KeyError> {
        let (mode, u) = if der.starts_with(&wei25519::SPKI_PREFIX) {
            (KeyMode::Wei25519, wei25519::parse_spki(der)?)
        } else {
            (KeyMode::X25519, x25519::parse_spki(der)?)
        };
        Ok(Self { mode, u })
    }

    /// Wire mode of this key.
    pub fn mode(&self) -> KeyMode {
        self.mode
    }

    #[cfg(test)]
    pub(crate) fn montgomery_u(&self) -> &MontgomeryPoint {
        &self.u
    }
}

/// Mode-encoded 32-byte ECDH output (wei25519: big-endian x_W; x25519: little-endian u).
pub struct SharedSecret(Zeroizing<[u8; 32]>);

impl SharedSecret {
    /// Raw bytes, the HKDF input.
    pub fn as_bytes(&self) -> &[u8; 32] {
        &self.0
    }
}

/// Our per-session key pair. The secret never leaves this struct.
pub struct SessionKeyPair {
    mode: KeyMode,
    secret: Zeroizing<[u8; 32]>,
    public: PublicKey,
}

impl core::fmt::Debug for SessionKeyPair {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.debug_struct("SessionKeyPair")
            .field("mode", &self.mode)
            .field("public", &self.public)
            .finish_non_exhaustive()
    }
}

impl SessionKeyPair {
    /// Generates a fresh key pair. The scalar is clamped (RFC 7748): that
    /// clears the cofactor, so any small-order peer point maps to u = 0,
    /// which [`Self::shared_secret`] rejects.
    pub fn generate(mode: KeyMode, rng: &mut impl CryptoRngCore) -> Self {
        let mut secret = Zeroizing::new([0u8; 32]);
        rng.fill_bytes(secret.as_mut());
        // `*secret` is copied into dalek, whose internal `Scalar` isn't wiped
        // on drop. dalek offers no way around it; a known stack residual.
        let u = MontgomeryPoint::mul_base_clamped(*secret);
        Self {
            mode,
            secret,
            public: PublicKey { mode, u },
        }
    }

    /// Wire mode of this key pair.
    pub fn mode(&self) -> KeyMode {
        self.mode
    }

    /// Our public key.
    pub fn public_key(&self) -> &PublicKey {
        &self.public
    }

    /// ECDH with a peer key of the same mode.
    ///
    /// A mode mismatch is rejected: a BouncyCastle FIP can't have parsed an
    /// X25519 key, so a mismatch means the keys were swapped somewhere.
    ///
    /// # Errors
    /// [`KeyError::ModeMismatch`] or [`KeyError::InvalidPoint`].
    pub fn shared_secret(&self, peer: &PeerPublicKey) -> Result<SharedSecret, KeyError> {
        if peer.mode != self.mode {
            return Err(KeyError::ModeMismatch);
        }
        // Same scalar-copy residual as in `generate`. The ladder output is
        // the x25519 shared secret itself, so it is wiped.
        let s = Zeroizing::new(peer.u.mul_clamped(*self.secret));
        finish_shared(self.mode, &s)
    }
}

/// Turns a raw ladder output into the mode's shared-secret bytes.
///
/// Rejects the all-zero output of a small-order peer point: that secret is
/// known to everyone. Checked on the Montgomery u, before the wei25519
/// `+ A/3`, which would hide it. Known residual: the by-value `to_bytes()`
/// copies here and in `wei25519::shared_from_u` are not wiped.
pub(crate) fn finish_shared(mode: KeyMode, s: &MontgomeryPoint) -> Result<SharedSecret, KeyError> {
    if bool::from(s.as_bytes().ct_eq(&[0u8; 32])) {
        return Err(KeyError::InvalidPoint);
    }
    let bytes = match mode {
        KeyMode::Wei25519 => wei25519::shared_from_u(s),
        KeyMode::X25519 => s.to_bytes(),
    };
    Ok(SharedSecret(Zeroizing::new(bytes)))
}

#[cfg(test)]
mod tests;
