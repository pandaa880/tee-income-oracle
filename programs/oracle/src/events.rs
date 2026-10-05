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
