//! Route handlers (FORMATS §10). Each handler reads its body itself through
//! `read_body`, with a size limit and a time limit (the port is public, so a
//! client that sends a body slowly or never must not hold a task forever),
//! and a malformed, oversized or late body gets the §10 error shape, not
//! axum's plain-text rejection.
//!
//! Path ids are parsed as UUIDs before anything else: a non-UUID can't name
//! a session (404), and only a parsed id ever reaches the log.

use axum::{
    body::{to_bytes, Body, Bytes},
    extract::{DefaultBodyLimit, Path, State},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use http_body_util::LengthLimitError;
use serde::de::DeserializeOwned;
use std::time::Duration;
use tio_core::from_json_object;
use tokio::{sync::OwnedSemaphorePermit, time::timeout};
use uuid::Uuid;

use crate::{
    app::AppState,
    config::decode_pubkey,
    error::ApiError,
    flows::{create_session, evaluate_session},
    log,
    wire::{
        BindRequest, BindResponse, CreateSessionRequest, CreateSessionResponse, EvaluateRequest,
        EvaluateResponse, InfoResponse,
    },
};

pub(crate) fn routes(state: AppState) -> Router {
    // Every handler reads its own body with its own limits (`read_body`).
    Router::new()
        .route("/v1/info", get(info))
        .route("/v1/sessions", post(create))
        .route("/v1/sessions/{id}/bind", post(bind))
        .route("/v1/sessions/{id}/evaluate", post(evaluate))
        .layer(DefaultBodyLimit::disable())
        .with_state(state)
}

async fn info(State(state): State<AppState>) -> Json<InfoResponse> {
    let inner = &state.inner;
    Json(InfoResponse {
        app_version: inner.config.app_version,
        attester_address: inner.config.attester.address_hex(),
        fiu_public_jwk: inner.fiu_public_jwk.clone(),
        fiu_key_signature_hex: inner.fiu_key_signature_hex.clone(),
        pinned_kids: inner.config.pinned.kids(),
    })
}

async fn create(State(state): State<AppState>, body: Body) -> Response {
    let result = run_create(&state, body).await;
    respond(None, "create", result.map(Json))
}

async fn run_create(state: &AppState, body: Body) -> Result<CreateSessionResponse, ApiError> {
    let _in_flight = small_request_slot(state)?;
    let request = read_small::<CreateSessionRequest>(state, body).await?;
    if request.measurement_id == u8::MAX {
        // 255 is never assigned (FORMATS §13).
        return Err(ApiError::BAD_REQUEST);
    }
    create_session(state, &request)
}

async fn bind(State(state): State<AppState>, Path(id): Path<String>, body: Body) -> Response {
    let Some(id) = session_id(&id) else {
        return respond::<Json<BindResponse>>(None, "bind", Err(ApiError::SESSION_NOT_FOUND));
    };
    let result = run_bind(&state, &id, body).await;
    respond(Some(&id), "bind", result.map(Json))
}

async fn run_bind(state: &AppState, id: &str, body: Body) -> Result<BindResponse, ApiError> {
    let _in_flight = small_request_slot(state)?;
    let request = read_small::<BindRequest>(state, body).await?;
    let wallet = decode_pubkey(&request.wallet).ok_or(ApiError::BAD_REQUEST)?;
    let now = state.inner.config.clock.now();
    state
        .inner
        .sessions
        .bind(id, &wallet, &request.signature_b58, now)?;
    Ok(BindResponse { status: "bound" })
}

/// One of the create/bind in-flight slots, held until the request is done
/// (body read and processing), or 503 `too_many_requests` before any byte
/// of the body is read.
fn small_request_slot(state: &AppState) -> Result<OwnedSemaphorePermit, ApiError> {
    state
        .inner
        .small_requests
        .clone()
        .try_acquire_owned()
        .map_err(|_| ApiError::TOO_MANY_REQUESTS)
}

/// The session is taken (and so used up) before the body is read: a request
/// for an unknown, unbound or expired session is refused without buffering
/// up to 8 MiB, and any evaluate call on a bound session consumes it,
/// whatever the body turns out to be.
async fn evaluate(State(state): State<AppState>, Path(id): Path<String>, body: Body) -> Response {
    let Some(id) = session_id(&id) else {
        return respond::<Json<EvaluateResponse>>(
            None,
            "evaluate",
            Err(ApiError::SESSION_NOT_FOUND),
        );
    };
    let result = run_evaluate(&state, &id, body).await;
    respond(Some(&id), "evaluate", result.map(Json))
}

async fn run_evaluate(
    state: &AppState,
    id: &str,
    body: Body,
) -> Result<EvaluateResponse, ApiError> {
    // Held for the whole request (read, wait, run; moved into the blocking
    // task), so at most `max_inflight_evaluate_requests` bodies are in
    // memory. Refused before the session is taken, so a busy server never
    // uses a session up.
    let in_flight = state
        .inner
        .evaluate_requests
        .clone()
        .try_acquire_owned()
        .map_err(|_| ApiError::TOO_MANY_EVALUATIONS)?;
    let now = state.inner.config.clock.now();
    let session = state.inner.sessions.take_bound(id, now)?;
    let limit = state.inner.config.limits.evaluate_body_bytes;
    let (request, fetch_response) = read_evaluate_request(state, body, limit).await?;
    evaluate_session(state, in_flight, session, request, fetch_response).await
}

/// Reads and decodes the evaluate body. The raw body and the base64 text
/// are freed here, so only the decoded fetch response is held while the
/// evaluation waits for a slot.
async fn read_evaluate_request(
    state: &AppState,
    body: Body,
    limit: usize,
) -> Result<(EvaluateRequest, Vec<u8>), ApiError> {
    let bytes = read_body(state, body, limit).await?;
    let mut request: EvaluateRequest = from_json_object(&bytes).ok_or(ApiError::BAD_REQUEST)?;
    drop(bytes);
    let fetch_response_b64 = std::mem::take(&mut request.fetch_response_b64);
    let fetch_response = STANDARD
        .decode(fetch_response_b64)
        .map_err(|_| ApiError::BAD_REQUEST)?;
    Ok((request, fetch_response))
}

/// A create or bind body (≤ `other_body_bytes`) as JSON of `T`; unknown
/// members and anything else that doesn't parse are `bad_request`.
async fn read_small<T: DeserializeOwned>(state: &AppState, body: Body) -> Result<T, ApiError> {
    let limit = state.inner.config.limits.other_body_bytes;
    let bytes = read_body(state, body, limit).await?;
    from_json_object(&bytes).ok_or(ApiError::BAD_REQUEST)
}

/// Reads a whole body within `limit` bytes and `body_read_timeout_secs`:
/// 408 if it doesn't arrive in time, 413 over the limit, 400 for bad framing.
async fn read_body(state: &AppState, body: Body, limit: usize) -> Result<Bytes, ApiError> {
    let secs = state.inner.config.limits.body_read_timeout_secs;
    timeout(Duration::from_secs(secs), to_bytes(body, limit))
        .await
        .map_err(|_| ApiError::BODY_TIMEOUT)?
        .map_err(|error| {
            if is_length_limit(&error) {
                ApiError::BODY_TOO_LARGE
            } else {
                ApiError::BAD_REQUEST
            }
        })
}

/// Whether a body read failed because it passed the limit (axum's
/// documented check), rather than on bad framing.
fn is_length_limit(error: &axum::Error) -> bool {
    let mut source: Option<&(dyn std::error::Error + 'static)> = Some(error);
    while let Some(current) = source {
        if current.is::<LengthLimitError>() {
            return true;
        }
        source = current.source();
    }
    false
}

/// The canonical (lowercase, hyphenated) form of a UUID path id.
fn session_id(raw: &str) -> Option<String> {
    Uuid::parse_str(raw).ok().map(|id| id.to_string())
}

/// Logs the outcome code (never data) and turns the result into a response.
fn respond<T: IntoResponse>(
    session_id: Option<&str>,
    stage: &str,
    result: Result<T, ApiError>,
) -> Response {
    match result {
        Ok(body) => {
            log::event(session_id, stage, "ok");
            body.into_response()
        }
        Err(error) => {
            log::event(session_id, stage, error.code);
            error.into_response()
        }
    }
}
