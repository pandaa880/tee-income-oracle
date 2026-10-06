//! Wallet intent (FORMATS §9): the borrower's wallet signs a text that binds
//! it to one session and one policy. Without it, anyone holding a session
//! id could get a tier written to a wallet they don't control.

use ed25519_dalek::{Signature, VerifyingKey};

use crate::error::ApiError;

/// Builds the exact §9 text: five `\n`-separated lines, no trailing newline.
pub fn build_intent(
    session_id: &str,
    wallet: &[u8; 32],
    policy_hash: &[u8; 32],
    expires: i64,
) -> String {
    format!(
        "tee-income-oracle: bind session\nsession: {session_id}\nwallet: {}\npolicy: {}\nexpires: {expires}",
        bs58::encode(wallet).into_string(),
        hex::encode(policy_hash),
    )
}

/// Verifies `signature_b58` (64-byte Ed25519 signature, base58) by `wallet`
/// over the exact `intent` bytes, with `verify_strict` (rejects small-order
/// keys and non-canonical signatures).
///
/// # Errors
/// [`ApiError::BAD_REQUEST`] for a signature that isn't base58 of 64 bytes
/// or a wallet that isn't a valid key; [`ApiError::BAD_INTENT_SIGNATURE`] if
/// it doesn't verify.
pub fn verify_intent(intent: &str, wallet: &[u8; 32], signature_b58: &str) -> Result<(), ApiError> {
    let signature_bytes: [u8; 64] = bs58::decode(signature_b58)
        .into_vec()
        .ok()
        .and_then(|bytes| bytes.try_into().ok())
        .ok_or(ApiError::BAD_REQUEST)?;
    let key = VerifyingKey::from_bytes(wallet).map_err(|_| ApiError::BAD_REQUEST)?;
    key.verify_strict(intent.as_bytes(), &Signature::from_bytes(&signature_bytes))
        .map_err(|_| ApiError::BAD_INTENT_SIGNATURE)
}
