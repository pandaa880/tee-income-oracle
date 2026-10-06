//! Application state and router.

use std::sync::Arc;

use axum::Router;
use serde_json::value::RawValue;
use tio_core::FiuSigningKey;
use tokio::sync::Semaphore;

use crate::{
    attester::{fiu_binding_message, Attester},
    clock::Clock,
    config::DeploymentIds,
    pinned::Pinned,
    session::SessionStore,
};

/// Request and session limits (FORMATS §10).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Limits {
    pub max_sessions: usize,
    pub session_ttl_secs: i64,
    pub max_concurrent_evaluations: usize,
    /// Evaluate requests in flight (reading, waiting or running). Taking a
    /// session frees its place under `max_sessions`, so this is what bounds
    /// the memory held by evaluate bodies.
    pub max_inflight_evaluate_requests: usize,
    /// Time allowed to receive an evaluate body.
    pub body_read_timeout_secs: u64,
    pub evaluate_body_bytes: usize,
    pub other_body_bytes: usize,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            max_sessions: 256,
            session_ttl_secs: 600,
            max_concurrent_evaluations: 2,
            max_inflight_evaluate_requests: 4,
            body_read_timeout_secs: 30,
            evaluate_body_bytes: 8 * 1024 * 1024,
            other_body_bytes: 64 * 1024,
        }
    }
}

/// Everything the server needs, built at boot (or by a test).
pub struct EnclaveConfig {
    pub pinned: Pinned,
    pub attester: Attester,
    pub fiu_key: FiuSigningKey,
    pub ids: DeploymentIds,
    pub clock: Arc<dyn Clock>,
    pub limits: Limits,
    pub app_version: &'static str,
}

/// Boot failed after the keys were loaded.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
#[error("enclave state could not be built")]
pub struct StateError;

/// Shared server state.
#[derive(Clone)]
pub struct AppState {
    pub(crate) inner: Arc<Inner>,
}

pub(crate) struct Inner {
    pub(crate) config: EnclaveConfig,
    pub(crate) sessions: SessionStore,
    /// Bounds evaluations running at once (memory and the one vCPU).
    pub(crate) evaluations: Arc<Semaphore>,
    /// Bounds evaluate requests in flight (see `Limits`).
    pub(crate) evaluate_requests: Arc<Semaphore>,
    /// JCS bytes of the FIU public JWK (`e`, `kid`, `kty`, `n`).
    pub(crate) fiu_public_jwk: Box<RawValue>,
    /// §8.1 binding signature, hex.
    pub(crate) fiu_key_signature_hex: String,
}

impl AppState {
    /// Builds the state: computes the FIU public JWK and its §8.1 binding
    /// signature once.
    ///
    /// # Errors
    /// [`StateError`] if the JWK can't be encoded or signing fails.
    pub fn new(config: EnclaveConfig) -> Result<Self, StateError> {
        let jwk = config.fiu_key.public_jwk_jcs().map_err(|_| StateError)?;
        let signature = config
            .attester
            .sign(&fiu_binding_message(&jwk))
            .map_err(|_| StateError)?;
        let fiu_public_jwk = String::from_utf8(jwk)
            .ok()
            .and_then(|jwk| RawValue::from_string(jwk).ok())
            .ok_or(StateError)?;
        Ok(Self {
            inner: Arc::new(Inner {
                sessions: SessionStore::new(config.limits.max_sessions),
                evaluations: Arc::new(Semaphore::new(config.limits.max_concurrent_evaluations)),
                evaluate_requests: Arc::new(Semaphore::new(
                    config.limits.max_inflight_evaluate_requests,
                )),
                fiu_public_jwk,
                fiu_key_signature_hex: hex::encode(signature),
                config,
            }),
        })
    }

    /// The attester's `0x` address (public; logged at boot).
    pub fn attester_address(&self) -> String {
        self.inner.config.attester.address_hex()
    }

    /// Test hook: free evaluation slots.
    #[cfg(feature = "test-hooks")]
    pub fn available_evaluation_slots(&self) -> usize {
        self.inner.evaluations.available_permits()
    }

    /// Test hook: stores a prepared session under a fixed id (vector
    /// sessions use the test enclave key). Not compiled into the image.
    ///
    /// # Errors
    /// As [`SessionStore::insert`].
    #[cfg(feature = "test-hooks")]
    pub fn plant_session(
        &self,
        id: &str,
        state: crate::session::SessionState,
    ) -> Result<(), crate::ApiError> {
        let now = self.inner.config.clock.now();
        self.inner.sessions.insert(id.to_owned(), state, now)
    }
}

/// The §10 routes with their body limits.
pub fn router(state: AppState) -> Router {
    crate::routes::routes(state)
}
