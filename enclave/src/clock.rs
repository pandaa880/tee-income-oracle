//! The enclave's clock. It comes from the untrusted host (Oyster has no
//! trusted time source), so every on-chain use re-checks it: the oracle
//! bounds `issued_at` and `expiry` against the Solana clock (FORMATS §8).

use std::{
    sync::atomic::{AtomicI64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};

/// Current unix time in seconds.
pub trait Clock: Send + Sync {
    fn now(&self) -> i64;
}

/// The system clock.
pub struct SystemClock;

impl Clock for SystemClock {
    /// A clock before 1970 or past `i64` reads as 0, which fails closed:
    /// every consent and window check then rejects.
    fn now(&self) -> i64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .ok()
            .and_then(|elapsed| i64::try_from(elapsed.as_secs()).ok())
            .unwrap_or(0)
    }
}

/// A clock tests set by hand.
pub struct ManualClock(AtomicI64);

impl ManualClock {
    pub fn new(now: i64) -> Self {
        Self(AtomicI64::new(now))
    }

    pub fn set(&self, now: i64) {
        self.0.store(now, Ordering::SeqCst);
    }
}

impl Clock for ManualClock {
    fn now(&self) -> i64 {
        self.0.load(Ordering::SeqCst)
    }
}
