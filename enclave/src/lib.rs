//! TEE Income Oracle enclave: the HTTP layer around `tio-core`
//! (`docs/FORMATS.md` §10), run inside an AWS Nitro enclave on Marlin Oyster.
//!
//! Everything trusted that isn't HTTP lives in `tio-core`. This crate adds
//! the session store, the attester key (secp256k1, from Oyster), the wallet
//! intent check, the startup guard and the routes. Only the §10 response
//! fields ever leave: no statement data, no scores.

// The test hook plants arbitrary sessions; a release build (the image) must
// never contain it. Tests run in debug builds.
#[cfg(all(feature = "test-hooks", not(debug_assertions)))]
compile_error!("the test-hooks feature must never reach a release build");

pub mod app;
pub mod attester;
pub mod clock;
pub mod config;
pub mod error;
mod flows;
pub mod guard;
pub mod intent;
pub mod log;
pub mod pinned;
pub mod platform;
mod routes;
pub mod session;
pub mod wire;

pub use app::{router, AppState, EnclaveConfig, Limits};
pub use error::ApiError;
