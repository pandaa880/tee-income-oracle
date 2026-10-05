use anchor_lang::prelude::*;

use crate::checks::check_params;
use crate::error::PoolError;
use crate::events::PoolUpdated;
use crate::state::{Pool, PoolParams, POOL_SEED};

#[derive(Accounts)]
pub struct UpdatePool<'info> {
    pub admin: Signer<'info>,
    // The seeds repeat what owner + discriminator already prove (this program
    // only ever creates a `Pool` at its PDA); kept as defence in depth.
    #[account(
        mut,
        seeds = [POOL_SEED, pool.admin.as_ref(), &pool.pool_id.to_le_bytes()],
        bump = pool.bump,
        has_one = admin @ PoolError::NotAdmin,
    )]
    pub pool: Account<'info, Pool>,
}

pub fn handle_update_pool(ctx: Context<UpdatePool>, params: PoolParams) -> Result<()> {
    check_params(&params)?;
    ctx.accounts.pool.params = params;
    emit!(PoolUpdated {
        pool: ctx.accounts.pool.key(),
        params,
    });
    Ok(())
}
