use anchor_lang::prelude::*;

#[error_code]
pub enum PoolError {
    #[msg("signer is not the pool admin")]
    NotAdmin,
    #[msg("tier limits must satisfy A > 0 and A >= B >= C")]
    InvalidTierLimits,
    #[msg("borrow amount is zero")]
    ZeroAmount,
    #[msg("attestation account is not a SAS attestation of the expected size")]
    InvalidAttestation,
    #[msg("attestation was not written by the oracle's SAS signer")]
    WrongAttestationSigner,
    #[msg("attestation has expired")]
    AttestationExpired,
    #[msg("pool does not lend to the attestation's tier")]
    TierNotAccepted,
    #[msg("amount is above the pool's limit for the attestation's tier")]
    AmountOverTierLimit,
    #[msg("attestation was scored under a different policy than the pool requires")]
    PolicyMismatch,
    #[msg("attestation is older than the pool accepts")]
    AttestationTooOld,
    #[msg("statement window ended longer ago than the pool accepts")]
    WindowTooOld,
    #[msg("statement window is shorter than the pool requires")]
    WindowTooShort,
    #[msg("pool has not approved the enclave build that produced the attestation")]
    MeasurementNotApproved,
    #[msg("enclave entry is not the one named in the attestation")]
    EnclaveEntryMismatch,
    #[msg("enclave build that produced the attestation is revoked")]
    EnclaveRevoked,
}
