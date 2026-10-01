#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::indexing_slicing,
    clippy::panic
)]

use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use super::*;

/// FORMATS §6 v2 default, hand-written JCS (keys sorted, no whitespace).
/// Same literal as `sandbox-bank/src/vectors/policy.test.ts`.
const CANONICAL: &str = concat!(
    r#"{"recent_months":3,"recurrence":{"amount_tol_bps":1000,"day_tol":5,"min_occurrences":3},"#,
    r#""reject_if":{"od_days_min":30},"#,
    r#""tiers":[{"bounces_max":0,"cv_max_bps":1500,"foir_max_bps":4000,"tier":"A"},"#,
    r#"{"bounces_max":1,"cv_max_bps":5000,"foir_max_bps":5500,"tier":"B"},"#,
    r#"{"bounces_max":3,"cv_max_bps":6000,"foir_max_bps":7000,"tier":"C"}],"#,
    r#""v":2,"window":{"max_age_days":7,"min_days":180}}"#,
);

fn default_value() -> Value {
    json!({
        "v": 2,
        "recurrence": { "amount_tol_bps": 1000, "day_tol": 5, "min_occurrences": 3 },
        "recent_months": 3,
        "window": { "min_days": 180, "max_age_days": 7 },
        "tiers": [
            { "tier": "A", "foir_max_bps": 4000, "cv_max_bps": 1500, "bounces_max": 0 },
            { "tier": "B", "foir_max_bps": 5500, "cv_max_bps": 5000, "bounces_max": 1 },
            { "tier": "C", "foir_max_bps": 7000, "cv_max_bps": 6000, "bounces_max": 3 },
        ],
        "reject_if": { "od_days_min": 30 },
    })
}

/// Thresholds loosen by letter (A strictest): identical tiers are now rejected.
fn tier_entry(tier: &str) -> Value {
    let (foir, cv, bounces) = match tier {
        "A" => (1, 1, 0),
        "B" => (2, 2, 1),
        _ => (3, 3, 2),
    };
    tier_with(tier, foir, cv, bounces)
}

fn tier_with(tier: &str, foir: u32, cv: u32, bounces: u32) -> Value {
    json!({ "tier": tier, "foir_max_bps": foir, "cv_max_bps": cv, "bounces_max": bounces })
}

/// `(letter, foir, cv, bounces)` rows as a tiers array.
type Row = (&'static str, u32, u32, u32);

fn tiers_from(rows: &[Row]) -> Value {
    Value::Array(
        rows.iter()
            .map(|&(t, foir, cv, bounces)| tier_with(t, foir, cv, bounces))
            .collect(),
    )
}

fn tiers_value(names: &[&str]) -> Value {
    Value::Array(names.iter().map(|n| tier_entry(n)).collect())
}

/// Default policy with the value at JSON pointer `ptr` replaced.
fn with(ptr: &str, value: Value) -> Value {
    let mut v = default_value();
    *v.pointer_mut(ptr)
        .unwrap_or_else(|| panic!("no such path {ptr}")) = value;
    v
}

/// Default policy with the key at JSON pointer `ptr` removed.
fn without(ptr: &str) -> Value {
    let mut v = default_value();
    let (parent, key) = ptr.rsplit_once('/').expect("pointer has a slash");
    v.pointer_mut(parent)
        .and_then(Value::as_object_mut)
        .unwrap_or_else(|| panic!("no object at {parent}"))
        .remove(key)
        .unwrap_or_else(|| panic!("no key at {ptr}"));
    v
}

fn bytes(value: &Value) -> Vec<u8> {
    serde_json::to_vec(value).unwrap()
}

fn parse(value: &Value) -> Result<Policy, PolicyError> {
    Policy::from_json(&bytes(value))
}

fn parse_str(raw: &str) -> Result<Policy, PolicyError> {
    Policy::from_json(raw.as_bytes())
}

/// `CANONICAL` with the first `from` replaced by `to`; panics if `from` is
/// absent, so a typo can't turn a reject test into a vacuous one.
fn edit(from: &str, to: &str) -> String {
    assert!(CANONICAL.contains(from), "{from:?} not in CANONICAL");
    assert_ne!(from, to, "edit must change the input");
    CANONICAL.replacen(from, to, 1)
}

fn sha256(data: &[u8]) -> [u8; 32] {
    Sha256::digest(data).into()
}

fn assert_err(raw: &str, want: PolicyError) {
    assert_eq!(parse_str(raw).err(), Some(want), "input {raw:?}");
}

fn canonical_of(raw: &str) -> Vec<u8> {
    parse_str(raw)
        .unwrap_or_else(|e| panic!("input {raw:?} should parse: {e:?}"))
        .canonical_json()
        .to_vec()
}

// --- Accepting the v2 default ---

#[test]
fn default_policy_parses() {
    assert!(parse(&default_value()).is_ok());
    assert!(parse_str(CANONICAL).is_ok());
}

#[test]
fn default_policy_canonical_json_is_the_jcs_literal() {
    let policy = parse(&default_value()).unwrap();
    assert_eq!(policy.canonical_json(), CANONICAL.as_bytes());
}

#[test]
fn default_policy_hash_is_sha256_of_the_jcs_literal() {
    let policy = parse(&default_value()).unwrap();
    assert_eq!(policy.hash().as_bytes(), &sha256(CANONICAL.as_bytes()));
}

#[test]
fn default_policy_rules_have_the_expected_values() {
    let rules = parse_str(CANONICAL).unwrap().rules;
    assert_eq!(rules.v, 2);
    assert_eq!(rules.recent_months, 3);
    assert_eq!(rules.recurrence.amount_tol_bps, 1000);
    assert_eq!(rules.recurrence.day_tol, 5);
    assert_eq!(rules.recurrence.min_occurrences, 3);
    assert_eq!(rules.window.min_days, 180);
    assert_eq!(rules.window.max_age_days, 7);
    assert_eq!(rules.reject_if.od_days_min, 30);
    let got: Vec<_> = rules
        .tiers
        .iter()
        .map(|t| (t.tier, t.foir_max_bps, t.cv_max_bps, t.bounces_max))
        .collect();
    assert_eq!(
        got,
        vec![
            (Tier::A, 4000, 1500, 0),
            (Tier::B, 5500, 5000, 1),
            (Tier::C, 7000, 6000, 3),
        ]
    );
}

#[test]
fn hash_is_stable_across_calls_and_clones() {
    let policy = parse_str(CANONICAL).unwrap();
    assert_eq!(policy.hash(), policy.hash());
    assert_eq!(policy.clone().hash(), policy.hash());
    assert_eq!(policy.clone(), policy);
}

// --- Normalization: every spelling of one policy gives the same bytes ---

#[test]
fn pretty_printed_input_normalizes() {
    let pretty = serde_json::to_string_pretty(&default_value()).unwrap();
    let policy = parse_str(&pretty).unwrap();
    assert_eq!(policy.canonical_json(), CANONICAL.as_bytes());
    assert_eq!(policy.hash().as_bytes(), &sha256(CANONICAL.as_bytes()));
}

#[test]
fn reordered_keys_normalize() {
    let reordered = concat!(
        r#"{"window":{"min_days":180,"max_age_days":7},"v":2,"#,
        r#""tiers":[{"tier":"A","foir_max_bps":4000,"cv_max_bps":1500,"bounces_max":0},"#,
        r#"{"tier":"B","foir_max_bps":5500,"cv_max_bps":5000,"bounces_max":1},"#,
        r#"{"tier":"C","foir_max_bps":7000,"cv_max_bps":6000,"bounces_max":3}],"#,
        r#""reject_if":{"od_days_min":30},"recurrence":{"min_occurrences":3,"day_tol":5,"amount_tol_bps":1000},"#,
        r#""recent_months":3}"#,
    );
    assert_eq!(canonical_of(reordered), CANONICAL.as_bytes());
}

#[test]
fn escaped_tier_letter_normalizes() {
    let escaped = edit(r#""tier":"A""#, r#""tier":"\u0041""#);
    assert_ne!(escaped, CANONICAL);
    assert_eq!(canonical_of(&escaped), CANONICAL.as_bytes());
    assert_eq!(
        parse_str(&escaped).unwrap().hash(),
        parse_str(CANONICAL).unwrap().hash()
    );
}

#[test]
fn escaped_keys_normalize_at_top_level_and_nested() {
    for (from, to) in [
        (r#""v":2"#, r#""\u0076":2"#),
        (r#""min_days":180"#, r#""min_\u0064ays":180"#),
    ] {
        assert_eq!(canonical_of(&edit(from, to)), CANONICAL.as_bytes(), "{to}");
    }
}

/// A last-wins parser would accept these and hash one reading of the key.
#[test]
fn duplicate_key_spelled_with_an_escape_is_malformed() {
    for (from, to) in [
        (r#""v":2"#, r#""v":2,"\u0076":2"#),
        (r#""min_days":180"#, r#""min_days":180,"min_\u0064ays":180"#),
    ] {
        assert_err(&edit(from, to), PolicyError::Malformed);
    }
}

#[test]
fn leading_and_trailing_whitespace_normalizes() {
    let padded = format!(" \n\t\r{CANONICAL} \n\t\r");
    assert_eq!(canonical_of(&padded), CANONICAL.as_bytes());
}

// --- Size cap ---

fn padded_to(total: usize) -> Vec<u8> {
    let pad = total - CANONICAL.len();
    let mut out = " ".repeat(pad / 2).into_bytes();
    out.extend_from_slice(CANONICAL.as_bytes());
    out.extend(std::iter::repeat_n(b' ', pad - pad / 2));
    assert_eq!(out.len(), total);
    out
}

#[test]
fn exactly_max_policy_bytes_is_accepted() {
    let policy = Policy::from_json(&padded_to(MAX_POLICY_BYTES)).unwrap();
    assert_eq!(policy.canonical_json(), CANONICAL.as_bytes());
}

#[test]
fn one_byte_over_max_policy_bytes_is_too_large() {
    assert_eq!(
        Policy::from_json(&padded_to(MAX_POLICY_BYTES + 1)).err(),
        Some(PolicyError::TooLarge)
    );
}

#[test]
fn oversized_invalid_json_is_too_large_not_malformed() {
    let junk = vec![b'x'; MAX_POLICY_BYTES + 1];
    assert_eq!(Policy::from_json(&junk).err(), Some(PolicyError::TooLarge));
}

#[test]
fn max_policy_bytes_is_4096() {
    assert_eq!(MAX_POLICY_BYTES, 4096);
}

// --- Malformed: shape ---

#[test]
fn non_object_documents_are_malformed() {
    for raw in ["[]", "null", r#""x""#, r#""""#, "", " ", "{}", "3", "true"] {
        assert_err(raw, PolicyError::Malformed);
    }
}

#[test]
fn bom_prefix_is_malformed() {
    let mut raw = vec![0xEF, 0xBB, 0xBF];
    raw.extend_from_slice(CANONICAL.as_bytes());
    assert_eq!(Policy::from_json(&raw).err(), Some(PolicyError::Malformed));
}

#[test]
fn trailing_garbage_is_malformed() {
    for tail in ["}", "x", " {}", "\0", ",", "\n1"] {
        assert_err(&format!("{CANONICAL}{tail}"), PolicyError::Malformed);
    }
}

#[test]
fn truncated_json_is_malformed() {
    assert_err(&CANONICAL[..CANONICAL.len() - 1], PolicyError::Malformed);
}

#[test]
fn array_shaped_policy_is_malformed() {
    // Positional array of the struct fields in declaration order. Serde's
    // derived visitor would accept it, but its JCS would differ from the input.
    let positional = concat!(
        r#"[3,{"amount_tol_bps":1000,"day_tol":5,"min_occurrences":3},{"od_days_min":30},"#,
        r#"[{"bounces_max":0,"cv_max_bps":1500,"foir_max_bps":4000,"tier":"A"}],2,"#,
        r#"{"max_age_days":7,"min_days":180}]"#,
    );
    assert_err(positional, PolicyError::Malformed);
    assert_err(&format!("  \n{positional}"), PolicyError::Malformed);
}

// --- Malformed: unknown / duplicate / missing keys ---

#[test]
fn unknown_key_at_top_level_and_in_each_nested_object_is_malformed() {
    let cases = [
        (r#""v":2"#, r#""v":2,"extra":1"#),
        (r#""day_tol":5"#, r#""day_tol":5,"extra":1"#),
        (r#""min_days":180"#, r#""min_days":180,"extra":1"#),
        (r#""od_days_min":30"#, r#""od_days_min":30,"extra":1"#),
        (r#""tier":"A""#, r#""tier":"A","extra":1"#),
        (r#""tier":"C""#, r#""tier":"C","extra":1"#),
    ];
    for (from, to) in cases {
        assert_err(&edit(from, to), PolicyError::Malformed);
    }
}

#[test]
fn unknown_key_with_null_value_is_malformed() {
    assert_err(
        &edit(r#""v":2"#, r#""v":2,"extra":null"#),
        PolicyError::Malformed,
    );
}

#[test]
fn duplicate_key_at_top_level_and_in_each_nested_object_is_malformed() {
    let cases = [
        (r#""v":2"#, r#""v":2,"v":2"#),
        (
            r#""recent_months":3"#,
            r#""recent_months":3,"recent_months":3"#,
        ),
        (r#""day_tol":5"#, r#""day_tol":5,"day_tol":5"#),
        (
            r#""max_age_days":7"#,
            r#""max_age_days":7,"max_age_days":7"#,
        ),
        (
            r#""od_days_min":30"#,
            r#""od_days_min":30,"od_days_min":30"#,
        ),
        (r#""tier":"A""#, r#""tier":"A","tier":"A""#),
        (r#""bounces_max":3"#, r#""bounces_max":3,"bounces_max":3"#),
    ];
    for (from, to) in cases {
        assert_err(&edit(from, to), PolicyError::Malformed);
    }
}

#[test]
fn duplicate_key_with_a_different_value_is_malformed() {
    // Last-wins parsers would silently pick one; we must refuse.
    assert_err(&edit(r#""v":2"#, r#""v":1,"v":2"#), PolicyError::Malformed);
    assert_err(&edit(r#""v":2"#, r#""v":2,"v":1"#), PolicyError::Malformed);
}

#[test]
fn each_missing_required_key_is_malformed() {
    let pointers = [
        "/v",
        "/recent_months",
        "/recurrence",
        "/window",
        "/tiers",
        "/reject_if",
        "/recurrence/amount_tol_bps",
        "/recurrence/day_tol",
        "/recurrence/min_occurrences",
        "/window/min_days",
        "/window/max_age_days",
        "/reject_if/od_days_min",
        "/tiers/0/tier",
        "/tiers/0/foir_max_bps",
        "/tiers/0/cv_max_bps",
        "/tiers/0/bounces_max",
        "/tiers/2/bounces_max",
    ];
    for ptr in pointers {
        assert_eq!(
            parse(&without(ptr)).err(),
            Some(PolicyError::Malformed),
            "missing {ptr}"
        );
    }
}

// --- Malformed: value types ---

#[test]
fn bad_integer_spellings_are_malformed_for_every_integer_field() {
    let fields = [
        r#""recent_months":3"#,
        r#""amount_tol_bps":1000"#,
        r#""day_tol":5"#,
        r#""min_occurrences":3"#,
        r#""min_days":180"#,
        r#""max_age_days":7"#,
        r#""od_days_min":30"#,
        r#""bounces_max":0"#,
        r#""cv_max_bps":1500"#,
        r#""foir_max_bps":4000"#,
    ];
    let bad = [
        "3.0",
        "3e0",
        "-1",
        r#""3""#,
        "4294967296",
        "03",
        "null",
        "true",
        "[]",
        "1.5",
        "-0",
        "5E0",
    ];
    for field in fields {
        let (key, _) = field.split_once(':').unwrap();
        for value in bad {
            assert_err(
                &edit(field, &format!("{key}:{value}")),
                PolicyError::Malformed,
            );
        }
    }
}

#[test]
fn u32_max_is_accepted_for_a_free_field() {
    let raw = edit(r#""day_tol":5"#, r#""day_tol":4294967295"#);
    assert_eq!(parse_str(&raw).unwrap().rules.recurrence.day_tol, u32::MAX);
}

#[test]
fn version_must_be_a_plain_integer() {
    for value in [r#""2""#, "2.0", "2e0", "null", "02", "-2"] {
        assert_err(
            &edit(r#""v":2"#, &format!(r#""v":{value}"#)),
            PolicyError::Malformed,
        );
    }
}

#[test]
fn unknown_tier_names_are_malformed() {
    for tier in [
        r#""D""#,
        r#""a""#,
        r#""REJECT""#,
        r#""""#,
        r#""AB""#,
        r#""A ""#,
        "1",
        "null",
        r#"["A"]"#,
    ] {
        assert_err(
            &edit(r#""tier":"A""#, &format!(r#""tier":{tier}"#)),
            PolicyError::Malformed,
        );
    }
}

#[test]
fn tier_as_unit_variant_object_is_malformed() {
    // Serde's derived enum would take `{"A":null}` as `A`, giving an input
    // whose JCS differs from our bytes (a parser differential).
    assert_err(
        &edit(r#""tier":"A""#, r#""tier":{"A":null}"#),
        PolicyError::Malformed,
    );
}

#[test]
fn wrong_container_types_are_malformed() {
    let cases = [
        with("/tiers", json!({})),
        with("/tiers", json!("A")),
        with("/tiers/0", json!("A")),
        with("/recurrence", json!(3)),
        with("/window", json!([180, 7])),
        with("/reject_if", json!(null)),
    ];
    for value in cases {
        assert_eq!(parse(&value).err(), Some(PolicyError::Malformed), "{value}");
    }
}

// --- UnsupportedVersion ---

#[test]
fn other_versions_are_unsupported() {
    for v in [0, 1, 3, 4, u32::MAX] {
        assert_eq!(
            parse(&with("/v", json!(v))).err(),
            Some(PolicyError::UnsupportedVersion),
            "v {v}"
        );
    }
}

// --- BadTiers ---

#[test]
fn bad_tier_lists_are_rejected() {
    let cases: [&[&str]; 8] = [
        &[],
        &["A", "A"],
        &["B", "B"],
        &["B", "A"],
        &["A", "C", "B"],
        &["C", "B", "A"],
        &["A", "B", "C", "C"],
        &["A", "A", "B", "C"],
    ];
    for names in cases {
        assert_eq!(
            parse(&with("/tiers", tiers_value(names))).err(),
            Some(PolicyError::BadTiers),
            "tiers {names:?}"
        );
    }
}

#[test]
fn strictly_ascending_tier_subsets_are_accepted() {
    let cases: [&[&str]; 7] = [
        &["A"],
        &["B"],
        &["C"],
        &["A", "C"],
        &["B", "C"],
        &["A", "B"],
        &["A", "B", "C"],
    ];
    for names in cases {
        let policy = parse(&with("/tiers", tiers_value(names))).unwrap();
        let got: Vec<&str> = policy
            .rules
            .tiers
            .iter()
            .map(|t| match t.tier {
                Tier::A => "A",
                Tier::B => "B",
                Tier::C => "C",
            })
            .collect();
        assert_eq!(got, names);
    }
}

// --- BadTiers: thresholds must loosen A -> B -> C ---

#[test]
fn tiers_that_never_loosen_are_rejected() {
    let cases: [(&str, &[Row]); 10] = [
        (
            "A looser than B in all three",
            &[("A", 5, 5, 5), ("B", 2, 2, 2)],
        ),
        ("identical [A,B]", &[("A", 2, 2, 1), ("B", 2, 2, 1)]),
        (
            "identical [A,B,C]",
            &[("A", 2, 2, 1), ("B", 2, 2, 1), ("C", 2, 2, 1)],
        ),
        (
            "B looser foir, stricter cv",
            &[("A", 2, 2, 1), ("B", 3, 1, 1)],
        ),
        ("B stricter foir only", &[("A", 2, 2, 1), ("B", 1, 3, 2)]),
        ("B stricter cv only", &[("A", 2, 2, 1), ("B", 3, 1, 2)]),
        ("B stricter bounces only", &[("A", 2, 2, 1), ("B", 3, 3, 0)]),
        (
            "only B -> C identical",
            &[("A", 1, 1, 0), ("B", 2, 2, 1), ("C", 2, 2, 1)],
        ),
        (
            "only B -> C stricter",
            &[("A", 1, 1, 0), ("B", 2, 2, 1), ("C", 1, 3, 2)],
        ),
        ("identical subset [A,C]", &[("A", 2, 2, 1), ("C", 2, 2, 1)]),
    ];
    for (name, rows) in cases {
        assert_eq!(
            parse(&with("/tiers", tiers_from(rows))).err(),
            Some(PolicyError::BadTiers),
            "{name}"
        );
    }
}

#[test]
fn tiers_loosening_in_at_least_one_dimension_and_never_stricter_are_accepted() {
    let cases: [(&str, &[Row]); 9] = [
        ("foir only", &[("A", 1, 2, 1), ("B", 2, 2, 1)]),
        ("cv only", &[("A", 2, 1, 1), ("B", 2, 2, 1)]),
        ("bounces only", &[("A", 2, 2, 0), ("B", 2, 2, 1)]),
        (
            "fixture A,B,C",
            &[("A", 1, 1, 0), ("B", 2, 2, 1), ("C", 3, 3, 2)],
        ),
        ("subset [A,C]", &[("A", 1, 1, 0), ("C", 3, 3, 2)]),
        ("subset [B,C]", &[("B", 2, 2, 1), ("C", 3, 3, 2)]),
        (
            "each pair loosens a different dimension",
            &[("A", 1, 1, 0), ("B", 2, 1, 0), ("C", 2, 1, 1)],
        ),
        (
            "bps above 10000 on C",
            &[("A", 1, 1, 0), ("B", 2, 2, 1), ("C", 20_000, 50_000, 2)],
        ),
        (
            "zero A, u32::MAX C",
            &[("A", 0, 0, 0), ("C", u32::MAX, u32::MAX, u32::MAX)],
        ),
    ];
    for (name, rows) in cases {
        assert!(parse(&with("/tiers", tiers_from(rows))).is_ok(), "{name}");
    }
}

#[test]
fn single_tier_lists_are_accepted_whatever_the_thresholds() {
    for rows in [[("A", 0, 0, 0)], [("C", 9, 9, 9)]] {
        assert!(
            parse(&with("/tiers", tiers_from(&rows))).is_ok(),
            "{rows:?}"
        );
    }
}

// --- ZeroValue ---

#[test]
fn zero_in_a_must_be_positive_field_is_rejected() {
    for ptr in [
        "/recent_months",
        "/recurrence/min_occurrences",
        "/reject_if/od_days_min",
    ] {
        assert_eq!(
            parse(&with(ptr, json!(0))).err(),
            Some(PolicyError::ZeroValue),
            "{ptr} = 0"
        );
    }
}

#[test]
fn one_in_a_must_be_positive_field_is_accepted() {
    for ptr in [
        "/recent_months",
        "/recurrence/min_occurrences",
        "/reject_if/od_days_min",
    ] {
        assert!(parse(&with(ptr, json!(1))).is_ok(), "{ptr} = 1");
    }
}

#[test]
fn zero_in_a_free_field_is_accepted() {
    for ptr in [
        "/window/min_days",
        "/window/max_age_days",
        "/recurrence/amount_tol_bps",
        "/recurrence/day_tol",
        "/tiers/0/bounces_max",
        "/tiers/0/foir_max_bps",
        "/tiers/0/cv_max_bps",
    ] {
        assert!(parse(&with(ptr, json!(0))).is_ok(), "{ptr} = 0");
    }
}

#[test]
fn bps_above_ten_thousand_is_accepted() {
    // CV can exceed 100 %, so caps are not range-checked.
    assert!(parse(&with("/tiers/2/cv_max_bps", json!(50_000))).is_ok());
}

// --- Check order: first failing check wins ---

#[test]
fn version_is_checked_before_tiers() {
    let mut v = with("/v", json!(1));
    v["tiers"] = json!([]);
    assert_eq!(parse(&v).err(), Some(PolicyError::UnsupportedVersion));
}

#[test]
fn tiers_are_checked_before_zero_values() {
    let mut v = with("/tiers", json!([]));
    v["recent_months"] = json!(0);
    assert_eq!(parse(&v).err(), Some(PolicyError::BadTiers));
}

#[test]
fn wrong_letter_order_is_rejected_even_when_thresholds_loosen() {
    // Thresholds loosen by position, so only the letter rule can reject these.
    let cases: [&[Row]; 4] = [
        &[("B", 1, 1, 0), ("A", 2, 2, 1)],
        &[("A", 1, 1, 0), ("A", 2, 2, 1)],
        &[("A", 1, 1, 0), ("C", 2, 2, 1), ("B", 3, 3, 2)],
        &[
            ("A", 1, 1, 0),
            ("B", 2, 2, 1),
            ("C", 3, 3, 2),
            ("C", 4, 4, 3),
        ],
    ];
    for rows in cases {
        assert_eq!(
            parse(&with("/tiers", tiers_from(rows))).err(),
            Some(PolicyError::BadTiers),
            "tiers {rows:?}"
        );
    }
}

#[test]
fn earlier_tier_at_u32_max_must_loosen_in_another_limit() {
    let looser_cv: [Row; 2] = [("A", u32::MAX, 1, 0), ("B", u32::MAX, 2, 0)];
    assert!(parse(&with("/tiers", tiers_from(&looser_cv))).is_ok());
    let identical: [Row; 2] = [("A", u32::MAX, 1, 0), ("B", u32::MAX, 1, 0)];
    assert_eq!(
        parse(&with("/tiers", tiers_from(&identical))).err(),
        Some(PolicyError::BadTiers)
    );
}

#[test]
fn tier_thresholds_are_checked_before_zero_values() {
    let rows: [Row; 2] = [("A", 1, 1, 1), ("B", 1, 1, 1)];
    let mut v = with("/tiers", tiers_from(&rows));
    v["recent_months"] = json!(0);
    assert_eq!(parse(&v).err(), Some(PolicyError::BadTiers));
}

#[test]
fn version_is_checked_before_zero_values() {
    let mut v = with("/v", json!(3));
    v["reject_if"]["od_days_min"] = json!(0);
    assert_eq!(parse(&v).err(), Some(PolicyError::UnsupportedVersion));
}

#[test]
fn malformed_is_checked_before_version() {
    assert_err(
        &edit(r#""v":2"#, r#""v":1,"extra":1"#),
        PolicyError::Malformed,
    );
    assert_err(&edit(r#""v":2"#, r#""v":1,"v":1"#), PolicyError::Malformed);
}

// --- Error code and messages ---

#[test]
fn every_policy_error_maps_to_bad_policy() {
    for err in [
        PolicyError::TooLarge,
        PolicyError::Malformed,
        PolicyError::UnsupportedVersion,
        PolicyError::BadTiers,
        PolicyError::ZeroValue,
    ] {
        assert_eq!(err.code(), "bad_policy", "{err:?}");
        assert!(!err.to_string().is_empty(), "{err:?}");
    }
}

#[test]
fn error_display_does_not_echo_input_bytes() {
    let marker = "SECRET_MARKER_9f3a";
    let inputs = [
        format!(r#"{{"{marker}":1}}"#),
        edit(r#""v":2"#, &format!(r#""v":2,"{marker}":1"#)),
        edit(r#""tier":"A""#, &format!(r#""tier":"{marker}""#)),
        edit(r#""day_tol":5"#, &format!(r#""day_tol":"{marker}""#)),
        format!("{marker}{}", " ".repeat(MAX_POLICY_BYTES)),
    ];
    for raw in inputs {
        let err = parse_str(&raw).unwrap_err();
        assert!(!err.to_string().contains(marker), "{err}");
        assert!(!format!("{err:?}").contains(marker), "{err:?}");
    }
}

// --- Tier ---

#[test]
fn tier_orders_a_before_b_before_c() {
    assert!(Tier::A < Tier::B);
    assert!(Tier::B < Tier::C);
    assert!(Tier::A < Tier::C);
}

#[test]
fn tier_serializes_as_its_letter() {
    for (tier, want) in [
        (Tier::A, r#""A""#),
        (Tier::B, r#""B""#),
        (Tier::C, r#""C""#),
    ] {
        assert_eq!(serde_json::to_string(&tier).unwrap(), want);
    }
}

#[test]
fn tier_deserializes_only_its_letters() {
    for (raw, want) in [
        (r#""A""#, Some(Tier::A)),
        (r#""B""#, Some(Tier::B)),
        (r#""C""#, Some(Tier::C)),
        (r#""\u0042""#, Some(Tier::B)),
        (r#""D""#, None),
        (r#""a""#, None),
        (r#"{"A":null}"#, None),
        ("null", None),
    ] {
        assert_eq!(serde_json::from_str::<Tier>(raw).ok(), want, "{raw}");
    }
}

// --- Nested positional arrays: same parser differential as the top level ---

#[test]
fn nested_positional_arrays_and_object_tiers_are_malformed() {
    let cases = [
        edit(
            r#""recurrence":{"amount_tol_bps":1000,"day_tol":5,"min_occurrences":3}"#,
            r#""recurrence":[1000,5,3]"#,
        ),
        edit(
            r#""window":{"max_age_days":7,"min_days":180}"#,
            r#""window":[7,180]"#,
        ),
        edit(r#""reject_if":{"od_days_min":30}"#, r#""reject_if":[30]"#),
        edit(
            r#"{"bounces_max":0,"cv_max_bps":1500,"foir_max_bps":4000,"tier":"A"}"#,
            r#"[0,1500,4000,"A"]"#,
        ),
    ];
    for raw in cases {
        assert_err(&raw, PolicyError::Malformed);
    }
    let tiers_object = concat!(
        r#"{"recent_months":3,"recurrence":{"amount_tol_bps":1000,"day_tol":5,"min_occurrences":3},"#,
        r#""reject_if":{"od_days_min":30},"tiers":{},"#,
        r#""v":2,"window":{"max_age_days":7,"min_days":180}}"#,
    );
    assert_err(tiers_object, PolicyError::Malformed);
}
