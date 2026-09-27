//! Pinned RSA verification keys and the enclave's FIU signing key.

use rand_core::CryptoRngCore;
use rsa::{traits::PublicKeyParts, BigUint, Pkcs1v15Sign, RsaPrivateKey, RsaPublicKey};
use serde::{de::IgnoredAny, Deserialize};
use sha2::{Digest, Sha256, Sha512};

use super::{detached_header_b64, detached_signing_input, from_json_object, present, JwsError};
use crate::encoding::{b64url_decode, b64url_encode};

/// Smallest modulus we accept. `RsaPublicKey::new` has no lower bound, and
/// a short modulus can be factored, which turns a pinned key into a forgery
/// key for anyone.
const MIN_MODULUS_BITS: usize = 2048;

/// Our FIU key size (`docs/FORMATS.md` §2).
const FIU_KEY_BITS: usize = 2048;

/// Signature algorithms we accept (`docs/FORMATS.md` §4).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Alg {
    Rs256,
    Rs512,
}

impl Alg {
    /// Exact, case-sensitive match on the JWS `alg` value. Everything else
    /// (`none`, `HS*`, `PS*`, `ES*`) is refused: an allow-list, so a new or
    /// unexpected algorithm can never be verified by accident.
    pub(crate) fn from_name(name: &str) -> Result<Self, JwsError> {
        match name {
            "RS256" => Ok(Self::Rs256),
            "RS512" => Ok(Self::Rs512),
            _ => Err(JwsError::BadAlg),
        }
    }
}

/// A public RSA JWK as pinned in the image. The private members are
/// declared only to detect them: a pinned file carrying any part of a
/// private key is a key-handling mistake.
#[derive(Deserialize)]
struct PublicJwk {
    kty: String,
    n: String,
    e: String,
    kid: String,
    #[serde(default, deserialize_with = "present")]
    d: Option<IgnoredAny>,
    #[serde(default, deserialize_with = "present")]
    p: Option<IgnoredAny>,
    #[serde(default, deserialize_with = "present")]
    q: Option<IgnoredAny>,
    #[serde(default, deserialize_with = "present")]
    dp: Option<IgnoredAny>,
    #[serde(default, deserialize_with = "present")]
    dq: Option<IgnoredAny>,
    #[serde(default, deserialize_with = "present")]
    qi: Option<IgnoredAny>,
    #[serde(default, deserialize_with = "present")]
    oth: Option<IgnoredAny>,
}

impl PublicJwk {
    fn has_private_member(&self) -> bool {
        [
            &self.d, &self.p, &self.q, &self.dp, &self.dq, &self.qi, &self.oth,
        ]
        .iter()
        .any(|m| m.is_some())
    }
}

/// A pinned RSA public key and its `kid`.
#[derive(Debug, Clone)]
pub struct PinnedKey {
    kid: String,
    key: RsaPublicKey,
}

impl PinnedKey {
    /// Parses a public RSA JWK `{kty:"RSA", n, e, kid}` of at least 2048 bits.
    ///
    /// # Errors
    /// [`JwsError::BadPinnedKey`].
    pub fn from_jwk(json: &[u8]) -> Result<Self, JwsError> {
        let jwk: PublicJwk = from_json_object(json).ok_or(JwsError::BadPinnedKey)?;
        if jwk.kty != "RSA" || jwk.has_private_member() {
            return Err(JwsError::BadPinnedKey);
        }
        let n = decode_biguint(&jwk.n)?;
        let e = decode_biguint(&jwk.e)?;
        let key = RsaPublicKey::new(n, e).map_err(|_| JwsError::BadPinnedKey)?;
        if key.n().bits() < MIN_MODULUS_BITS {
            return Err(JwsError::BadPinnedKey);
        }
        Ok(Self { kid: jwk.kid, key })
    }

    /// The key id.
    pub fn kid(&self) -> &str {
        &self.kid
    }

    pub(crate) fn key(&self) -> &RsaPublicKey {
        &self.key
    }
}

/// Decodes a JWK `Base64urlUInt` (RFC 7518 §2): big-endian, minimal length,
/// so empty or leading-zero values are refused and each integer has one
/// accepted encoding.
fn decode_biguint(b64url: &str) -> Result<BigUint, JwsError> {
    let bytes = b64url_decode(b64url).map_err(|_| JwsError::BadPinnedKey)?;
    match bytes.first() {
        None | Some(0) => Err(JwsError::BadPinnedKey),
        Some(_) => Ok(BigUint::from_bytes_be(&bytes)),
    }
}

/// The enclave's FIU request-signing key. Born inside the enclave, so the
/// host can't sign an `FI/request` carrying its own session key
/// (`docs/ARCHITECTURE.md`). `RsaPrivateKey` wipes itself on drop.
/// Known residual: rejected prime candidates during generation and
/// num-bigint-dig's modpow temporaries are not wiped.
pub struct FiuSigningKey {
    kid: String,
    key: RsaPrivateKey,
}

impl FiuSigningKey {
    /// Generates a fresh RSA-2048 key.
    ///
    /// # Errors
    /// [`JwsError::SignFailed`].
    pub fn generate(kid: String, rng: &mut impl CryptoRngCore) -> Result<Self, JwsError> {
        let key = RsaPrivateKey::new(rng, FIU_KEY_BITS).map_err(|_| JwsError::SignFailed)?;
        Ok(Self { kid, key })
    }

    /// Wraps an existing private key (tests use the RFC 7515 A.2 key).
    #[cfg(test)]
    pub(crate) fn from_private_key(kid: String, key: RsaPrivateKey) -> Self {
        Self { kid, key }
    }

    /// The key id.
    pub fn kid(&self) -> &str {
        &self.kid
    }

    /// Signs `body` as a detached RS256 JWS (`header..signature`), header
    /// `{"alg":"RS256","kid":…,"b64":false,"crit":["b64"]}`.
    ///
    /// # Errors
    /// [`JwsError::SignFailed`].
    pub fn sign_detached(
        &self,
        body: &[u8],
        rng: &mut impl CryptoRngCore,
    ) -> Result<String, JwsError> {
        let header_b64 = detached_header_b64(&self.kid)?;
        let signing_input = detached_signing_input(&header_b64, body);
        let signature = sign_rs256(&self.key, &signing_input, rng)?;
        Ok(format!("{header_b64}..{}", b64url_encode(&signature)))
    }

    #[cfg(test)]
    pub(crate) fn key(&self) -> &RsaPrivateKey {
        &self.key
    }
}

impl core::fmt::Debug for FiuSigningKey {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.debug_struct("FiuSigningKey")
            .field("kid", &self.kid)
            .finish_non_exhaustive()
    }
}

/// Verifies a PKCS#1 v1.5 signature over `signing_input`. rsa checks the
/// signature length equals the modulus size and compares the padded
/// encoding in constant time.
pub(crate) fn verify_signature(
    key: &RsaPublicKey,
    alg: Alg,
    signing_input: &[u8],
    signature: &[u8],
) -> Result<(), JwsError> {
    let verified = match alg {
        Alg::Rs256 => key.verify(
            Pkcs1v15Sign::new::<Sha256>(),
            &Sha256::digest(signing_input),
            signature,
        ),
        Alg::Rs512 => key.verify(
            Pkcs1v15Sign::new::<Sha512>(),
            &Sha512::digest(signing_input),
            signature,
        ),
    };
    verified.map_err(|_| JwsError::BadSignature)
}

/// RS256 signature over `signing_input`. Always blinded: `sign_with_rng`
/// hands rsa the rng, which masks the private-key exponentiation so its
/// timing doesn't track the key (RUSTSEC-2023-0071 residual, see
/// Cargo.toml). Blinding doesn't change the output: PKCS#1 v1.5 is
/// deterministic.
pub(crate) fn sign_rs256(
    key: &RsaPrivateKey,
    signing_input: &[u8],
    rng: &mut impl CryptoRngCore,
) -> Result<Vec<u8>, JwsError> {
    key.sign_with_rng(
        rng,
        Pkcs1v15Sign::new::<Sha256>(),
        &Sha256::digest(signing_input),
    )
    .map_err(|_| JwsError::SignFailed)
}

#[cfg(test)]
mod tests;
