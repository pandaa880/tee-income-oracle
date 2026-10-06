//! In-memory session store (FORMATS §10, limits).
//!
//! A session holds the per-session Curve25519 key, so it lives only in
//! enclave memory, for at most its TTL, and is removed by the first
//! evaluate, whatever the result: the same bytes can't be evaluated twice
//! (single-use). The cap bounds memory against an untrusted gateway that
//! keeps creating sessions.

use std::{
    collections::HashMap,
    sync::{Mutex, MutexGuard},
};

use tio_core::{FiDataRange, Nonce, Policy, SessionKeyPair};

use crate::{error::ApiError, intent::verify_intent};

/// What the enclave holds for one session.
pub struct SessionState {
    pub key_pair: SessionKeyPair,
    pub nonce: Nonce,
    pub txnid: String,
    pub consent_id: String,
    pub range: FiDataRange,
    pub policy: Policy,
    pub wallet: [u8; 32],
    pub measurement_id: u8,
    /// The exact §9 intent text the wallet must sign.
    pub intent: String,
    /// Unix seconds after which the session is gone (= `intent_expires`).
    pub expires_at: i64,
    pub bound: bool,
}

/// Sessions by id, capped.
pub struct SessionStore {
    sessions: Mutex<HashMap<String, SessionState>>,
    cap: usize,
}

impl SessionStore {
    pub fn new(cap: usize) -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
            cap,
        }
    }

    /// Stores a new session. Expired sessions are swept first.
    ///
    /// # Errors
    /// [`ApiError::TOO_MANY_SESSIONS`] at the cap; [`ApiError::INTERNAL`] if
    /// the id is already taken or the lock is poisoned.
    pub fn insert(&self, id: String, state: SessionState, now: i64) -> Result<(), ApiError> {
        let mut sessions = self.lock()?;
        sessions.retain(|_, s| !is_expired(s, now));
        if sessions.contains_key(&id) {
            return Err(ApiError::INTERNAL);
        }
        if sessions.len() >= self.cap {
            return Err(ApiError::TOO_MANY_SESSIONS);
        }
        sessions.insert(id, state);
        Ok(())
    }

    fn lock(&self) -> Result<MutexGuard<'_, HashMap<String, SessionState>>, ApiError> {
        self.sessions.lock().map_err(|_| ApiError::INTERNAL)
    }

    /// Marks the session bound after checking the wallet and its signature
    /// over the session's intent.
    ///
    /// # Errors
    /// `session_not_found`, `session_expired`, `session_already_bound`,
    /// `bad_request` (other wallet), `bad_intent_signature`.
    pub fn bind(
        &self,
        id: &str,
        wallet: &[u8; 32],
        signature_b58: &str,
        now: i64,
    ) -> Result<(), ApiError> {
        let mut sessions = self.lock()?;
        let state = sessions.get_mut(id).ok_or(ApiError::SESSION_NOT_FOUND)?;
        if is_expired(state, now) {
            return Err(ApiError::SESSION_EXPIRED);
        }
        if state.bound {
            return Err(ApiError::SESSION_ALREADY_BOUND);
        }
        if &state.wallet != wallet {
            return Err(ApiError::BAD_REQUEST);
        }
        verify_intent(&state.intent, wallet, signature_b58)?;
        state.bound = true;
        Ok(())
    }

    /// Removes the session and returns it if it is bound and not expired.
    /// The session is removed in every case where it exists.
    ///
    /// # Errors
    /// `session_not_found`, `session_expired`, `session_not_bound`.
    pub fn take_bound(&self, id: &str, now: i64) -> Result<SessionState, ApiError> {
        let state = self.lock()?.remove(id).ok_or(ApiError::SESSION_NOT_FOUND)?;
        if is_expired(&state, now) {
            return Err(ApiError::SESSION_EXPIRED);
        }
        if !state.bound {
            return Err(ApiError::SESSION_NOT_BOUND);
        }
        Ok(state)
    }

    /// Number of stored sessions (expired ones included until swept).
    pub fn len(&self) -> usize {
        self.lock().map(|sessions| sessions.len()).unwrap_or(0)
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

/// A session is usable while `now < expires_at`.
fn is_expired(state: &SessionState, now: i64) -> bool {
    now >= state.expires_at
}
