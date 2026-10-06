//! The enclave's attester key (secp256k1) and what it signs.
//!
//! Oyster generates this key inside the enclave at boot and puts its public
//! half in the Nitro attestation document, so a verifier can tie the key to
//! the measured image. It signs two things: the §8 attestation message and,
//! once per boot, the §8.1 FIU-key binding. Both are keccak256-prehashed,
//! recoverable, low-s, `v ∈ {0, 1}`, as the Solana secp256k1 precompile
//! expects.

use std::path::Path;

use k256::ecdsa::{SigningKey, VerifyingKey};
use sha2::Sha256;
use sha3::{Digest, Keccak256};
use zeroize::Zeroizing;

/// Domain tag of the FIU-key binding message (FORMATS §8.1).
pub const FIU_KEY_DOMAIN_TAG: &[u8; 14] = b"TIO-FIU-KEY-v1";

/// Length of the FIU-key binding message: tag + sha256.
pub const FIU_BINDING_LEN: usize = 14 + 32;

/// Why the attester key could not be loaded or used. Errors name the file,
/// never its contents (CODING-GUIDELINES §1.11).
#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum AttesterError {
    #[error("{path}: cannot read attester key file")]
    Read { path: String },
    #[error("{path}: attester key must be exactly 32 raw bytes")]
    BadLength { path: String },
    #[error("{path}: attester key is not a valid secp256k1 scalar")]
    InvalidKey { path: String },
    #[error("attester signing failed")]
    SignFailed,
}

/// The secp256k1 attester key. `SigningKey` wipes its scalar on drop.
pub struct Attester {
    key: SigningKey,
    address: [u8; 20],
}

impl Attester {
    /// Loads Oyster's raw 32-byte key file.
    ///
    /// # Errors
    /// [`AttesterError::Read`], [`AttesterError::BadLength`] or
    /// [`AttesterError::InvalidKey`].
    pub fn from_file(path: &Path) -> Result<Self, AttesterError> {
        let label = path.display().to_string();
        let bytes = Zeroizing::new(std::fs::read(path).map_err(|_| AttesterError::Read {
            path: label.clone(),
        })?);
        Self::from_bytes(&bytes, &label)
    }

    /// Builds the key from 32 raw bytes (big-endian scalar, `0 < k < n`).
    /// `label` names the source in errors.
    ///
    /// # Errors
    /// [`AttesterError::BadLength`] or [`AttesterError::InvalidKey`].
    pub fn from_bytes(bytes: &[u8], label: &str) -> Result<Self, AttesterError> {
        let scalar: &[u8; 32] = bytes.try_into().map_err(|_| AttesterError::BadLength {
            path: label.to_owned(),
        })?;
        // Rejects 0 and anything >= the group order n.
        let key = SigningKey::from_bytes(scalar.into()).map_err(|_| AttesterError::InvalidKey {
            path: label.to_owned(),
        })?;
        let address = eth_address_of(key.verifying_key());
        Ok(Self { key, address })
    }

    /// Ethereum-style address: the last 20 bytes of keccak256 of the
    /// 64-byte uncompressed public key (what the precompile recovers).
    pub fn eth_address(&self) -> [u8; 20] {
        self.address
    }

    /// `0x` + 40 lowercase hex chars (FORMATS §0).
    pub fn address_hex(&self) -> String {
        format!("0x{}", hex::encode(self.address))
    }

    /// Signs keccak256(`message`): 65 bytes `r ‖ s ‖ v`, low-s, `v ∈ {0, 1}`.
    ///
    /// k256 normalizes `s` to the low half and flips the recovery id to
    /// match. The precompile accepts either half, so low-s isn't a security
    /// property here (replay is stopped by `issued_at`, FORMATS §8); it
    /// keeps the bytes canonical for any other verifier.
    ///
    /// # Errors
    /// [`AttesterError::SignFailed`].
    pub fn sign(&self, message: &[u8]) -> Result<[u8; 65], AttesterError> {
        let digest = Keccak256::digest(message);
        let (signature, recovery_id) = self
            .key
            .sign_prehash_recoverable(&digest)
            .map_err(|_| AttesterError::SignFailed)?;
        let mut out = [0u8; 65];
        let (rs, v) = out.split_at_mut(64);
        rs.copy_from_slice(&signature.to_bytes());
        v.copy_from_slice(&[recovery_id.to_byte()]);
        Ok(out)
    }
}

/// Last 20 bytes of keccak256 of the uncompressed point without its `0x04`
/// prefix.
fn eth_address_of(key: &VerifyingKey) -> [u8; 20] {
    let point = key.to_encoded_point(false);
    let hash = Keccak256::digest(point.as_bytes().get(1..).unwrap_or_default());
    let mut address = [0u8; 20];
    address.copy_from_slice(hash.get(12..).unwrap_or_default());
    address
}

/// The §8.1 message: `TIO-FIU-KEY-v1 ‖ sha256(jwk_jcs)`.
pub fn fiu_binding_message(jwk_jcs: &[u8]) -> [u8; FIU_BINDING_LEN] {
    let mut message = [0u8; FIU_BINDING_LEN];
    let (tag, hash) = message.split_at_mut(FIU_KEY_DOMAIN_TAG.len());
    tag.copy_from_slice(FIU_KEY_DOMAIN_TAG);
    hash.copy_from_slice(&Sha256::digest(jwk_jcs));
    message
}

impl core::fmt::Debug for Attester {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.debug_struct("Attester").finish_non_exhaustive()
    }
}
