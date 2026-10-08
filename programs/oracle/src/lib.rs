use anchor_lang::prelude::*;

pub mod attest;
pub mod error;
pub mod events;
pub mod instructions;
pub mod sas;
pub mod state;

use instructions::*;

declare_id!("HZyMtqfwXMbqDUwWe9GVSvfZTaXaJZuKAMtJ1i6xwNG8");

/// The on-chain trust anchor: a registry of attested enclave builds.
/// Account layouts: `docs/FORMATS.md` §13.
#[program]
pub mod oracle {
    use super::*;

    /// Create the registry config. Only the program's upgrade authority may
    /// call it, so nobody can front-run deployment and make themselves admin.
    pub fn initialize(ctx: Context<Initialize>, admin: Pubkey) -> Result<()> {
        handle_initialize(ctx, admin)
    }

    /// Register an enclave build checked off-chain; assigns the next id.
    pub fn register_enclave(
        ctx: Context<RegisterEnclave>,
        args: RegisterEnclaveArgs,
    ) -> Result<()> {
        handle_register_enclave(ctx, args)
    }

    /// Revoke an entry for good. Its id is never reassigned.
    pub fn revoke_enclave(ctx: Context<RevokeEnclave>, measurement_id: u8) -> Result<()> {
        handle_revoke_enclave(ctx, measurement_id)
    }

    /// Step 1 of an admin change: the admin names the next admin.
    pub fn propose_admin(ctx: Context<ProposeAdmin>, new_admin: Pubkey) -> Result<()> {
        handle_propose_admin(ctx, new_admin)
    }

    /// Step 2: the proposed admin signs to take over. Two steps, so the
    /// registry can't be handed to a key nobody controls.
    pub fn accept_admin(ctx: Context<AcceptAdmin>) -> Result<()> {
        handle_accept_admin(ctx)
    }

    /// Write an enclave result to SAS. Anyone can relay it: the transaction
    /// must carry the enclave's signature in a secp256k1 precompile
    /// instruction right before this one, and the signer must be an active
    /// registry entry (FORMATS §8, §13). Replaces an older attestation for
    /// the same wallet.
    pub fn submit_attestation(ctx: Context<SubmitAttestation>) -> Result<()> {
        handle_submit_attestation(ctx)
    }
}
