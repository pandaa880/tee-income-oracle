//! Attestation payload and signed message (`docs/FORMATS.md` §7, §8).
//!
//! The payload is the 83 bytes an attestation commits to; the message wraps
//! it with the deployment's ids, the wallet and an expiry. Both are fixed
//! layouts, little-endian, built by hand so a second implementation (the
//! TypeScript generator) can be compared byte for byte.
//!
//! Signing is not here: the enclave binary holds the Oyster key and signs
//! the message (step 4). The on-chain secp256k1 precompile keccak256-hashes
//! the message it is given, so the layout below is exactly what it hashes.

use crate::policy::{PolicyHash, Tier};

/// Length of the §7 payload.
pub const PAYLOAD_LEN: usize = 83;

/// Length of the §8 signed message.
pub const MESSAGE_LEN: usize = 232;

/// Domain separation: a signature over this message can't be replayed as a
/// signature over any other kind of message.
pub const DOMAIN_TAG: &[u8; 13] = b"TIO-ATTEST-v1";

/// Which kind of proof backs the attestation. Append-only: values are
/// written on-chain. 2 = `tee_nitro_aws` is reserved and not built.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum ProofType {
    /// AWS Nitro enclave run on Marlin Oyster.
    TeeNitroOyster = 1,
}

/// Fixed per deployment (enclave configuration).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AttestContext {
    pub oracle_program_id: [u8; 32],
    pub sas_credential: [u8; 32],
    pub sas_schema: [u8; 32],
    pub proof_type: ProofType,
    pub measurement_id: u8,
}

/// The fields of the §7 payload.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PayloadFields {
    /// `Tier` has no reject variant, so a reject can never be written: the
    /// type rules it out, not a runtime check.
    pub tier: Tier,
    pub proof_type: ProofType,
    pub measurement_id: u8,
    pub policy_hash: PolicyHash,
    pub consent_hash: [u8; 32],
    pub issued_at: i64,
    pub window_from: u32,
    pub window_to: u32,
}

/// Writes `parts` back to back into a fixed-size array. Callers pass parts
/// that add up to exactly `N`; a mismatch would leave zeros rather than
/// panic (the unit tests pin the lengths).
fn assemble<const N: usize>(parts: &[&[u8]]) -> [u8; N] {
    let mut out = [0u8; N];
    let mut rest = out.as_mut_slice();
    for part in parts {
        let Some((head, tail)) = std::mem::take(&mut rest).split_at_mut_checked(part.len()) else {
            break;
        };
        head.copy_from_slice(part);
        rest = tail;
    }
    out
}

fn tier_byte(tier: Tier) -> u8 {
    match tier {
        Tier::A => 1,
        Tier::B => 2,
        Tier::C => 3,
    }
}

/// Builds the §7 payload: tier, proof type, measurement id, policy hash,
/// consent hash, `issued_at` (i64 LE), window from / to (u32 LE).
pub fn build_payload(fields: &PayloadFields) -> [u8; PAYLOAD_LEN] {
    assemble(&[
        &[tier_byte(fields.tier)],
        &[fields.proof_type as u8],
        &[fields.measurement_id],
        fields.policy_hash.as_bytes(),
        &fields.consent_hash,
        &fields.issued_at.to_le_bytes(),
        &fields.window_from.to_le_bytes(),
        &fields.window_to.to_le_bytes(),
    ])
}

/// Builds the §8 message: domain tag, oracle program, SAS credential, SAS
/// schema, wallet, payload, expiry (i64 LE).
pub fn build_message(
    ctx: &AttestContext,
    wallet: &[u8; 32],
    payload: &[u8; PAYLOAD_LEN],
    expiry: i64,
) -> [u8; MESSAGE_LEN] {
    assemble(&[
        DOMAIN_TAG,
        &ctx.oracle_program_id,
        &ctx.sas_credential,
        &ctx.sas_schema,
        wallet,
        payload,
        &expiry.to_le_bytes(),
    ])
}

#[cfg(test)]
mod tests;
