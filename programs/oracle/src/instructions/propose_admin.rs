use anchor_lang::prelude::*;

use crate::error::OracleError;
use crate::events::AdminProposed;
use crate::state::{Config, CONFIG_SEED};

#[derive(Accounts)]
pub struct ProposeAdmin<'info> {
    pub admin: Signer<'info>,
    #[account(
        mut,
        seeds = [CONFIG_SEED],
        bump = config.bump,
        has_one = admin @ OracleError::NotAdmin,
    )]
    pub config: Account<'info, Config>,
}

/// Name the next admin. Replaces any earlier proposal; nothing changes
/// until that key signs `accept_admin`.
pub fn handle_propose_admin(ctx: Context<ProposeAdmin>, new_admin: Pubkey) -> Result<()> {
    require!(new_admin != Pubkey::default(), OracleError::ZeroAdmin);
    ctx.accounts.config.pending_admin = Some(new_admin);
    emit!(AdminProposed {
        admin: ctx.accounts.admin.key(),
        pending_admin: new_admin,
    });
    Ok(())
}
