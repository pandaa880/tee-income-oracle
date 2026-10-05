use anchor_lang::prelude::*;

use crate::error::OracleError;
use crate::events::EnclaveRegistered;
use crate::state::{
    Config, EnclaveEntry, ACCOUNT_VERSION, CONFIG_SEED, ENCLAVE_SEED, MEASUREMENT_KIND_AWS_PCR0,
    MEASUREMENT_KIND_OYSTER_IMAGE_ID,
};

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct RegisterEnclaveArgs {
    pub measurement_kind: u8,
    pub measurement: [u8; 32],
    pub attester: [u8; 20],
    pub attestation_doc_hash: [u8; 32],
}

#[derive(Accounts)]
pub struct RegisterEnclave<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(
        mut,
        seeds = [CONFIG_SEED],
        bump = config.bump,
        has_one = admin @ OracleError::NotAdmin,
    )]
    pub config: Account<'info, Config>,
    // The entry address is keyed by the next id, so an id can only ever be
    // created once: revoked ids are never reassigned.
    #[account(
        init,
        payer = admin,
        space = 8 + EnclaveEntry::INIT_SPACE,
        seeds = [ENCLAVE_SEED, &config.next_measurement_id.to_le_bytes()],
        bump,
    )]
    pub enclave_entry: Account<'info, EnclaveEntry>,
    pub system_program: Program<'info, System>,
}

pub fn handle_register_enclave(
    ctx: Context<RegisterEnclave>,
    args: RegisterEnclaveArgs,
) -> Result<()> {
    require!(
        matches!(
            args.measurement_kind,
            MEASUREMENT_KIND_OYSTER_IMAGE_ID | MEASUREMENT_KIND_AWS_PCR0
        ),
        OracleError::UnknownMeasurementKind
    );
    require!(args.measurement != [0; 32], OracleError::ZeroMeasurement);
    // A zero address is what a failed secp256k1 recovery looks like; never trust it.
    require!(args.attester != [0; 20], OracleError::ZeroAttester);
    // The hash is the audit anchor: an auditor re-verifies the build from it.
    require!(
        args.attestation_doc_hash != [0; 32],
        OracleError::ZeroAttestationDocHash
    );

    let config = &mut ctx.accounts.config;
    let measurement_id = config.next_measurement_id;
    // Id 255 is never assigned: incrementing past it fails instead of wrapping.
    config.next_measurement_id = measurement_id
        .checked_add(1)
        .ok_or(OracleError::RegistryFull)?;

    ctx.accounts.enclave_entry.set_inner(EnclaveEntry {
        version: ACCOUNT_VERSION,
        bump: ctx.bumps.enclave_entry,
        measurement_id,
        measurement_kind: args.measurement_kind,
        measurement: args.measurement,
        attester: args.attester,
        attestation_doc_hash: args.attestation_doc_hash,
        registered_at: Clock::get()?.unix_timestamp,
        revoked_at: 0,
    });
    emit!(EnclaveRegistered {
        measurement_id,
        measurement_kind: args.measurement_kind,
        measurement: args.measurement,
        attester: args.attester,
        attestation_doc_hash: args.attestation_doc_hash,
    });
    Ok(())
}
