//! In-process tests of the §10 HTTP API: the router driven with `tower`, test
//! keys, a manual clock and (feature `test-hooks`) sessions planted from the
//! committed test vectors.
//!
//! Most tests share one state (built once: it holds a generated RSA key).
//! Tests that move the clock or change limits build their own.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::indexing_slicing,
    clippy::panic
)]

mod common;

use std::sync::{
    atomic::{AtomicBool, AtomicUsize, Ordering},
    Arc, Condvar, Mutex, OnceLock,
};

use axum::{
    body::Body,
    http::{header, Request, StatusCode},
    Router,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use ed25519_dalek::{Signer, SigningKey};
use http_body_util::BodyExt;
use serde::Deserialize;
use serde_json::{json, value::RawValue, Value};
use tio_core::{parse_rebit_timestamp, verify_detached, FiuSigningKey, PinnedKey};
use tio_enclave::{
    attester::{fiu_binding_message, Attester},
    clock::{Clock, ManualClock},
    config::DeploymentIds,
    intent::build_intent,
    pinned::Pinned,
    router,
    session::SessionState,
    AppState, EnclaveConfig, Limits,
};

use common::{
    address_hex, b58_32, default_policy, enclave_key_pair, enclave_test_secret, eth_address_of,
    manifest_cases, nonce_of, policy_bytes, recover_address, test_key_bytes, vectors_dir,
    SeededRng, VectorCase,
};

const FIU_KID: &str = "9f2b6c1e-7a44-4d0b-8e55-3c1d2e4f5a60";
const DAY: i64 = 86_400;

// --- Harness --------------------------------------------------------------------

#[derive(Clone)]
struct Harness {
    app: Router,
    state: AppState,
    clock: Arc<ManualClock>,
}

fn salaried() -> VectorCase {
    VectorCase::load(vectors_dir().join("vectors").join("salaried_steady"))
}

fn build_harness(now: i64, limits: Limits) -> Harness {
    let clock = Arc::new(ManualClock::new(now));
    let state = build_state(clock.clone(), limits);
    Harness {
        app: router(state.clone()),
        state,
        clock,
    }
}

/// The state with test keys, the salaried vector's deployment ids and any clock.
fn build_state(clock: Arc<dyn Clock>, limits: Limits) -> AppState {
    let aa = test_key_bytes("aa");
    let fip = test_key_bytes("fip");
    let pinned = Pinned::parse(&[aa.as_slice()], &[fip.as_slice()]).expect("pinned");
    let attester =
        Attester::from_bytes(&enclave_test_secret("secp256k1_hex"), "test").expect("attester");
    let fiu_key = FiuSigningKey::generate(FIU_KID.to_owned(), &mut SeededRng(1234)).expect("fiu");
    let case = salaried();
    let attest = &case.session["attest"];
    let id = |member: &str| b58_32(attest[member].as_str().expect("attest id"));
    let ids = DeploymentIds {
        oracle_program_id: id("oracle_program_id"),
        sas_credential: id("sas_credential"),
        sas_schema: id("sas_schema"),
    };
    AppState::new(EnclaveConfig {
        pinned,
        attester,
        fiu_key,
        ids,
        clock,
        limits,
        app_version: "0.0.0-test",
    })
    .expect("AppState::new")
}

fn vector_now() -> i64 {
    salaried().now()
}

fn own_harness() -> Harness {
    build_harness(vector_now(), Limits::default())
}

fn shared() -> Harness {
    static SHARED: OnceLock<Harness> = OnceLock::new();
    SHARED.get_or_init(own_harness).clone()
}

fn attester_address() -> [u8; 20] {
    eth_address_of(&enclave_test_secret("secp256k1_hex"))
}

// --- HTTP helpers ------------------------------------------------------------------

struct Reply {
    status: StatusCode,
    content_type: Option<String>,
    body: Vec<u8>,
}

impl Reply {
    fn text(&self) -> String {
        String::from_utf8_lossy(&self.body).into_owned()
    }

    fn json(&self) -> Value {
        serde_json::from_slice(&self.body)
            .unwrap_or_else(|e| panic!("body is not JSON ({e}): {}", self.text()))
    }
}

async fn send(app: &Router, method: &str, uri: &str, body: Vec<u8>) -> Reply {
    let request = Request::builder()
        .method(method)
        .uri(uri)
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(body))
        .expect("request");
    let response = app.clone().oneshot_compat(request).await;
    let status = response.status();
    let content_type = response
        .headers()
        .get(header::CONTENT_TYPE)
        .map(|v| v.to_str().expect("ascii").to_owned());
    let body = response
        .into_body()
        .collect()
        .await
        .expect("body")
        .to_bytes()
        .to_vec();
    Reply {
        status,
        content_type,
        body,
    }
}

/// `tower::ServiceExt::oneshot` without the `Result<_, Infallible>` noise.
trait OneshotCompat {
    async fn oneshot_compat(self, request: Request<Body>) -> axum::response::Response;
}

impl OneshotCompat for Router {
    async fn oneshot_compat(self, request: Request<Body>) -> axum::response::Response {
        tower::ServiceExt::oneshot(self, request)
            .await
            .expect("router is infallible")
    }
}

fn json_bytes(value: &Value) -> Vec<u8> {
    serde_json::to_vec(value).expect("serialize")
}

async fn post(h: &Harness, uri: &str, body: &Value) -> Reply {
    send(&h.app, "POST", uri, json_bytes(body)).await
}

fn sorted_keys(value: &Value) -> Vec<String> {
    let mut keys: Vec<String> = value
        .as_object()
        .unwrap_or_else(|| panic!("not an object: {value}"))
        .keys()
        .cloned()
        .collect();
    keys.sort();
    keys
}

/// Status, the exact `{"error":{"code","message"}}` shape, and the code.
fn assert_error(reply: &Reply, status: u16, code: &str) {
    assert_eq!(reply.status.as_u16(), status, "body: {}", reply.text());
    let v = reply.json();
    assert_eq!(sorted_keys(&v), ["error"], "{}", reply.text());
    assert_eq!(
        sorted_keys(&v["error"]),
        ["code", "message"],
        "{}",
        reply.text()
    );
    assert_eq!(v["error"]["code"], code, "{}", reply.text());
    assert!(
        v["error"]["message"]
            .as_str()
            .is_some_and(|m| !m.is_empty()),
        "message must be a non-empty string"
    );
}

fn assert_json_content_type(reply: &Reply) {
    let content_type = reply.content_type.as_deref().unwrap_or("");
    assert!(
        content_type.starts_with("application/json"),
        "{content_type}"
    );
}

// --- Planting ----------------------------------------------------------------------

fn plant(h: &Harness, id: &str, case: &VectorCase, wallet: [u8; 32], bound: bool, expires_at: i64) {
    let policy = default_policy();
    let state = SessionState {
        key_pair: enclave_key_pair(case.key_mode()),
        nonce: nonce_of(case),
        txnid: case.str_field("txnid").to_owned(),
        consent_id: case.str_field("consent_id").to_owned(),
        range: case.range(),
        intent: build_intent(id, &wallet, policy.hash().as_bytes(), expires_at),
        policy,
        wallet,
        measurement_id: case.measurement_id(),
        expires_at,
        bound,
    };
    h.state.plant_session(id, state).expect("plant session");
}

fn plant_vector(h: &Harness, case: &VectorCase, bound: bool) {
    plant(
        h,
        case.session_id(),
        case,
        case.wallet(),
        bound,
        case.now() + 600,
    );
}

/// Plants a bound salaried session under a fresh UUID: evaluate takes the
/// session before it reads the body, so body errors need a live session.
fn planted_bound(h: &Harness) -> String {
    let case = salaried();
    let id = uuid::Uuid::new_v4().to_string();
    plant(h, &id, &case, case.wallet(), true, case.now() + 600);
    id
}

fn evaluate_uri(id: &str) -> String {
    format!("/v1/sessions/{id}/evaluate")
}

fn bind_uri(id: &str) -> String {
    format!("/v1/sessions/{id}/bind")
}

fn evaluate_body(case: &VectorCase) -> Value {
    json!({
        "fetch_response_b64": STANDARD.encode(case.file("fetch_response.body")),
        "fetch_response_jws": case.text("fetch_response.jws"),
        "consent_jws": case.text("consent.jws"),
    })
}

// --- Evaluate: positive vectors -------------------------------------------------------

#[tokio::test]
async fn every_positive_vector_evaluates_to_its_expected_payload_and_signature() {
    let h = shared();
    let cases = manifest_cases("positive");
    assert!(cases.len() >= 6);
    for (case, _) in &cases {
        plant_vector(&h, case, true);
        let reply = post(&h, &evaluate_uri(case.session_id()), &evaluate_body(case)).await;
        assert_eq!(reply.status.as_u16(), 200, "{}: {}", case.id, reply.text());
        assert_json_content_type(&reply);
        let got = reply.json();
        let expected = case.expected();
        assert_eq!(got["tier"], expected["tier"], "{}", case.id);
        if expected["tier"] == "REJECT" {
            continue;
        }
        assert_eq!(got["payload_hex"], expected["payload_hex"], "{}", case.id);
        assert_eq!(got["expiry"].as_i64(), Some(case.expiry()), "{}", case.id);
        assert_eq!(case.expiry(), case.now() + 600, "fixture sanity");
        let signature_hex = got["signature_hex"].as_str().expect("signature_hex");
        assert_eq!(signature_hex.len(), 130, "{}", case.id);
        assert_eq!(signature_hex, signature_hex.to_lowercase());
        let message = hex::decode(expected["msg_hex"].as_str().expect("msg_hex")).expect("hex");
        let signature = hex::decode(signature_hex).expect("hex");
        assert_eq!(
            recover_address(&message, &signature),
            attester_address(),
            "{}: signature must recover to the attester",
            case.id
        );
    }
}

/// A clock that, once armed, blocks its second call until opened. In an
/// evaluate the first call is the TTL check in the handler and the second
/// runs inside the blocking task, after the evaluation slot is taken: so the
/// test can hold an evaluation mid-flight.
struct GateClock {
    now: i64,
    armed: AtomicBool,
    calls: AtomicUsize,
    open: Mutex<bool>,
    opened: Condvar,
}

impl GateClock {
    fn new(now: i64) -> Self {
        Self {
            now,
            armed: AtomicBool::new(false),
            calls: AtomicUsize::new(0),
            open: Mutex::new(false),
            opened: Condvar::new(),
        }
    }

    fn release(&self) {
        *self.open.lock().unwrap() = true;
        self.opened.notify_all();
    }
}

impl Clock for GateClock {
    fn now(&self) -> i64 {
        if self.armed.load(Ordering::SeqCst) && self.calls.fetch_add(1, Ordering::SeqCst) == 1 {
            let mut open = self.open.lock().unwrap();
            while !*open {
                open = self.opened.wait(open).unwrap();
            }
        }
        self.now
    }
}

/// Opens the gate when dropped, so a failing assertion can't leave a
/// blocking task parked and hang the runtime's shutdown.
struct ReleaseOnDrop(Arc<GateClock>);

impl Drop for ReleaseOnDrop {
    fn drop(&mut self) {
        self.0.release();
    }
}

async fn wait_for_slots(state: &AppState, slots: usize) {
    for _ in 0..500 {
        if state.available_evaluation_slots() == slots {
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    panic!("evaluation slots never reached {slots}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_evaluation_keeps_its_slots_until_the_work_ends_even_if_the_client_leaves() {
    let clock = Arc::new(GateClock::new(vector_now()));
    let state = build_state(
        clock.clone(),
        Limits {
            max_concurrent_evaluations: 1,
            max_inflight_evaluate_requests: 1,
            ..Limits::default()
        },
    );
    // `plant` only uses the state; this harness's manual clock is unused.
    let h = Harness {
        app: router(state.clone()),
        state: state.clone(),
        clock: Arc::new(ManualClock::new(0)),
    };
    let case = salaried();
    plant_vector(&h, &case, true);
    let second_id = uuid::Uuid::new_v4().to_string();
    plant(&h, &second_id, &case, case.wallet(), true, case.now() + 600);
    clock.armed.store(true, Ordering::SeqCst);
    let _release = ReleaseOnDrop(clock.clone());

    // The first evaluate takes the slot and blocks inside the computation;
    // then its client goes away.
    let app = h.app.clone();
    let uri = evaluate_uri(case.session_id());
    let body = json_bytes(&evaluate_body(&case));
    let first = tokio::spawn(async move { send(&app, "POST", &uri, body).await });
    wait_for_slots(&state, 0).await;
    first.abort();
    assert!(first.await.is_err(), "the request future was cancelled");
    assert_eq!(
        state.available_evaluation_slots(),
        0,
        "slot held after the client left"
    );

    // The in-flight cap (1) is still taken too: a second evaluate is turned
    // away without using its session up.
    let busy = post(&h, &evaluate_uri(&second_id), &evaluate_body(&case)).await;
    assert_error(&busy, 503, "too_many_evaluations");

    clock.release();
    wait_for_slots(&state, 1).await;
    let reply = post(&h, &evaluate_uri(&second_id), &evaluate_body(&case)).await;
    assert_eq!(reply.status.as_u16(), 200, "{}", reply.text());
}

/// A body that never sends anything.
struct StalledBody;

impl http_body::Body for StalledBody {
    type Data = axum::body::Bytes;
    type Error = std::convert::Infallible;

    fn poll_frame(
        self: std::pin::Pin<&mut Self>,
        _: &mut std::task::Context<'_>,
    ) -> std::task::Poll<Option<Result<http_body::Frame<Self::Data>, Self::Error>>> {
        std::task::Poll::Pending
    }
}

#[tokio::test(start_paused = true)]
async fn an_evaluate_body_that_never_arrives_times_out_with_408() {
    let h = own_harness();
    let case = salaried();
    plant_vector(&h, &case, true);
    let request = Request::builder()
        .method("POST")
        .uri(evaluate_uri(case.session_id()))
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::new(StalledBody))
        .expect("request");
    let response = h.app.clone().oneshot_compat(request).await;
    let status = response.status();
    let body = response
        .into_body()
        .collect()
        .await
        .expect("body")
        .to_bytes();
    let reply = Reply {
        status,
        content_type: None,
        body: body.to_vec(),
    };
    assert_error(&reply, 408, "body_timeout");
}

#[tokio::test]
async fn an_evaluate_for_an_unknown_session_is_refused_before_its_body_is_read() {
    // A body over the 8 MiB limit: had it been read first, the answer would be 413.
    let big = vec![b' '; 8 * 1024 * 1024 + 1];
    let reply = send(
        &shared().app,
        "POST",
        &evaluate_uri("00000000-0000-4000-8000-000000000000"),
        big,
    )
    .await;
    assert_error(&reply, 404, "session_not_found");
}

#[tokio::test]
async fn a_non_uuid_session_id_is_session_not_found() {
    let h = shared();
    let body = json!({ "wallet": "x", "signature_b58": "y" });
    assert_error(
        &post(&h, &bind_uri("not-a-uuid%0Aforged=1"), &body).await,
        404,
        "session_not_found",
    );
    assert_error(
        &post(&h, &evaluate_uri("not-a-uuid"), &json!({})).await,
        404,
        "session_not_found",
    );
}

#[tokio::test]
async fn a_tier_response_has_exactly_the_four_public_members() {
    let h = own_harness();
    let (case, _) = manifest_cases("positive")
        .into_iter()
        .find(|(_, e)| e["tier"] == "A")
        .expect("tier A vector");
    plant_vector(&h, &case, true);
    let reply = post(&h, &evaluate_uri(case.session_id()), &evaluate_body(&case)).await;
    assert_eq!(reply.status.as_u16(), 200, "{}", reply.text());
    assert_eq!(
        sorted_keys(&reply.json()),
        ["expiry", "payload_hex", "signature_hex", "tier"]
    );
}

#[tokio::test]
async fn the_reject_vector_returns_exactly_the_tier_member() {
    let h = own_harness();
    let (case, _) = manifest_cases("positive")
        .into_iter()
        .find(|(_, e)| e["tier"] == "REJECT")
        .expect("REJECT vector");
    assert_eq!(case.id, "stressed");
    plant_vector(&h, &case, true);
    let reply = post(&h, &evaluate_uri(case.session_id()), &evaluate_body(&case)).await;
    assert_eq!(reply.status.as_u16(), 200, "{}", reply.text());
    assert_eq!(reply.json(), json!({"tier": "REJECT"}));
    assert_eq!(reply.body, br#"{"tier":"REJECT"}"#);
}

#[tokio::test]
async fn a_second_evaluate_of_the_same_session_is_session_not_found() {
    let h = own_harness();
    let (case, _) = manifest_cases("positive").remove(0);
    plant_vector(&h, &case, true);
    let first = post(&h, &evaluate_uri(case.session_id()), &evaluate_body(&case)).await;
    assert_eq!(first.status.as_u16(), 200);
    let second = post(&h, &evaluate_uri(case.session_id()), &evaluate_body(&case)).await;
    assert_error(&second, 404, "session_not_found");
}

// --- Evaluate: negative vectors -----------------------------------------------------------

#[tokio::test]
async fn every_negative_vector_is_422_with_its_code_and_removes_the_session() {
    let h = shared();
    let cases = manifest_cases("negative");
    assert!(cases.len() >= 25, "expected the full negative set");
    for (case, expected) in &cases {
        let code = expected["error_code"].as_str().expect("error_code");
        plant_vector(&h, case, true);
        let reply = post(&h, &evaluate_uri(case.session_id()), &evaluate_body(case)).await;
        assert_error(&reply, 422, code);
        let again = post(&h, &evaluate_uri(case.session_id()), &evaluate_body(case)).await;
        assert_error(&again, 404, "session_not_found");
    }
}

#[tokio::test]
async fn error_bodies_never_echo_request_data() {
    let h = own_harness();
    let (case, _) = manifest_cases("negative")
        .into_iter()
        .find(|(c, _)| c.id == "fetch_response_flipped")
        .expect("vector");
    plant_vector(&h, &case, true);
    let reply = post(&h, &evaluate_uri(case.session_id()), &evaluate_body(&case)).await;
    assert_eq!(reply.status.as_u16(), 422);
    let text = reply.text();
    assert!(!text.contains(case.str_field("txnid")), "{text}");
    assert!(!text.contains(case.str_field("consent_id")), "{text}");
}

// --- Evaluate: state and limit errors ----------------------------------------------------

#[tokio::test]
async fn evaluate_on_an_unknown_id_is_404_session_not_found() {
    let h = shared();
    let reply = post(
        &h,
        &evaluate_uri("00000000-0000-4000-8000-00000000dead"),
        &evaluate_body(&salaried()),
    )
    .await;
    assert_error(&reply, 404, "session_not_found");
}

#[tokio::test]
async fn evaluate_on_an_unbound_session_is_409_and_consumes_the_session() {
    let h = shared();
    let case = salaried();
    let id = "6b2dc547-44ca-5949-80b5-572879cd096a" /* planted-unbound-evaluate */;
    plant(&h, id, &case, case.wallet(), false, case.now() + 600);
    let reply = post(&h, &evaluate_uri(id), &evaluate_body(&case)).await;
    assert_error(&reply, 409, "session_not_bound");
    let again = post(&h, &evaluate_uri(id), &evaluate_body(&case)).await;
    assert_error(&again, 404, "session_not_found");
}

#[tokio::test]
async fn evaluate_after_the_ttl_is_410_session_expired() {
    let h = own_harness();
    let case = salaried();
    plant(
        &h,
        "2b524aea-21ab-5b37-a350-27002f99be85", /* planted-expired */
        &case,
        case.wallet(),
        true,
        case.now() + 600,
    );
    h.clock.set(case.now() + 601);
    let reply = post(
        &h,
        &evaluate_uri(
            "2b524aea-21ab-5b37-a350-27002f99be85", /* planted-expired */
        ),
        &evaluate_body(&case),
    )
    .await;
    assert_error(&reply, 410, "session_expired");
}

#[tokio::test]
async fn an_evaluate_body_over_8_mib_is_413_body_too_large() {
    let h = shared();
    let case = salaried();
    plant(
        &h,
        "fc305fb9-5009-581d-92a9-499f6c527ddd", /* planted-big-evaluate */
        &case,
        case.wallet(),
        true,
        case.now() + 600,
    );
    let big = vec![b' '; 8 * 1024 * 1024 + 1];
    let reply = send(
        &h.app,
        "POST",
        &evaluate_uri(
            "fc305fb9-5009-581d-92a9-499f6c527ddd", /* planted-big-evaluate */
        ),
        big,
    )
    .await;
    assert_error(&reply, 413, "body_too_large");
}

#[tokio::test]
async fn an_evaluate_body_over_64_kib_is_accepted_up_to_8_mib() {
    // The vectors' fetch responses are ~88 KB as base64: well over 64 KiB.
    let case = salaried();
    let body = json_bytes(&evaluate_body(&case));
    assert!(body.len() > 64 * 1024, "fixture sanity: {}", body.len());
    let h = shared();
    plant(
        &h,
        "62b97abd-0b37-5e19-be5f-5e5855ff6f3e", /* planted-over-64k */
        &case,
        case.wallet(),
        true,
        case.now() + 600,
    );
    let reply = send(
        &h.app,
        "POST",
        &evaluate_uri(
            "62b97abd-0b37-5e19-be5f-5e5855ff6f3e", /* planted-over-64k */
        ),
        body,
    )
    .await;
    assert_eq!(reply.status.as_u16(), 200, "{}", reply.text());
}

#[tokio::test]
async fn evaluate_rejects_an_unknown_json_member_as_400_bad_request() {
    let h = shared();
    let case = salaried();
    let mut body = evaluate_body(&case);
    body["extra"] = json!(1);
    let reply = post(&h, &evaluate_uri(&planted_bound(&h)), &body).await;
    assert_error(&reply, 400, "bad_request");
}

#[tokio::test]
async fn evaluate_rejects_a_missing_member_as_400_bad_request() {
    let h = shared();
    let body = json!({"fetch_response_b64": "AAAA", "fetch_response_jws": "a..b"});
    let reply = post(&h, &evaluate_uri(&planted_bound(&h)), &body).await;
    assert_error(&reply, 400, "bad_request");
}

#[tokio::test]
async fn evaluate_rejects_malformed_json_as_400_bad_request() {
    let h = shared();
    let reply = send(
        &h.app,
        "POST",
        &evaluate_uri(&planted_bound(&h)),
        b"{not json".to_vec(),
    )
    .await;
    assert_error(&reply, 400, "bad_request");
}

#[tokio::test]
async fn evaluate_rejects_invalid_base64_as_400_bad_request() {
    let h = shared();
    let case = salaried();
    plant(
        &h,
        "0bd7f12e-1767-5cdc-80ba-a7d1a7f35c39", /* planted-bad-b64 */
        &case,
        case.wallet(),
        true,
        case.now() + 600,
    );
    let mut body = evaluate_body(&case);
    body["fetch_response_b64"] = json!("***not base64***");
    let reply = post(
        &h,
        &evaluate_uri(
            "0bd7f12e-1767-5cdc-80ba-a7d1a7f35c39", /* planted-bad-b64 */
        ),
        &body,
    )
    .await;
    assert_error(&reply, 400, "bad_request");
    // Any evaluate call on a bound session uses it up, whatever the body.
    let again = post(
        &h,
        &evaluate_uri(
            "0bd7f12e-1767-5cdc-80ba-a7d1a7f35c39", /* planted-bad-b64 */
        ),
        &evaluate_body(&case),
    )
    .await;
    assert_error(&again, 404, "session_not_found");
}

// --- Bind ---------------------------------------------------------------------------------

fn bind_key() -> SigningKey {
    SigningKey::from_bytes(&[21u8; 32])
}

fn bind_body(wallet: &SigningKey, signer: &SigningKey, intent: &str) -> Value {
    json!({
        "wallet": bs58::encode(wallet.verifying_key().to_bytes()).into_string(),
        "signature_b58": bs58::encode(signer.sign(intent.as_bytes()).to_bytes()).into_string(),
    })
}

/// Plants an unbound session owned by `bind_key()` and returns its intent.
fn plant_bindable(h: &Harness, id: &str) -> String {
    let case = salaried();
    let wallet = bind_key().verifying_key().to_bytes();
    plant(h, id, &case, wallet, false, case.now() + 600);
    build_intent(
        id,
        &wallet,
        default_policy().hash().as_bytes(),
        case.now() + 600,
    )
}

#[tokio::test]
async fn bind_with_the_wallets_signature_is_200_bound() {
    let h = shared();
    let intent = plant_bindable(
        &h,
        "9a0fdb88-dfbb-5e66-af5e-0b55381fad9e", /* bind-ok */
    );
    let key = bind_key();
    let reply = post(
        &h,
        &bind_uri("9a0fdb88-dfbb-5e66-af5e-0b55381fad9e" /* bind-ok */),
        &bind_body(&key, &key, &intent),
    )
    .await;
    assert_eq!(reply.status.as_u16(), 200, "{}", reply.text());
    assert_json_content_type(&reply);
    assert_eq!(reply.json(), json!({"status": "bound"}));
}

#[tokio::test]
async fn a_session_bound_over_http_then_evaluates() {
    let h = shared();
    let case = salaried();
    // Same wallet key owns the session; bind it over HTTP, then evaluate.
    let wallet = bind_key().verifying_key().to_bytes();
    plant(
        &h,
        "de61518d-6b12-5599-bfa3-a762c99e5cf9", /* bind-then-eval */
        &case,
        wallet,
        false,
        case.now() + 600,
    );
    let intent = build_intent(
        "de61518d-6b12-5599-bfa3-a762c99e5cf9", /* bind-then-eval */
        &wallet,
        default_policy().hash().as_bytes(),
        case.now() + 600,
    );
    let key = bind_key();
    let bound = post(
        &h,
        &bind_uri(
            "de61518d-6b12-5599-bfa3-a762c99e5cf9", /* bind-then-eval */
        ),
        &bind_body(&key, &key, &intent),
    )
    .await;
    assert_eq!(bound.status.as_u16(), 200);
    // The consent's id and txnid match the planted session, so the bank data
    // for the salaried vector evaluates (wallet only affects the payload).
    let reply = post(
        &h,
        &evaluate_uri(
            "de61518d-6b12-5599-bfa3-a762c99e5cf9", /* bind-then-eval */
        ),
        &evaluate_body(&case),
    )
    .await;
    assert_eq!(reply.status.as_u16(), 200, "{}", reply.text());
    assert_eq!(reply.json()["tier"], "A");
}

#[tokio::test]
async fn a_second_bind_is_409_session_already_bound() {
    let h = shared();
    let intent = plant_bindable(
        &h,
        "d274f3bd-2e0a-5678-9a67-87d2fd7580be", /* bind-twice */
    );
    let key = bind_key();
    let body = bind_body(&key, &key, &intent);
    assert_eq!(
        post(
            &h,
            &bind_uri("d274f3bd-2e0a-5678-9a67-87d2fd7580be" /* bind-twice */),
            &body
        )
        .await
        .status
        .as_u16(),
        200
    );
    assert_error(
        &post(
            &h,
            &bind_uri("d274f3bd-2e0a-5678-9a67-87d2fd7580be" /* bind-twice */),
            &body,
        )
        .await,
        409,
        "session_already_bound",
    );
}

#[tokio::test]
async fn bind_with_a_bad_signature_is_401_bad_intent_signature() {
    let h = shared();
    let intent = plant_bindable(
        &h,
        "03f0d49e-7061-514b-99d1-38d328bd223a", /* bind-bad-sig */
    );
    let other = SigningKey::from_bytes(&[22u8; 32]);
    let reply = post(
        &h,
        &bind_uri(
            "03f0d49e-7061-514b-99d1-38d328bd223a", /* bind-bad-sig */
        ),
        &bind_body(&bind_key(), &other, &intent),
    )
    .await;
    assert_error(&reply, 401, "bad_intent_signature");
}

#[tokio::test]
async fn bind_with_another_wallet_is_400_bad_request() {
    let h = shared();
    let other = SigningKey::from_bytes(&[22u8; 32]);
    let intent = plant_bindable(
        &h,
        "9cc004f3-78f1-5a67-916f-acfd88053a5c", /* bind-other-wallet */
    );
    let reply = post(
        &h,
        &bind_uri(
            "9cc004f3-78f1-5a67-916f-acfd88053a5c", /* bind-other-wallet */
        ),
        &bind_body(&other, &other, &intent),
    )
    .await;
    assert_error(&reply, 400, "bad_request");
}

#[tokio::test]
async fn bind_with_a_wallet_that_is_not_base58_is_400_bad_request() {
    let h = shared();
    plant_bindable(
        &h,
        "25a333d2-e069-5e19-9daf-3177a770993a", /* bind-bad-wallet */
    );
    let body = json!({"wallet": "0OIl-not-base58", "signature_b58": "abc"});
    assert_error(
        &post(
            &h,
            &bind_uri(
                "25a333d2-e069-5e19-9daf-3177a770993a", /* bind-bad-wallet */
            ),
            &body,
        )
        .await,
        400,
        "bad_request",
    );
}

#[tokio::test]
async fn bind_with_a_signature_that_is_not_base58_is_400_bad_request() {
    let h = shared();
    plant_bindable(
        &h,
        "ac0f4daa-2b86-5cf7-b4d9-f15ecb71a828", /* bind-bad-sig-encoding */
    );
    let wallet = bs58::encode(bind_key().verifying_key().to_bytes()).into_string();
    let body = json!({"wallet": wallet, "signature_b58": "0OIl-not-base58"});
    assert_error(
        &post(
            &h,
            &bind_uri(
                "ac0f4daa-2b86-5cf7-b4d9-f15ecb71a828", /* bind-bad-sig-encoding */
            ),
            &body,
        )
        .await,
        400,
        "bad_request",
    );
}

#[tokio::test]
async fn bind_on_an_unknown_id_is_404() {
    let h = shared();
    let key = bind_key();
    let reply = post(&h, &bind_uri("nobody"), &bind_body(&key, &key, "x")).await;
    assert_error(&reply, 404, "session_not_found");
}

#[tokio::test]
async fn bind_after_the_ttl_is_410() {
    let h = own_harness();
    let intent = plant_bindable(
        &h,
        "61a57b57-cac7-5bc5-9248-6f0c3bf6b887", /* bind-expired */
    );
    h.clock.set(vector_now() + 601);
    let key = bind_key();
    let reply = post(
        &h,
        &bind_uri(
            "61a57b57-cac7-5bc5-9248-6f0c3bf6b887", /* bind-expired */
        ),
        &bind_body(&key, &key, &intent),
    )
    .await;
    assert_error(&reply, 410, "session_expired");
}

#[tokio::test]
async fn a_bind_body_over_64_kib_is_413_body_too_large() {
    let h = shared();
    plant_bindable(
        &h,
        "20bf97c6-f66c-58e6-a90d-f97e3b7f9db0", /* bind-big */
    );
    let big = vec![b' '; 64 * 1024 + 1];
    assert_error(
        &send(
            &h.app,
            "POST",
            &bind_uri("20bf97c6-f66c-58e6-a90d-f97e3b7f9db0" /* bind-big */),
            big,
        )
        .await,
        413,
        "body_too_large",
    );
}

#[tokio::test]
async fn bind_rejects_an_unknown_json_member_as_400() {
    let h = shared();
    let body = json!({"wallet": "x", "signature_b58": "y", "extra": true});
    assert_error(
        &post(&h, &bind_uri("8f4c2f8e-0b7e-4c1a-9a43-2f6b1d0e5c11"), &body).await,
        400,
        "bad_request",
    );
}

// --- Info -----------------------------------------------------------------------------------

#[derive(Deserialize)]
struct InfoRaw {
    attester_address: String,
    fiu_public_jwk: Box<RawValue>,
    fiu_key_signature_hex: String,
    pinned_kids: Vec<String>,
}

async fn info(h: &Harness) -> (Reply, InfoRaw) {
    let reply = send(&h.app, "GET", "/v1/info", Vec::new()).await;
    assert_eq!(reply.status.as_u16(), 200, "{}", reply.text());
    let raw: InfoRaw = serde_json::from_slice(&reply.body).expect("info shape");
    (reply, raw)
}

#[tokio::test]
async fn info_has_exactly_the_five_public_members() {
    let (reply, _) = info(&shared()).await;
    assert_json_content_type(&reply);
    let v = reply.json();
    assert_eq!(
        sorted_keys(&v),
        [
            "app_version",
            "attester_address",
            "fiu_key_signature_hex",
            "fiu_public_jwk",
            "pinned_kids"
        ]
    );
    assert!(v["app_version"].as_str().is_some_and(|s| !s.is_empty()));
    assert_eq!(sorted_keys(&v["fiu_public_jwk"]), ["e", "kid", "kty", "n"]);
}

#[tokio::test]
async fn info_attester_address_is_the_test_key_address() {
    let (_, raw) = info(&shared()).await;
    assert_eq!(raw.attester_address, address_hex(&attester_address()));
}

#[tokio::test]
async fn info_pinned_kids_are_the_aa_kid_then_the_fip_kid() {
    let (_, raw) = info(&shared()).await;
    let kid = |name: &str| common::jwk_kid(&test_key_bytes(name));
    assert_eq!(raw.pinned_kids, vec![kid("aa"), kid("fip")]);
}

#[tokio::test]
async fn info_fiu_jwk_is_the_canonical_jcs_text_of_the_generated_key() {
    let (_, raw) = info(&shared()).await;
    let text = raw.fiu_public_jwk.get();
    assert!(
        text.starts_with(&format!(
            r#"{{"e":"AQAB","kid":"{FIU_KID}","kty":"RSA","n":""#
        )),
        "{text}"
    );
    assert!(text.ends_with("\"}"));
    assert!(!text.contains(char::is_whitespace));
    assert_eq!(
        PinnedKey::from_jwk(text.as_bytes()).expect("jwk").kid(),
        FIU_KID
    );
}

#[tokio::test]
async fn info_fiu_key_signature_recovers_to_the_attester_address() {
    let (_, raw) = info(&shared()).await;
    let message = fiu_binding_message(raw.fiu_public_jwk.get().as_bytes());
    let signature = hex::decode(&raw.fiu_key_signature_hex).expect("hex");
    assert_eq!(signature.len(), 65);
    assert_eq!(
        address_hex(&recover_address(&message, &signature)),
        raw.attester_address
    );
}

#[tokio::test]
async fn info_does_not_verify_for_a_different_jwk() {
    let (_, raw) = info(&shared()).await;
    let tampered = raw.fiu_public_jwk.get().replace("AQAB", "AQAC");
    let message = fiu_binding_message(tampered.as_bytes());
    let signature = hex::decode(&raw.fiu_key_signature_hex).expect("hex");
    assert_ne!(
        address_hex(&recover_address(&message, &signature)),
        raw.attester_address
    );
}

#[tokio::test]
async fn info_is_stable_between_calls() {
    let h = shared();
    let (first, _) = info(&h).await;
    let (second, _) = info(&h).await;
    assert_eq!(first.body, second.body);
}

#[tokio::test]
async fn info_rejects_post_with_405_and_unknown_paths_are_404() {
    let h = shared();
    let post = send(&h.app, "POST", "/v1/info", b"{}".to_vec()).await;
    assert_eq!(post.status.as_u16(), 405);
    let missing = send(&h.app, "GET", "/v1/nothing", Vec::new()).await;
    assert_eq!(missing.status.as_u16(), 404);
}

// --- Create ---------------------------------------------------------------------------------

fn wallet_key() -> SigningKey {
    SigningKey::from_bytes(&[9u8; 32])
}

fn wallet_b58() -> String {
    bs58::encode(wallet_key().verifying_key().to_bytes()).into_string()
}

fn policy_value() -> Value {
    serde_json::from_slice(&policy_bytes()).expect("policy json")
}

fn create_request(consent: &str, wallet: &str, measurement: Value) -> Value {
    json!({
        "policy": policy_value(),
        "wallet": wallet,
        "consent_jws": consent,
        "measurement_id": measurement,
    })
}

fn good_create_request() -> Value {
    create_request(&salaried().text("consent.jws"), &wallet_b58(), json!(0))
}

async fn create_ok(h: &Harness) -> Value {
    let reply = post(h, "/v1/sessions", &good_create_request()).await;
    assert_eq!(reply.status.as_u16(), 200, "{}", reply.text());
    assert_json_content_type(&reply);
    reply.json()
}

fn is_uuid_v4(text: &str) -> bool {
    let b = text.as_bytes();
    b.len() == 36
        && [8, 13, 18, 23].iter().all(|&i| b[i] == b'-')
        && b[14] == b'4'
        && matches!(b[19], b'8' | b'9' | b'a' | b'b')
        && text.chars().enumerate().all(|(i, c)| {
            [8, 13, 18, 23].contains(&i) || c.is_ascii_digit() || ('a'..='f').contains(&c)
        })
}

fn fi_request_body(created: &Value) -> Vec<u8> {
    STANDARD
        .decode(created["fi_request_body_b64"].as_str().expect("b64"))
        .expect("standard base64")
}

#[tokio::test]
async fn create_returns_exactly_the_six_documented_members_and_a_uuid_v4_id() {
    let created = create_ok(&shared()).await;
    assert_eq!(
        sorted_keys(&created),
        [
            "fi_request_body_b64",
            "fi_request_jws",
            "intent",
            "intent_expires",
            "key_material",
            "session_id"
        ]
    );
    let id = created["session_id"].as_str().expect("session_id");
    assert!(is_uuid_v4(id), "{id}");
}

#[tokio::test]
async fn two_creates_give_two_different_session_ids() {
    let h = shared();
    let a = create_ok(&h).await;
    let b = create_ok(&h).await;
    assert_ne!(a["session_id"], b["session_id"]);
}

#[tokio::test]
async fn create_builds_the_fi_request_for_the_consent_and_the_clocks_day() {
    let case = salaried();
    let created = create_ok(&shared()).await;
    let body: Value = serde_json::from_slice(&fi_request_body(&created)).expect("json");
    let vector_body: Value = serde_json::from_slice(&case.file("fi_request.body")).expect("json");

    assert_eq!(body["ver"], "1.1.3");
    assert_eq!(body["Consent"]["id"], case.str_field("consent_id"));
    let signature = case.text("consent.jws");
    assert_eq!(
        body["Consent"]["digitalSignature"].as_str().expect("sig"),
        signature.trim().rsplit('.').next().expect("segment")
    );
    // The clock equals the vector's `now`, so these match the vector body.
    assert_eq!(body["timestamp"], vector_body["timestamp"]);
    assert_eq!(body["FIDataRange"], vector_body["FIDataRange"]);
    assert_eq!(
        body["KeyMaterial"]["DHPublicKey"]["expiry"],
        vector_body["KeyMaterial"]["DHPublicKey"]["expiry"]
    );
    assert!(body["txnid"].as_str().is_some_and(|t| !t.is_empty()));
}

#[tokio::test]
async fn create_key_material_matches_the_one_inside_the_fi_request_and_is_fresh() {
    let h = shared();
    let a = create_ok(&h).await;
    let b = create_ok(&h).await;
    let body: Value = serde_json::from_slice(&fi_request_body(&a)).expect("json");
    assert_eq!(a["key_material"], body["KeyMaterial"]);
    let nonce = STANDARD
        .decode(a["key_material"]["Nonce"].as_str().expect("nonce"))
        .expect("base64");
    assert_eq!(nonce.len(), 32);
    assert!(a["key_material"]["DHPublicKey"]["KeyValue"]
        .as_str()
        .expect("pem")
        .starts_with("-----BEGIN PUBLIC KEY-----"));
    assert_ne!(a["key_material"]["Nonce"], b["key_material"]["Nonce"]);
    assert_ne!(
        a["key_material"]["DHPublicKey"]["KeyValue"],
        b["key_material"]["DHPublicKey"]["KeyValue"]
    );
}

#[tokio::test]
async fn create_signs_the_exact_request_bytes_with_the_fiu_key_from_info() {
    let h = shared();
    let created = create_ok(&h).await;
    let (_, raw) = info(&h).await;
    let key = PinnedKey::from_jwk(raw.fiu_public_jwk.get().as_bytes()).expect("fiu jwk");
    let jws = created["fi_request_jws"].as_str().expect("jws");
    let body = fi_request_body(&created);
    verify_detached(jws, &body, std::slice::from_ref(&key))
        .expect("JWS verifies over the exact bytes");
    let mut changed = body.clone();
    changed.push(b' ');
    assert!(verify_detached(jws, &changed, &[key]).is_err());
}

#[tokio::test]
async fn create_intent_is_the_section_9_text_expiring_in_600_seconds() {
    let h = shared();
    let created = create_ok(&h).await;
    let id = created["session_id"].as_str().expect("id");
    let expires = created["intent_expires"].as_i64().expect("intent_expires");
    assert_eq!(expires, vector_now() + 600);
    let expected = build_intent(
        id,
        &wallet_key().verifying_key().to_bytes(),
        default_policy().hash().as_bytes(),
        expires,
    );
    assert_eq!(created["intent"], expected.as_str());
}

#[tokio::test]
async fn a_created_session_binds_with_the_wallets_signature_over_the_intent() {
    let h = shared();
    let created = create_ok(&h).await;
    let id = created["session_id"].as_str().expect("id");
    let intent = created["intent"].as_str().expect("intent");
    let key = wallet_key();
    let reply = post(&h, &bind_uri(id), &bind_body(&key, &key, intent)).await;
    assert_eq!(reply.status.as_u16(), 200, "{}", reply.text());
    assert_eq!(reply.json(), json!({"status": "bound"}));
    let again = post(&h, &bind_uri(id), &bind_body(&key, &key, intent)).await;
    assert_error(&again, 409, "session_already_bound");
}

#[tokio::test]
async fn a_created_session_rejects_a_signature_by_another_key() {
    let h = shared();
    let created = create_ok(&h).await;
    let id = created["session_id"].as_str().expect("id");
    let intent = created["intent"].as_str().expect("intent");
    let other = SigningKey::from_bytes(&[10u8; 32]);
    let reply = post(&h, &bind_uri(id), &bind_body(&wallet_key(), &other, intent)).await;
    assert_error(&reply, 401, "bad_intent_signature");
}

#[tokio::test]
async fn a_created_session_cannot_be_evaluated_before_it_is_bound() {
    let h = shared();
    let created = create_ok(&h).await;
    let id = created["session_id"].as_str().expect("id");
    let reply = post(&h, &evaluate_uri(id), &evaluate_body(&salaried())).await;
    assert_error(&reply, 409, "session_not_bound");
}

#[tokio::test]
async fn create_range_is_utc_midnight_to_and_365_days_before_across_clock_edges() {
    let h = own_harness();
    let cases = [
        (1_790_380_800, 1_790_380_800), // 00:00:00 UTC exactly
        (1_790_380_801, 1_790_380_800), // 00:00:01
        (1_790_467_199, 1_790_380_800), // 23:59:59 the same day
        (1_790_467_200, 1_790_467_200), // next 00:00:00
        (1_835_481_600, 1_835_481_600), // 2028-03-01, after a leap day
        (1_835_567_999, 1_835_481_600), // 2028-03-01 23:59:59
    ];
    for (now, expected_to) in cases {
        h.clock.set(now);
        let created = create_ok(&h).await;
        let body: Value = serde_json::from_slice(&fi_request_body(&created)).expect("json");
        let ts = |v: &Value| parse_rebit_timestamp(v.as_str().expect("ts")).expect("timestamp");
        let to = ts(&body["FIDataRange"]["to"]);
        let from = ts(&body["FIDataRange"]["from"]);
        assert_eq!(to, expected_to, "now = {now}");
        assert_eq!(to % DAY, 0);
        assert_eq!(
            from,
            to - 365 * DAY,
            "now = {now}: 365 days, not a calendar year"
        );
        assert_eq!(ts(&body["timestamp"]), now);
        assert_eq!(ts(&body["KeyMaterial"]["DHPublicKey"]["expiry"]), now + DAY);
        assert_eq!(created["intent_expires"].as_i64(), Some(now + 600));
    }
}

#[tokio::test]
async fn create_rejects_a_bad_policy_as_422_bad_policy() {
    let mut request = good_create_request();
    request["policy"] = json!({"v": 1});
    assert_error(
        &post(&shared(), "/v1/sessions", &request).await,
        422,
        "bad_policy",
    );
}

#[tokio::test]
async fn create_rejects_a_policy_with_an_unknown_member_as_422_bad_policy() {
    let mut request = good_create_request();
    request["policy"]["surprise"] = json!(1);
    assert_error(
        &post(&shared(), "/v1/sessions", &request).await,
        422,
        "bad_policy",
    );
}

#[tokio::test]
async fn create_rejects_a_tampered_consent_as_422_bad_consent_signature() {
    let tampered = std::fs::read_to_string(
        vectors_dir()
            .join("negative")
            .join("consent_tampered")
            .join("consent.jws"),
    )
    .expect("consent");
    let request = create_request(&tampered, &wallet_b58(), json!(0));
    assert_error(
        &post(&shared(), "/v1/sessions", &request).await,
        422,
        "bad_consent_signature",
    );
}

#[tokio::test]
async fn create_rejects_a_malformed_consent_without_echoing_it() {
    let request = create_request("supersecret.marker.value", &wallet_b58(), json!(0));
    let reply = post(&shared(), "/v1/sessions", &request).await;
    assert_eq!(reply.status.as_u16(), 422, "{}", reply.text());
    assert!(!reply.text().contains("supersecret"));
}

#[tokio::test]
async fn create_rejects_bad_wallets_as_400_bad_request() {
    let consent = salaried().text("consent.jws");
    let short = bs58::encode([1u8; 31]).into_string();
    let long = bs58::encode([1u8; 33]).into_string();
    for wallet in ["0OIl-not-base58", "", short.as_str(), long.as_str()] {
        let request = create_request(&consent, wallet, json!(0));
        assert_error(
            &post(&shared(), "/v1/sessions", &request).await,
            400,
            "bad_request",
        );
    }
}

#[tokio::test]
async fn create_rejects_measurement_ids_outside_0_to_254_as_400() {
    let consent = salaried().text("consent.jws");
    for bad in [
        json!(256),
        json!(255),
        json!(-1),
        json!(1.5),
        json!("7"),
        json!(null),
    ] {
        let request = create_request(&consent, &wallet_b58(), bad.clone());
        assert_error(
            &post(&shared(), "/v1/sessions", &request).await,
            400,
            "bad_request",
        );
    }
}

#[tokio::test]
async fn create_accepts_the_largest_measurement_id_254() {
    let request = create_request(&salaried().text("consent.jws"), &wallet_b58(), json!(254));
    let reply = post(&shared(), "/v1/sessions", &request).await;
    assert_eq!(reply.status.as_u16(), 200, "{}", reply.text());
}

#[tokio::test]
async fn create_rejects_the_old_fi_data_range_member_as_400() {
    let mut request = good_create_request();
    request["fi_data_range"] = json!({"from": "x", "to": "y"});
    assert_error(
        &post(&shared(), "/v1/sessions", &request).await,
        400,
        "bad_request",
    );
}

#[tokio::test]
async fn create_rejects_a_missing_member_as_400() {
    for member in ["policy", "wallet", "consent_jws", "measurement_id"] {
        let mut request = good_create_request();
        request.as_object_mut().expect("object").remove(member);
        assert_error(
            &post(&shared(), "/v1/sessions", &request).await,
            400,
            "bad_request",
        );
    }
}

#[tokio::test]
async fn create_rejects_malformed_json_as_400() {
    let reply = send(&shared().app, "POST", "/v1/sessions", b"[1,2".to_vec()).await;
    assert_error(&reply, 400, "bad_request");
}

#[tokio::test]
async fn a_create_body_over_64_kib_is_413_body_too_large() {
    let big = vec![b' '; 64 * 1024 + 1];
    assert_error(
        &send(&shared().app, "POST", "/v1/sessions", big).await,
        413,
        "body_too_large",
    );
}

#[tokio::test]
async fn the_257th_open_session_is_503_too_many_sessions_and_expiry_frees_slots() {
    // Cap of 1 stands in for 256 (Limits::default() is checked separately).
    let limits = Limits {
        max_sessions: 1,
        ..Limits::default()
    };
    let h = build_harness(vector_now(), limits);
    create_ok(&h).await;
    let second = post(&h, "/v1/sessions", &good_create_request()).await;
    assert_error(&second, 503, "too_many_sessions");
    h.clock.set(vector_now() + 601);
    create_ok(&h).await;
}

#[test]
fn default_limits_are_256_sessions_600_seconds_2_evaluations_8_mib_and_64_kib() {
    let limits = Limits::default();
    assert_eq!(limits.max_sessions, 256);
    assert_eq!(limits.session_ttl_secs, 600);
    assert_eq!(limits.max_concurrent_evaluations, 2);
    assert_eq!(limits.evaluate_body_bytes, 8 * 1024 * 1024);
    assert_eq!(limits.other_body_bytes, 64 * 1024);
}
