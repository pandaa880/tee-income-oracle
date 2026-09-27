//! ReBIT `KeyMaterial` JSON (`docs/FORMATS.md` §3).

use serde::{Deserialize, Serialize};

use crate::{
    cipher::{DecryptError, Nonce},
    ecdh::{KeyError, PeerPublicKey, PublicKey},
    encoding::{der_to_single_line_pem, pem_to_der},
    time::format_iso_utc,
    ErrorCode,
};

/// ReBIT `KeyMaterial`. The labels (`cryptoAlg`, `curve`, `params`) are
/// never trusted: real samples shuffle them. The key type comes from
/// `KeyValue` only.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct KeyMaterial {
    /// Label only.
    #[serde(rename = "cryptoAlg")]
    pub crypto_alg: Option<String>,
    /// Label only.
    pub curve: Option<String>,
    /// Label only.
    pub params: Option<String>,
    /// The public key and its expiry.
    #[serde(rename = "DHPublicKey")]
    pub dh_public_key: DhPublicKey,
    /// Base64 of the 32-byte nonce.
    #[serde(rename = "Nonce")]
    pub nonce: String,
}

/// `KeyMaterial.DHPublicKey`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DhPublicKey {
    /// ISO-8601 expiry; peers enforce it, we only emit it.
    pub expiry: String,
    /// Label only. rahasya emits the singular `Parameter`.
    #[serde(rename = "Parameters", alias = "Parameter", default)]
    pub parameters: Option<String>,
    /// PEM (any form on input; single-line on output).
    #[serde(rename = "KeyValue")]
    pub key_value: String,
}

/// Errors reading or building a `KeyMaterial`.
#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum KeyMaterialError {
    /// The key failed to parse or validate.
    #[error(transparent)]
    Key(#[from] KeyError),
    /// The nonce is not valid base64, or not exactly 32 bytes.
    #[error(transparent)]
    Decrypt(#[from] DecryptError),
    /// `KeyValue` is not valid PEM/base64.
    #[error("bad key material encoding")]
    BadEncoding,
}

impl ErrorCode for KeyMaterialError {
    fn code(&self) -> &'static str {
        match self {
            Self::Key(e) => e.code(),
            Self::Decrypt(e) => e.code(),
            Self::BadEncoding => "bad_key_material",
        }
    }
}

impl KeyMaterial {
    /// Builds our `KeyMaterial`. `expiry_unix` comes from the caller's clock
    /// (the enclave uses now + 24h).
    ///
    /// # Errors
    /// Propagates [`PublicKey::to_spki_der`] errors.
    pub fn new(
        public: &PublicKey,
        nonce: &Nonce,
        expiry_unix: i64,
    ) -> Result<Self, KeyMaterialError> {
        Ok(Self {
            crypto_alg: Some("ECDH".to_owned()),
            curve: Some("Curve25519".to_owned()),
            params: Some(String::new()),
            dh_public_key: DhPublicKey {
                expiry: format_iso_utc(expiry_unix),
                parameters: Some(String::new()),
                key_value: der_to_single_line_pem(&public.to_spki_der()?),
            },
            nonce: nonce.to_base64(),
        })
    }

    /// The peer's validated public key, decided by `KeyValue` alone.
    ///
    /// # Errors
    /// [`KeyMaterialError::BadEncoding`] or a wrapped [`KeyError`].
    pub fn peer_public_key(&self) -> Result<PeerPublicKey, KeyMaterialError> {
        let der =
            pem_to_der(&self.dh_public_key.key_value).map_err(|_| KeyMaterialError::BadEncoding)?;
        Ok(PeerPublicKey::from_spki_der(&der)?)
    }

    /// The peer's nonce.
    ///
    /// # Errors
    /// [`KeyMaterialError::Decrypt`] with [`DecryptError::BadNonce`].
    pub fn nonce(&self) -> Result<Nonce, KeyMaterialError> {
        Ok(Nonce::from_base64(&self.nonce)?)
    }
}

#[cfg(test)]
mod tests;
