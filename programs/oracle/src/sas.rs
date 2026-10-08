//! Solana Attestation Service (SAS) instructions and account layout, built by
//! hand. The published Rust client pins solana-program 2.x, whose types don't
//! mix with Anchor 1.2's; the wire format is small and fixed. Source: SAS at
//! commit `12582e23d4`, which matches the devnet binary in
//! `test-fixtures/sas/` (create and close are unchanged in SAS 2.0).

use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};

use crate::attest::{parse_payload, ISSUED_AT_OFFSET, PAYLOAD_LEN};
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
/// Where the payload's `issued_at` (i64 LE) sits inside the account.
pub const STORED_ISSUED_AT_OFFSET: usize = ATTESTATION_DATA_OFFSET + ISSUED_AT_OFFSET;

/// The credential signer that wrote the attestation follows the payload.
pub const ATTESTATION_SIGNER_OFFSET: usize = ATTESTATION_DATA_OFFSET + PAYLOAD_LEN;
/// SAS `expiry` (i64 LE) follows the signer.
pub const ATTESTATION_EXPIRY_OFFSET: usize = ATTESTATION_SIGNER_OFFSET + 32;
// payload ‖ signer ‖ expiry ‖ token account fill the account exactly.
const _: () = assert!(ATTESTATION_EXPIRY_OFFSET + 8 + 32 == ATTESTATION_ACCOUNT_LEN);

/// What a reader needs from one of our stored attestations (FORMATS §7).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct StoredAttestation<'a> {
    pub payload: &'a [u8; PAYLOAD_LEN],
    /// The credential signer SAS recorded. Ours is always the oracle's
    /// `sas_signer` PDA; a reader that lends on the result must check it.
    pub signer: Pubkey,
    /// Unix seconds; SAS treats 0 as "never expires".
    pub expiry: i64,
}

/// Splits `data` into the fields of one of our attestations, or `None` if
/// the account isn't one: SAS must own it, and it must have our size and
/// SAS's attestation discriminator.
pub fn parse_attestation<'a>(owner: &Pubkey, data: &'a [u8]) -> Option<StoredAttestation<'a>> {
    // Anyone can send lamports to an attestation address, and only SAS can
    // give it data. Owner, size and discriminator together say SAS wrote it
    // as one of our attestations.
    let is_ours = *owner == SAS_PROGRAM_ID
        && data.len() == ATTESTATION_ACCOUNT_LEN
        && data.first() == Some(&ATTESTATION_DISCRIMINATOR);
    if !is_ours {
        return None;
    }
    let fields = data.get(ATTESTATION_DATA_OFFSET..)?;
    let (payload, fields) = fields.split_first_chunk::<PAYLOAD_LEN>()?;
    let (signer, fields) = fields.split_first_chunk::<32>()?;
    let (expiry, _token_account) = fields.split_first_chunk::<8>()?;
    Some(StoredAttestation {
        payload,
        signer: Pubkey::new_from_array(*signer),
        expiry: i64::from_le_bytes(*expiry),
    })
}

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
/// is one of our SAS attestations.
pub fn stored_issued_at(owner: &Pubkey, data: &[u8]) -> Result<i64> {
    let stored = parse_attestation(owner, data).ok_or(OracleError::InvalidExistingAttestation)?;
    Ok(parse_payload(stored.payload).issued_at)
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
