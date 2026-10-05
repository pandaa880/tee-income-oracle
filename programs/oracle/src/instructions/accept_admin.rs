use anchor_lang::prelude::*;

use crate::error::OracleError;
use crate::events::AdminChanged;
use crate::state::{Config, CONFIG_SEED};

#[derive(Accounts)]
pub struct AcceptAdmin<'info> {
    pub new_admin: Signer<'info>,
    #[account(
        mut,
        seeds = [CONFIG_SEED],
        bump = config.bump,
        constraint = config.pending_admin == Some(new_admin.key()) @ OracleError::NotPendingAdmin,
    )]
    pub config: Account<'info, Config>,
}

/// The proposed admin takes over. Requiring its signature proves someone
/// controls the new key before the old one loses the registry.
pub fn handle_accept_admin(ctx: Context<AcceptAdmin>) -> Result<()> {
    let config = &mut ctx.accounts.config;
    let old_admin = config.admin;
    config.admin = ctx.accounts.new_admin.key();
    config.pending_admin = None;
    emit!(AdminChanged {
        old_admin,
        new_admin: config.admin,
    });
    Ok(())
}
