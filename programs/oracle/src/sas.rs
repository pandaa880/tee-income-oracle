//! Solana Attestation Service (SAS) instructions and account layout, built by
//! hand. The published Rust client pins solana-program 2.x, whose types don't
//! mix with Anchor 1.2's; the wire format is small and fixed. Source: SAS at
//! commit `12582e23d4`, which matches the devnet binary in
//! `test-fixtures/sas/` (create and close are unchanged in SAS 2.0).

use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};

use crate::attest::PAYLOAD_LEN;
use crate::error::OracleError;

pub const SAS_PROGRAM_ID: Pubkey = pubkey!("22zoJMtdu4tQc2PzL74ZUT7FrwgB1Udec8DdW4yw4BdG");
pub const ATTESTATION_SEED: &[u8] = b"attestation";
pub const EVENT_AUTHORITY_SEED: &[u8] = b"__event_authority";

/// `PAYLOAD_LEN` as SAS's u32 data-length prefix.
const PAYLOAD_LEN_U32: u32 = 83;
const _: () = assert!(PAYLOAD_LEN_U32 as usize == PAYLOAD_LEN);

const CREATE_ATTESTATION: u8 = 6;
const CLOSE_ATTESTATION: u8 = 7;

/// SAS account discriminator (first byte) of an `Attestation`.
pub const ATTESTATION_DISCRIMINATOR: u8 = 2;
/// Our attestation account: discriminator, nonce, credential, schema,
/// data length (u32) + 83-byte payload, signer, expiry, token account.
pub const ATTESTATION_ACCOUNT_LEN: usize = 256;
/// Where the payload starts inside the account.
pub const ATTESTATION_DATA_OFFSET: usize = 1 + 32 + 32 + 32 + 4;
/// `issued_at` (i64 LE) is at payload offset 67 (FORMATS §7).
pub const STORED_ISSUED_AT_OFFSET: usize = ATTESTATION_DATA_OFFSET + 67;

/// SAS address of the attestation for (`credential`, `schema`, `nonce`).
pub fn attestation_address(credential: &Pubkey, schema: &Pubkey, nonce: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(
        &[
            ATTESTATION_SEED,
            credential.as_ref(),
            schema.as_ref(),
            nonce.as_ref(),
        ],
        &SAS_PROGRAM_ID,
    )
    .0
}

/// `issued_at` of an existing attestation account, after checking it really
/// is a SAS attestation of our size.
pub fn stored_issued_at(owner: &Pubkey, data: &[u8]) -> Result<i64> {
    // The address is already checked to be the SAS PDA, but anyone can send
    // lamports to it, and only SAS can give it data. Owner, size and
    // discriminator together say SAS wrote it as one of our attestations.
    let is_ours = *owner == SAS_PROGRAM_ID
        && data.len() == ATTESTATION_ACCOUNT_LEN
        && data.first() == Some(&ATTESTATION_DISCRIMINATOR);
    let issued_at = data
        .get(STORED_ISSUED_AT_OFFSET..STORED_ISSUED_AT_OFFSET + 8)
        .and_then(|bytes| <[u8; 8]>::try_from(bytes).ok());
    match (is_ours, issued_at) {
        (true, Some(bytes)) => Ok(i64::from_le_bytes(bytes)),
        _ => err!(OracleError::InvalidExistingAttestation),
    }
}

/// Accounts both SAS instructions take, in the roles SAS names them.
pub struct SasAccounts {
    pub payer: Pubkey,
    pub authority: Pubkey,
    pub credential: Pubkey,
    pub schema: Pubkey,
    pub attestation: Pubkey,
    pub event_authority: Pubkey,
}

/// `CreateAttestation`: `[6] ‖ nonce ‖ u32 len ‖ data ‖ i64 expiry`.
pub fn create_attestation_ix(
    accounts: &SasAccounts,
    nonce: &Pubkey,
    data: &[u8; PAYLOAD_LEN],
    expiry: i64,
) -> Instruction {
    let mut ix_data = Vec::with_capacity(1 + 32 + 4 + PAYLOAD_LEN + 8);
    ix_data.push(CREATE_ATTESTATION);
    ix_data.extend_from_slice(nonce.as_ref());
    ix_data.extend_from_slice(&PAYLOAD_LEN_U32.to_le_bytes());
    ix_data.extend_from_slice(data);
    ix_data.extend_from_slice(&expiry.to_le_bytes());
    Instruction {
        program_id: SAS_PROGRAM_ID,
        accounts: vec![
            AccountMeta::new(accounts.payer, true),
            AccountMeta::new_readonly(accounts.authority, true),
            AccountMeta::new_readonly(accounts.credential, false),
            AccountMeta::new_readonly(accounts.schema, false),
            AccountMeta::new(accounts.attestation, false),
            AccountMeta::new_readonly(system_program::ID, false),
        ],
        data: ix_data,
    }
}

/// `CloseAttestation`: `[7]`. SAS sends the rent to the `payer` account
/// without checking who it is, so the caller must pass its own payer.
pub fn close_attestation_ix(accounts: &SasAccounts) -> Instruction {
    Instruction {
        program_id: SAS_PROGRAM_ID,
        accounts: vec![
            AccountMeta::new(accounts.payer, false),
            AccountMeta::new_readonly(accounts.authority, true),
            AccountMeta::new_readonly(accounts.credential, false),
            AccountMeta::new(accounts.attestation, false),
            AccountMeta::new_readonly(accounts.event_authority, false),
            AccountMeta::new_readonly(system_program::ID, false),
            AccountMeta::new_readonly(SAS_PROGRAM_ID, false),
        ],
        data: vec![CLOSE_ATTESTATION],
    }
}
