//! Pinned FIP and AA public keys, compiled into the image (AGENTS invariant
//! 3): the enclave never takes a verification key from the network or a
//! JWS header. Changing them changes the image id.

use tio_core::PinnedKey;

use crate::guard::{check_pinned, GuardError};

/// AA public keys (`enclave/pinned/aa.jwk.json`).
pub const AA_JWKS: &[&[u8]] = &[include_bytes!("../pinned/aa.jwk.json")];

/// FIP public keys (`enclave/pinned/fip.jwk.json`).
pub const FIP_JWKS: &[&[u8]] = &[include_bytes!("../pinned/fip.jwk.json")];

/// Parsed pinned keys.
#[derive(Debug, Clone)]
pub struct Pinned {
    pub aa: Vec<PinnedKey>,
    pub fip: Vec<PinnedKey>,
}

impl Pinned {
    /// Parses JWKs without the startup guard (tests pin test keys).
    ///
    /// # Errors
    /// [`GuardError::BadPinnedKey`] if a JWK doesn't parse as a pinned key.
    pub fn parse(aa: &[&[u8]], fip: &[&[u8]]) -> Result<Self, GuardError> {
        let parse_all = |jwks: &[&[u8]]| {
            jwks.iter()
                .map(|jwk| PinnedKey::from_jwk(jwk).map_err(|_| GuardError::BadPinnedKey))
                .collect::<Result<Vec<_>, _>>()
        };
        Ok(Self {
            aa: parse_all(aa)?,
            fip: parse_all(fip)?,
        })
    }

    /// Every pinned `kid`, AA first, for `GET /v1/info`.
    pub fn kids(&self) -> Vec<String> {
        self.aa
            .iter()
            .chain(&self.fip)
            .map(|key| key.kid().to_owned())
            .collect()
    }
}

/// The compiled-in keys, after the startup guard.
///
/// # Errors
/// [`GuardError`].
pub fn load_compiled() -> Result<Pinned, GuardError> {
    let all: Vec<&[u8]> = AA_JWKS.iter().chain(FIP_JWKS).copied().collect();
    check_pinned(&all)?;
    Pinned::parse(AA_JWKS, FIP_JWKS)
}
