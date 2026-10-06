//! Trusted core of TEE Income Oracle.
//!
//! Pure functions, no I/O: no network, files, clock or randomness of its own.
//! The enclave binary injects all of those. Everything that touches secret
//! keys or plaintext bank data lives here, so it stays small and auditable.
//!
//! Wire formats: `docs/FORMATS.md`. Security model: `docs/ARCHITECTURE.md`.

pub mod attest;
pub mod cipher;
pub mod ecdh;
mod encoding;
pub mod evaluate;
pub mod fi_request;
pub mod jws;
pub mod key_material;
pub mod money;
pub mod policy;
pub mod rebit;
pub mod score;
pub mod time;

pub use attest::{
    build_message, build_payload, AttestContext, PayloadFields, ProofType, MESSAGE_LEN, PAYLOAD_LEN,
};
pub use cipher::{decrypt, derive_session_key, DecryptError, Nonce, SessionKey};
pub use ecdh::{KeyError, KeyMode, PeerPublicKey, PublicKey, SessionKeyPair, SharedSecret};
pub use evaluate::{
    consent_ref, evaluate, Attestation, Clock, ConsentRef, EvaluateError, EvaluateInput,
    Evaluation, FiDataRange, PinnedKeys, RangeError, Session,
};
pub use fi_request::{build_fi_request, FiRequest, FiRequestError, REBIT_VERSION};
pub use jws::{verify_compact, verify_detached, FiuSigningKey, JwsError, PinnedKey};
pub use key_material::{DhPublicKey, KeyMaterial, KeyMaterialError};
pub use money::{parse_paise, MoneyError, Paise, Sign};
pub use policy::{Policy, PolicyError, PolicyHash, Tier, MAX_POLICY_BYTES};
pub use rebit::{parse_deposit_fi, DepositFi, FiError, Txn};
pub use score::{score, Features, Outcome, ScoreError, Scores};
pub use time::{parse_date, parse_rebit_timestamp, TimeError};

/// Stable, machine-readable error code for the enclave's HTTP layer
/// (`docs/FORMATS.md` §10). Codes never contain payload data.
pub trait ErrorCode {
    /// The stable code string, e.g. `"decrypt_failed"`.
    fn code(&self) -> &'static str;
}
