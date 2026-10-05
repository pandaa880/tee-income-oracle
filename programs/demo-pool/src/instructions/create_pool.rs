use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, Token, TokenAccount};

use crate::checks::check_params;
use crate::events::PoolCreated;
use crate::state::{Pool, PoolParams, ACCOUNT_VERSION, POOL_SEED, VAULT_SEED};

#[derive(Accounts)]
#[instruction(pool_id: u8)]
pub struct CreatePool<'info> {
    /// Pays for both accounts and becomes the pool's admin.
    #[account(mut)]
    pub admin: Signer<'info>,
    // The admin is a seed, so nobody can take another lender's pool address.
    #[account(
        init,
        payer = admin,
        space = 8 + Pool::INIT_SPACE,
        seeds = [POOL_SEED, admin.key().as_ref(), &pool_id.to_le_bytes()],
        bump,
    )]
    pub pool: Account<'info, Pool>,
    pub mint: Account<'info, Mint>,
    /// The pool's token account. Its authority is the pool PDA, so only this
    /// program can move tokens out, and only through `borrow`.
    #[account(
        init,
        payer = admin,
        seeds = [VAULT_SEED, pool.key().as_ref()],
        bump,
        token::mint = mint,
        token::authority = pool,
    )]
    pub vault: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

pub fn handle_create_pool(
    ctx: Context<CreatePool>,
    pool_id: u8,
    credential: Pubkey,
    schema: Pubkey,
    params: PoolParams,
) -> Result<()> {
    check_params(&params)?;
    let pool = Pool {
        version: ACCOUNT_VERSION,
        bump: ctx.bumps.pool,
        vault_bump: ctx.bumps.vault,
        pool_id,
        admin: ctx.accounts.admin.key(),
        mint: ctx.accounts.mint.key(),
        // Not checked to be real SAS accounts: `borrow` derives the
        // attestation address from them, and only SAS can own that address.
        // A wrong value gives a pool that never lends.
        credential,
        schema,
        params,
    };
    emit!(PoolCreated {
        pool: ctx.accounts.pool.key(),
        admin: pool.admin,
        pool_id,
        mint: pool.mint,
        credential,
        schema,
        params,
    });
    ctx.accounts.pool.set_inner(pool);
    Ok(())
}
