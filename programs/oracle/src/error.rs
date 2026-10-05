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
    #[msg("instruction before this one is not a secp256k1 precompile instruction")]
    PrecompileNotFound,
    #[msg("secp256k1 precompile data is not the fixed single-signature layout")]
    InvalidPrecompileLayout,
    #[msg("signed message does not start with the TIO-ATTEST-v1 domain tag")]
    WrongDomainTag,
    #[msg("signed message names a different oracle program")]
    WrongProgramId,
    #[msg("credential account is not the one in the signed message")]
    CredentialMismatch,
    #[msg("schema account is not the one in the signed message")]
    SchemaMismatch,
    #[msg("attestation account is not the SAS PDA for credential, schema and wallet")]
    AttestationAddressMismatch,
    #[msg("enclave entry is not the one named by the payload's measurement_id")]
    EnclaveEntryMismatch,
    #[msg("enclave entry is revoked")]
    EnclaveRevoked,
    #[msg("signature was not made by the enclave entry's attester key")]
    AttesterMismatch,
    #[msg("payload proof_type does not match the entry's measurement_kind")]
    ProofTypeMismatch,
    #[msg("payload tier must be 1 (A), 2 (B) or 3 (C)")]
    InvalidTier,
    #[msg("payload issued_at is too far in the future")]
    IssuedInFuture,
    #[msg("signed expiry has passed")]
    SignatureExpired,
    #[msg("signed expiry is not within the allowed lifetime after issued_at")]
    ExpiryTooFar,
    #[msg("attestation is not newer than the stored one")]
    StaleAttestation,
    #[msg("account at the attestation address is not a SAS attestation")]
    InvalidExistingAttestation,
}
