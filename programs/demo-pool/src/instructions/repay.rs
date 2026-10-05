use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, TransferChecked};

use crate::events::Repaid;
use crate::state::{Loan, Pool, LOAN_SEED, POOL_SEED, VAULT_SEED};

#[derive(Accounts)]
pub struct Repay<'info> {
    pub borrower: Signer<'info>,
    // The seeds repeat what owner + discriminator already prove (this program
    // only ever creates a `Pool` at its PDA); kept as defence in depth.
    #[account(
        seeds = [POOL_SEED, pool.admin.as_ref(), &pool.pool_id.to_le_bytes()],
        bump = pool.bump,
        has_one = mint,
    )]
    pub pool: Account<'info, Pool>,
    pub mint: Account<'info, Mint>,
    #[account(mut, seeds = [VAULT_SEED, pool.key().as_ref()], bump = pool.vault_bump)]
    pub vault: Account<'info, TokenAccount>,
    #[account(mut, token::mint = mint, token::authority = borrower)]
    pub borrower_token: Account<'info, TokenAccount>,
    #[account(
        mut,
        close = rent_payer,
        seeds = [LOAN_SEED, pool.key().as_ref(), borrower.key().as_ref()],
        bump = loan.bump,
        has_one = rent_payer,
    )]
    pub loan: Account<'info, Loan>,
    /// CHECK: receives the loan account's rent; `has_one` pins it to the
    /// account that paid it at `borrow`.
    #[account(mut)]
    pub rent_payer: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
}

/// Returns the principal to the vault. Anchor then closes the loan account
/// (`close = rent_payer`), which lets the borrower borrow again.
pub fn handle_repay(ctx: Context<Repay>) -> Result<()> {
    let amount = ctx.accounts.loan.amount;
    let transfer = TransferChecked {
        from: ctx.accounts.borrower_token.to_account_info(),
        mint: ctx.accounts.mint.to_account_info(),
        to: ctx.accounts.vault.to_account_info(),
        authority: ctx.accounts.borrower.to_account_info(),
    };
    let cpi = CpiContext::new(ctx.accounts.token_program.key(), transfer);
    token::transfer_checked(cpi, amount, ctx.accounts.mint.decimals)?;
    emit!(Repaid {
        pool: ctx.accounts.pool.key(),
        borrower: ctx.accounts.borrower.key(),
        amount,
    });
    Ok(())
}
