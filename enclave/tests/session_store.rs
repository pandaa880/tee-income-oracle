//! The in-memory session store: cap, TTL, bind and single-use `take_bound`.
//!
//! Boundary choice: a session is alive at `now < expires_at` and expired at
//! `now > expires_at`; the exact `now == expires_at` tick is not pinned.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::indexing_slicing,
    clippy::panic
)]

mod common;

use ed25519_dalek::{Signer, SigningKey};
use tio_core::{FiDataRange, KeyMode, Nonce, SessionKeyPair};
use tio_enclave::{
    intent::build_intent,
    session::{SessionState, SessionStore},
    ApiError,
};

use common::{default_policy, SeededRng};

const NOW: i64 = 1_790_416_800;
const TTL: i64 = 600;

fn wallet_key() -> SigningKey {
    SigningKey::from_bytes(&[5u8; 32])
}

fn other_key() -> SigningKey {
    SigningKey::from_bytes(&[6u8; 32])
}

fn state(id: &str, wallet: &SigningKey, expires_at: i64, bound: bool) -> SessionState {
    let mut rng = SeededRng(42);
    let policy = default_policy();
    let wallet_bytes = wallet.verifying_key().to_bytes();
    SessionState {
        key_pair: SessionKeyPair::generate(KeyMode::Wei25519, &mut rng),
        nonce: Nonce::random(&mut rng),
        txnid: "txn-1".to_owned(),
        consent_id: "consent-1".to_owned(),
        range: FiDataRange::new(1_000_000, 2_000_000).expect("range"),
        intent: build_intent(id, &wallet_bytes, policy.hash().as_bytes(), expires_at),
        policy,
        wallet: wallet_bytes,
        measurement_id: 3,
        expires_at,
        bound,
    }
}

fn open(id: &str) -> SessionState {
    state(id, &wallet_key(), NOW + TTL, false)
}

fn sign_intent(store_state_intent: &str, key: &SigningKey) -> String {
    bs58::encode(key.sign(store_state_intent.as_bytes()).to_bytes()).into_string()
}

/// Inserts an unbound session and returns its (intent, wallet) for binding.
fn insert_open(store: &SessionStore, id: &str) -> (String, [u8; 32]) {
    let s = open(id);
    let intent = s.intent.clone();
    let wallet = s.wallet;
    store.insert(id.to_owned(), s, NOW).expect("insert");
    (intent, wallet)
}

fn bind_ok(store: &SessionStore, id: &str) {
    let (intent, wallet) = insert_open(store, id);
    store
        .bind(id, &wallet, &sign_intent(&intent, &wallet_key()), NOW)
        .expect("bind");
}

fn err_of<T>(result: Result<T, ApiError>) -> ApiError {
    match result {
        Ok(_) => panic!("expected an error"),
        Err(e) => e,
    }
}

// --- insert / len / cap ---------------------------------------------------------

#[test]
fn a_new_store_is_empty() {
    let store = SessionStore::new(4);
    assert_eq!(store.len(), 0);
    assert!(store.is_empty());
}

#[test]
fn insert_then_len_counts_the_session() {
    let store = SessionStore::new(4);
    store
        .insert("a".to_owned(), open("a"), NOW)
        .expect("insert");
    assert_eq!(store.len(), 1);
    assert!(!store.is_empty());
    store
        .insert("b".to_owned(), open("b"), NOW)
        .expect("insert");
    assert_eq!(store.len(), 2);
}

#[test]
fn insert_at_the_cap_is_too_many_sessions_503() {
    let store = SessionStore::new(2);
    store.insert("a".to_owned(), open("a"), NOW).expect("a");
    store.insert("b".to_owned(), open("b"), NOW).expect("b");
    let err = err_of(store.insert("c".to_owned(), open("c"), NOW));
    assert_eq!(err, ApiError::TOO_MANY_SESSIONS);
    assert_eq!(err.status.as_u16(), 503);
    assert_eq!(err.code, "too_many_sessions");
    assert_eq!(store.len(), 2);
}

#[test]
fn a_cap_of_one_allows_exactly_one_live_session() {
    let store = SessionStore::new(1);
    store.insert("a".to_owned(), open("a"), NOW).expect("a");
    assert_eq!(
        err_of(store.insert("b".to_owned(), open("b"), NOW)),
        ApiError::TOO_MANY_SESSIONS
    );
}

#[test]
fn expired_sessions_are_swept_before_the_cap_is_checked() {
    let store = SessionStore::new(2);
    store
        .insert(
            "a".to_owned(),
            state("a", &wallet_key(), NOW + TTL, false),
            NOW,
        )
        .expect("a");
    store
        .insert(
            "b".to_owned(),
            state("b", &wallet_key(), NOW + TTL, false),
            NOW,
        )
        .expect("b");
    let later = NOW + TTL + 1;
    store
        .insert(
            "c".to_owned(),
            state("c", &wallet_key(), later + TTL, false),
            later,
        )
        .expect("expired sessions free their slots");
    assert_eq!(store.len(), 1, "both expired sessions were swept");
}

#[test]
fn live_sessions_are_not_swept_to_make_room() {
    let store = SessionStore::new(2);
    store.insert("a".to_owned(), open("a"), NOW).expect("a");
    store.insert("b".to_owned(), open("b"), NOW).expect("b");
    let almost = NOW + TTL - 1;
    assert_eq!(
        err_of(store.insert("c".to_owned(), open("c"), almost)),
        ApiError::TOO_MANY_SESSIONS
    );
    assert_eq!(store.len(), 2);
}

#[test]
fn only_the_expired_sessions_are_swept() {
    let store = SessionStore::new(3);
    store
        .insert(
            "old".to_owned(),
            state("old", &wallet_key(), NOW + 10, false),
            NOW,
        )
        .expect("old");
    store
        .insert("new1".to_owned(), open("new1"), NOW)
        .expect("new1");
    store
        .insert("new2".to_owned(), open("new2"), NOW)
        .expect("new2");
    let now = NOW + 11;
    store
        .insert("new3".to_owned(), open("new3"), now)
        .expect("slot freed by sweep");
    assert_eq!(store.len(), 3);
    assert_eq!(
        err_of(store.take_bound("old", now)),
        ApiError::SESSION_NOT_FOUND
    );
}

#[test]
fn inserting_an_id_that_exists_is_an_internal_error_and_keeps_the_first() {
    let store = SessionStore::new(4);
    store.insert("a".to_owned(), open("a"), NOW).expect("a");
    assert_eq!(
        err_of(store.insert("a".to_owned(), open("a"), NOW)),
        ApiError::INTERNAL
    );
    assert_eq!(store.len(), 1);
}

// --- bind ---------------------------------------------------------------------

#[test]
fn bind_with_the_right_wallet_and_signature_succeeds() {
    let store = SessionStore::new(4);
    let (intent, wallet) = insert_open(&store, "a");
    store
        .bind("a", &wallet, &sign_intent(&intent, &wallet_key()), NOW)
        .expect("bind");
    store.take_bound("a", NOW).expect("now bound");
}

#[test]
fn bind_with_another_wallet_is_bad_request_and_leaves_the_session_unbound() {
    let store = SessionStore::new(4);
    let (intent, _) = insert_open(&store, "a");
    let other = other_key();
    let err = err_of(store.bind(
        "a",
        &other.verifying_key().to_bytes(),
        &sign_intent(&intent, &other),
        NOW,
    ));
    assert_eq!(err, ApiError::BAD_REQUEST);
    assert_eq!(
        err_of(store.take_bound("a", NOW)),
        ApiError::SESSION_NOT_BOUND
    );
}

#[test]
fn bind_with_a_bad_signature_is_401_and_the_session_stays_unbound_and_bindable() {
    let store = SessionStore::new(4);
    let (intent, wallet) = insert_open(&store, "a");
    let wrong = sign_intent(&intent, &other_key());
    let err = err_of(store.bind("a", &wallet, &wrong, NOW));
    assert_eq!(err, ApiError::BAD_INTENT_SIGNATURE);
    assert_eq!(err.status.as_u16(), 401);
    // Still unbound: a correct signature now succeeds.
    store
        .bind("a", &wallet, &sign_intent(&intent, &wallet_key()), NOW)
        .expect("session was left unbound");
}

#[test]
fn bind_with_a_signature_over_another_sessions_intent_is_rejected() {
    let store = SessionStore::new(4);
    let (_, wallet) = insert_open(&store, "a");
    let (other_intent, _) = insert_open(&store, "b");
    let err = err_of(store.bind(
        "a",
        &wallet,
        &sign_intent(&other_intent, &wallet_key()),
        NOW,
    ));
    assert_eq!(err, ApiError::BAD_INTENT_SIGNATURE);
}

#[test]
fn bind_with_a_malformed_signature_string_is_bad_request() {
    let store = SessionStore::new(4);
    let (_, wallet) = insert_open(&store, "a");
    assert_eq!(
        err_of(store.bind("a", &wallet, "not-base58-0OIl", NOW)),
        ApiError::BAD_REQUEST
    );
}

#[test]
fn a_second_bind_is_session_already_bound_409() {
    let store = SessionStore::new(4);
    let (intent, wallet) = insert_open(&store, "a");
    let sig = sign_intent(&intent, &wallet_key());
    store.bind("a", &wallet, &sig, NOW).expect("first bind");
    let err = err_of(store.bind("a", &wallet, &sig, NOW));
    assert_eq!(err, ApiError::SESSION_ALREADY_BOUND);
    assert_eq!(err.status.as_u16(), 409);
}

#[test]
fn bind_on_an_unknown_id_is_session_not_found_404() {
    let store = SessionStore::new(4);
    let err = err_of(store.bind("missing", &[0u8; 32], "x", NOW));
    assert_eq!(err, ApiError::SESSION_NOT_FOUND);
    assert_eq!(err.status.as_u16(), 404);
}

#[test]
fn bind_after_expiry_is_session_expired_410() {
    let store = SessionStore::new(4);
    let (intent, wallet) = insert_open(&store, "a");
    let err = err_of(store.bind(
        "a",
        &wallet,
        &sign_intent(&intent, &wallet_key()),
        NOW + TTL + 1,
    ));
    assert_eq!(err, ApiError::SESSION_EXPIRED);
    assert_eq!(err.status.as_u16(), 410);
}

// --- take_bound ---------------------------------------------------------------

#[test]
fn take_after_bind_returns_the_state_and_removes_it() {
    let store = SessionStore::new(4);
    bind_ok(&store, "a");
    let taken = store.take_bound("a", NOW).expect("take");
    assert_eq!(taken.txnid, "txn-1");
    assert_eq!(taken.consent_id, "consent-1");
    assert_eq!(taken.measurement_id, 3);
    assert!(taken.bound);
    assert_eq!(taken.wallet, wallet_key().verifying_key().to_bytes());
    assert_eq!(store.len(), 0);
    assert_eq!(
        err_of(store.take_bound("a", NOW)),
        ApiError::SESSION_NOT_FOUND
    );
}

#[test]
fn take_before_bind_is_session_not_bound_and_removes_the_session() {
    let store = SessionStore::new(4);
    insert_open(&store, "a");
    let err = err_of(store.take_bound("a", NOW));
    assert_eq!(err, ApiError::SESSION_NOT_BOUND);
    assert_eq!(err.status.as_u16(), 409);
    assert_eq!(store.len(), 0, "single use: removed even though it failed");
    assert_eq!(
        err_of(store.take_bound("a", NOW)),
        ApiError::SESSION_NOT_FOUND
    );
}

#[test]
fn take_of_a_planted_bound_session_works_without_a_bind() {
    let store = SessionStore::new(4);
    store
        .insert(
            "a".to_owned(),
            state("a", &wallet_key(), NOW + TTL, true),
            NOW,
        )
        .expect("insert");
    store.take_bound("a", NOW).expect("already bound");
}

#[test]
fn take_after_expiry_is_session_expired_and_removes_the_session() {
    let store = SessionStore::new(4);
    bind_ok(&store, "a");
    let late = NOW + TTL + 1;
    let err = err_of(store.take_bound("a", late));
    assert_eq!(err, ApiError::SESSION_EXPIRED);
    assert_eq!(err.status.as_u16(), 410);
    assert_eq!(
        err_of(store.take_bound("a", late)),
        ApiError::SESSION_NOT_FOUND
    );
}

#[test]
fn take_on_an_unknown_id_is_session_not_found() {
    let store = SessionStore::new(4);
    assert_eq!(
        err_of(store.take_bound("nope", NOW)),
        ApiError::SESSION_NOT_FOUND
    );
}

#[test]
fn taking_one_session_leaves_the_others() {
    let store = SessionStore::new(4);
    bind_ok(&store, "a");
    bind_ok(&store, "b");
    store.take_bound("a", NOW).expect("a");
    assert_eq!(store.len(), 1);
    store.take_bound("b", NOW).expect("b");
}

#[test]
fn a_freed_slot_can_be_reused_at_the_cap() {
    let store = SessionStore::new(1);
    bind_ok(&store, "a");
    store.take_bound("a", NOW).expect("a");
    store
        .insert("b".to_owned(), open("b"), NOW)
        .expect("slot is free again");
}
