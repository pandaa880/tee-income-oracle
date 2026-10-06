//! Startup guard (FORMATS §2): the enclave refuses to start if a pinned key
//! is a test key. Test-vector private keys are committed, so anyone could
//! sign "bank data" with them; an enclave that pinned one would attest to
//! forgeries.
//!
//! The deny-list holds every test key's `kid` and the SHA-256 of its RSA
//! modulus (the big-endian bytes of the JWK `n`), so renaming a test key's
//! `kid` doesn't get it past the guard. A test checks the list covers every
//! RSA key under `test-vectors/`.

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use serde::Deserialize;
use sha2::{Digest, Sha256};

/// `kid`s of the test-vector RSA keys (`test-vectors/keys/`).
pub const TEST_KEY_KIDS: &[&str] = &[
    "4563ba63-fb15-4a02-a970-4f45e9739f95", // aa
    "8559928d-c3b8-4610-843a-9983490775bf", // fip
    "283c926d-6d74-4bab-8142-a6abc9a71e5f", // fiu
    "b536d213-f323-43f6-9af1-b7a92b31bc70", // rogue
    "bilbo.baggins@hobbiton.example",       // RFC 7520 golden key
];

/// SHA-256 (hex) of each test RSA modulus, including the golden RFC keys.
pub const TEST_KEY_MODULUS_SHA256: &[&str] = &[
    "ac08342db9dcda52cd79ee3eff2b22f6420c9cb63fb7e9ed5c92c2013cf68ad3", // aa
    "23805ff05748ee15a407a8abc339ac7f29f8a999e6ad7e0ff27ade5ce5636f45", // fip
    "655ebfab96f7267f02df6349f328c1747f901d7daf0316b4f0a6bed68619ddc2", // fiu
    "cd5121df3360f286d30a1350191dcafe5a6a1bfbbd0d0558d44f98ef3d1ecbf2", // rogue
    "26d6872d476b20e7eaa7cc894dcbc03f2347e88fb8cb46066642213cacf257d5", // RFC 7515 A.2
    "91c2c702c0240040ba2a82a55357ac081cbac4b463632d77efa71d25b2c2b2a2", // RFC 7520
];

/// Why the pinned keys were refused.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum GuardError {
    /// A pinned key is a test key.
    #[error("a pinned key is a test key")]
    TestKeyPinned,
    /// A pinned JWK is not a JSON object with string `kid` and base64url `n`.
    #[error("a pinned key is not a valid JWK")]
    BadPinnedKey,
}

impl GuardError {
    /// Stable code printed at exit.
    pub fn code(&self) -> &'static str {
        match self {
            Self::TestKeyPinned => "test_key_pinned",
            Self::BadPinnedKey => "bad_pinned_key",
        }
    }
}

/// Checks that no JWK in `jwks` is a test key, by `kid` or modulus.
///
/// # Errors
/// [`GuardError`].
pub fn check_pinned(jwks: &[&[u8]]) -> Result<(), GuardError> {
    for jwk in jwks {
        let (kid, modulus_hash) = identify(jwk)?;
        if TEST_KEY_KIDS.contains(&kid.as_str())
            || TEST_KEY_MODULUS_SHA256.contains(&modulus_hash.as_str())
        {
            return Err(GuardError::TestKeyPinned);
        }
    }
    Ok(())
}

#[derive(Deserialize)]
struct JwkId {
    kid: String,
    n: String,
}

/// The `kid` and the hex SHA-256 of the modulus bytes.
fn identify(jwk: &[u8]) -> Result<(String, String), GuardError> {
    let parsed: JwkId = serde_json::from_slice(jwk).map_err(|_| GuardError::BadPinnedKey)?;
    let modulus = URL_SAFE_NO_PAD
        .decode(&parsed.n)
        .map_err(|_| GuardError::BadPinnedKey)?;
    Ok((parsed.kid, hex::encode(Sha256::digest(modulus))))
}
