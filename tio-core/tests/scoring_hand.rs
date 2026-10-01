//! Replays the hand-calculated scoring cases
//! (`test-fixtures/scoring/hand-cases.json`, `docs/FORMATS.md` §6.1).
//!
//! The expectations were worked out by hand from the §6.1 text, never by
//! running a scorer, and the TypeScript scorer replays the same file. A
//! mismatch means the code or the hand arithmetic is wrong: find out which,
//! never copy the printed value into the fixture.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::indexing_slicing,
    clippy::panic
)]

use std::{fs, path::Path};

use serde_json::Value;
use tio_core::{
    parse_date, parse_rebit_timestamp, score, DepositFi, ErrorCode, Features, Outcome, Paise,
    Policy, Tier, Txn,
};

fn repo_file(relative: &str) -> Vec<u8> {
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join(relative);
    fs::read(&path).unwrap_or_else(|e| panic!("read {}: {e}", path.display()))
}

fn cases() -> Vec<Value> {
    let root: Value =
        serde_json::from_slice(&repo_file("test-fixtures/scoring/hand-cases.json")).unwrap();
    root["cases"].as_array().expect("cases array").clone()
}

fn policy_of(case: &Value) -> Policy {
    let bytes = match &case["policy"] {
        Value::String(name) if name == "default" => repo_file("test-vectors/policy/default.json"),
        object @ Value::Object(_) => serde_json::to_vec(object).unwrap(),
        other => panic!("case {}: unsupported policy {other}", case["id"]),
    };
    Policy::from_json(&bytes).unwrap()
}

fn str_of<'a>(value: &'a Value, key: &str) -> &'a str {
    value[key]
        .as_str()
        .unwrap_or_else(|| panic!("{key} must be a string in {value}"))
}

fn int_of(value: &Value, key: &str) -> i64 {
    value[key]
        .as_i64()
        .unwrap_or_else(|| panic!("{key} must be an integer in {value}"))
}

fn flag_of(value: &Value, key: &str) -> bool {
    value[key]
        .as_bool()
        .unwrap_or_else(|| panic!("{key} must be a bool in {value}"))
}

fn txn_of(value: &Value) -> Txn {
    Txn {
        credit: flag_of(value, "credit"),
        amount: Paise::new(int_of(value, "amount")),
        balance: Paise::new(int_of(value, "balance")),
        at: parse_rebit_timestamp(str_of(value, "at")).unwrap(),
        bounce: flag_of(value, "bounce"),
        emi_word: flag_of(value, "emi"),
    }
}

fn fi_of(case: &Value) -> DepositFi {
    DepositFi {
        start_day: parse_date(str_of(case, "start")).unwrap(),
        end_day: parse_date(str_of(case, "end")).unwrap(),
        transactions: case["txns"]
            .as_array()
            .expect("txns array")
            .iter()
            .map(txn_of)
            .collect(),
    }
}

fn tier_name(outcome: Outcome) -> &'static str {
    match outcome {
        Outcome::Tier(Tier::A) => "A",
        Outcome::Tier(Tier::B) => "B",
        Outcome::Tier(Tier::C) => "C",
        Outcome::Reject => "REJECT",
    }
}

fn u32_of(value: &Value, key: &str) -> u32 {
    u32::try_from(int_of(value, key)).unwrap()
}

fn expected_features(value: &Value) -> Features {
    Features {
        months: u32_of(value, "months"),
        income_median: Paise::new(int_of(value, "income_median_paise")),
        obligation_median: Paise::new(int_of(value, "obligation_median_paise")),
        foir_bps: u32_of(value, "foir_bps"),
        cv_bps: u32_of(value, "cv_bps"),
        loans: u32_of(value, "loans"),
        bounces: u32_of(value, "bounces"),
        unmatched_emi_bounces: u32_of(value, "unmatched_emi_bounces"),
        od_days: u32_of(value, "od_days"),
    }
}

#[test]
fn hand_cases_are_present_and_unique() {
    let all = cases();
    assert!(all.len() >= 15, "expected the full hand-case set");
    let mut ids: Vec<&str> = all.iter().map(|c| str_of(c, "id")).collect();
    ids.sort_unstable();
    ids.dedup();
    assert_eq!(ids.len(), all.len(), "case ids must be unique");
}

#[test]
fn every_hand_case_scores_exactly_as_calculated() {
    for case in cases() {
        let id = str_of(&case, "id").to_owned();
        let result = score(&fi_of(&case), &policy_of(&case));
        let expected = &case["expected"];
        if let Some(code) = expected.get("error").and_then(Value::as_str) {
            let err = result.expect_err(&format!("case {id}: expected error {code}"));
            assert_eq!(err.code(), code, "case {id}: error code");
            continue;
        }
        let got = result.unwrap_or_else(|e| panic!("case {id}: unexpected error {e}"));
        assert_eq!(
            tier_name(got.outcome),
            str_of(expected, "tier"),
            "case {id}: tier"
        );
        assert_eq!(
            got.full,
            expected_features(&expected["full"]),
            "case {id}: full features"
        );
        assert_eq!(
            got.recent,
            expected_features(&expected["recent"]),
            "case {id}: recent features"
        );
    }
}
