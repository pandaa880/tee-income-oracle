//! Request log: one line per request with the session id, the stage and the
//! outcome code only (CODING-GUIDELINES §1.9). Never a field of a request,
//! a statement or an evaluation.

/// Writes `session=<id> stage=<stage> code=<code>` to stderr.
pub fn event(session_id: Option<&str>, stage: &str, code: &str) {
    eprintln!(
        "session={} stage={stage} code={code}",
        session_id.unwrap_or("-")
    );
}
