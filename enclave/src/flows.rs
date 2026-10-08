//! The two flows with real work: create a session (key exchange material +
//! the FIU-signed FI request) and evaluate it (`tio_core::evaluate`, then
//! the attester signature).

use base64::{engine::general_purpose::STANDARD, Engine as _};
use rand_core::OsRng;
use tio_core::{
    build_fi_request, consent_ref, evaluate, Clock as EvalClock, ConsentRef, ErrorCode,
    EvaluateInput, FiDataRange, FiRequest, KeyMaterial, KeyMode, Nonce, Outcome, PinnedKeys,
    Policy, Session, SessionKeyPair, Tier,
};
use tokio::sync::OwnedSemaphorePermit;
use uuid::Uuid;

use crate::{
    app::AppState,
    config::decode_pubkey,
    error::ApiError,
    intent::build_intent,
    session::SessionState,
    wire::{CreateSessionRequest, CreateSessionResponse, EvaluateRequest, EvaluateResponse},
};

const DAY: i64 = 86_400;

/// Requested statement window: the 365 days before today's 00:00 UTC.
const REQUEST_WINDOW_DAYS: i64 = 365;

/// `KeyMaterial.DHPublicKey.expiry`: now + 24 h (tio-core `KeyMaterial::new`).
const KEY_MATERIAL_TTL_SECS: i64 = DAY;

/// §8 message expiry: now + 600 s, the oracle's maximum signature lifetime.
const SIGNATURE_LIFETIME_SECS: i64 = 600;

/// `POST /v1/sessions`: everything the gateway carries to the bank, signed.
pub(crate) fn create_session(
    state: &AppState,
    request: &CreateSessionRequest,
) -> Result<CreateSessionResponse, ApiError> {
    let inner = &state.inner;
    let policy = Policy::from_json(request.policy.get().as_bytes())
        .map_err(|e| ApiError::unprocessable(e.code()))?;
    let wallet = decode_pubkey(&request.wallet).ok_or(ApiError::BAD_REQUEST)?;
    let consent = consent_ref(&request.consent_jws, &inner.config.pinned.aa)
        .map_err(|e| ApiError::unprocessable(e.code()))?;
    let now = inner.config.clock.now();
    let range = requested_range(now)?;
    let key_pair = SessionKeyPair::generate(KeyMode::Wei25519, &mut OsRng);
    let nonce = Nonce::random(&mut OsRng);
    let key_material = KeyMaterial::new(key_pair.public_key(), &nonce, now + KEY_MATERIAL_TTL_SECS)
        .map_err(|_| ApiError::INTERNAL)?;
    let session_id = Uuid::new_v4().to_string();
    let txnid = Uuid::new_v4().to_string();
    let body = signed_fi_request(state, &txnid, now, &consent, range, &key_material)?;
    let expires_at = now + inner.config.limits.session_ttl_secs;
    let intent = build_intent(&session_id, &wallet, policy.hash().as_bytes(), expires_at);
    let session = SessionState {
        key_pair,
        nonce,
        txnid,
        consent_id: consent.id,
        range,
        policy,
        wallet,
        measurement_id: request.measurement_id,
        intent: intent.clone(),
        expires_at,
        bound: false,
    };
    inner.sessions.insert(session_id.clone(), session, now)?;
    Ok(CreateSessionResponse {
        session_id,
        key_material,
        fi_request_body_b64: STANDARD.encode(&body.0),
        fi_request_jws: body.1,
        intent,
        intent_expires: expires_at,
    })
}

/// `[to − 365 d, to)` with `to` = today 00:00 UTC by the enclave clock, the
/// same clock evaluate's future-end rule (§10.1 check 10b) reads. A `to` of
/// "now" would floor to the previous day for an Indian bank between 18:30
/// and 24:00 UTC and fail as `window_mismatch`.
fn requested_range(now: i64) -> Result<FiDataRange, ApiError> {
    let to = now.div_euclid(DAY) * DAY;
    FiDataRange::new(to - REQUEST_WINDOW_DAYS * DAY, to)
        .map_err(|e| ApiError::unprocessable(e.code()))
}

/// The §5.1 body and its detached JWS by the enclave's FIU key.
fn signed_fi_request(
    state: &AppState,
    txnid: &str,
    now: i64,
    consent: &ConsentRef,
    range: FiDataRange,
    key_material: &KeyMaterial,
) -> Result<(Vec<u8>, String), ApiError> {
    let body = build_fi_request(&FiRequest {
        txnid,
        now,
        consent,
        range,
        key_material,
    })
    .map_err(|_| ApiError::INTERNAL)?;
    let jws = state
        .inner
        .config
        .fiu_key
        .sign_detached(&body, &mut OsRng)
        .map_err(|_| ApiError::INTERNAL)?;
    Ok((body, jws))
}

/// Runs one evaluation of an already-taken session once a slot is free.
///
/// Both permits (the evaluation slot and the caller's in-flight slot) are
/// moved into the blocking task, so they are held exactly as long as the
/// computation and its buffers: if the client disconnects, the handler
/// future is dropped but the slots stay taken until the work ends. The clock
/// is read after the wait, so a queued evaluation still signs a fresh
/// `issued_at`.
pub(crate) async fn evaluate_session(
    state: &AppState,
    in_flight: OwnedSemaphorePermit,
    session: SessionState,
    request: EvaluateRequest,
    fetch_response: Vec<u8>,
) -> Result<EvaluateResponse, ApiError> {
    let permit = state
        .inner
        .evaluations
        .clone()
        .acquire_owned()
        .await
        .map_err(|_| ApiError::INTERNAL)?;
    let state = state.clone();
    tokio::task::spawn_blocking(move || {
        let _permits = (permit, in_flight);
        let now = state.inner.config.clock.now();
        run_evaluate(&state, &session, &request, &fetch_response, now)
    })
    .await
    .map_err(|_| ApiError::INTERNAL)?
}

/// `tio_core::evaluate` on one session, then the attester signature. Only
/// the outcome and the signed payload come out: the scores stay here and
/// are dropped with the rest of the evaluation.
fn run_evaluate(
    state: &AppState,
    session: &SessionState,
    request: &EvaluateRequest,
    fetch_response: &[u8],
    now: i64,
) -> Result<EvaluateResponse, ApiError> {
    let config = &state.inner.config;
    let clock = EvalClock {
        now,
        expiry: now + SIGNATURE_LIFETIME_SECS,
    };
    let evaluation = evaluate(
        &Session {
            key_pair: &session.key_pair,
            nonce: &session.nonce,
            txnid: &session.txnid,
            consent_id: &session.consent_id,
            range: session.range,
            policy: &session.policy,
            wallet: session.wallet,
        },
        &PinnedKeys {
            aa: &config.pinned.aa,
            fip: &config.pinned.fip,
        },
        &EvaluateInput {
            fetch_response,
            fetch_response_jws: &request.fetch_response_jws,
            consent_jws: &request.consent_jws,
        },
        &config.ids.context(session.measurement_id),
        clock,
    )
    .map_err(|e| ApiError::unprocessable(e.code()))?;
    match (evaluation.outcome, evaluation.attestation) {
        (Outcome::Tier(tier), Some(attestation)) => Ok(EvaluateResponse::Tier {
            tier: tier_name(tier),
            payload_hex: hex::encode(attestation.payload),
            signature_hex: hex::encode(
                config
                    .attester
                    .sign(&attestation.message)
                    .map_err(|_| ApiError::INTERNAL)?,
            ),
            expiry: clock.expiry,
        }),
        (Outcome::Reject, None) => Ok(EvaluateResponse::Reject { tier: "REJECT" }),
        // tio-core pairs a tier with an attestation and a reject with none.
        _ => Err(ApiError::INTERNAL),
    }
}

fn tier_name(tier: Tier) -> &'static str {
    match tier {
        Tier::A => "A",
        Tier::B => "B",
        Tier::C => "C",
    }
}
