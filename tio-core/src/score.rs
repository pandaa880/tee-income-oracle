//! Scoring (`docs/FORMATS.md` §6.1): a parsed DEPOSIT statement and a policy
//! → an outcome (tier or reject) and the features behind it.
//!
//! Pure and integer-only: money in paise (`i64`), ratios in basis points,
//! time in India calendar days. Every sum and product is checked; overflow is
//! an error, never a wrap. Features stay inside the enclave in production
//! (only the outcome leaves, via the attestation payload); test vectors
//! expose them so a second implementation can be compared field by field.
//!
//! Wiping rule: every heap buffer holding bank-derived values is a
//! `Zeroizing` buffer sized up front (never grown by `push` or `collect`
//! from a filter, so no unwiped old allocation is freed), and no map or set
//! holds bank data. Known residual: `Entry`, `Txn` and `Features` are `Copy`,
//! so stack copies (and a `Features` copied out of `Scores`) are not wiped;
//! the same holds for the `Copy` types of `rebit`.

use zeroize::{Zeroize, ZeroizeOnDrop, Zeroizing};

use crate::money::Paise;
use crate::policy::{Policy, Recurrence, Rules, Tier};
use crate::rebit::{DepositFi, Txn};
use crate::time::{civil_from_days, days_from_civil};
use crate::ErrorCode;

/// India Standard Time, UTC+05:30, in seconds. India has no daylight saving.
const IST_OFFSET: i64 = 19_800;

const SECS_PER_DAY: i64 = 86_400;

/// Final verdict. Ordered best first, `Tier(A) < Tier(B) < Tier(C) < Reject`,
/// so "worse of two" is `max`.
///
/// Not zeroized: the outcome is the one value that leaves the enclave.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Outcome {
    Tier(Tier),
    Reject,
}

/// What one set of complete months looks like (FORMATS §6.1 step 5).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Zeroize)]
pub struct Features {
    /// Complete calendar months in the set.
    pub months: u32,
    /// Median of the monthly income sums.
    pub income_median: Paise,
    /// Median of the monthly obligation sums (scheduled EMIs of known loans).
    pub obligation_median: Paise,
    /// `floor(obligation_median * 10000 / income_median)`; `u32::MAX` means
    /// "at or above the representable cap" and always rejects.
    pub foir_bps: u32,
    /// Coefficient of variation of the monthly incomes, in basis points.
    pub cv_bps: u32,
    /// Known recurring loans active in the set.
    pub loans: u32,
    /// Bounce transactions on the set's days.
    pub bounces: u32,
    /// EMI bounces not explained by a known loan missing that month.
    pub unmatched_emi_bounces: u32,
    /// Days of the set that end with a negative balance.
    pub od_days: u32,
}

/// The scorer's result: the final outcome and both feature sets.
#[derive(Debug, Clone, PartialEq, Eq, Zeroize, ZeroizeOnDrop)]
pub struct Scores {
    /// Worse of the full-window and recent-window outcomes.
    #[zeroize(skip)]
    pub outcome: Outcome,
    /// All complete months (bounces and OD days: the whole statement).
    pub full: Features,
    /// The last `recent_months` complete months.
    pub recent: Features,
}

/// Why a statement could not be scored. Carries no bank data.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum ScoreError {
    #[error("transaction outside the statement period")]
    TxnOutsideStatement,
    #[error("score arithmetic overflow")]
    Overflow,
}

impl ErrorCode for ScoreError {
    fn code(&self) -> &'static str {
        match self {
            ScoreError::TxnOutsideStatement => "window_mismatch",
            ScoreError::Overflow => "bad_fi_data",
        }
    }
}

/// Why one feature set was rejected, in the order the rules are checked
/// (FORMATS §6.1 step 6). Internal: only `Outcome::Reject` leaves.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RejectReason {
    NoMonths,
    NoIncome,
    FoirOutOfRange,
    UnmeasuredDebt,
    Overdraft,
    NoTierMatch,
}

/// One transaction with its calendar position, in scoring order.
#[derive(Debug, Clone, Copy, Zeroize)]
struct Entry {
    /// India calendar day.
    day: i64,
    /// Month key, `year * 12 + month - 1`.
    month: i64,
    /// Day of month, 1–31.
    dom: i64,
    txn: Txn,
}

/// What a transaction counts as (FORMATS §6.1 step 1).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Class {
    Income,
    Candidate,
    Bounce { emi: bool },
    Ignored,
}

/// Inclusive range of India calendar days.
#[derive(Debug, Clone, Copy)]
struct DaySpan {
    first: i64,
    last: i64,
}

impl DaySpan {
    fn contains(&self, day: i64) -> bool {
        self.first <= day && day <= self.last
    }
}

/// A complete calendar month of the statement.
#[derive(Debug, Clone, Copy)]
struct Month {
    key: i64,
    span: DaySpan,
}

/// A recurring obligation: a cluster with at least `min_occurrences` months.
#[derive(Debug, Clone, Zeroize)]
struct Loan {
    /// Median of the member amounts; counted every month from `first_day`.
    scheduled: Paise,
    /// India day of the first payment.
    first_day: i64,
    /// Month keys with a payment.
    paid_months: Vec<i64>,
}

/// Scores a statement under a policy (FORMATS §6.1).
///
/// # Errors
///
/// - [`ScoreError::TxnOutsideStatement`]: a transaction's India calendar day
///   is outside `[start_day, end_day]`.
/// - [`ScoreError::Overflow`]: checked arithmetic overflowed.
pub fn score(fi: &DepositFi, policy: &Policy) -> Result<Scores, ScoreError> {
    let rules = &policy.rules;
    let statement = DaySpan {
        first: fi.start_day,
        last: fi.end_day,
    };
    let entries = ordered_entries(fi, statement)?;
    let loans = find_loans(&entries, &rules.recurrence);
    let months = complete_months(fi.start_day, fi.end_day);
    let recent_len = months
        .len()
        .min(usize::try_from(rules.recent_months).unwrap_or(usize::MAX));
    let recent_months = months.get(months.len() - recent_len..).unwrap_or(&[]);
    let full = features(&entries, &loans, &months, Some(statement))?;
    let recent = features(&entries, &loans, recent_months, span_of(recent_months))?;
    let outcome = outcome(&full, rules).max(outcome(&recent, rules));
    Ok(Scores {
        outcome,
        full,
        recent,
    })
}

/// Checks every transaction lies inside the statement and returns them in
/// scoring order: by timestamp, ties kept in input order.
fn ordered_entries(
    fi: &DepositFi,
    statement: DaySpan,
) -> Result<Zeroizing<Vec<Entry>>, ScoreError> {
    // Sort (timestamp, index) pairs, not transactions: an in-place unstable
    // sort on a unique key is deterministic and leaves no unwiped copies.
    let mut order: Zeroizing<Vec<(i64, usize)>> = Zeroizing::new(
        fi.transactions
            .iter()
            .enumerate()
            .map(|(i, t)| (t.at, i))
            .collect(),
    );
    order.sort_unstable();
    let mut entries = Zeroizing::new(Vec::with_capacity(order.len()));
    for txn in order.iter().filter_map(|&(_, i)| fi.transactions.get(i)) {
        let day = india_day(txn.at);
        if !statement.contains(day) {
            return Err(ScoreError::TxnOutsideStatement);
        }
        entries.push(Entry {
            day,
            month: month_key(day),
            dom: civil_from_days(day).2,
            txn: *txn,
        });
    }
    Ok(entries)
}

/// India calendar day (days since 1970-01-01 in IST) of a unix timestamp.
fn india_day(at: i64) -> i64 {
    at.saturating_add(IST_OFFSET).div_euclid(SECS_PER_DAY)
}

fn classify(txn: &Txn) -> Class {
    match (txn.credit, txn.bounce, txn.emi_word) {
        (false, true, emi) => Class::Bounce { emi },
        (false, false, true) => Class::Candidate,
        (true, false, _) => Class::Income,
        _ => Class::Ignored,
    }
}

/// Loans from the EMI candidates (FORMATS §6.1 step 2).
fn find_loans(entries: &[Entry], recurrence: &Recurrence) -> Zeroizing<Vec<Loan>> {
    let mut candidates = Zeroizing::new(Vec::with_capacity(entries.len()));
    candidates.extend(
        entries
            .iter()
            .filter(|e| classify(&e.txn) == Class::Candidate)
            .copied(),
    );
    let min_occurrences = usize::try_from(recurrence.min_occurrences).unwrap_or(usize::MAX);
    let mut assigned = Zeroizing::new(vec![false; candidates.len()]);
    let mut loans = Zeroizing::new(Vec::with_capacity(candidates.len()));
    for (i, anchor) in candidates.iter().enumerate() {
        if assigned.get(i).copied().unwrap_or(true) {
            continue;
        }
        let members = grow_cluster(i, anchor, &candidates, &mut assigned, recurrence);
        if members.len() >= min_occurrences {
            loans.push(loan_from(&members));
        }
    }
    loans
}

/// The cluster anchored at candidate `i`: later unassigned candidates that
/// match the anchor, at most one per month.
fn grow_cluster(
    i: usize,
    anchor: &Entry,
    candidates: &[Entry],
    assigned: &mut [bool],
    recurrence: &Recurrence,
) -> Zeroizing<Vec<Entry>> {
    let mut members = Zeroizing::new(Vec::with_capacity(candidates.len() - i));
    members.push(*anchor);
    if let Some(slot) = assigned.get_mut(i) {
        *slot = true;
    }
    for (j, candidate) in candidates.iter().enumerate().skip(i + 1) {
        let Some(slot) = assigned.get_mut(j) else {
            continue;
        };
        if *slot || !joins(anchor, candidate, recurrence) {
            continue;
        }
        if members.iter().all(|m| m.month != candidate.month) {
            *slot = true;
            members.push(*candidate);
        }
    }
    members
}

/// Amount within `amount_tol_bps` of the anchor's and day of month within
/// `day_tol` of the anchor's.
fn joins(anchor: &Entry, candidate: &Entry, recurrence: &Recurrence) -> bool {
    let a = i128::from(anchor.txn.amount.into_inner());
    let c = i128::from(candidate.txn.amount.into_inner());
    let amount_ok = (c - a).abs() * 10_000 <= a * i128::from(recurrence.amount_tol_bps);
    let day_ok = (candidate.dom - anchor.dom).abs() <= i64::from(recurrence.day_tol);
    amount_ok && day_ok
}

fn loan_from(members: &[Entry]) -> Loan {
    let mut amounts: Zeroizing<Vec<i64>> =
        Zeroizing::new(members.iter().map(|m| m.txn.amount.into_inner()).collect());
    Loan {
        scheduled: Paise::new(median(&mut amounts)),
        first_day: members.first().map_or(0, |m| m.day),
        paid_months: members.iter().map(|m| m.month).collect(),
    }
}

/// Calendar months lying wholly inside `[start, end]`, ascending.
fn complete_months(start: i64, end: i64) -> Vec<Month> {
    (month_key(start)..=month_key(end))
        .map(|key| Month {
            key,
            span: month_span(key),
        })
        .filter(|m| m.span.first >= start && m.span.last <= end)
        .collect()
}

fn month_key(day: i64) -> i64 {
    let (year, month, _) = civil_from_days(day);
    year * 12 + month - 1
}

fn month_span(key: i64) -> DaySpan {
    let (year, month) = (key.div_euclid(12), key.rem_euclid(12) + 1);
    let next = if month == 12 {
        days_from_civil(year + 1, 1, 1)
    } else {
        days_from_civil(year, month + 1, 1)
    };
    DaySpan {
        first: days_from_civil(year, month, 1),
        last: next - 1,
    }
}

/// Days from the first month's first day to the last month's last day.
fn span_of(months: &[Month]) -> Option<DaySpan> {
    Some(DaySpan {
        first: months.first()?.span.first,
        last: months.last()?.span.last,
    })
}

/// Features of one set of months; `span` is the days that bounces and OD
/// days are counted on (`None`: no days).
fn features(
    entries: &[Entry],
    loans: &[Loan],
    months: &[Month],
    span: Option<DaySpan>,
) -> Result<Features, ScoreError> {
    let (mut incomes, mut obligations) = monthly_sums(entries, loans, months)?;
    let cv = cv_bps(&incomes)?;
    let income_median = median(&mut incomes);
    let obligation_median = median(&mut obligations);
    let active_loans = span.map_or(0, |s| {
        loans.iter().filter(|l| l.first_day <= s.last).count()
    });
    let bounces = span.map_or(0, |s| {
        entries
            .iter()
            .filter(|e| s.contains(e.day) && matches!(classify(&e.txn), Class::Bounce { .. }))
            .count()
    });
    Ok(Features {
        months: count(months.len())?,
        income_median: Paise::new(income_median),
        obligation_median: Paise::new(obligation_median),
        foir_bps: foir_bps(obligation_median, income_median),
        cv_bps: cv,
        loans: count(active_loans)?,
        bounces: count(bounces)?,
        unmatched_emi_bounces: unmatched_emi_bounces(entries, loans, span)?,
        od_days: od_days(entries, span)?,
    })
}

fn count(n: usize) -> Result<u32, ScoreError> {
    u32::try_from(n).map_err(|_| ScoreError::Overflow)
}

/// Per-month income sums and obligation sums, aligned with the months.
type MonthlySums = (Zeroizing<Vec<i64>>, Zeroizing<Vec<i64>>);

/// Per month: the income sum, and the scheduled amounts of the loans that
/// started by the month's end (FORMATS §6.1 step 4).
fn monthly_sums(
    entries: &[Entry],
    loans: &[Loan],
    months: &[Month],
) -> Result<MonthlySums, ScoreError> {
    let mut incomes = Zeroizing::new(vec![0_i64; months.len()]);
    for e in entries.iter().filter(|e| classify(&e.txn) == Class::Income) {
        let index = months.binary_search_by_key(&e.month, |m| m.key).ok();
        if let Some(slot) = index.and_then(|i| incomes.get_mut(i)) {
            *slot = slot
                .checked_add(e.txn.amount.into_inner())
                .ok_or(ScoreError::Overflow)?;
        }
    }
    let mut obligations = Zeroizing::new(Vec::with_capacity(months.len()));
    for month in months {
        obligations.push(obligation_in(loans, month)?);
    }
    Ok((incomes, obligations))
}

fn obligation_in(loans: &[Loan], month: &Month) -> Result<i64, ScoreError> {
    loans
        .iter()
        .filter(|l| l.first_day <= month.span.last)
        .try_fold(0_i64, |sum, l| {
            sum.checked_add(l.scheduled.into_inner())
                .ok_or(ScoreError::Overflow)
        })
}

/// EMI bounces on `span`'s days that no known loan's missed month explains.
/// Entries are in time order, so each month's bounces form one run: count
/// runs in place instead of building a map of bank data.
fn unmatched_emi_bounces(
    entries: &[Entry],
    loans: &[Loan],
    span: Option<DaySpan>,
) -> Result<u32, ScoreError> {
    let Some(span) = span else {
        return Ok(0);
    };
    let mut emi_bounces = entries
        .iter()
        .filter(|e| span.contains(e.day) && classify(&e.txn) == Class::Bounce { emi: true })
        .peekable();
    let mut unmatched = 0_usize;
    while let Some(first) = emi_bounces.next() {
        let mut bounces = 1_usize;
        while emi_bounces.next_if(|e| e.month == first.month).is_some() {
            bounces += 1;
        }
        unmatched += bounces.saturating_sub(missed(loans, first.month));
    }
    count(unmatched)
}

/// Known loans that had started by the end of month `key` but have no
/// payment in it.
fn missed(loans: &[Loan], key: i64) -> usize {
    let last = month_span(key).last;
    loans
        .iter()
        .filter(|l| l.first_day <= last && !l.paid_months.contains(&key))
        .count()
}

/// Days of `span` whose end-of-day balance is negative. A day's balance is
/// the last transaction's balance on or before it; days before the first
/// transaction don't count.
fn od_days(entries: &[Entry], span: Option<DaySpan>) -> Result<u32, ScoreError> {
    let Some(span) = span else {
        return Ok(0);
    };
    let mut days = 0_i64;
    let mut rest = entries.iter().peekable();
    while let Some(first) = rest.next() {
        let mut last = first;
        while let Some(same_day) = rest.next_if(|e| e.day == first.day) {
            last = same_day;
        }
        if last.txn.balance < Paise::ZERO {
            let until = rest.peek().map_or(i64::MAX, |next| next.day - 1);
            days += overlap(first.day, until, span);
        }
    }
    u32::try_from(days).map_err(|_| ScoreError::Overflow)
}

/// Number of days in both `[first, last]` and `span`.
fn overlap(first: i64, last: i64, span: DaySpan) -> i64 {
    (last.min(span.last) - first.max(span.first) + 1).max(0)
}

/// Median: odd count → middle value; even → floor of the two middle values'
/// mean; empty → 0. Sorts `values` in place.
fn median(values: &mut [i64]) -> i64 {
    values.sort_unstable();
    let mid = values.len() / 2;
    match (values.len() % 2, values.get(mid)) {
        (_, None) => 0,
        (1, Some(&middle)) => middle,
        (_, Some(&upper)) => {
            let lower = values.get(mid - 1).copied().unwrap_or(upper);
            let mean = (i128::from(lower) + i128::from(upper)).div_euclid(2);
            i64::try_from(mean).unwrap_or(upper)
        }
    }
}

/// Coefficient of variation of `incomes` in basis points:
/// `floor(isqrt(10^8 * (n*Σx² − (Σx)²)) / Σx)`, 0 when `Σx == 0`. Scaling
/// before the root keeps it exact: `floor(floor(y) / b) = floor(y / b)`.
fn cv_bps(incomes: &[i64]) -> Result<u32, ScoreError> {
    let n = u128::try_from(incomes.len()).map_err(|_| ScoreError::Overflow)?;
    let (mut sum, mut sum_sq) = (0_u128, 0_u128);
    for &income in incomes {
        let x = u128::try_from(income).map_err(|_| ScoreError::Overflow)?;
        sum = sum.checked_add(x).ok_or(ScoreError::Overflow)?;
        let square = x.checked_mul(x).ok_or(ScoreError::Overflow)?;
        sum_sq = sum_sq.checked_add(square).ok_or(ScoreError::Overflow)?;
    }
    if sum == 0 {
        return Ok(0);
    }
    let spread = n
        .checked_mul(sum_sq)
        .and_then(|a| a.checked_sub(sum.checked_mul(sum)?))
        .and_then(|d| d.checked_mul(100_000_000))
        .ok_or(ScoreError::Overflow)?;
    u32::try_from(spread.isqrt() / sum).map_err(|_| ScoreError::Overflow)
}

/// `floor(obligation * 10000 / income)`, `u32::MAX` at or above the cap,
/// 0 when `income == 0`.
fn foir_bps(obligation: i64, income: i64) -> u32 {
    if income <= 0 {
        return 0;
    }
    let ratio = i128::from(obligation) * 10_000 / i128::from(income);
    u32::try_from(ratio.clamp(0, i128::from(u32::MAX))).unwrap_or(u32::MAX)
}

/// The first rule a feature set breaks, in FORMATS §6.1 order, or `None`.
fn reject_reason(features: &Features, rules: &Rules) -> Option<RejectReason> {
    let reason = if features.months == 0 {
        RejectReason::NoMonths
    } else if features.income_median <= Paise::ZERO {
        RejectReason::NoIncome
    } else if features.foir_bps == u32::MAX {
        RejectReason::FoirOutOfRange
    } else if features.unmatched_emi_bounces > 0 {
        RejectReason::UnmeasuredDebt
    } else if features.od_days >= rules.reject_if.od_days_min {
        RejectReason::Overdraft
    } else if matching_tier(features, rules).is_none() {
        RejectReason::NoTierMatch
    } else {
        return None;
    };
    Some(reason)
}

/// The first tier whose every limit the features meet.
fn matching_tier(features: &Features, rules: &Rules) -> Option<Tier> {
    rules
        .tiers
        .iter()
        .find(|t| {
            features.foir_bps <= t.foir_max_bps
                && features.cv_bps <= t.cv_max_bps
                && features.bounces <= t.bounces_max
        })
        .map(|t| t.tier)
}

fn outcome(features: &Features, rules: &Rules) -> Outcome {
    match reject_reason(features, rules) {
        Some(_) => Outcome::Reject,
        None => matching_tier(features, rules).map_or(Outcome::Reject, Outcome::Tier),
    }
}

#[cfg(test)]
mod tests;
