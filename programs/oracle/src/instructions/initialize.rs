use anchor_lang::prelude::*;

use crate::error::OracleError;
use crate::program::Oracle;
use crate::state::{Config, ACCOUNT_VERSION, CONFIG_SEED};

// Anchor creates `init` accounts before it checks any other constraint, so
// `config` exists briefly before the authority checks fail. That is safe: a
// failed check aborts the whole transaction, creation included.
#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    /// Ties `program_data` to this program. Without it, a caller could pass
    /// the ProgramData of their own program, where they are the authority.
    #[account(
        constraint = program.programdata_address()? == Some(program_data.key())
            @ OracleError::ProgramDataMismatch,
    )]
    pub program: Program<'info, Oracle>,
    #[account(
        constraint = program_data.upgrade_authority_address == Some(authority.key())
            @ OracleError::NotUpgradeAuthority,
    )]
    pub program_data: Account<'info, ProgramData>,
    #[account(init, payer = authority, space = 8 + Config::INIT_SPACE, seeds = [CONFIG_SEED], bump)]
    pub config: Account<'info, Config>,
    pub system_program: Program<'info, System>,
}

pub fn handle_initialize(ctx: Context<Initialize>, admin: Pubkey) -> Result<()> {
    // initialize runs once, and only the admin can propose a successor: a
    // zero admin can never sign, so the registry would be stuck for good.
    require!(admin != Pubkey::default(), OracleError::ZeroAdmin);
    ctx.accounts.config.set_inner(Config {
        version: ACCOUNT_VERSION,
        bump: ctx.bumps.config,
        admin,
        pending_admin: None,
        next_measurement_id: 0,
    });
    Ok(())
}
