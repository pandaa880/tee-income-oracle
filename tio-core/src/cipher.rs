//! Session key derivation and AES-256-GCM decryption (`docs/FORMATS.md` §3).

use aes_gcm::{aead::Aead, Aes256Gcm, KeyInit};
use base64::{engine::general_purpose::STANDARD, Engine};
use hkdf::Hkdf;
use rand_core::CryptoRngCore;
use sha2::Sha256;
use zeroize::{ZeroizeOnDrop, Zeroizing};

use crate::{ecdh::SharedSecret, ErrorCode};

const NONCE_LEN: usize = 32;
const SALT_LEN: usize = 20;

/// Decryption-side errors.
#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum DecryptError {
    /// Not valid base64, or not exactly 32 bytes.
    #[error("nonce must be 32 bytes")]
    BadNonce,
    /// Bad base64, too short, or GCM tag mismatch (deliberately one variant).
    #[error("decryption failed")]
    DecryptFailed,
}

impl ErrorCode for DecryptError {
    fn code(&self) -> &'static str {
        match self {
            Self::BadNonce => "bad_nonce",
            Self::DecryptFailed => "decrypt_failed",
        }
    }
}

/// A 32-byte session nonce.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Nonce([u8; NONCE_LEN]);

impl Nonce {
    /// A fresh random nonce.
    pub fn random(rng: &mut impl CryptoRngCore) -> Self {
        let mut bytes = [0u8; NONCE_LEN];
        rng.fill_bytes(&mut bytes);
        Self(bytes)
    }

    /// Decodes standard base64; must be exactly 32 bytes. rahasya sizes the
    /// XOR by its own nonce and cycles the other, so a wrong length would
    /// silently derive a different key instead of failing.
    ///
    /// # Errors
    /// [`DecryptError::BadNonce`].
    pub fn from_base64(s: &str) -> Result<Self, DecryptError> {
        let bytes = STANDARD.decode(s).map_err(|_| DecryptError::BadNonce)?;
        bytes
            .try_into()
            .map(Self)
            .map_err(|_| DecryptError::BadNonce)
    }

    /// Standard base64 with padding.
    pub fn to_base64(&self) -> String {
        STANDARD.encode(self.0)
    }
}

/// AES-256-GCM key and IV for one session.
#[derive(ZeroizeOnDrop)]
pub struct SessionKey {
    aes_key: Zeroizing<[u8; 32]>,
    iv: [u8; 12],
}

impl SessionKey {
    #[cfg(test)]
    pub(crate) fn aes_key(&self) -> &[u8; 32] {
        &self.aes_key
    }

    #[cfg(test)]
    pub(crate) fn iv(&self) -> &[u8; 12] {
        &self.iv
    }
}

/// Derives the session key: `xn = ours XOR theirs`,
/// `aes_key = HKDF-SHA256(ikm = shared, salt = xn[0..20], info = empty)`,
/// `iv = xn[20..32]`. Both parties contribute a nonce, so each session gets
/// a fresh key and IV. Reusing a key + nonce pair would repeat the GCM IV.
///
/// # Errors
/// [`DecryptError::DecryptFailed`] only if HKDF rejects the output length,
/// which cannot happen for 32 bytes.
pub fn derive_session_key(
    shared: &SharedSecret,
    ours: &Nonce,
    theirs: &Nonce,
) -> Result<SessionKey, DecryptError> {
    let mut xn = [0u8; NONCE_LEN];
    for (out, (a, b)) in xn.iter_mut().zip(ours.0.iter().zip(theirs.0.iter())) {
        *out = a ^ b;
    }
    let (salt, iv) = xn
        .split_at_checked(SALT_LEN)
        .ok_or(DecryptError::DecryptFailed)?;
    let iv: [u8; 12] = iv.try_into().map_err(|_| DecryptError::DecryptFailed)?;
    let mut aes_key = Zeroizing::new([0u8; 32]);
    // Known residual: hkdf 0.12 does not wipe the PRK held in its HMAC state.
    Hkdf::<Sha256>::new(Some(salt), shared.as_bytes())
        .expand(&[], aes_key.as_mut())
        .map_err(|_| DecryptError::DecryptFailed)?;
    Ok(SessionKey { aes_key, iv })
}

/// Decrypts base64 `encryptedFI` (ciphertext ‖ 16-byte tag, no AAD).
///
/// The GCM tag authenticates the ciphertext: one flipped byte fails here.
/// All failures share one error, so the caller learns nothing about which
/// check fired.
///
/// # Errors
/// [`DecryptError::DecryptFailed`].
pub fn decrypt(
    key: &SessionKey,
    encrypted_fi_b64: &str,
) -> Result<Zeroizing<Vec<u8>>, DecryptError> {
    let sealed = STANDARD
        .decode(encrypted_fi_b64)
        .map_err(|_| DecryptError::DecryptFailed)?;
    let cipher =
        Aes256Gcm::new_from_slice(key.aes_key.as_ref()).map_err(|_| DecryptError::DecryptFailed)?;
    cipher
        .decrypt(&key.iv.into(), sealed.as_ref())
        .map(Zeroizing::new)
        .map_err(|_| DecryptError::DecryptFailed)
}

#[cfg(test)]
mod tests;
