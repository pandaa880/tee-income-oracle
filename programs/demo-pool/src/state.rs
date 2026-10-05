use anchor_lang::prelude::*;

/// Layout version of every pool account (FORMATS §14). Bump on a layout change.
pub const ACCOUNT_VERSION: u8 = 1;

pub const POOL_SEED: &[u8] = b"pool";
pub const VAULT_SEED: &[u8] = b"vault";
pub const LOAN_SEED: &[u8] = b"loan";

/// The lender's rules: everything `update_pool` may change.
#[derive(AnchorSerialize, AnchorDeserialize, InitSpace, Clone, Copy, Debug, PartialEq, Eq)]
pub struct PoolParams {
    /// Scoring policy the pool requires (FORMATS §6). A tier means nothing
    /// without the rules that produced it.
    pub policy_hash: [u8; 32],
    /// Largest principal for tier A, B, C, in the mint's base units.
    /// 0 = the pool doesn't lend to that tier.
    pub tier_limits: [u64; 3],
    /// Oldest attestation accepted: `now - issued_at`, seconds.
    pub max_age_secs: u32,
    /// Oldest statement accepted: `issued_at - window_to`, seconds.
    pub max_window_age_secs: u32,
    /// Shortest statement accepted: `window_to - window_from`, seconds.
    pub min_window_secs: u32,
    /// Enclave builds this pool trusts: bit `id` set = registry entry `id`
    /// approved (byte `id / 8`, bit `id % 8`).
    pub approved_measurements: [u8; 32],
}

/// One lender's pool. PDA `["pool", admin, [pool_id]]`.
#[account]
#[derive(InitSpace)]
pub struct Pool {
    pub version: u8,
    pub bump: u8,
    /// Bump of the vault PDA `["vault", pool]`.
    pub vault_bump: u8,
    pub pool_id: u8,
    /// The creator; the only key that may `update_pool`.
    pub admin: Pubkey,
    /// The lent token (classic SPL Token).
    pub mint: Pubkey,
    /// SAS credential and schema whose attestations the pool accepts. They
    /// are seeds of the attestation address, so only attestations under this
    /// credential and schema version can be passed in; `borrow` then checks
    /// that the stored signer is the oracle's.
    pub credential: Pubkey,
    pub schema: Pubkey,
    pub params: PoolParams,
}

/// An open loan. PDA `["loan", pool, borrower]`: one per borrower per pool,
/// closed by `repay`.
#[account]
#[derive(InitSpace)]
pub struct Loan {
    pub version: u8,
    pub bump: u8,
    /// Tier of the attestation the loan was made on (1 = A, 2 = B, 3 = C).
    pub tier: u8,
    pub pool: Pubkey,
    pub borrower: Pubkey,
    /// Who paid this account's rent; `repay` refunds it there.
    pub rent_payer: Pubkey,
    /// Principal, in the mint's base units.
    pub amount: u64,
    pub borrowed_at: i64,
    /// `issued_at` of the attestation used, for audit.
    pub attestation_issued_at: i64,
}
