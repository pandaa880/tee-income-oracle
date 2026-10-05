use anchor_lang::prelude::*;

pub mod checks;
pub mod error;
pub mod events;
pub mod instructions;
pub mod state;

use instructions::*;
use state::PoolParams;

declare_id!("DvDkXcQFJAvCvrMfoujKu2BWfWqVYRmL8WW9hpMgW8KC");

/// A minimal lending pool that lends on the oracle's SAS attestation, read
/// inside its own instruction (no CPI). Built to show how a lender checks
/// the attestation, not as a real protocol. Layouts and check order:
/// `docs/FORMATS.md` §14.
#[program]
pub mod demo_pool {
    use super::*;

    /// Create a pool and its token vault. Anyone can; the signer becomes the
    /// pool's admin, and `pool_id` lets one admin run several pools.
    pub fn create_pool(
        ctx: Context<CreatePool>,
        pool_id: u8,
        credential: Pubkey,
        schema: Pubkey,
        params: PoolParams,
    ) -> Result<()> {
        handle_create_pool(ctx, pool_id, credential, schema, params)
    }

    /// Replace the pool's lending rules. The mint, credential and schema
    /// never change.
    pub fn update_pool(ctx: Context<UpdatePool>, params: PoolParams) -> Result<()> {
        handle_update_pool(ctx, params)
    }

    /// Lend `amount` to the signing borrower if their attestation passes
    /// every check of this pool. One open loan per borrower.
    pub fn borrow(ctx: Context<Borrow>, amount: u64) -> Result<()> {
        handle_borrow(ctx, amount)
    }

    /// Pay the principal back and close the loan.
    pub fn repay(ctx: Context<Repay>) -> Result<()> {
        handle_repay(ctx)
    }
}
