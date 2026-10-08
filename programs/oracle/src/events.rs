use anchor_lang::prelude::*;

/// Public record of a registration, so anyone can re-run the verifier on it.
#[event]
pub struct EnclaveRegistered {
    pub measurement_id: u8,
    pub measurement_kind: u8,
    pub measurement: [u8; 32],
    pub attester: [u8; 20],
    pub attestation_doc_hash: [u8; 32],
}

#[event]
pub struct EnclaveRevoked {
    pub measurement_id: u8,
}

/// The admin proposed a new admin (who must still accept).
#[event]
pub struct AdminProposed {
    pub admin: Pubkey,
    pub pending_admin: Pubkey,
}

/// An enclave result was written to SAS for `subject` (the SAS nonce).
#[event]
pub struct AttestationSubmitted {
    pub subject: Pubkey,
    pub measurement_id: u8,
    pub tier: u8,
    pub issued_at: i64,
    /// True when an older attestation for the same wallet was replaced.
    pub refreshed: bool,
}

/// The pending admin accepted and is now the admin.
#[event]
pub struct AdminChanged {
    pub old_admin: Pubkey,
    pub new_admin: Pubkey,
}
