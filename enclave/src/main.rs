//! Enclave server entry point: check and load keys, then serve §10.
//!
//! Boot order matters: the startup guard runs before anything else, so an
//! image that pins a test key never serves a request (FORMATS §2).

use std::{path::Path, process::ExitCode, sync::Arc};

use rand_core::OsRng;
use tio_core::FiuSigningKey;
use tio_enclave::{
    attester::Attester,
    clock::SystemClock,
    config::DeploymentIds,
    pinned::load_compiled,
    platform::{ATTESTER_KEY_PATH, LISTEN_PORT},
    router, AppState, EnclaveConfig, Limits,
};
use uuid::Uuid;

#[tokio::main]
async fn main() -> ExitCode {
    match run().await {
        Ok(()) => ExitCode::SUCCESS,
        Err(code) => {
            eprintln!("boot failed: {code}");
            ExitCode::FAILURE
        }
    }
}

async fn run() -> Result<(), String> {
    let state = boot()?;
    eprintln!(
        "attester={} listening on 0.0.0.0:{LISTEN_PORT}",
        state.attester_address()
    );
    let listener = tokio::net::TcpListener::bind(("0.0.0.0", LISTEN_PORT))
        .await
        .map_err(|_| "listen_failed".to_owned())?;
    axum::serve(listener, router(state))
        .await
        .map_err(|_| "serve_failed".to_owned())
}

/// Guard, keys, state. Every error is a stable code (and, for the key
/// file, its path), never key material.
fn boot() -> Result<AppState, String> {
    let pinned = load_compiled().map_err(|e| e.code().to_owned())?;
    let attester = Attester::from_file(Path::new(ATTESTER_KEY_PATH))
        .map_err(|e| format!("attester_key: {e}"))?;
    let fiu_key = FiuSigningKey::generate(Uuid::new_v4().to_string(), &mut OsRng)
        .map_err(|_| "fiu_key_failed".to_owned())?;
    let ids = DeploymentIds::compiled_in().map_err(|_| "bad_config".to_owned())?;
    AppState::new(EnclaveConfig {
        pinned,
        attester,
        fiu_key,
        ids,
        clock: Arc::new(SystemClock),
        limits: Limits::default(),
        app_version: env!("CARGO_PKG_VERSION"),
    })
    .map_err(|_| "state_failed".to_owned())
}
