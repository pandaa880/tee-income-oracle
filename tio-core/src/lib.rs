//! Trusted core of TEE Income Oracle.
//!
//! Pure functions, no I/O: no network, files, clock or randomness of its own.
//! The enclave binary injects all of those. Everything that touches secret
//! keys or plaintext bank data lives here, so it stays small and auditable.
//!
//! Wire formats: `docs/FORMATS.md`. Security model: `docs/ARCHITECTURE.md`.

pub mod cipher;
pub mod ecdh;
mod encoding;
pub mod jws;
pub mod key_material;
pub mod time;

pub use cipher::{decrypt, derive_session_key, DecryptError, Nonce, SessionKey};
pub use ecdh::{KeyError, KeyMode, PeerPublicKey, PublicKey, SessionKeyPair, SharedSecret};
pub use jws::{verify_compact, verify_detached, FiuSigningKey, JwsError, PinnedKey};
pub use key_material::{DhPublicKey, KeyMaterial, KeyMaterialError};

/// Stable, machine-readable error code for the enclave's HTTP layer
/// (`docs/FORMATS.md` §10). Codes never contain payload data.
pub trait ErrorCode {
    /// The stable code string, e.g. `"decrypt_failed"`.
    fn code(&self) -> &'static str;
}
