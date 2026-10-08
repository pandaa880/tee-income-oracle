use anchor_lang::prelude::*;

use crate::state::PoolParams;

#[event]
pub struct PoolCreated {
    pub pool: Pubkey,
    pub admin: Pubkey,
    pub pool_id: u8,
    pub mint: Pubkey,
    pub credential: Pubkey,
    pub schema: Pubkey,
    pub params: PoolParams,
}

/// The admin replaced the pool's lending rules.
#[event]
pub struct PoolUpdated {
    pub pool: Pubkey,
    pub params: PoolParams,
}

#[event]
pub struct Borrowed {
    pub pool: Pubkey,
    pub borrower: Pubkey,
    pub amount: u64,
    pub tier: u8,
    pub measurement_id: u8,
    pub attestation_issued_at: i64,
}

#[event]
pub struct Repaid {
    pub pool: Pubkey,
    pub borrower: Pubkey,
    pub amount: u64,
}
