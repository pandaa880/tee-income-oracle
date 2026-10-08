use anchor_lang::prelude::*;

use crate::error::OracleError;
use crate::events::EnclaveRevoked;
use crate::state::{Config, EnclaveEntry, CONFIG_SEED, ENCLAVE_SEED};

#[derive(Accounts)]
#[instruction(measurement_id: u8)]
pub struct RevokeEnclave<'info> {
    pub admin: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump, has_one = admin @ OracleError::NotAdmin)]
    pub config: Account<'info, Config>,
    #[account(mut, seeds = [ENCLAVE_SEED, &measurement_id.to_le_bytes()], bump = enclave_entry.bump)]
    pub enclave_entry: Account<'info, EnclaveEntry>,
}

pub fn handle_revoke_enclave(ctx: Context<RevokeEnclave>, measurement_id: u8) -> Result<()> {
    let entry = &mut ctx.accounts.enclave_entry;
    require!(entry.is_active(), OracleError::AlreadyRevoked);
    // revoked_at == 0 means active, so never store 0 here (clock is > 0 on
    // every real cluster; this keeps a revoke from silently not happening).
    // Not covered by a test: no test cluster runs with its clock at 0.
    entry.revoked_at = Clock::get()?.unix_timestamp.max(1);
    emit!(EnclaveRevoked { measurement_id });
    Ok(())
}
