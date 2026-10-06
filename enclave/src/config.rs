//! Deployment ids compiled into the image, so they are part of its
//! measurement: the enclave can't be told to sign for another oracle
//! program, credential or schema.
//!
//! The credential and schema addresses depend only on the admin wallet,
//! names and version (FORMATS §7), so they are the same on every cluster. A
//! test pins these constants to `deployments/*.json`.
//!
//! `measurement_id` is not here: it only exists after the enclave is
//! registered, and registering needs the enclave's attester address. The
//! gateway passes it per session; a wrong id fails on-chain (§13 checks 8
//! and 10).

use tio_core::AttestContext;

pub const ORACLE_PROGRAM_ID: &str = "HZyMtqfwXMbqDUwWe9GVSvfZTaXaJZuKAMtJ1i6xwNG8";
pub const SAS_CREDENTIAL: &str = "F8K44XAxQ66GWjtpnnTidox81YHcr2VN5ogFofFViCP7";
pub const SAS_SCHEMA: &str = "991nZUZr63g1pZJ7VQ8GQWk5fVbP7WsuX7crsY5q8qKV";

/// A base58 id in the constants above is not 32 bytes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
#[error("bad compiled-in deployment id")]
pub struct ConfigError;

/// The three fixed ids of one deployment.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DeploymentIds {
    pub oracle_program_id: [u8; 32],
    pub sas_credential: [u8; 32],
    pub sas_schema: [u8; 32],
}

impl DeploymentIds {
    /// The ids compiled into this build.
    ///
    /// # Errors
    /// [`ConfigError`] if a constant is not base58 of 32 bytes.
    pub fn compiled_in() -> Result<Self, ConfigError> {
        let decode = |b58| decode_pubkey(b58).ok_or(ConfigError);
        Ok(Self {
            oracle_program_id: decode(ORACLE_PROGRAM_ID)?,
            sas_credential: decode(SAS_CREDENTIAL)?,
            sas_schema: decode(SAS_SCHEMA)?,
        })
    }

    /// The §8 context for one session.
    pub fn context(&self, measurement_id: u8) -> AttestContext {
        AttestContext {
            oracle_program_id: self.oracle_program_id,
            sas_credential: self.sas_credential,
            sas_schema: self.sas_schema,
            proof_type: crate::platform::PROOF_TYPE,
            measurement_id,
        }
    }
}

/// Decodes a base58 public key of exactly 32 bytes.
pub fn decode_pubkey(b58: &str) -> Option<[u8; 32]> {
    bs58::decode(b58).into_vec().ok()?.try_into().ok()
}
