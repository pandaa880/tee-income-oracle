//! The trusted pipeline (`docs/FORMATS.md` §10.1): signed AA response and
//! consent, plus the enclave's session state, in; an outcome and the signed
//! attestation message out.
//!
//! One error per call, the first check that fails. The order matters for two
//! reasons. Everything that can be decided from the signed outer layers
//! (steps 1-10) is decided before the ciphertext is decrypted, so a request
//! that can't produce a valid result never touches plaintext. And an error
//! code never depends on data from a later layer, so a failing code can't
//! leak anything about the statement.
//!
//! Plaintext hygiene (invariant 1): the decrypted envelope stays in the
//! `Zeroizing` buffer `decrypt` returned, its fields are borrowed from it
//! (an envelope containing a backslash is refused, because an escaped string
//! can't be borrowed and serde_json would copy it into an unwiped scratch
//! buffer), and the decoded statement goes into a `Zeroizing` buffer sized up
//! front, so no unwiped copy is left on the heap. Errors carry no data.

use base64::{engine::general_purpose::STANDARD, Engine};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use zeroize::Zeroizing;

use crate::{
    attest::{
        build_message, build_payload, AttestContext, PayloadFields, MESSAGE_LEN, PAYLOAD_LEN,
    },
    cipher::{decrypt, derive_session_key, DecryptError, Nonce},
    ecdh::{KeyError, SessionKeyPair},
    encoding::{from_json_object, object, objects},
    jws::{verify_compact, verify_detached, JwsError, PinnedKey},
    key_material::{KeyMaterial, KeyMaterialError},
    policy::{Policy, PolicyHash},
    rebit::{parse_deposit_fi, DepositFi, FiError},
    score::{score, Outcome, ScoreError, Scores},
    time::{india_day, parse_rebit_timestamp, SECS_PER_DAY},
    ErrorCode,
};

/// The FI data range the enclave asked for. `0 <= from < to <= u32::MAX`
/// (unix seconds), so its day-floored ends always fit the payload's `u32`s.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FiDataRange {
    from: i64,
    to: i64,
}

/// The requested range is empty, negative or past `u32::MAX`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
#[error("bad FI data range")]
pub struct RangeError;

impl ErrorCode for RangeError {
    fn code(&self) -> &'static str {
        "bad_fi_data_range"
    }
}

impl FiDataRange {
    /// # Errors
    /// [`RangeError`] unless `0 <= from < to <= u32::MAX`.
    pub fn new(from: i64, to: i64) -> Result<Self, RangeError> {
        let max = i64::from(u32::MAX);
        if from < 0 || from >= to || to > max {
            return Err(RangeError);
        }
        Ok(Self { from, to })
    }

    /// Start, unix seconds.
    pub fn from(&self) -> i64 {
        self.from
    }

    /// End, unix seconds.
    pub fn to(&self) -> i64 {
        self.to
    }
}

/// What the enclave holds for one session.
pub struct Session<'a> {
    pub key_pair: &'a SessionKeyPair,
    /// The enclave's own nonce (ours in the key derivation).
    pub nonce: &'a Nonce,
    pub txnid: &'a str,
    pub consent_id: &'a str,
    pub range: FiDataRange,
    pub policy: &'a Policy,
    pub wallet: [u8; 32],
}

/// Pinned verification keys, chosen by `kid` (never taken from a message).
pub struct PinnedKeys<'a> {
    pub aa: &'a [PinnedKey],
    pub fip: &'a [PinnedKey],
}

/// The untrusted gateway's bytes.
pub struct EvaluateInput<'a> {
    /// The AA response body, exactly as received (the JWS covers its bytes).
    pub fetch_response: &'a [u8],
    pub fetch_response_jws: &'a str,
    pub consent_jws: &'a str,
}

/// Time inputs: the crate has no clock of its own.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Clock {
    /// Current unix time. Must come from the same clock that set the session's
    /// requested `to`: the future-end rule (step 10) compares the two.
    pub now: i64,
    /// Expiry written into the signed message (§8). The caller (the enclave)
    /// sets it after `now`; it is not checked here.
    pub expiry: i64,
}

/// The §7 payload and the §8 message built from it, ready to sign.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Attestation {
    pub payload: [u8; PAYLOAD_LEN],
    pub message: [u8; MESSAGE_LEN],
}

/// Result of a successful evaluation.
///
/// Only `outcome` and `attestation` may leave the enclave; `scores` exists
/// for tests and vectors.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Evaluation {
    pub outcome: Outcome,
    pub scores: Scores,
    pub policy_hash: PolicyHash,
    pub consent_hash: [u8; 32],
    pub window_from: u32,
    pub window_to: u32,
    /// `None` for a reject: a reject is never written on-chain.
    pub attestation: Option<Attestation>,
}

/// Why an evaluation failed, one variant per check. Carries no data.
#[derive(Debug, PartialEq, Eq, thiserror::Error)]
pub enum EvaluateError {
    #[error("fetch response signature: {0}")]
    AaSignature(JwsError),
    #[error("malformed fetch response")]
    BadFetchResponse,
    #[error("response does not belong to this session")]
    SessionMismatch,
    #[error("consent signature: {0}")]
    ConsentSignature(JwsError),
    #[error("consent is invalid or not active")]
    ConsentInvalid,
    #[error("window is outside the consent, the request or the statement")]
    WindowMismatch,
    #[error("window is shorter than the policy minimum")]
    WindowTooShort,
    #[error("window ended longer ago than the policy allows")]
    WindowStale,
    #[error("key material: {0}")]
    KeyMaterial(KeyMaterialError),
    #[error("key agreement: {0}")]
    Key(KeyError),
    #[error("decryption: {0}")]
    Decrypt(DecryptError),
    #[error("malformed FIP envelope")]
    BadFipEnvelope,
    #[error("FIP signature: {0}")]
    FipSignature(JwsError),
    #[error("statement: {0}")]
    Fi(FiError),
    #[error("scoring: {0}")]
    Score(ScoreError),
}

/// A bad signature takes the code of the layer it was found in; every other
/// JWS error keeps its own code.
fn layered(layer: &'static str, err: &JwsError) -> &'static str {
    match err {
        JwsError::BadSignature => layer,
        other => other.code(),
    }
}

impl ErrorCode for EvaluateError {
    fn code(&self) -> &'static str {
        match self {
            Self::AaSignature(e) => layered("bad_aa_signature", e),
            Self::BadFetchResponse => "bad_fetch_response",
            Self::SessionMismatch => "session_mismatch",
            Self::ConsentSignature(e) => layered("bad_consent_signature", e),
            Self::ConsentInvalid => "consent_invalid",
            Self::WindowMismatch => "window_mismatch",
            Self::WindowTooShort => "window_too_short",
            Self::WindowStale => "window_stale",
            Self::KeyMaterial(e) => e.code(),
            Self::Key(e) => e.code(),
            Self::Decrypt(e) => e.code(),
            Self::BadFipEnvelope => "bad_fip_envelope",
            Self::FipSignature(e) => layered("bad_fip_signature", e),
            Self::Fi(e) => e.code(),
            Self::Score(e) => e.code(),
        }
    }
}

// --- Wire shapes ---------------------------------------------------------
//
// Owned serde structs, read object-only (`object` / `objects` /
// `from_json_object`): serde's derived struct visitor would also take an
// array, which no other implementation does. A repeated declared member is
// an error; members we don't read are ignored. `KeyMaterial` itself is read
// object-only, but its nested `DHPublicKey` is a plain derived struct, which
// would also take an array. That is a known looseness: it sits inside the
// AA-signed bytes, and no vector uses it.

#[derive(Deserialize)]
struct FetchResponse {
    txnid: String,
    #[serde(rename = "FI", deserialize_with = "objects")]
    fi: Vec<FiEntry>,
}

#[derive(Deserialize)]
struct FiEntry {
    #[serde(deserialize_with = "objects")]
    data: Vec<FiData>,
    #[serde(rename = "KeyMaterial", deserialize_with = "object")]
    key_material: KeyMaterial,
}

#[derive(Deserialize)]
struct FiData {
    #[serde(rename = "encryptedFI")]
    encrypted_fi: String,
}

#[derive(Deserialize)]
struct RawConsent {
    #[serde(rename = "consentId")]
    consent_id: String,
    status: String,
    #[serde(rename = "consentStart")]
    start: String,
    #[serde(rename = "consentExpiry")]
    expiry: String,
    #[serde(rename = "fiTypes")]
    fi_types: Vec<String>,
    #[serde(rename = "FIDataRange", deserialize_with = "object")]
    range: RawConsentRange,
}

#[derive(Deserialize)]
struct RawConsentRange {
    from: String,
    to: String,
}

/// The decrypted envelope (§5.2). Borrowed from the plaintext buffer, so no
/// `String` copy of it exists. `open_envelope` refuses any `\` first, so the
/// members are never escaped and never copied by the parser.
#[derive(Deserialize)]
struct Envelope<'a> {
    fi: &'a str,
    jws: &'a str,
}

/// A consent with every field parsed and `from < to` checked.
struct Consent {
    id: String,
    active: bool,
    deposit: bool,
    start: i64,
    expiry: i64,
    from: i64,
    to: i64,
}

/// A window in unix seconds on a UTC day boundary. The floored request range
/// is checked before decryption; the statement's own window (its dates at
/// 00:00 UTC) is what the payload carries.
#[derive(Clone, Copy)]
struct Window {
    from: u32,
    to: u32,
}

// --- Steps ---------------------------------------------------------------

/// Step 2: object shape, and exactly one account.
///
/// One `KeyMaterial` gives one AES key and IV. Two ciphertexts under one key
/// and IV break AES-GCM: the XOR of the plaintexts leaks and the GHASH key
/// can be recovered (NIST SP 800-38D). So reject until a provider shows
/// per-account keys or nonces. This also rules out several FIPs.
fn parse_fetch_response(body: &[u8]) -> Result<(String, KeyMaterial, String), EvaluateError> {
    let response: FetchResponse = from_json_object(body).ok_or(EvaluateError::BadFetchResponse)?;
    let FetchResponse { txnid, fi } = response;
    let (Some(entry), None) = single(fi) else {
        return Err(EvaluateError::BadFetchResponse);
    };
    let FiEntry { data, key_material } = entry;
    let (Some(item), None) = single(data) else {
        return Err(EvaluateError::BadFetchResponse);
    };
    Ok((txnid, key_material, item.encrypted_fi))
}

/// First element and the next one, if any.
fn single<T>(items: Vec<T>) -> (Option<T>, Option<T>) {
    let mut it = items.into_iter();
    (it.next(), it.next())
}

/// Step 5: the consent payload, every field typed and parsed.
fn parse_consent(payload: &[u8]) -> Result<Consent, EvaluateError> {
    let raw: RawConsent = from_json_object(payload).ok_or(EvaluateError::ConsentInvalid)?;
    let time = |s: &str| parse_rebit_timestamp(s).map_err(|_| EvaluateError::ConsentInvalid);
    let (from, to) = (time(&raw.range.from)?, time(&raw.range.to)?);
    if from >= to {
        return Err(EvaluateError::ConsentInvalid);
    }
    Ok(Consent {
        active: raw.status == "ACTIVE",
        deposit: raw.fi_types.iter().any(|t| t == "DEPOSIT"),
        start: time(&raw.start)?,
        expiry: time(&raw.expiry)?,
        id: raw.consent_id,
        from,
        to,
    })
}

/// Step 7: active, covers DEPOSIT, and `start <= now < expiry`.
fn check_consent_active(consent: &Consent, now: i64) -> Result<(), EvaluateError> {
    if consent.active && consent.deposit && consent.start <= now && now < consent.expiry {
        Ok(())
    } else {
        Err(EvaluateError::ConsentInvalid)
    }
}

/// Step 8: the request stays inside what the user consented to.
fn check_within_consent(range: FiDataRange, consent: &Consent) -> Result<(), EvaluateError> {
    if consent.from <= range.from() && range.to() <= consent.to {
        Ok(())
    } else {
        Err(EvaluateError::WindowMismatch)
    }
}

/// Step 9 (first half): floor both ends to a UTC day, as written in §7.
fn floor_window(range: FiDataRange) -> Result<Window, EvaluateError> {
    let floor = |t: i64| {
        u32::try_from(t.div_euclid(SECS_PER_DAY) * SECS_PER_DAY)
            .map_err(|_| EvaluateError::WindowMismatch)
    };
    Ok(Window {
        from: floor(range.from())?,
        to: floor(range.to())?,
    })
}

/// The window spans at least `min_days`. i64 holds every product
/// (`u32 * 86400`). Shared by the request (step 9) and the statement (15b):
/// the length is `to - from`, which is what the pool reads from the payload.
fn check_long_enough(window: Window, policy: &Policy) -> Result<(), EvaluateError> {
    let length = i64::from(window.to) - i64::from(window.from);
    if length < i64::from(policy.rules.window.min_days) * SECS_PER_DAY {
        return Err(EvaluateError::WindowTooShort);
    }
    Ok(())
}

/// The window ended at most `max_age_days` before `now` (checked math).
/// Shared by the request (step 10) and the statement (15c).
fn check_fresh(window: Window, policy: &Policy, now: i64) -> Result<(), EvaluateError> {
    let max_age = i64::from(policy.rules.window.max_age_days) * SECS_PER_DAY;
    match now.checked_sub(i64::from(window.to)) {
        Some(age) if age <= max_age => Ok(()),
        _ => Err(EvaluateError::WindowStale),
    }
}

/// Steps 9 and 10: the requested window is long enough, recent enough, and
/// does not end after `now`.
///
/// The future check uses the raw requested end: a window can't end after the
/// moment it is evaluated, or the payload would attest days that haven't
/// happened yet.
fn check_window_policy(
    window: Window,
    range: FiDataRange,
    policy: &Policy,
    now: i64,
) -> Result<(), EvaluateError> {
    check_long_enough(window, policy)?;
    check_fresh(window, policy, now)?;
    if range.to() > now {
        return Err(EvaluateError::WindowMismatch);
    }
    Ok(())
}

/// Step 11: ECDH, session key, AES-GCM.
fn decrypt_fi(
    session: &Session<'_>,
    key_material: &KeyMaterial,
    encrypted_fi: &str,
) -> Result<Zeroizing<Vec<u8>>, EvaluateError> {
    let peer = key_material
        .peer_public_key()
        .map_err(EvaluateError::KeyMaterial)?;
    let theirs = key_material.nonce().map_err(EvaluateError::KeyMaterial)?;
    let shared = session
        .key_pair
        .shared_secret(&peer)
        .map_err(EvaluateError::Key)?;
    let key =
        derive_session_key(&shared, session.nonce, &theirs).map_err(EvaluateError::Decrypt)?;
    decrypt(&key, encrypted_fi).map_err(EvaluateError::Decrypt)
}

/// Step 12: the FIP envelope. Returns the decoded statement bytes (wiped on
/// drop) and the borrowed detached JWS.
fn open_envelope(plaintext: &[u8]) -> Result<(Zeroizing<Vec<u8>>, &str), EvaluateError> {
    if plaintext.trim_ascii_start().first() != Some(&b'{') {
        return Err(EvaluateError::BadFipEnvelope);
    }
    // Refuse escapes up front. Given a borrowed `&str` with an escape,
    // serde_json copies the string into its internal scratch `Vec`, which is
    // freed unwiped. Base64 and compact JWS never need escapes, so refusing
    // them keeps every plaintext byte in the `Zeroizing` buffer.
    if plaintext.contains(&b'\\') {
        return Err(EvaluateError::BadFipEnvelope);
    }
    let envelope: Envelope<'_> =
        serde_json::from_slice(plaintext).map_err(|_| EvaluateError::BadFipEnvelope)?;
    // Pre-sized so decoding never reallocates (a grown `Vec` would free an
    // unwiped old buffer of statement bytes).
    let mut fi = Zeroizing::new(vec![0u8; base64::decoded_len_estimate(envelope.fi.len())]);
    let len = STANDARD
        .decode_slice(envelope.fi, fi.as_mut_slice())
        .map_err(|_| EvaluateError::BadFipEnvelope)?;
    fi.truncate(len);
    Ok((fi, envelope.jws))
}

/// Step 15: the statement's own window, which the payload will carry.
///
/// It must lie inside the requested window by India day (15), and is then
/// held to the policy itself: `window_from`/`window_to` are the statement's
/// `startDate`/`endDate` at 00:00 UTC, long enough (15b) and fresh (15c). The
/// request-level checks (steps 9-10) can't stand in for these: a FIP-signed
/// statement ending months before the requested end would otherwise get a
/// fresh attestation claiming the requested window. Each date goes through
/// `u32::try_from` so the payload fields can't wrap.
fn check_statement_window(
    fi: &DepositFi,
    requested: Window,
    policy: &Policy,
    now: i64,
) -> Result<Window, EvaluateError> {
    let inside = india_day(i64::from(requested.from)) <= fi.start_day
        && fi.end_day <= india_day(i64::from(requested.to));
    if !inside {
        return Err(EvaluateError::WindowMismatch);
    }
    let at_midnight = |day: i64| {
        day.checked_mul(SECS_PER_DAY)
            .and_then(|t| u32::try_from(t).ok())
            .ok_or(EvaluateError::WindowMismatch)
    };
    let window = Window {
        from: at_midnight(fi.start_day)?,
        to: at_midnight(fi.end_day)?,
    };
    check_long_enough(window, policy)?;
    check_fresh(window, policy, now)?;
    Ok(window)
}

/// Steps 11-16: from the encrypted statement to its scores and the
/// statement's window.
fn score_statement(
    session: &Session<'_>,
    keys: &PinnedKeys<'_>,
    key_material: &KeyMaterial,
    encrypted_fi: &str,
    requested: Window,
    now: i64,
) -> Result<(Scores, Window), EvaluateError> {
    let plaintext = decrypt_fi(session, key_material, encrypted_fi)?;
    let (fi_bytes, jws) = open_envelope(&plaintext)?;
    verify_detached(jws, &fi_bytes, keys.fip).map_err(EvaluateError::FipSignature)?;
    let fi = parse_deposit_fi(&fi_bytes).map_err(EvaluateError::Fi)?;
    let window = check_statement_window(&fi, requested, session.policy, now)?;
    let scores = score(&fi, session.policy).map_err(EvaluateError::Score)?;
    Ok((scores, window))
}

/// Step 17: hashes, and for a tier the payload and message (a reject has
/// none). `window` is the statement's.
fn finish(
    session: &Session<'_>,
    ctx: &AttestContext,
    clock: Clock,
    consent_jws: &str,
    window: Window,
    scores: Scores,
) -> Evaluation {
    let consent_hash: [u8; 32] = Sha256::digest(consent_jws.as_bytes()).into();
    let policy_hash = session.policy.hash();
    let attestation = match scores.outcome {
        Outcome::Tier(tier) => {
            let payload = build_payload(&PayloadFields {
                tier,
                proof_type: ctx.proof_type,
                measurement_id: ctx.measurement_id,
                policy_hash,
                consent_hash,
                issued_at: clock.now,
                window_from: window.from,
                window_to: window.to,
            });
            let message = build_message(ctx, &session.wallet, &payload, clock.expiry);
            Some(Attestation { payload, message })
        }
        Outcome::Reject => None,
    };
    Evaluation {
        outcome: scores.outcome,
        scores,
        policy_hash,
        consent_hash,
        window_from: window.from,
        window_to: window.to,
        attestation,
    }
}

/// Runs the whole pipeline (§10.1). See the module docs for the order.
///
/// # Errors
/// The first failing check, as an [`EvaluateError`].
pub fn evaluate(
    session: &Session<'_>,
    keys: &PinnedKeys<'_>,
    input: &EvaluateInput<'_>,
    ctx: &AttestContext,
    clock: Clock,
) -> Result<Evaluation, EvaluateError> {
    // Steps 1-10 never touch plaintext: a request that can't produce a valid
    // result is rejected before anything is decrypted.
    verify_detached(input.fetch_response_jws, input.fetch_response, keys.aa)
        .map_err(EvaluateError::AaSignature)?;
    let (txnid, key_material, encrypted_fi) = parse_fetch_response(input.fetch_response)?;
    if txnid != session.txnid {
        return Err(EvaluateError::SessionMismatch);
    }
    let consent_bytes =
        verify_compact(input.consent_jws, keys.aa).map_err(EvaluateError::ConsentSignature)?;
    let consent = parse_consent(&consent_bytes)?;
    if consent.id != session.consent_id {
        return Err(EvaluateError::SessionMismatch);
    }
    check_consent_active(&consent, clock.now)?;
    check_within_consent(session.range, &consent)?;
    let requested = floor_window(session.range)?;
    check_window_policy(requested, session.range, session.policy, clock.now)?;

    let (scores, window) = score_statement(
        session,
        keys,
        &key_material,
        &encrypted_fi,
        requested,
        clock.now,
    )?;
    Ok(finish(
        session,
        ctx,
        clock,
        input.consent_jws,
        window,
        scores,
    ))
}

/// What the FI request (§5.1) needs from the consent: its id and the
/// signature segment of its compact JWS.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConsentRef {
    /// `consentId` from the verified payload.
    pub id: String,
    /// The third segment of the compact JWS, as received.
    pub signature: String,
}

/// Verifies the consent's AA signature, then reads its `consentId`. Used
/// at session create; `evaluate` re-checks the whole consent (§10.1).
///
/// # Errors
/// [`EvaluateError::ConsentSignature`] or [`EvaluateError::ConsentInvalid`].
pub fn consent_ref(consent_jws: &str, aa: &[PinnedKey]) -> Result<ConsentRef, EvaluateError> {
    let payload = verify_compact(consent_jws, aa).map_err(EvaluateError::ConsentSignature)?;
    let consent = parse_consent(&payload)?;
    // `verify_compact` accepted exactly three segments, so the last one is
    // the signature.
    let signature = consent_jws
        .rsplit('.')
        .next()
        .ok_or(EvaluateError::ConsentInvalid)?;
    Ok(ConsentRef {
        id: consent.id,
        signature: signature.to_owned(),
    })
}

#[cfg(test)]
mod tests;
