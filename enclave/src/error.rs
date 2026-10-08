//! HTTP errors: `{ "error": { "code", "message" } }` (FORMATS §10). The
//! message is a fixed string per code, so no error ever carries request or
//! statement data.

use axum::{
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use serde_json::json;

/// A stable error code and the HTTP status it is sent with.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ApiError {
    pub status: StatusCode,
    pub code: &'static str,
}

impl ApiError {
    pub const fn new(status: StatusCode, code: &'static str) -> Self {
        Self { status, code }
    }

    /// 400: malformed JSON, unknown members, bad encodings or field values.
    pub const BAD_REQUEST: Self = Self::new(StatusCode::BAD_REQUEST, "bad_request");
    /// 404: no session with this id (never created, already evaluated, or swept).
    pub const SESSION_NOT_FOUND: Self = Self::new(StatusCode::NOT_FOUND, "session_not_found");
    /// 410: the session's TTL has passed.
    pub const SESSION_EXPIRED: Self = Self::new(StatusCode::GONE, "session_expired");
    /// 409: evaluate before bind.
    pub const SESSION_NOT_BOUND: Self = Self::new(StatusCode::CONFLICT, "session_not_bound");
    /// 409: bind twice.
    pub const SESSION_ALREADY_BOUND: Self =
        Self::new(StatusCode::CONFLICT, "session_already_bound");
    /// 401: the wallet's signature over the intent doesn't verify.
    pub const BAD_INTENT_SIGNATURE: Self =
        Self::new(StatusCode::UNAUTHORIZED, "bad_intent_signature");
    /// 503: the open-session cap is reached.
    pub const TOO_MANY_SESSIONS: Self =
        Self::new(StatusCode::SERVICE_UNAVAILABLE, "too_many_sessions");
    /// 503: the create/bind in-flight cap is reached; retry later.
    pub const TOO_MANY_REQUESTS: Self =
        Self::new(StatusCode::SERVICE_UNAVAILABLE, "too_many_requests");
    /// 503: the evaluate in-flight cap is reached; retry later.
    pub const TOO_MANY_EVALUATIONS: Self =
        Self::new(StatusCode::SERVICE_UNAVAILABLE, "too_many_evaluations");
    /// 408: the evaluate body didn't arrive within the read timeout.
    pub const BODY_TIMEOUT: Self = Self::new(StatusCode::REQUEST_TIMEOUT, "body_timeout");
    /// 413: the body is over the route's cap.
    pub const BODY_TOO_LARGE: Self = Self::new(StatusCode::PAYLOAD_TOO_LARGE, "body_too_large");
    /// 500: something that should never happen (signing, serialization).
    pub const INTERNAL: Self = Self::new(StatusCode::INTERNAL_SERVER_ERROR, "internal_error");

    /// 422 with a `tio-core` code (evaluate pipeline, policy, consent).
    pub const fn unprocessable(code: &'static str) -> Self {
        Self::new(StatusCode::UNPROCESSABLE_ENTITY, code)
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let body = Json(json!({ "error": { "code": self.code, "message": message(self.code) } }));
        (self.status, body).into_response()
    }
}

/// A fixed, data-free sentence per code.
fn message(code: &str) -> &'static str {
    match code {
        "bad_request" => "the request is malformed",
        "session_not_found" => "no such session",
        "session_expired" => "the session has expired",
        "session_not_bound" => "the session is not bound to a wallet",
        "session_already_bound" => "the session is already bound",
        "bad_intent_signature" => "the wallet signature over the intent does not verify",
        "too_many_sessions" => "too many open sessions",
        "body_too_large" => "the request body is too large",
        "too_many_evaluations" => "too many evaluations in progress",
        "too_many_requests" => "too many requests in progress",
        "body_timeout" => "the request body did not arrive in time",
        "internal_error" => "internal error",
        _ => "the request was rejected; see the code",
    }
}
