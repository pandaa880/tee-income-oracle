use anchor_lang::prelude::*;

#[error_code]
pub enum OracleError {
    #[msg("signer is not the program's upgrade authority")]
    NotUpgradeAuthority,
    #[msg("signer is not the registry admin")]
    NotAdmin,
    #[msg("measurement_kind must be 1 (Oyster image id) or 2 (AWS PCR0 hash)")]
    UnknownMeasurementKind,
    #[msg("measurement is all zeros")]
    ZeroMeasurement,
    #[msg("attester address is all zeros")]
    ZeroAttester,
    #[msg("registry is full: all 255 measurement ids are used")]
    RegistryFull,
    #[msg("enclave entry is already revoked")]
    AlreadyRevoked,
    #[msg("program_data is not this program's ProgramData account")]
    ProgramDataMismatch,
    #[msg("admin is the all-zero address")]
    ZeroAdmin,
    #[msg("attestation document hash is all zeros")]
    ZeroAttestationDocHash,
    #[msg("signer is not the pending admin")]
    NotPendingAdmin,
}
