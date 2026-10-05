use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, TransferChecked};
use oracle::attest::{parse_payload, PayloadHeader};
use oracle::sas::{parse_attestation, ATTESTATION_SEED, SAS_PROGRAM_ID};
use oracle::state::{EnclaveEntry, SAS_SIGNER_SEED};

use crate::checks::{check_expiry, check_freshness, is_approved, tier_limit};
use crate::error::PoolError;
use crate::events::Borrowed;
use crate::state::{Loan, Pool, PoolParams, ACCOUNT_VERSION, LOAN_SEED, POOL_SEED, VAULT_SEED};

#[derive(Accounts)]
pub struct Borrow<'info> {
    /// Pays the loan account's rent and the fee; may be a relayer.
    #[account(mut)]
    pub payer: Signer<'info>,
    /// Must sign: the attestation address below is derived from this key, so
    /// a wallet can only ever borrow on its own attestation.
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
    // Created here and closed by `repay`: while it exists the borrower has
    // an open loan, and a second `borrow` fails with "already in use".
    #[account(
        init,
        payer = payer,
        space = 8 + Loan::INIT_SPACE,
        seeds = [LOAN_SEED, pool.key().as_ref(), borrower.key().as_ref()],
        bump,
    )]
    pub loan: Account<'info, Loan>,
    /// CHECK: the SAS attestation of `borrower` under the pool's credential
    /// and schema: the seeds pin the address, and the handler checks owner,
    /// size, discriminator and the stored signer before it trusts a byte.
    #[account(
        seeds = [
            ATTESTATION_SEED,
            pool.credential.as_ref(),
            pool.schema.as_ref(),
            borrower.key().as_ref(),
        ],
        bump,
        seeds::program = SAS_PROGRAM_ID,
    )]
    pub attestation: UncheckedAccount<'info>,
    /// Anchor checks it is an oracle-owned `EnclaveEntry`; the handler
    /// matches its id with the attestation's `measurement_id`.
    pub enclave_entry: Account<'info, EnclaveEntry>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

/// Check order (FORMATS §14): amount, the attestation is the oracle's and
/// still valid, the pool's own rules, the enclave build; then the transfer.
pub fn handle_borrow(ctx: Context<Borrow>, amount: u64) -> Result<()> {
    require!(amount > 0, PoolError::ZeroAmount);
    let now = Clock::get()?.unix_timestamp;
    let payload = checked_payload(ctx.accounts, amount, now)?;
    check_enclave(
        &ctx.accounts.pool.params,
        &ctx.accounts.enclave_entry,
        payload.measurement_id,
    )?;
    pay_out(ctx.accounts, amount)?;

    ctx.accounts.loan.set_inner(Loan {
        version: ACCOUNT_VERSION,
        bump: ctx.bumps.loan,
        tier: payload.tier,
        pool: ctx.accounts.pool.key(),
        borrower: ctx.accounts.borrower.key(),
        rent_payer: ctx.accounts.payer.key(),
        amount,
        borrowed_at: now,
        attestation_issued_at: payload.issued_at,
    });
    emit!(Borrowed {
        pool: ctx.accounts.pool.key(),
        borrower: ctx.accounts.borrower.key(),
        amount,
        tier: payload.tier,
        measurement_id: payload.measurement_id,
        attestation_issued_at: payload.issued_at,
    });
    Ok(())
}

/// Reads the attestation and applies every rule that needs only it and the
/// pool's config. Returns the payload for the enclave checks.
fn checked_payload(accounts: &Borrow, amount: u64, now: i64) -> Result<PayloadHeader> {
    let params = &accounts.pool.params;
    let attestation = accounts.attestation.to_account_info();
    let data = attestation.try_borrow_data()?;
    let stored =
        parse_attestation(attestation.owner, &data).ok_or(PoolError::InvalidAttestation)?;
    // SAS lets anyone create attestations under their own credential, and a
    // credential's authority can add signers. Only the oracle's PDA signs
    // after checking an enclave signature, so only its attestations count.
    require_keys_eq!(
        stored.signer,
        sas_signer_address(),
        PoolError::WrongAttestationSigner
    );
    check_expiry(now, stored.expiry)?;

    let payload = parse_payload(stored.payload);
    let limit = tier_limit(&params.tier_limits, payload.tier)?;
    require!(amount <= limit, PoolError::AmountOverTierLimit);
    // A tier only means something under the policy that produced it.
    require!(
        payload.policy_hash == params.policy_hash,
        PoolError::PolicyMismatch
    );
    check_freshness(params, now, &payload)?;
    Ok(payload)
}

/// The oracle's SAS signer: PDA `["sas_signer"]` of the oracle program.
fn sas_signer_address() -> Pubkey {
    Pubkey::find_program_address(&[SAS_SIGNER_SEED], &oracle::ID).0
}

/// The enclave build behind the attestation must be one this pool approved
/// and one the registry hasn't revoked since. Revoking an entry therefore
/// stops lending on every attestation it produced.
fn check_enclave(params: &PoolParams, entry: &EnclaveEntry, measurement_id: u8) -> Result<()> {
    require!(
        is_approved(&params.approved_measurements, measurement_id),
        PoolError::MeasurementNotApproved
    );
    require!(
        entry.measurement_id == measurement_id,
        PoolError::EnclaveEntryMismatch
    );
    require!(entry.is_active(), PoolError::EnclaveRevoked);
    Ok(())
}

/// Sends `amount` from the vault to the borrower, signed by the pool PDA
/// (the vault's authority).
fn pay_out(accounts: &Borrow, amount: u64) -> Result<()> {
    let pool = &accounts.pool;
    let pool_id = pool.pool_id.to_le_bytes();
    let bump = [pool.bump];
    let signer: &[&[&[u8]]] = &[&[POOL_SEED, pool.admin.as_ref(), &pool_id, &bump]];
    let transfer = TransferChecked {
        from: accounts.vault.to_account_info(),
        mint: accounts.mint.to_account_info(),
        to: accounts.borrower_token.to_account_info(),
        authority: pool.to_account_info(),
    };
    let cpi = CpiContext::new(accounts.token_program.key(), transfer).with_signer(signer);
    token::transfer_checked(cpi, amount, accounts.mint.decimals)
}
