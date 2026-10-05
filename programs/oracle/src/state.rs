use anchor_lang::prelude::*;

/// Layout version of every oracle account (FORMATS §13). Bump on a layout change.
pub const ACCOUNT_VERSION: u8 = 1;

pub const CONFIG_SEED: &[u8] = b"config";
pub const ENCLAVE_SEED: &[u8] = b"enclave";

/// `measurement_kind` values. They match the payload's `proof_type` (FORMATS §7).
pub const MEASUREMENT_KIND_OYSTER_IMAGE_ID: u8 = 1;
pub const MEASUREMENT_KIND_AWS_PCR0: u8 = 2;

/// Registry settings. One per program, PDA `["config"]`.
#[account]
#[derive(InitSpace)]
pub struct Config {
    pub version: u8,
    pub bump: u8,
    /// Registers and revokes enclave builds (the MVP trust anchor, ARCHITECTURE G5).
    pub admin: Pubkey,
    /// Proposed next admin; becomes `admin` only when that key signs
    /// `accept_admin`, so a typo can't hand the registry to an unusable key.
    pub pending_admin: Option<Pubkey>,
    /// Id the next `register_enclave` assigns. Only ever increases, so an id
    /// is never reused, even after revoke. 255 is never assigned.
    pub next_measurement_id: u8,
}

/// One attested enclave build and its signing key. PDA `["enclave", [measurement_id]]`.
#[account]
#[derive(InitSpace)]
pub struct EnclaveEntry {
    pub version: u8,
    pub bump: u8,
    pub measurement_id: u8,
    pub measurement_kind: u8,
    /// Platform measurement: Oyster image id or AWS PCR0 hash (32 bytes).
    pub measurement: [u8; 32],
    /// Ethereum-style address of the enclave's secp256k1 attester key: what
    /// the secp256k1 precompile recovers from an enclave signature.
    pub attester: [u8; 20],
    /// SHA-256 of the attestation document checked off-chain, so an auditor
    /// can re-verify the build after the enclave is gone.
    pub attestation_doc_hash: [u8; 32],
    pub registered_at: i64,
    /// 0 while active; the revoke time afterwards. The only "active" flag.
    pub revoked_at: i64,
}

impl EnclaveEntry {
    pub fn is_active(&self) -> bool {
        self.revoked_at == 0
    }
}
