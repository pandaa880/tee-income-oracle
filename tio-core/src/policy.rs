//! Scoring policy (`docs/FORMATS.md` §6): strict parse, canonical JSON
//! (RFC 8785, JCS) and `policy_hash = sha256(JCS(policy))`.
//!
//! The policy arrives from the untrusted gateway, and its hash is what the
//! attestation commits to. So every spelling of the same policy must give the
//! same hash, and anything ambiguous is rejected rather than guessed.

use serde::{
    de::{DeserializeOwned, Error as _},
    Deserialize, Deserializer, Serialize,
};
use serde_json::value::RawValue;
use sha2::{Digest, Sha256};

use crate::{encoding::from_json_object, ErrorCode};

/// Largest policy accepted, in bytes. The v2 default is about 400 bytes.
pub const MAX_POLICY_BYTES: usize = 4096;

/// The only policy schema version this build accepts (FORMATS §0.1).
const POLICY_VERSION: u32 = 2;

/// A tier a policy can award. Reject is not a tier: it is never written
/// on-chain (FORMATS §7). Ordered best first: `A < B < C`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize)]
pub enum Tier {
    A,
    B,
    C,
}

/// `sha256(JCS(policy))`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct PolicyHash([u8; 32]);

impl PolicyHash {
    /// The 32 hash bytes.
    pub fn as_bytes(&self) -> &[u8; 32] {
        &self.0
    }
}

/// A validated policy. Only [`Policy::from_json`] builds one.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Policy {
    pub(crate) rules: Rules,
    canonical: Vec<u8>,
    hash: PolicyHash,
}

/// Why a policy was rejected. All map to code `bad_policy`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum PolicyError {
    #[error("policy is larger than the size limit")]
    TooLarge,
    #[error("policy is not a well-formed v2 policy object")]
    Malformed,
    #[error("unsupported policy version")]
    UnsupportedVersion,
    #[error("policy tiers must be non-empty and strictly ordered A, B, C")]
    BadTiers,
    #[error("policy field must be at least 1")]
    ZeroValue,
}

impl ErrorCode for PolicyError {
    fn code(&self) -> &'static str {
        "bad_policy"
    }
}

// Field order below is the JCS key order (byte-sorted): derived `Serialize`
// writes fields in declaration order, so `serde_json::to_vec` gives the
// canonical bytes. Don't reorder.

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Rules {
    pub(crate) recent_months: u32,
    #[serde(deserialize_with = "object")]
    pub(crate) recurrence: Recurrence,
    #[serde(deserialize_with = "object")]
    pub(crate) reject_if: RejectIf,
    #[serde(deserialize_with = "objects")]
    pub(crate) tiers: Vec<TierRule>,
    pub(crate) v: u32,
    #[serde(deserialize_with = "object")]
    pub(crate) window: Window,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Recurrence {
    pub(crate) amount_tol_bps: u32,
    pub(crate) day_tol: u32,
    pub(crate) min_occurrences: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct RejectIf {
    pub(crate) od_days_min: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct TierRule {
    pub(crate) bounces_max: u32,
    pub(crate) cv_max_bps: u32,
    pub(crate) foir_max_bps: u32,
    pub(crate) tier: Tier,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Window {
    pub(crate) max_age_days: u32,
    pub(crate) min_days: u32,
}

/// Nested structs must be JSON objects too. Derived visitors also accept a
/// positional array (`"window":[7,180]`), which JCS of the input would keep
/// as an array while our re-serialized bytes have an object: two different
/// hashes for one policy. So each nested value is read raw and re-parsed
/// object-only.
fn object<'de, D: Deserializer<'de>, T: DeserializeOwned>(deserializer: D) -> Result<T, D::Error> {
    let raw = Box::<RawValue>::deserialize(deserializer)?;
    from_json_object(raw.get().as_bytes()).ok_or_else(|| D::Error::custom("expected a JSON object"))
}

/// [`object`] for each element of an array.
fn objects<'de, D: Deserializer<'de>, T: DeserializeOwned>(
    deserializer: D,
) -> Result<Vec<T>, D::Error> {
    Vec::<Box<RawValue>>::deserialize(deserializer)?
        .iter()
        .map(|raw| {
            from_json_object(raw.get().as_bytes())
                .ok_or_else(|| D::Error::custom("expected a JSON object"))
        })
        .collect()
}

/// Only the strings `"A"`, `"B"`, `"C"`. The derived enum visitor would also
/// accept `{"A":null}`, another spelling whose JCS differs from ours. Owned
/// `String`, so an escaped `"\u0041"` still parses.
impl<'de> Deserialize<'de> for Tier {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        match String::deserialize(deserializer)?.as_str() {
            "A" => Ok(Tier::A),
            "B" => Ok(Tier::B),
            "C" => Ok(Tier::C),
            _ => Err(D::Error::custom("unknown tier")),
        }
    }
}

impl Policy {
    /// Parses and validates a policy, then computes its canonical bytes and
    /// hash. Accepts any JSON spelling of a valid policy; all spellings give
    /// the same bytes and hash.
    ///
    /// # Errors
    ///
    /// - [`PolicyError::TooLarge`]: more than [`MAX_POLICY_BYTES`] bytes.
    /// - [`PolicyError::Malformed`]: not a JSON object of the §6 shape (any
    ///   nested value not an object, unknown/repeated/missing key, wrong type,
    ///   non-integer, unknown tier letter).
    /// - [`PolicyError::UnsupportedVersion`]: `v` is not 2.
    /// - [`PolicyError::BadTiers`]: `tiers` empty or not strictly A, B, C.
    /// - [`PolicyError::ZeroValue`]: `recent_months`, `min_occurrences` or
    ///   `od_days_min` is 0.
    pub fn from_json(bytes: &[u8]) -> Result<Self, PolicyError> {
        if bytes.len() > MAX_POLICY_BYTES {
            return Err(PolicyError::TooLarge);
        }
        let rules: Rules = from_json_object(bytes).ok_or(PolicyError::Malformed)?;
        check_version(&rules)?;
        check_tiers(&rules.tiers)?;
        check_non_zero(&rules)?;
        let canonical = serde_json::to_vec(&rules).map_err(|_| PolicyError::Malformed)?;
        let hash = PolicyHash(Sha256::digest(&canonical).into());
        Ok(Policy {
            rules,
            canonical,
            hash,
        })
    }

    /// The exact JCS bytes the hash commits to.
    pub fn canonical_json(&self) -> &[u8] {
        &self.canonical
    }

    /// `sha256(canonical_json())`.
    pub fn hash(&self) -> PolicyHash {
        self.hash
    }
}

fn check_version(rules: &Rules) -> Result<(), PolicyError> {
    if rules.v == POLICY_VERSION {
        Ok(())
    } else {
        Err(PolicyError::UnsupportedVersion)
    }
}

/// Non-empty, strictly ascending (A before B before C), and each tier looser
/// than the one before it ([`loosens`]). Tiers are matched first-to-last:
/// this keeps every listed tier reachable and A the strictest, which is what
/// a pool assumes when it reads the tier byte. A mixed pair (looser in one
/// limit, stricter in another) is reachable but rejected for that reason.
fn check_tiers(tiers: &[TierRule]) -> Result<(), PolicyError> {
    let ordered = tiers.windows(2).all(|pair| match pair {
        [a, b] => a.tier < b.tier && loosens(a, b),
        _ => false,
    });
    if tiers.is_empty() || !ordered {
        return Err(PolicyError::BadTiers);
    }
    Ok(())
}

/// `later` is never stricter than `earlier` and strictly looser in at least
/// one limit. Then a borrower exactly at `later`'s limits passes `later` but
/// fails `earlier` (and every tier before it), so `later` is reachable.
fn loosens(earlier: &TierRule, later: &TierRule) -> bool {
    let limits = |t: &TierRule| [t.foir_max_bps, t.cv_max_bps, t.bounces_max];
    let never_stricter = limits(earlier)
        .into_iter()
        .zip(limits(later))
        .all(|(e, l)| l >= e);
    never_stricter && limits(earlier) != limits(later)
}

/// Values that would make scoring undefined or its outcome fixed: no recent
/// months, every candidate "recurring", or every borrower rejected
/// (`od_days >= 0` always holds).
fn check_non_zero(rules: &Rules) -> Result<(), PolicyError> {
    let values = [
        rules.recent_months,
        rules.recurrence.min_occurrences,
        rules.reject_if.od_days_min,
    ];
    if values.contains(&0) {
        return Err(PolicyError::ZeroValue);
    }
    Ok(())
}

#[cfg(test)]
mod tests;
