use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::Instruction;
use anchor_lang::solana_program::program::invoke_signed;
use solana_instructions_sysvar::{load_current_index_checked, load_instruction_at_checked};

use crate::attest::{
    check_tier, check_times, parse_message, parse_payload, parse_precompile, sas_expiry,
    PayloadHeader, SignedMessage,
};
use crate::error::OracleError;
use crate::events::AttestationSubmitted;
use crate::sas::{
    attestation_address, close_attestation_ix, create_attestation_ix, stored_issued_at,
    SasAccounts, EVENT_AUTHORITY_SEED, SAS_PROGRAM_ID,
};
use crate::state::{EnclaveEntry, SAS_SIGNER_SEED};

#[derive(Accounts)]
pub struct SubmitAttestation<'info> {
    /// Relayer: pays the attestation rent and receives the old rent on refresh.
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: PDA with no data; signs the SAS CPI as the credential's only
    /// authorized signer.
    #[account(seeds = [SAS_SIGNER_SEED], bump)]
    pub sas_signer: UncheckedAccount<'info>,
    /// CHECK: must equal the credential in the signed message (handler); SAS
    /// checks it is a credential that lists `sas_signer`.
    pub credential: UncheckedAccount<'info>,
    /// CHECK: must equal the schema in the signed message (handler); SAS
    /// checks it belongs to `credential`.
    pub schema: UncheckedAccount<'info>,
    /// CHECK: handler compares it with the SAS PDA for (credential, schema,
    /// wallet) before reading or writing it.
    #[account(mut)]
    pub attestation: UncheckedAccount<'info>,
    /// Anchor checks owner and discriminator; the handler matches its id
    /// with the payload's `measurement_id`.
    pub enclave_entry: Account<'info, EnclaveEntry>,
    /// CHECK: pinned to the instructions sysvar, so introspection can't read
    /// a fake instruction list.
    #[account(address = solana_sdk_ids::sysvar::instructions::ID)]
    pub instructions: UncheckedAccount<'info>,
    /// CHECK: SAS event authority PDA, needed by SAS close (self-CPI event).
    #[account(seeds = [EVENT_AUTHORITY_SEED], bump, seeds::program = sas_program.key())]
    pub sas_event_authority: UncheckedAccount<'info>,
    /// CHECK: pinned to the SAS program id.
    #[account(address = SAS_PROGRAM_ID)]
    pub sas_program: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

/// Check order (FORMATS §13): precompile, message tag, message ↔ accounts,
/// registry entry, tier, clock, existing attestation; then the SAS writes.
pub fn handle_submit_attestation(ctx: Context<SubmitAttestation>) -> Result<()> {
    let (precompile_index, precompile_data) = load_precompile(&ctx.accounts.instructions)?;
    let verified = parse_precompile(&precompile_data, precompile_index)?;
    let message = parse_message(verified.message)?;
    check_accounts(ctx.accounts, &message)?;
    let header = parse_payload(message.payload);
    check_entry(&ctx.accounts.enclave_entry, &header, verified.attester)?;
    check_tier(header.tier)?;
    check_times(
        Clock::get()?.unix_timestamp,
        header.issued_at,
        message.expiry,
    )?;

    let signer_seeds: &[&[u8]] = &[SAS_SIGNER_SEED, &[ctx.bumps.sas_signer]];
    let refreshed = close_older(ctx.accounts, header.issued_at, signer_seeds)?;
    let create = create_attestation_ix(
        &sas_accounts(ctx.accounts),
        &message.wallet,
        message.payload,
        sas_expiry(header.issued_at)?,
    );
    invoke_sas(ctx.accounts, &create, signer_seeds)?;

    emit!(AttestationSubmitted {
        subject: message.wallet,
        measurement_id: header.measurement_id,
        tier: header.tier,
        issued_at: header.issued_at,
        refreshed,
    });
    Ok(())
}

/// The instruction right before this one must be the secp256k1 precompile.
/// A fixed position (not a scan) keeps one precompile from backing several
/// top-level `submit_attestation`s. Replay itself is stopped by the strictly
/// increasing `issued_at` (`close_older`), which also covers a wrapper
/// program that CPIs twice. Returns its index and data.
fn load_precompile(sysvar: &AccountInfo) -> Result<(u8, Vec<u8>)> {
    let current = load_current_index_checked(sysvar)?;
    let index = current
        .checked_sub(1)
        .ok_or(OracleError::PrecompileNotFound)?;
    let precompile = load_instruction_at_checked(usize::from(index), sysvar)?;
    require!(
        precompile.program_id == solana_sdk_ids::secp256k1_program::ID,
        OracleError::PrecompileNotFound
    );
    // The precompile's index fields are one byte, so a precompile beyond
    // index 255 can't point at itself.
    let index = u8::try_from(index).map_err(|_| OracleError::InvalidPrecompileLayout)?;
    Ok((index, precompile.data))
}

/// The signed message names this program, the credential, the schema and
/// the wallet; the accounts passed must be exactly those.
fn check_accounts(accounts: &SubmitAttestation, message: &SignedMessage) -> Result<()> {
    require_keys_eq!(message.program_id, crate::ID, OracleError::WrongProgramId);
    require_keys_eq!(
        accounts.credential.key(),
        message.credential,
        OracleError::CredentialMismatch
    );
    require_keys_eq!(
        accounts.schema.key(),
        message.schema,
        OracleError::SchemaMismatch
    );
    // Checked before the account is read: another wallet's attestation must
    // never decide whether this one is stale.
    require_keys_eq!(
        accounts.attestation.key(),
        attestation_address(&message.credential, &message.schema, &message.wallet),
        OracleError::AttestationAddressMismatch
    );
    Ok(())
}

/// The payload's registry entry is active, holds the key that signed, and
/// is of the payload's proof type.
fn check_entry(entry: &EnclaveEntry, header: &PayloadHeader, attester: &[u8; 20]) -> Result<()> {
    require!(
        entry.measurement_id == header.measurement_id,
        OracleError::EnclaveEntryMismatch
    );
    require!(entry.is_active(), OracleError::EnclaveRevoked);
    require!(entry.attester == *attester, OracleError::AttesterMismatch);
    require!(
        entry.measurement_kind == header.proof_type,
        OracleError::ProofTypeMismatch
    );
    Ok(())
}

/// Closes the wallet's existing attestation if there is one, after checking
/// the new one is strictly newer. Without that, a still-valid older
/// signature (or a replay of the same one) could replace a newer tier.
/// Returns whether one was closed.
fn close_older(
    accounts: &SubmitAttestation,
    issued_at: i64,
    signer_seeds: &[&[u8]],
) -> Result<bool> {
    let attestation = accounts.attestation.to_account_info();
    // Empty (even if someone sent lamports to it): nothing to replace, and
    // SAS creates the account over the lamports.
    if attestation.data_is_empty() {
        return Ok(false);
    }
    let stored = stored_issued_at(attestation.owner, &attestation.try_borrow_data()?)?;
    require!(issued_at > stored, OracleError::StaleAttestation);
    let close = close_attestation_ix(&sas_accounts(accounts));
    invoke_sas(accounts, &close, signer_seeds)?;
    Ok(true)
}

/// SAS accounts for both instructions. `payer` is this instruction's payer:
/// SAS refunds a closed attestation's rent to whatever account is passed.
fn sas_accounts(accounts: &SubmitAttestation) -> SasAccounts {
    SasAccounts {
        payer: accounts.payer.key(),
        authority: accounts.sas_signer.key(),
        credential: accounts.credential.key(),
        schema: accounts.schema.key(),
        attestation: accounts.attestation.key(),
        event_authority: accounts.sas_event_authority.key(),
    }
}

/// Calls SAS, signing as `sas_signer`.
fn invoke_sas(
    accounts: &SubmitAttestation,
    ix: &Instruction,
    signer_seeds: &[&[u8]],
) -> Result<()> {
    invoke_signed(
        ix,
        &[
            accounts.payer.to_account_info(),
            accounts.sas_signer.to_account_info(),
            accounts.credential.to_account_info(),
            accounts.schema.to_account_info(),
            accounts.attestation.to_account_info(),
            accounts.sas_event_authority.to_account_info(),
            accounts.system_program.to_account_info(),
            accounts.sas_program.to_account_info(),
        ],
        &[signer_seeds],
    )?;
    Ok(())
}
