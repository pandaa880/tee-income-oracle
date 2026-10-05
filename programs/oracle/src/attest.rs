//! Byte layouts `submit_attestation` reads: the secp256k1 precompile
//! instruction data, the enclave's signed message (`docs/FORMATS.md` §8) and
//! the payload header (§7). Pure functions, no accounts, so every rule is
//! unit-tested on its own.

use anchor_lang::prelude::Pubkey;

use crate::error::OracleError;

/// Domain tag that starts every signed message (§8, §0.1).
pub const DOMAIN_TAG: &[u8; 13] = b"TIO-ATTEST-v1";
/// Length of the §7 payload.
pub const PAYLOAD_LEN: usize = 83;
/// Length of the §8 signed message.
pub const MESSAGE_LEN: usize = 232;

/// Fixed layout of the precompile instruction data (one signature):
/// `count ‖ offsets(11) ‖ eth address(20) ‖ r‖s(64) ‖ recovery id(1) ‖ message(232)`.
pub const PRECOMPILE_DATA_LEN: usize = 329;
pub const OFFSETS_LEN: usize = 11;
pub const ETH_ADDRESS_OFFSET: u16 = 12;
pub const SIGNATURE_OFFSET: u16 = 32;
pub const MESSAGE_OFFSET: u16 = 97;

/// Tolerance for the enclave clock running ahead of the Solana clock.
pub const MAX_SKEW_SECS: i64 = 300;
/// Longest a signature may stay submittable after `issued_at`.
pub const MAX_SIGNATURE_LIFETIME_SECS: i64 = 600;
/// SAS `expiry` the oracle writes: `issued_at` + 30 days.
pub const ATTESTATION_TTL_SECS: i64 = 30 * 86_400;

/// What the precompile verified: the recovered signer and the signed bytes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct VerifiedSignature<'a> {
    pub attester: &'a [u8; 20],
    pub message: &'a [u8; MESSAGE_LEN],
}

/// The §8 message, split into its fields.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SignedMessage<'a> {
    pub program_id: Pubkey,
    pub credential: Pubkey,
    pub schema: Pubkey,
    pub wallet: Pubkey,
    pub payload: &'a [u8; PAYLOAD_LEN],
    pub expiry: i64,
}

/// The §7 payload fields the oracle checks. The rest is copied to SAS as is.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PayloadHeader {
    pub tier: u8,
    pub proof_type: u8,
    pub measurement_id: u8,
    pub issued_at: i64,
}

// The §8 field sizes add up to the message length, so `take` below never
// runs out of bytes on a `[u8; MESSAGE_LEN]`.
const _: () = assert!(13 + 32 + 32 + 32 + 32 + PAYLOAD_LEN + 8 == MESSAGE_LEN);
const _: () = assert!(MESSAGE_OFFSET as usize + MESSAGE_LEN == PRECOMPILE_DATA_LEN);
/// `MESSAGE_LEN` as the precompile's u16 message-size field.
const MESSAGE_LEN_U16: u16 = 232;
const _: () = assert!(MESSAGE_LEN_U16 as usize == MESSAGE_LEN);

/// The 11 offset bytes a well-formed precompile instruction at
/// `precompile_index` must carry: signature, address and message offsets,
/// each with its instruction index set to the precompile itself.
pub fn expected_offsets(precompile_index: u8) -> [u8; OFFSETS_LEN] {
    let [sig_lo, sig_hi] = SIGNATURE_OFFSET.to_le_bytes();
    let [eth_lo, eth_hi] = ETH_ADDRESS_OFFSET.to_le_bytes();
    let [msg_lo, msg_hi] = MESSAGE_OFFSET.to_le_bytes();
    let [len_lo, len_hi] = MESSAGE_LEN_U16.to_le_bytes();
    #[rustfmt::skip]
    let offsets = [
        sig_lo, sig_hi, precompile_index,
        eth_lo, eth_hi, precompile_index,
        msg_lo, msg_hi, len_lo, len_hi, precompile_index,
    ];
    offsets
}

/// Checks the precompile data is exactly the fixed layout, with all three
/// instruction-index fields pointing at `precompile_index` itself, and
/// returns the address and message the precompile verified.
///
/// The secp256k1 precompile's index fields are absolute: any of them may name
/// another instruction, and the precompile then verifies bytes this program
/// never reads. Comparing the whole offsets block with the one expected for
/// this index rules that out, and pins where the address and message sit.
pub fn parse_precompile(
    data: &[u8],
    precompile_index: u8,
) -> Result<VerifiedSignature<'_>, OracleError> {
    let layout_ok = data.len() == PRECOMPILE_DATA_LEN
        && data.first() == Some(&1)
        && data.get(1..1 + OFFSETS_LEN) == Some(expected_offsets(precompile_index).as_slice());
    if !layout_ok {
        return Err(OracleError::InvalidPrecompileLayout);
    }
    let attester = array_at(data, ETH_ADDRESS_OFFSET as usize);
    let message = array_at(data, MESSAGE_OFFSET as usize);
    match (attester, message) {
        (Some(attester), Some(message)) => Ok(VerifiedSignature { attester, message }),
        _ => Err(OracleError::InvalidPrecompileLayout),
    }
}

/// Splits the §8 message; rejects a wrong domain tag.
pub fn parse_message(message: &[u8; MESSAGE_LEN]) -> Result<SignedMessage<'_>, OracleError> {
    let mut rest = message.as_slice();
    let tag: &[u8; 13] = take(&mut rest)?;
    if tag != DOMAIN_TAG {
        return Err(OracleError::WrongDomainTag);
    }
    Ok(SignedMessage {
        program_id: Pubkey::new_from_array(*take(&mut rest)?),
        credential: Pubkey::new_from_array(*take(&mut rest)?),
        schema: Pubkey::new_from_array(*take(&mut rest)?),
        wallet: Pubkey::new_from_array(*take(&mut rest)?),
        payload: take(&mut rest)?,
        expiry: i64::from_le_bytes(*take(&mut rest)?),
    })
}

/// Reads tier, proof type, measurement id and `issued_at` from the payload.
pub fn parse_payload(payload: &[u8; PAYLOAD_LEN]) -> PayloadHeader {
    // Irrefutable patterns on the fixed-size array: the payload starts with
    // the three one-byte fields and ends with `issued_at` (8), `window_from`
    // (4) and `window_to` (4), §7.
    let [tier, proof_type, measurement_id, ..] = *payload;
    #[rustfmt::skip]
    let [.., i0, i1, i2, i3, i4, i5, i6, i7, _, _, _, _, _, _, _, _] = *payload;
    PayloadHeader {
        tier,
        proof_type,
        measurement_id,
        issued_at: i64::from_le_bytes([i0, i1, i2, i3, i4, i5, i6, i7]),
    }
}

/// Tier must be 1 (A), 2 (B) or 3 (C). SAS checks only the data length, so
/// this is the last place a malformed tier byte can be stopped.
pub fn check_tier(tier: u8) -> Result<(), OracleError> {
    match tier {
        1..=3 => Ok(()),
        _ => Err(OracleError::InvalidTier),
    }
}

/// Clock rules, in order: `issued_at <= now + MAX_SKEW_SECS`,
/// `now <= expiry`, `0 < expiry - issued_at <= MAX_SIGNATURE_LIFETIME_SECS`.
///
/// The enclave's clock comes from its host, which is untrusted. Together the
/// rules keep a signature from being used more than `MAX_SKEW_SECS` before or
/// `MAX_SIGNATURE_LIFETIME_SECS` after the time it claims.
pub fn check_times(now: i64, issued_at: i64, expiry: i64) -> Result<(), OracleError> {
    if issued_at > now.saturating_add(MAX_SKEW_SECS) {
        return Err(OracleError::IssuedInFuture);
    }
    if now > expiry {
        return Err(OracleError::SignatureExpired);
    }
    match expiry.checked_sub(issued_at) {
        Some(lifetime) if lifetime > 0 && lifetime <= MAX_SIGNATURE_LIFETIME_SECS => Ok(()),
        _ => Err(OracleError::ExpiryTooFar),
    }
}

/// SAS `expiry` for an attestation issued at `issued_at`. Overflow means an
/// absurd `issued_at`, reported as `IssuedInFuture`.
pub fn sas_expiry(issued_at: i64) -> Result<i64, OracleError> {
    issued_at
        .checked_add(ATTESTATION_TTL_SECS)
        .ok_or(OracleError::IssuedInFuture)
}

/// The `N` bytes at `offset`, or `None` if `data` is too short.
fn array_at<const N: usize>(data: &[u8], offset: usize) -> Option<&[u8; N]> {
    data.get(offset..offset.checked_add(N)?)?.try_into().ok()
}

/// Takes the next `N` bytes of `rest`. Only used on the fixed §8 layout, so
/// running out can't happen (const assert above); it would read as a bad tag.
fn take<'a, const N: usize>(rest: &mut &'a [u8]) -> Result<&'a [u8; N], OracleError> {
    let (head, tail) = rest
        .split_first_chunk::<N>()
        .ok_or(OracleError::WrongDomainTag)?;
    *rest = tail;
    Ok(head)
}

#[cfg(test)]
mod tests;
