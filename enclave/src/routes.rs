//! Route handlers (FORMATS §10). Each handler parses its body itself, so a
//! malformed body, an unknown member or an oversized body gets the §10
//! error shape, not axum's plain-text rejection.
//!
//! Path ids are parsed as UUIDs before anything else: a non-UUID can't name
//! a session (404), and only a parsed id ever reaches the log.

use axum::{
    body::{to_bytes, Body, Bytes},
    extract::{rejection::BytesRejection, DefaultBodyLimit, Path, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use http_body_util::LengthLimitError;
use serde::de::DeserializeOwned;
use std::time::Duration;
use tokio::time::timeout;
use uuid::Uuid;

use crate::{
    app::AppState,
    config::decode_pubkey,
    error::ApiError,
    flows::{create_session, evaluate_session},
    log,
    wire::{
        BindRequest, BindResponse, CreateSessionRequest, EvaluateRequest, EvaluateResponse,
        InfoResponse,
    },
};

pub(crate) fn routes(state: AppState) -> Router {
    let small = DefaultBodyLimit::max(state.inner.config.limits.other_body_bytes);
    Router::new()
        .route("/v1/info", get(info))
        .route("/v1/sessions", post(create).layer(small))
        .route("/v1/sessions/{id}/bind", post(bind).layer(small))
        // Evaluate reads its body itself, after the session lookup, with its
        // own limit (see `evaluate`).
        .route(
            "/v1/sessions/{id}/evaluate",
            post(evaluate).layer(DefaultBodyLimit::disable()),
        )
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

async fn create(State(state): State<AppState>, body: Result<Bytes, BytesRejection>) -> Response {
    let result = parse::<CreateSessionRequest>(body).and_then(|request| {
        if request.measurement_id == u8::MAX {
            // 255 is never assigned (FORMATS §13).
            return Err(ApiError::BAD_REQUEST);
        }
        create_session(&state, &request)
    });
    respond(None, "create", result.map(Json))
}

async fn bind(
    State(state): State<AppState>,
    Path(id): Path<String>,
    body: Result<Bytes, BytesRejection>,
) -> Response {
    let Some(id) = session_id(&id) else {
        return respond::<Json<BindResponse>>(None, "bind", Err(ApiError::SESSION_NOT_FOUND));
    };
    let result = parse::<BindRequest>(body).and_then(|request| {
        let wallet = decode_pubkey(&request.wallet).ok_or(ApiError::BAD_REQUEST)?;
        let now = state.inner.config.clock.now();
        state
            .inner
            .sessions
            .bind(&id, &wallet, &request.signature_b58, now)?;
        Ok(Json(BindResponse { status: "bound" }))
    });
    respond(Some(&id), "bind", result)
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
    let limits = state.inner.config.limits;
    let (request, fetch_response) = timeout(
        Duration::from_secs(limits.body_read_timeout_secs),
        read_evaluate_request(body, limits.evaluate_body_bytes),
    )
    .await
    .map_err(|_| ApiError::BODY_TIMEOUT)??;
    evaluate_session(state, in_flight, session, request, fetch_response).await
}

/// Reads and decodes the evaluate body. The raw body and the base64 text
/// are freed here, so only the decoded fetch response is held while the
/// evaluation waits for a slot.
async fn read_evaluate_request(
    body: Body,
    limit: usize,
) -> Result<(EvaluateRequest, Vec<u8>), ApiError> {
    let bytes = to_bytes(body, limit).await.map_err(|error| {
        if is_length_limit(&error) {
            ApiError::BODY_TOO_LARGE
        } else {
            ApiError::BAD_REQUEST
        }
    })?;
    let mut request: EvaluateRequest =
        serde_json::from_slice(&bytes).map_err(|_| ApiError::BAD_REQUEST)?;
    drop(bytes);
    let fetch_response_b64 = std::mem::take(&mut request.fetch_response_b64);
    let fetch_response = STANDARD
        .decode(fetch_response_b64)
        .map_err(|_| ApiError::BAD_REQUEST)?;
    Ok((request, fetch_response))
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

/// The body as JSON of `T`: 413 over the route's limit, 400 for anything
/// else that doesn't parse (including unknown members).
fn parse<T: DeserializeOwned>(body: Result<Bytes, BytesRejection>) -> Result<T, ApiError> {
    let bytes = body.map_err(|rejection| {
        if rejection.status() == StatusCode::PAYLOAD_TOO_LARGE {
            ApiError::BODY_TOO_LARGE
        } else {
            ApiError::BAD_REQUEST
        }
    })?;
    serde_json::from_slice(&bytes).map_err(|_| ApiError::BAD_REQUEST)
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
