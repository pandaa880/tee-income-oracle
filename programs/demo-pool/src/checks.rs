//! The pool's lending rules as pure functions: no accounts, no clock, so
//! every rule and boundary is unit-tested on its own. `borrow` calls them in
//! the order of `docs/FORMATS.md` §14.

use oracle::attest::PayloadHeader;

use crate::error::PoolError;
use crate::state::PoolParams;

/// Rules a pool config must satisfy: tier A is lendable and no tier may
/// borrow more than a better one. Catches a config typed in the wrong order.
pub fn check_params(params: &PoolParams) -> Result<(), PoolError> {
    let [a, b, c] = params.tier_limits;
    if a > 0 && a >= b && b >= c {
        Ok(())
    } else {
        Err(PoolError::InvalidTierLimits)
    }
}

/// The pool's limit for `tier` (1 = A, 2 = B, 3 = C). A limit of 0, or a
/// tier byte outside 1..=3, means the pool doesn't lend on it.
pub fn tier_limit(tier_limits: &[u64; 3], tier: u8) -> Result<u64, PoolError> {
    let [a, b, c] = *tier_limits;
    let limit = match tier {
        1 => a,
        2 => b,
        3 => c,
        _ => 0,
    };
    if limit == 0 {
        return Err(PoolError::TierNotAccepted);
    }
    Ok(limit)
}

/// Whether the pool approved registry entry `measurement_id`: bit `id` of
/// the bitmap, byte `id / 8`, counted from the least significant bit.
pub fn is_approved(approved: &[u8; 32], measurement_id: u8) -> bool {
    // 256 ids fill the 32 bytes exactly, so the byte is always there.
    approved
        .get(usize::from(measurement_id / 8))
        .is_some_and(|byte| (byte >> (measurement_id % 8)) & 1 == 1)
}

/// SAS expiry: valid strictly before `expiry`, the rule SAS's own verifiers
/// use. SAS reads 0 as "never expires"; the oracle never writes 0 (it sets
/// `issued_at + 30 days`), so a 0 here is rejected rather than trusted.
pub fn check_expiry(now: i64, expiry: i64) -> Result<(), PoolError> {
    if expiry != 0 && now < expiry {
        Ok(())
    } else {
        Err(PoolError::AttestationExpired)
    }
}

/// The pool's own freshness limits, in order: attestation age, statement
/// age, statement length. They stop a borrower from reusing an old result
/// or one scored on an old or short statement. Arithmetic that overflows
/// fails the rule (fail closed).
pub fn check_freshness(
    params: &PoolParams,
    now: i64,
    payload: &PayloadHeader,
) -> Result<(), PoolError> {
    // An `issued_at` slightly ahead of the cluster clock gives a negative
    // age and passes: the oracle already bounded that skew (FORMATS §8).
    let age = now.checked_sub(payload.issued_at);
    if age.is_none_or(|age| age > i64::from(params.max_age_secs)) {
        return Err(PoolError::AttestationTooOld);
    }
    let window_age = payload.issued_at.checked_sub(i64::from(payload.window_to));
    if window_age.is_none_or(|age| age > i64::from(params.max_window_age_secs)) {
        return Err(PoolError::WindowTooOld);
    }
    // A window that ends before it starts has no length: `None`, rejected.
    let window_len = payload.window_to.checked_sub(payload.window_from);
    if window_len.is_none_or(|len| len < params.min_window_secs) {
        return Err(PoolError::WindowTooShort);
    }
    Ok(())
}

#[cfg(test)]
mod tests;
