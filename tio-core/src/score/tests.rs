//! Scoring tests (FORMATS §6.1). Written red-first by test-designer.
//!
//! Every number is worked out from the §6.1 text, not from the code. Each
//! `&&` part of a rule gets a fixture that breaks only that part, so deleting
//! the part turns a test red.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::indexing_slicing,
    clippy::panic
)]

use std::time::Instant;

use serde_json::{json, Value};

use super::*;
use crate::rebit::Txn;
use crate::time::parse_date;

/// A balance that is never overdrawn.
const BAL: i64 = 1_000_000_000;
/// ₹1000 in paise: the monthly income of most fixtures.
const INCOME: i64 = 100_000;
/// ₹100 in paise: the usual instalment.
const EMI: i64 = 10_000;

type Row = (&'static str, u32, u32, u32);

const DEFAULT_TIERS: [Row; 3] = [
    ("A", 4000, 1500, 0),
    ("B", 5500, 5000, 1),
    ("C", 7000, 6000, 3),
];

const H1: [&str; 6] = [
    "2026-01", "2026-02", "2026-03", "2026-04", "2026-05", "2026-06",
];
const Q1: [&str; 3] = ["2026-01", "2026-02", "2026-03"];

// ---------------------------------------------------------------- builders

/// `[amount_tol_bps, day_tol, min_occurrences]`.
fn policy_with(recurrence: [u32; 3], recent_months: u32, od_min: u32, tiers: &[Row]) -> Policy {
    let tiers: Vec<Value> = tiers
        .iter()
        .map(|(tier, foir, cv, bounces)| {
            json!({ "tier": tier, "foir_max_bps": foir, "cv_max_bps": cv, "bounces_max": bounces })
        })
        .collect();
    let value = json!({
        "v": 2,
        "recurrence": {
            "amount_tol_bps": recurrence[0],
            "day_tol": recurrence[1],
            "min_occurrences": recurrence[2],
        },
        "recent_months": recent_months,
        "window": { "min_days": 180, "max_age_days": 7 },
        "tiers": tiers,
        "reject_if": { "od_days_min": od_min },
    });
    Policy::from_json(&serde_json::to_vec(&value).unwrap()).unwrap()
}

fn default_policy() -> Policy {
    policy_with([1000, 5, 3], 3, 30, &DEFAULT_TIERS)
}

fn day(date: &str) -> i64 {
    parse_date(date).unwrap()
}

/// Unix seconds of `hour`:00 India time on the written date.
fn ist(date: &str, hour: i64) -> i64 {
    day(date) * 86_400 + hour * 3_600 - IST_OFFSET
}

fn txn_at(
    date: &str,
    hour: i64,
    credit: bool,
    amount: i64,
    balance: i64,
    bounce: bool,
    emi_word: bool,
) -> Txn {
    Txn {
        credit,
        amount: Paise::new(amount),
        balance: Paise::new(balance),
        at: ist(date, hour),
        bounce,
        emi_word,
    }
}

fn txn(date: &str, credit: bool, amount: i64, bounce: bool, emi_word: bool) -> Txn {
    txn_at(date, 12, credit, amount, BAL, bounce, emi_word)
}

fn income(date: &str, amount: i64) -> Txn {
    txn(date, true, amount, false, false)
}

fn emi(date: &str, amount: i64) -> Txn {
    txn(date, false, amount, false, true)
}

fn emi_bounce(date: &str, amount: i64) -> Txn {
    txn(date, false, amount, true, true)
}

/// A bounce debit with no EMI word (e.g. a cheque return charge).
fn plain_bounce(date: &str) -> Txn {
    txn(date, false, 500, true, false)
}

/// A debit with no flags: ignored by classification, moves the balance.
fn spend(date: &str, balance: i64) -> Txn {
    txn_at(date, 12, false, 5, balance, false, false)
}

/// One `INCOME` credit on day 1 of each `"YYYY-MM"` month.
fn incomes(months: &[&str]) -> Vec<Txn> {
    months
        .iter()
        .map(|m| income(&format!("{m}-01"), INCOME))
        .collect()
}

/// One instalment on `dom` (two digits) of each `"YYYY-MM"` month.
fn emis(months: &[&str], dom: &str, amount: i64) -> Vec<Txn> {
    months
        .iter()
        .map(|m| emi(&format!("{m}-{dom}"), amount))
        .collect()
}

fn run(
    start: &str,
    end: &str,
    transactions: Vec<Txn>,
    policy: &Policy,
) -> Result<Scores, ScoreError> {
    let fi = DepositFi {
        start_day: day(start),
        end_day: day(end),
        transactions,
    };
    score(&fi, policy)
}

fn scores(start: &str, end: &str, transactions: Vec<Txn>) -> Scores {
    run(start, end, transactions, &default_policy()).unwrap()
}

/// Jan-Mar 2026 with an income on day 1 of every month plus `extra`.
fn q1(extra: Vec<Txn>) -> Scores {
    let mut all = incomes(&Q1);
    all.extend(extra);
    scores("2026-01-01", "2026-03-31", all)
}

/// Jan-Jun 2026 with an income on day 1 of every month plus `extra`.
fn h1(extra: Vec<Txn>) -> Scores {
    let mut all = incomes(&H1);
    all.extend(extra);
    scores("2026-01-01", "2026-06-30", all)
}

/// A feature set that passes every rule under the default policy.
fn passing() -> Features {
    Features {
        months: 3,
        income_median: Paise::new(INCOME),
        ..Features::default()
    }
}

fn rules(tiers: &[Row]) -> Rules {
    policy_with([1000, 5, 3], 3, 30, tiers).rules
}

fn default_rules() -> Rules {
    default_policy().rules
}

// ------------------------------------------------------------- error codes

#[test]
fn score_errors_map_to_their_format_codes() {
    assert_eq!(ScoreError::TxnOutsideStatement.code(), "window_mismatch");
    assert_eq!(ScoreError::Overflow.code(), "bad_fi_data");
}

// ---------------------------------------------------------- Outcome order

#[test]
fn outcome_orders_tiers_then_reject() {
    assert!(Outcome::Tier(Tier::A) < Outcome::Tier(Tier::B));
    assert!(Outcome::Tier(Tier::B) < Outcome::Tier(Tier::C));
    assert!(Outcome::Tier(Tier::C) < Outcome::Reject);
}

#[test]
fn outcome_max_is_the_worse_one() {
    assert_eq!(
        Outcome::Tier(Tier::A).max(Outcome::Tier(Tier::C)),
        Outcome::Tier(Tier::C)
    );
    assert_eq!(Outcome::Reject.max(Outcome::Tier(Tier::C)), Outcome::Reject);
    assert_eq!(
        Outcome::Tier(Tier::B).max(Outcome::Tier(Tier::B)),
        Outcome::Tier(Tier::B)
    );
}

// ------------------------------------------------------------- india_day

#[test]
fn india_day_epoch_is_day_zero() {
    assert_eq!(india_day(0), 0);
}

#[test]
fn india_day_rolls_over_at_18_30_utc() {
    // 18:29:59Z is 23:59:59 IST, still day 0; 18:30:00Z is 00:00 IST, day 1.
    assert_eq!(india_day(66_599), 0);
    assert_eq!(india_day(66_600), 1);
}

#[test]
fn india_day_floors_before_the_epoch() {
    // 05:29:59 IST before the epoch's IST midnight is day -1, not day 0.
    assert_eq!(india_day(-19_801), -1);
    assert_eq!(india_day(-19_800), 0);
}

// ---------------------------------------------------------------- median

#[test]
fn median_of_odd_count_is_the_middle_value() {
    assert_eq!(median(&mut [5, 1, 3]), 3);
}

#[test]
fn median_of_even_count_floors_the_mean_of_the_middle_pair() {
    assert_eq!(median(&mut [4, 1, 3, 2]), 2); // (2+3)/2 = 2.5 -> 2
    assert_eq!(median(&mut [1, 3]), 2);
}

#[test]
fn median_of_empty_is_zero() {
    assert_eq!(median(&mut []), 0);
}

#[test]
fn median_of_one_value_is_that_value() {
    assert_eq!(median(&mut [7]), 7);
}

#[test]
fn median_of_two_maxima_does_not_overflow() {
    assert_eq!(median(&mut [i64::MAX, i64::MAX]), i64::MAX);
}

// ---------------------------------------------------------------- cv_bps

#[test]
fn cv_of_1_1_2_is_3535_not_2500() {
    // D = 3*6 - 16 = 2; isqrt(2e8) = 14142; 14142 / 4 = 3535.
    assert_eq!(cv_bps(&[1, 1, 2]), Ok(3535));
}

#[test]
fn cv_is_scale_invariant() {
    // D = 3*60000 - 400^2 = 20000; isqrt(2e12) = 1414213; / 400 = 3535.
    assert_eq!(cv_bps(&[100, 100, 200]), Ok(3535));
}

#[test]
fn cv_of_constant_income_is_zero() {
    assert_eq!(cv_bps(&[100, 100, 100]), Ok(0));
}

#[test]
fn cv_of_one_month_is_zero() {
    assert_eq!(cv_bps(&[12_345]), Ok(0));
}

#[test]
fn cv_of_zero_income_is_zero() {
    assert_eq!(cv_bps(&[0, 0, 0]), Ok(0));
}

#[test]
fn cv_of_no_months_is_zero() {
    assert_eq!(cv_bps(&[]), Ok(0));
}

#[test]
fn cv_of_1_2_3_4_floors_to_4472() {
    // D = 4*30 - 100 = 20; isqrt(2e9) = 44721; / 10 = 4472.
    assert_eq!(cv_bps(&[1, 2, 3, 4]), Ok(4472));
}

#[test]
fn cv_overflow_is_an_error_not_a_wrap() {
    // D = 3*(MAX^2) - MAX^2 ~ 1.7e38; times 10^8 does not fit in u128.
    assert_eq!(cv_bps(&[i64::MAX, 0, 0]), Err(ScoreError::Overflow));
}

// -------------------------------------------------------------- foir_bps

#[test]
fn foir_is_the_floored_ratio_in_bps() {
    assert_eq!(foir_bps(4000, 10_000), 4000);
    assert_eq!(foir_bps(1, 3), 3333); // 3333.33 floors
    assert_eq!(foir_bps(0, 10), 0);
}

#[test]
fn foir_without_income_is_zero() {
    assert_eq!(foir_bps(5_000, 0), 0);
}

#[test]
fn foir_just_below_the_cap_is_kept() {
    assert_eq!(foir_bps(4_294_967_294, 10_000), u32::MAX - 1);
}

#[test]
fn foir_exactly_at_the_cap_saturates_to_max() {
    assert_eq!(foir_bps(4_294_967_295, 10_000), u32::MAX);
}

#[test]
fn foir_above_the_cap_saturates_to_max() {
    assert_eq!(foir_bps(4_294_967_296, 10_000), u32::MAX);
    assert_eq!(foir_bps(i64::MAX, 1), u32::MAX);
}

// ---------------------------------------------------------- reject_reason

#[test]
fn passing_features_have_no_reject_reason() {
    assert_eq!(reject_reason(&passing(), &default_rules()), None);
}

#[test]
fn no_complete_months_rejects_with_no_months() {
    let f = Features {
        months: 0,
        ..passing()
    };
    assert_eq!(
        reject_reason(&f, &default_rules()),
        Some(RejectReason::NoMonths)
    );
}

#[test]
fn zero_income_median_rejects_with_no_income() {
    let f = Features {
        income_median: Paise::ZERO,
        ..passing()
    };
    assert_eq!(
        reject_reason(&f, &default_rules()),
        Some(RejectReason::NoIncome)
    );
}

#[test]
fn foir_at_u32_max_rejects_even_when_a_tier_allows_u32_max() {
    // Tier C's cap is u32::MAX, so only the saturation rule can reject.
    let rules = rules(&[("A", u32::MAX, u32::MAX, u32::MAX)]);
    let f = Features {
        foir_bps: u32::MAX,
        ..passing()
    };
    assert_eq!(
        reject_reason(&f, &rules),
        Some(RejectReason::FoirOutOfRange)
    );
}

#[test]
fn foir_just_below_u32_max_passes_a_u32_max_cap() {
    let rules = rules(&[("A", u32::MAX, u32::MAX, u32::MAX)]);
    let f = Features {
        foir_bps: u32::MAX - 1,
        ..passing()
    };
    assert_eq!(reject_reason(&f, &rules), None);
}

#[test]
fn foir_above_u32_max_rejects_through_the_saturated_value() {
    let rules = rules(&[("A", u32::MAX, u32::MAX, u32::MAX)]);
    let f = Features {
        foir_bps: foir_bps(4_294_967_296, 10_000),
        ..passing()
    };
    assert_eq!(
        reject_reason(&f, &rules),
        Some(RejectReason::FoirOutOfRange)
    );
}

#[test]
fn unmatched_emi_bounce_rejects_with_unmeasured_debt() {
    let f = Features {
        unmatched_emi_bounces: 1,
        ..passing()
    };
    assert_eq!(
        reject_reason(&f, &default_rules()),
        Some(RejectReason::UnmeasuredDebt)
    );
}

#[test]
fn overdraft_days_at_the_minimum_reject_with_overdraft() {
    let f = Features {
        od_days: 30,
        ..passing()
    };
    assert_eq!(
        reject_reason(&f, &default_rules()),
        Some(RejectReason::Overdraft)
    );
}

#[test]
fn overdraft_days_one_below_the_minimum_pass() {
    let f = Features {
        od_days: 29,
        ..passing()
    };
    assert_eq!(reject_reason(&f, &default_rules()), None);
}

#[test]
fn foir_above_every_tier_rejects_with_no_tier_match() {
    let f = Features {
        foir_bps: 7001,
        ..passing()
    };
    assert_eq!(
        reject_reason(&f, &default_rules()),
        Some(RejectReason::NoTierMatch)
    );
}

#[test]
fn reject_reasons_are_checked_in_the_documented_order() {
    let r = default_rules();
    // Every fault at once: months first.
    let all = Features {
        months: 0,
        income_median: Paise::ZERO,
        foir_bps: u32::MAX,
        unmatched_emi_bounces: 1,
        od_days: 30,
        bounces: 9,
        ..Features::default()
    };
    assert_eq!(reject_reason(&all, &r), Some(RejectReason::NoMonths));
    let from_income = Features { months: 3, ..all };
    assert_eq!(
        reject_reason(&from_income, &r),
        Some(RejectReason::NoIncome)
    );
    let from_foir = Features {
        income_median: Paise::new(INCOME),
        ..from_income
    };
    assert_eq!(
        reject_reason(&from_foir, &r),
        Some(RejectReason::FoirOutOfRange)
    );
    let from_unmeasured = Features {
        foir_bps: 0,
        ..from_foir
    };
    assert_eq!(
        reject_reason(&from_unmeasured, &r),
        Some(RejectReason::UnmeasuredDebt)
    );
    let from_overdraft = Features {
        unmatched_emi_bounces: 0,
        ..from_unmeasured
    };
    assert_eq!(
        reject_reason(&from_overdraft, &r),
        Some(RejectReason::Overdraft)
    );
    let from_tier = Features {
        od_days: 0,
        ..from_overdraft
    };
    assert_eq!(
        reject_reason(&from_tier, &r),
        Some(RejectReason::NoTierMatch)
    );
}

// ------------------------------------------------- tier match, each && part

fn single_tier() -> Rules {
    rules(&[("A", 4000, 1500, 0)])
}

#[test]
fn tier_matches_exactly_at_every_limit() {
    let f = Features {
        foir_bps: 4000,
        cv_bps: 1500,
        bounces: 0,
        ..passing()
    };
    assert_eq!(reject_reason(&f, &single_tier()), None);
}

#[test]
fn tier_fails_on_foir_alone() {
    let f = Features {
        foir_bps: 4001,
        cv_bps: 1500,
        bounces: 0,
        ..passing()
    };
    assert_eq!(
        reject_reason(&f, &single_tier()),
        Some(RejectReason::NoTierMatch)
    );
}

#[test]
fn tier_fails_on_cv_alone() {
    let f = Features {
        foir_bps: 4000,
        cv_bps: 1501,
        bounces: 0,
        ..passing()
    };
    assert_eq!(
        reject_reason(&f, &single_tier()),
        Some(RejectReason::NoTierMatch)
    );
}

#[test]
fn tier_fails_on_bounces_alone() {
    let f = Features {
        foir_bps: 4000,
        cv_bps: 1500,
        bounces: 1,
        ..passing()
    };
    assert_eq!(
        reject_reason(&f, &single_tier()),
        Some(RejectReason::NoTierMatch)
    );
}

// --------------------------------------------------------- tier selection

#[test]
fn a_statement_meeting_tier_a_gets_a_not_a_later_tier() {
    let s = h1(vec![]);
    assert_eq!(s.outcome, Outcome::Tier(Tier::A));
    assert_eq!(s.full.months, 6);
    assert_eq!(s.recent.months, 3);
}

#[test]
fn foir_equal_to_the_tier_limit_still_gets_that_tier() {
    // 40_000 / 100_000 = 4000 bps = A's foir_max.
    let s = h1(emis(&H1, "05", 40_000));
    assert_eq!(s.full.foir_bps, 4000);
    assert_eq!(s.outcome, Outcome::Tier(Tier::A));
}

#[test]
fn foir_one_bps_over_the_tier_limit_falls_to_the_next_tier() {
    // 40_010 * 10000 / 100_000 = 4001.
    let s = h1(emis(&H1, "05", 40_010));
    assert_eq!(s.full.foir_bps, 4001);
    assert_eq!(s.outcome, Outcome::Tier(Tier::B));
}

#[test]
fn foir_is_floored_not_rounded() {
    // 40_009 * 10000 / 100_000 = 4000.9 -> 4000, still A.
    let s = h1(emis(&H1, "05", 40_009));
    assert_eq!(s.full.foir_bps, 4000);
    assert_eq!(s.outcome, Outcome::Tier(Tier::A));
}

#[test]
fn one_bounce_gives_tier_b_two_or_three_give_c_four_reject() {
    let bounce = |n: usize| {
        (1..=n)
            .map(|d| plain_bounce(&format!("2026-01-{d:02}")))
            .collect()
    };
    assert_eq!(h1(bounce(1)).outcome, Outcome::Tier(Tier::B));
    assert_eq!(h1(bounce(2)).outcome, Outcome::Tier(Tier::C));
    assert_eq!(h1(bounce(3)).outcome, Outcome::Tier(Tier::C));
    assert_eq!(h1(bounce(4)).outcome, Outcome::Reject);
}

#[test]
fn final_outcome_is_the_worse_of_full_and_recent() {
    // The only bounce is in January: in the full window, not the recent one.
    let s = h1(vec![plain_bounce("2026-01-10")]);
    assert_eq!(s.full.bounces, 1);
    assert_eq!(s.recent.bounces, 0);
    assert_eq!(s.outcome, Outcome::Tier(Tier::B));
}

#[test]
fn a_full_window_reject_wins_over_a_clean_recent_window() {
    // Unknown-loan bounce in February: unmatched in full, not in recent.
    let s = h1(vec![emi_bounce("2026-02-10", EMI)]);
    assert_eq!(s.full.unmatched_emi_bounces, 1);
    assert_eq!(s.recent.unmatched_emi_bounces, 0);
    assert_eq!(s.outcome, Outcome::Reject);
}

// --------------------------------------------------- classification parts

#[test]
fn credit_with_emi_word_is_income_not_a_loan() {
    let extra = Q1
        .iter()
        .map(|m| txn(&format!("{m}-05"), true, 5_000, false, true))
        .collect();
    let s = q1(extra);
    assert_eq!(s.full.income_median, Paise::new(INCOME + 5_000));
    assert_eq!(s.full.loans, 0);
}

#[test]
fn credit_with_bounce_word_is_not_income_and_not_a_bounce() {
    let extra = Q1
        .iter()
        .map(|m| txn(&format!("{m}-05"), true, 5_000, true, false))
        .collect();
    let s = q1(extra);
    assert_eq!(s.full.income_median, Paise::new(INCOME));
    assert_eq!(s.full.bounces, 0);
    assert_eq!(s.full.unmatched_emi_bounces, 0);
}

#[test]
fn credit_with_bounce_and_emi_words_is_ignored_entirely() {
    let s = q1(vec![txn("2026-01-05", true, 5_000, true, true)]);
    assert_eq!(s.full.income_median, Paise::new(INCOME));
    assert_eq!(s.full.bounces, 0);
    assert_eq!(s.full.unmatched_emi_bounces, 0);
}

#[test]
fn debit_with_bounce_word_only_is_a_bounce_with_no_emi_evidence() {
    let s = q1(vec![plain_bounce("2026-02-10")]);
    assert_eq!(s.full.bounces, 1);
    assert_eq!(s.full.unmatched_emi_bounces, 0);
    assert_eq!(s.outcome, Outcome::Tier(Tier::B));
}

#[test]
fn debit_with_both_words_is_a_bounce_and_never_a_loan_payment() {
    let s = q1(emis(&Q1, "05", EMI)
        .into_iter()
        .map(|t| Txn { bounce: true, ..t })
        .collect());
    assert_eq!(s.full.loans, 0);
    assert_eq!(s.full.bounces, 3);
    assert_eq!(s.full.unmatched_emi_bounces, 3);
}

#[test]
fn debit_with_emi_word_only_is_a_loan_candidate() {
    let s = q1(emis(&Q1, "05", EMI));
    assert_eq!(s.full.loans, 1);
}

#[test]
fn debit_with_no_words_is_ignored() {
    let extra = Q1
        .iter()
        .map(|m| txn(&format!("{m}-05"), false, EMI, false, false))
        .collect();
    let s = q1(extra);
    assert_eq!(s.full.loans, 0);
    assert_eq!(s.full.bounces, 0);
    assert_eq!(s.full.obligation_median, Paise::ZERO);
}

// ----------------------------------------------------- loans: recurrence

#[test]
fn three_monthly_instalments_make_one_loan() {
    let s = q1(emis(&Q1, "05", EMI));
    assert_eq!(s.full.loans, 1);
    assert_eq!(s.full.obligation_median, Paise::new(EMI));
    assert_eq!(s.full.foir_bps, 1000);
}

#[test]
fn two_months_of_instalments_are_not_a_loan() {
    let s = q1(emis(&Q1[..2], "05", EMI));
    assert_eq!(s.full.loans, 0);
    assert_eq!(s.full.obligation_median, Paise::ZERO);
}

#[test]
fn min_occurrences_two_accepts_two_months() {
    let p = policy_with([1000, 5, 2], 3, 30, &DEFAULT_TIERS);
    let mut all = incomes(&Q1);
    all.extend(emis(&Q1[..2], "05", EMI));
    let s = run("2026-01-01", "2026-03-31", all, &p).unwrap();
    assert_eq!(s.full.loans, 1);
}

#[test]
fn a_second_debit_in_a_taken_month_does_not_join_the_cluster() {
    // Jan 5, Jan 6, Feb 5: only 2 distinct months. Counting transactions
    // would reach 3; the month rule keeps it at 2. Amount and day both match.
    let mut extra = vec![emi("2026-01-05", EMI), emi("2026-01-06", EMI)];
    extra.push(emi("2026-02-05", EMI));
    assert_eq!(q1(extra).full.loans, 0);
}

#[test]
fn a_debit_already_in_a_cluster_cannot_join_a_later_one() {
    // Jan 5 anchors {Jan 5, Feb 5, Mar 5}; Jan 6 then anchors its own cluster
    // and must not take Feb 5 / Mar 5 again: 1 loan, not 2.
    let s = q1(vec![
        emi("2026-01-05", EMI),
        emi("2026-01-06", EMI),
        emi("2026-02-05", EMI),
        emi("2026-03-05", EMI),
    ]);
    assert_eq!(s.full.loans, 1);
    assert_eq!(s.full.obligation_median, Paise::new(EMI));
}

#[test]
fn amount_exactly_at_the_tolerance_joins() {
    // Anchor 10_000; tolerance 1000 bps = 1_000 paise; 11_000 is in.
    let s = q1(vec![
        emi("2026-01-05", 10_000),
        emi("2026-02-05", 10_000),
        emi("2026-03-05", 11_000),
    ]);
    assert_eq!(s.full.loans, 1);
}

#[test]
fn amount_one_paise_over_the_tolerance_does_not_join() {
    let s = q1(vec![
        emi("2026-01-05", 10_000),
        emi("2026-02-05", 10_000),
        emi("2026-03-05", 11_001),
    ]);
    assert_eq!(s.full.loans, 0);
}

#[test]
fn amount_exactly_at_the_lower_tolerance_joins() {
    let s = q1(vec![
        emi("2026-01-05", 10_000),
        emi("2026-02-05", 10_000),
        emi("2026-03-05", 9_000),
    ]);
    assert_eq!(s.full.loans, 1);
}

#[test]
fn amount_one_paise_under_the_lower_tolerance_does_not_join() {
    let s = q1(vec![
        emi("2026-01-05", 10_000),
        emi("2026-02-05", 10_000),
        emi("2026-03-05", 8_999),
    ]);
    assert_eq!(s.full.loans, 0);
}

#[test]
fn day_exactly_at_the_tolerance_joins() {
    // Anchor Jan 5; day_tol 5; Feb 10 and Mar 10 are 5 days away.
    let s = q1(vec![
        emi("2026-01-05", EMI),
        emi("2026-02-10", EMI),
        emi("2026-03-10", EMI),
    ]);
    assert_eq!(s.full.loans, 1);
}

#[test]
fn day_one_over_the_tolerance_does_not_join() {
    let s = q1(vec![
        emi("2026-01-05", EMI),
        emi("2026-02-10", EMI),
        emi("2026-03-11", EMI),
    ]);
    assert_eq!(s.full.loans, 0);
}

#[test]
fn day_tolerance_applies_below_the_anchor_too() {
    // Anchor Jan 10: Feb 5 is 5 days earlier (in), Mar 4 is 6 earlier (out).
    let inside = q1(vec![
        emi("2026-01-10", EMI),
        emi("2026-02-05", EMI),
        emi("2026-03-05", EMI),
    ]);
    assert_eq!(inside.full.loans, 1);
    let outside = q1(vec![
        emi("2026-01-10", EMI),
        emi("2026-02-05", EMI),
        emi("2026-03-04", EMI),
    ]);
    assert_eq!(outside.full.loans, 0);
}

#[test]
fn members_are_compared_to_the_anchor_not_to_the_previous_member() {
    // Each step is within 10% of the previous one, but March is 18% away
    // from the January anchor.
    let amounts = q1(vec![
        emi("2026-01-05", 10_000),
        emi("2026-02-05", 10_900),
        emi("2026-03-05", 11_800),
    ]);
    assert_eq!(amounts.full.loans, 0);
    // Same for days: 5 -> 9 -> 13 steps of 4, but 8 from the anchor.
    let days = q1(vec![
        emi("2026-01-05", EMI),
        emi("2026-02-09", EMI),
        emi("2026-03-13", EMI),
    ]);
    assert_eq!(days.full.loans, 0);
}

#[test]
fn zero_tolerances_demand_an_exact_amount_and_day() {
    let p = policy_with([0, 0, 3], 3, 30, &DEFAULT_TIERS);
    let build = |third: &str| {
        let mut all = incomes(&Q1);
        all.extend([
            emi("2026-01-05", EMI),
            emi("2026-02-05", EMI),
            emi(third, EMI),
        ]);
        run("2026-01-01", "2026-03-31", all, &p).unwrap().full.loans
    };
    assert_eq!(build("2026-03-05"), 1);
    assert_eq!(build("2026-03-06"), 0);
}

#[test]
fn scheduled_amount_is_the_median_of_the_members() {
    let mut all = incomes(&["2026-01", "2026-02", "2026-03", "2026-04"]);
    all.extend([
        emi("2026-01-05", 10_000),
        emi("2026-02-05", 10_001),
        emi("2026-03-05", 10_002),
        emi("2026-04-05", 10_003),
    ]);
    let s = scores("2026-01-01", "2026-04-30", all);
    // Even count: floor((10_001 + 10_002) / 2) = 10_001.
    assert_eq!(s.full.obligation_median, Paise::new(10_001));
}

#[test]
fn two_equal_instalments_every_month_are_two_loans() {
    let mut extra = emis(&Q1, "05", EMI);
    extra.extend(emis(&Q1, "06", EMI));
    let s = q1(extra);
    assert_eq!(s.full.loans, 2);
    assert_eq!(s.full.obligation_median, Paise::new(2 * EMI));
}

#[test]
fn three_equal_debits_in_one_month_are_not_a_loan() {
    let s = q1(vec![
        emi("2026-01-05", EMI),
        emi("2026-01-06", EMI),
        emi("2026-01-07", EMI),
    ]);
    assert_eq!(s.full.loans, 0);
    assert_eq!(s.full.obligation_median, Paise::ZERO);
}

#[test]
fn a_loan_counts_only_from_the_month_of_its_first_payment() {
    // Payments in Apr, May, Jun: monthly obligation [0,0,0,E,E,E].
    let s = h1(emis(&H1[3..], "05", EMI));
    assert_eq!(s.full.loans, 1);
    assert_eq!(s.full.obligation_median, Paise::new(EMI / 2));
    assert_eq!(s.recent.obligation_median, Paise::new(EMI));
}

#[test]
fn a_loan_with_a_late_first_payment_counts_in_that_month() {
    // First payment on Apr 30 (the month's last day), then May 29 and Jun 28:
    // monthly obligation [0,0,0,E,E,E]. If April were dropped it would be
    // [0,0,0,0,E,E] and the full median 0 instead of E/2.
    let s = h1(vec![
        emi("2026-04-30", EMI),
        emi("2026-05-29", EMI),
        emi("2026-06-28", EMI),
    ]);
    assert_eq!(s.full.loans, 1);
    assert_eq!(s.full.obligation_median, Paise::new(EMI / 2));
}

#[test]
fn a_loan_persists_after_its_last_payment() {
    // Paid Jan-Mar only; April-June still carry the obligation.
    let s = h1(emis(&H1[..3], "05", EMI));
    assert_eq!(s.full.obligation_median, Paise::new(EMI));
    assert_eq!(s.recent.obligation_median, Paise::new(EMI));
    assert_eq!(s.recent.loans, 1);
}

#[test]
fn a_loan_persists_through_bounced_months_with_unchanged_foir() {
    let paid = h1(emis(&H1, "05", EMI));
    let mut extra = emis(&["2026-01", "2026-02", "2026-03", "2026-06"], "05", EMI);
    extra.push(emi_bounce("2026-04-05", EMI));
    extra.push(emi_bounce("2026-05-05", EMI));
    let bounced = h1(extra);
    assert_eq!(bounced.full.foir_bps, paid.full.foir_bps);
    assert_eq!(bounced.full.obligation_median, Paise::new(EMI));
    assert_eq!(bounced.full.unmatched_emi_bounces, 0);
    assert_eq!(bounced.full.bounces, 2);
}

#[test]
fn huge_amounts_do_not_overflow_the_tolerance_check() {
    let big = 9_000_000_000_000_000_000;
    let s = q1(vec![
        emi("2026-01-05", big),
        emi("2026-02-05", big),
        emi("2026-03-05", big + 1),
    ]);
    assert_eq!(s.full.loans, 1);
    assert_eq!(s.full.foir_bps, u32::MAX);
    assert_eq!(s.outcome, Outcome::Reject);
}

// ------------------------------------------------- UnmeasuredDebt guard

#[test]
fn a_bounce_in_a_month_a_known_loan_missed_is_explained() {
    // Paid Jan-Mar, bounced in April: the loan has no payment in April.
    let mut all = incomes(&["2026-01", "2026-02", "2026-03", "2026-04"]);
    all.extend(emis(&Q1, "05", EMI));
    all.push(emi_bounce("2026-04-05", EMI));
    let s = scores("2026-01-01", "2026-04-30", all);
    assert_eq!(s.full.bounces, 1);
    assert_eq!(s.full.unmatched_emi_bounces, 0);
    assert_eq!(s.outcome, Outcome::Tier(Tier::B));
}

#[test]
fn a_bounce_in_a_month_every_known_loan_paid_is_unmatched() {
    let mut extra = emis(&Q1, "05", EMI);
    extra.push(emi_bounce("2026-03-15", 50_000));
    let s = q1(extra);
    assert_eq!(s.full.unmatched_emi_bounces, 1);
    assert_eq!(s.outcome, Outcome::Reject);
}

#[test]
fn two_bounces_with_one_missed_loan_leave_one_unmatched() {
    // Paid Jan-Mar; April: 2 EMI bounces, 1 known loan that missed April.
    let mut all = incomes(&["2026-01", "2026-02", "2026-03", "2026-04"]);
    all.extend(emis(&Q1, "05", EMI));
    all.push(emi_bounce("2026-04-05", EMI));
    all.push(emi_bounce("2026-04-06", EMI));
    let s = scores("2026-01-01", "2026-04-30", all);
    assert_eq!(s.full.unmatched_emi_bounces, 1);
    assert_eq!(s.outcome, Outcome::Reject);
}

#[test]
fn no_bounce_and_no_loan_is_not_unmeasured_debt() {
    let s = q1(vec![]);
    assert_eq!(s.full.unmatched_emi_bounces, 0);
    assert_eq!(s.outcome, Outcome::Tier(Tier::A));
}

#[test]
fn a_missed_loan_month_without_a_bounce_is_not_negative_unmatched() {
    // Loan paid Jan-Mar, nothing in April, no bounce anywhere.
    let mut all = incomes(&["2026-01", "2026-02", "2026-03", "2026-04"]);
    all.extend(emis(&Q1, "05", EMI));
    let s = scores("2026-01-01", "2026-04-30", all);
    assert_eq!(s.full.unmatched_emi_bounces, 0);
}

#[test]
fn a_bounce_before_a_loans_first_payment_is_unmatched() {
    // Loan paid Mar-May; an EMI bounce on Feb 10 predates it: unknown debt.
    let mut extra = emis(&H1[2..5], "05", EMI);
    extra.push(emi_bounce("2026-02-10", EMI));
    let s = h1(extra);
    assert_eq!(s.full.unmatched_emi_bounces, 1);
    assert_eq!(s.recent.unmatched_emi_bounces, 0);
    assert_eq!(s.outcome, Outcome::Reject);
}

#[test]
fn nach_retry_in_the_same_month_is_rejected_as_unknown_debt() {
    let mut all = incomes(&["2026-01", "2026-02", "2026-03", "2026-04"]);
    all.extend([
        emi("2026-01-05", EMI),
        emi("2026-02-05", EMI),
        emi_bounce("2026-03-05", EMI),
        emi("2026-03-08", EMI),
        emi("2026-04-05", EMI),
    ]);
    let s = scores("2026-01-01", "2026-04-30", all);
    assert_eq!(s.full.loans, 1);
    assert_eq!(s.full.unmatched_emi_bounces, 1);
    assert_eq!(s.outcome, Outcome::Reject);
}

// ------------------------------------------------------ complete months

fn month_count(start: &str, end: &str) -> u32 {
    let mut all = Vec::new();
    for month in ["2025-12", "2026-01", "2026-02", "2026-03"] {
        let date = format!("{month}-15");
        if day(&date) >= day(start) && day(&date) <= day(end) {
            all.push(income(&date, INCOME));
        }
    }
    scores(start, end, all).full.months
}

#[test]
fn months_count_only_fully_covered_calendar_months() {
    assert_eq!(month_count("2026-01-01", "2026-03-31"), 3);
}

#[test]
fn a_start_after_the_first_of_the_month_drops_that_month() {
    assert_eq!(month_count("2026-01-02", "2026-03-31"), 2);
}

#[test]
fn an_end_before_the_last_of_the_month_drops_that_month() {
    assert_eq!(month_count("2026-01-01", "2026-03-30"), 2);
}

#[test]
fn months_roll_over_the_year_boundary() {
    assert_eq!(month_count("2025-12-01", "2026-01-31"), 2);
}

#[test]
fn a_leap_february_ends_on_the_29th() {
    let months = |end: &str| scores("2028-02-01", end, vec![]).full.months;
    assert_eq!(months("2028-02-29"), 1);
    assert_eq!(months("2028-02-28"), 0);
}

#[test]
fn income_in_an_incomplete_month_is_not_counted() {
    // Start Jan 2: January is incomplete, so its 999 never enters the median.
    let s = scores(
        "2026-01-02",
        "2026-03-31",
        vec![
            income("2026-01-15", 999),
            income("2026-02-15", INCOME),
            income("2026-03-15", INCOME),
        ],
    );
    assert_eq!(s.full.months, 2);
    assert_eq!(s.full.income_median, Paise::new(INCOME));
    assert_eq!(s.full.cv_bps, 0);
}

#[test]
fn recent_is_the_last_n_complete_months() {
    let mut all = incomes(&H1);
    all[0] = income("2026-01-01", 1); // first month is tiny: outside recent
    let s = scores("2026-01-01", "2026-06-30", all);
    assert_eq!(s.full.months, 6);
    assert_eq!(s.recent.months, 3);
    assert_eq!(s.recent.income_median, Paise::new(INCOME));
    assert_eq!(s.recent.cv_bps, 0);
}

#[test]
fn fewer_months_than_recent_months_makes_recent_equal_full() {
    let mut all = incomes(&H1[..2]);
    all.push(emi_bounce("2026-02-10", EMI));
    let s = scores("2026-01-01", "2026-02-28", all);
    assert_eq!(s.full.months, 2);
    assert_eq!(s.recent, s.full);
}

#[test]
fn recent_months_of_one_scores_only_the_last_month() {
    let p = policy_with([1000, 5, 3], 1, 30, &DEFAULT_TIERS);
    let mut all = incomes(&H1);
    all.push(plain_bounce("2026-02-10"));
    let s = run("2026-01-01", "2026-06-30", all, &p).unwrap();
    assert_eq!(s.recent.months, 1);
    assert_eq!(s.recent.bounces, 0);
    assert_eq!(s.full.bounces, 1);
}

#[test]
fn no_complete_month_rejects_with_empty_features() {
    let s = scores(
        "2026-01-05",
        "2026-01-20",
        vec![income("2026-01-10", INCOME), plain_bounce("2026-01-12")],
    );
    assert_eq!(s.outcome, Outcome::Reject);
    assert_eq!(s.full.months, 0);
    assert_eq!(s.full.income_median, Paise::ZERO);
    assert_eq!(s.recent.months, 0);
    // Full span is the whole statement; recent is the empty span.
    assert_eq!(s.full.bounces, 1);
    assert_eq!(s.recent.bounces, 0);
}

#[test]
fn a_statement_without_transactions_rejects_for_no_income() {
    let s = scores("2026-01-01", "2026-03-31", vec![]);
    assert_eq!(s.full.months, 3);
    assert_eq!(s.full.income_median, Paise::ZERO);
    assert_eq!(s.full.foir_bps, 0);
    assert_eq!(s.full.cv_bps, 0);
    assert_eq!(s.outcome, Outcome::Reject);
}

#[test]
fn bounces_and_od_in_a_partial_month_count_for_full_only() {
    // Start Jan 15; recent = Feb-Apr. A bounce and an overdrawn balance on
    // Jan 20 belong to the statement's days but not to the recent span.
    let mut all = vec![
        plain_bounce("2026-01-20"),
        txn_at("2026-01-20", 13, false, 5, -5, false, false),
    ];
    all.extend(incomes(&["2026-02", "2026-03", "2026-04"]));
    let s = scores("2026-01-15", "2026-04-30", all);
    assert_eq!(s.full.months, 3);
    assert_eq!(s.full.bounces, 1);
    assert_eq!(s.recent.bounces, 0);
    // Negative from the end of Jan 20 through Jan 31; Feb 1's income recovers.
    assert_eq!(s.full.od_days, 12);
    assert_eq!(s.recent.od_days, 0);
}

// ------------------------------------------------------------ overdraft

fn od_days(extra: Vec<Txn>) -> u32 {
    q1(extra).full.od_days
}

#[test]
fn a_negative_balance_carries_across_days_without_transactions() {
    // Negative at the end of Jan 10 until Feb 1's income: Jan 10..=31.
    assert_eq!(od_days(vec![spend("2026-01-10", -5)]), 22);
}

#[test]
fn days_before_the_first_transaction_are_not_overdrawn() {
    // First txn Jan 5 is negative; Jan 1-4 have no balance and don't count.
    let s = scores(
        "2026-01-01",
        "2026-03-31",
        vec![
            spend("2026-01-05", -5),
            income("2026-02-01", INCOME),
            income("2026-03-01", INCOME),
        ],
    );
    assert_eq!(s.full.od_days, 27);
}

#[test]
fn an_overdrawn_balance_runs_to_the_statement_end_and_no_further() {
    assert_eq!(od_days(vec![spend("2026-03-20", -5)]), 12);
}

#[test]
fn a_day_counts_by_its_last_transaction_negative_then_positive() {
    let extra = vec![
        txn_at("2026-01-10", 9, false, 5, -5, false, false),
        txn_at("2026-01-10", 15, true, 5, BAL, true, false),
    ];
    assert_eq!(od_days(extra), 0);
}

#[test]
fn a_day_counts_by_its_last_transaction_positive_then_negative() {
    let extra = vec![
        txn_at("2026-01-10", 9, true, 5, BAL, true, false),
        txn_at("2026-01-10", 15, false, 5, -5, false, false),
    ];
    assert_eq!(od_days(extra), 22);
}

#[test]
fn a_balance_of_exactly_zero_is_not_overdrawn() {
    assert_eq!(od_days(vec![spend("2026-01-10", 0)]), 0);
}

#[test]
fn twenty_nine_overdraft_days_do_not_reject() {
    // Negative Jan 2..=30 (29 days); Jan 31's txn is back in credit.
    let s = q1(vec![spend("2026-01-02", -5), spend("2026-01-31", 10)]);
    assert_eq!(s.full.od_days, 29);
    assert_eq!(s.outcome, Outcome::Tier(Tier::A));
}

#[test]
fn thirty_overdraft_days_reject() {
    // Negative Jan 2..=31 (30 days).
    let s = q1(vec![spend("2026-01-02", -5)]);
    assert_eq!(s.full.od_days, 30);
    assert_eq!(s.outcome, Outcome::Reject);
}

#[test]
fn od_days_min_comes_from_the_policy() {
    let p = policy_with([1000, 5, 3], 3, 2, &DEFAULT_TIERS);
    let mut all = incomes(&Q1);
    // Negative on Jan 10 and Jan 11 only.
    all.extend([spend("2026-01-10", -5), spend("2026-01-12", 10)]);
    let s = run("2026-01-01", "2026-03-31", all, &p).unwrap();
    assert_eq!(s.full.od_days, 2);
    assert_eq!(s.outcome, Outcome::Reject);
}

// ----------------------------------------------------------- bounds

fn one_credit_at(at: i64) -> Result<Scores, ScoreError> {
    let t = Txn {
        credit: true,
        amount: Paise::new(INCOME),
        balance: Paise::new(BAL),
        at,
        bounce: false,
        emi_word: false,
    };
    run("2026-01-01", "2026-01-31", vec![t], &default_policy())
}

#[test]
fn a_txn_in_the_first_second_of_the_start_day_is_accepted() {
    assert!(one_credit_at(ist("2026-01-01", 0)).is_ok());
}

#[test]
fn a_txn_one_second_before_the_start_day_is_outside() {
    assert_eq!(
        one_credit_at(ist("2026-01-01", 0) - 1).map(|_| ()),
        Err(ScoreError::TxnOutsideStatement)
    );
}

#[test]
fn a_txn_in_the_last_second_of_the_end_day_is_accepted() {
    assert!(one_credit_at(ist("2026-02-01", 0) - 1).is_ok());
}

#[test]
fn a_txn_in_the_first_second_after_the_end_day_is_outside() {
    assert_eq!(
        one_credit_at(ist("2026-02-01", 0)).map(|_| ()),
        Err(ScoreError::TxnOutsideStatement)
    );
}

#[test]
fn bounds_use_india_days_not_utc_days() {
    // 2026-01-01T00:30+05:30 is Dec 31 in UTC but Jan 1 in India.
    assert!(one_credit_at(ist("2026-01-01", 0) + 1_800).is_ok());
    // 2026-01-31T18:31Z is Feb 1 in India: outside a statement ending Jan 31.
    let utc_jan_31_1831 = day("2026-01-31") * 86_400 + 18 * 3_600 + 31 * 60;
    assert_eq!(
        one_credit_at(utc_jan_31_1831).map(|_| ()),
        Err(ScoreError::TxnOutsideStatement)
    );
}

#[test]
fn an_ignored_txn_outside_the_statement_is_still_an_error() {
    let outside = spend("2026-02-10", BAL);
    let r = run(
        "2026-01-01",
        "2026-01-31",
        vec![income("2026-01-10", INCOME), outside],
        &default_policy(),
    );
    assert_eq!(r.map(|_| ()), Err(ScoreError::TxnOutsideStatement));
}

#[test]
fn income_time_of_day_in_india_picks_the_month() {
    // 2026-01-31T18:31Z is 00:01 on Feb 1 in India: February income.
    let utc_jan_31_1831 = day("2026-01-31") * 86_400 + 18 * 3_600 + 31 * 60;
    let t = Txn {
        credit: true,
        amount: Paise::new(30_000),
        balance: Paise::new(BAL),
        at: utc_jan_31_1831,
        bounce: false,
        emi_word: false,
    };
    let s = scores(
        "2026-01-01",
        "2026-02-28",
        vec![income("2026-01-10", 10_000), t],
    );
    // [10_000, 30_000]: median 20_000, cv 5000 (D = 4e8, isqrt(4e16) = 2e8).
    assert_eq!(s.full.income_median, Paise::new(20_000));
    assert_eq!(s.full.cv_bps, 5000);
}

// ---------------------------------------------------------- overflow

#[test]
fn monthly_income_sum_overflow_is_an_error() {
    let r = run(
        "2026-01-01",
        "2026-03-31",
        vec![
            income("2026-01-10", i64::MAX),
            income("2026-01-11", 1),
            income("2026-02-10", INCOME),
            income("2026-03-10", INCOME),
        ],
        &default_policy(),
    );
    assert_eq!(r.map(|_| ()), Err(ScoreError::Overflow));
}

#[test]
fn monthly_obligation_sum_overflow_is_an_error() {
    let half = 5_000_000_000_000_000_000;
    let mut all = incomes(&Q1);
    for dom in ["05", "06"] {
        all.extend(emis(&Q1, dom, half));
    }
    let r = run("2026-01-01", "2026-03-31", all, &default_policy());
    assert_eq!(r.map(|_| ()), Err(ScoreError::Overflow));
}

#[test]
fn cv_overflow_through_score_is_an_error() {
    // Incomes [9e18, 0, 0]: 10^8 * D does not fit in u128.
    let r = run(
        "2026-01-01",
        "2026-03-31",
        vec![income("2026-01-10", 9_000_000_000_000_000_000)],
        &default_policy(),
    );
    assert_eq!(r.map(|_| ()), Err(ScoreError::Overflow));
}

#[test]
fn income_sum_that_would_wrap_back_positive_is_an_error() {
    // MAX + MAX wraps to -2, + MAX wraps back to MAX - 2: positive. With one
    // month the CV spread is 0, so no later step overflows either: only the
    // checked add can catch it.
    let all = vec![
        income("2026-01-10", i64::MAX),
        income("2026-01-11", i64::MAX),
        income("2026-01-12", i64::MAX),
    ];
    let r = run("2026-01-01", "2026-01-31", all, &default_policy());
    assert_eq!(r.map(|_| ()), Err(ScoreError::Overflow));
}

#[test]
fn loan_starting_after_the_recent_months_is_not_active_in_them() {
    // min_occurrences 1: one EMI in the trailing partial month (April) is a
    // loan for the statement, but it hadn't started in Jan-Mar.
    let policy = policy_with([1000, 5, 1], 3, 30, &DEFAULT_TIERS);
    let mut all = incomes(&Q1);
    all.push(emi("2026-04-05", EMI));
    let s = run("2026-01-01", "2026-04-15", all, &policy).unwrap();
    assert_eq!(s.full.loans, 1);
    assert_eq!(s.recent.loans, 0);
}

// ------------------------------------------------------------ ordering

/// Fixture with loans, bounces, an overdraft and an equal-`at` pair.
fn busy_statement() -> Vec<Txn> {
    let mut all = incomes(&H1);
    all.extend(emis(&H1, "05", EMI));
    all.push(plain_bounce("2026-02-20"));
    // Equal timestamps, in this input order: balance -5 then back in credit.
    all.push(txn_at("2026-03-10", 12, false, 5, -5, false, false));
    all.push(txn_at("2026-03-10", 12, true, 5, BAL, true, false));
    all.push(txn_at("2026-04-12", 9, false, 7, -7, false, false));
    all
}

/// Groups of equal `at`, in order; the groups are reversed, the order
/// inside each group is kept.
fn reverse_groups(mut sorted: Vec<Txn>) -> Vec<Txn> {
    sorted.sort_by_key(|t| t.at); // stable
    let mut groups: Vec<Vec<Txn>> = Vec::new();
    for t in sorted {
        match groups.last_mut() {
            Some(g) if g[0].at == t.at => g.push(t),
            _ => groups.push(vec![t]),
        }
    }
    groups.into_iter().rev().flatten().collect()
}

#[test]
fn input_permutation_that_keeps_equal_timestamp_order_gives_the_same_scores() {
    let policy = default_policy();
    let original = run("2026-01-01", "2026-06-30", busy_statement(), &policy).unwrap();
    // Sanity: the fixture exercises the features it claims to.
    assert_eq!(original.full.loans, 1);
    assert_eq!(original.full.bounces, 1);
    assert!(original.full.od_days > 0);
    let shuffled = reverse_groups(busy_statement());
    assert_ne!(shuffled, busy_statement());
    let again = run("2026-01-01", "2026-06-30", shuffled, &policy).unwrap();
    assert_eq!(again, original);
}

#[test]
fn equal_timestamp_txns_keep_input_order_so_swapping_them_changes_od_days() {
    let neg = txn_at("2026-02-10", 12, false, 5, -5, false, false);
    let pos = txn_at("2026-02-10", 12, true, 5, BAL, true, false);
    let with_order = |first: Txn, second: Txn| {
        let mut all = incomes(&Q1);
        all.extend([first, second]);
        scores("2026-01-01", "2026-03-31", all).full.od_days
    };
    // Last in input order wins: ends in credit (0) or overdrawn Feb 10..=28.
    assert_eq!(with_order(neg, pos), 0);
    assert_eq!(with_order(pos, neg), 19);
}

#[test]
fn transactions_are_ordered_by_time_not_by_input_position() {
    // Input lists the later (positive) txn first; time order decides.
    let early = txn_at("2026-01-10", 9, false, 5, -5, false, false);
    let late = txn_at("2026-01-10", 15, true, 5, BAL, true, false);
    assert_eq!(od_days(vec![late, early]), 0);
}

// ------------------------------------------------------------- bench

#[test]
#[ignore = "benchmark: run in release with --ignored --nocapture"]
fn bench_twenty_thousand_distinct_candidates() {
    // Distinct amounts and a zero tolerance: no candidate ever joins a
    // cluster, so clustering does the full O(c^2) work.
    let policy = policy_with([0, 5, 3], 3, 30, &DEFAULT_TIERS);
    let base = ist("2026-01-01", 0);
    let transactions: Vec<Txn> = (0..20_000_i64)
        .map(|i| Txn {
            credit: false,
            amount: Paise::new(1_000 + i),
            balance: Paise::new(BAL),
            at: base + i * 1_575,
            bounce: false,
            emi_word: true,
        })
        .collect();
    let started = Instant::now();
    let result = run("2026-01-01", "2026-12-31", transactions, &policy);
    let elapsed = started.elapsed();
    println!("score() over 20_000 distinct EMI candidates: {elapsed:?}");
    assert!(result.is_ok());
}
