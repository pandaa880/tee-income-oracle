//! ReBIT DEPOSIT FI data → the minimal typed statement the scorer needs
//! (`docs/FORMATS.md` §1, §12).
//!
//! The bytes arrive decrypted and FIP-signature-verified, so leniency here
//! affects correctness, not security: shape is accepted leniently (wrapper,
//! key case, object-or-array), meaning is checked strictly (enums, money,
//! timestamps). Only what scoring uses is read. `Profile`, `Summary` and ids
//! are never parsed, and narration is reduced to two flags, so after parsing
//! the only bank data left in memory is integers and booleans.
//!
//! Wiping rule: free text that can hold personal data (narration) is decoded
//! into `Zeroizing`, and the parsed transactions live in a pre-sized buffer
//! owned by [`DepositFi`] (wiped on drop, error paths included, never
//! reallocated). Short structural strings (member names, enum values,
//! timestamps, dates) are not wiped: they hold no personal data, and their
//! values survive as integers anyway. The input bytes are the caller's
//! `Zeroizing` buffer.

use std::{collections::BTreeMap, fmt};

use serde::de::{Deserialize, Deserializer, MapAccess, Visitor};
use serde_json::value::RawValue;
use zeroize::{Zeroize, ZeroizeOnDrop, Zeroizing};

use crate::money::{parse_paise, MoneyError, Paise, Sign};
use crate::time::{parse_date, parse_rebit_timestamp};
use crate::ErrorCode;

/// Most transactions one statement may carry (FORMATS §1).
pub const MAX_TRANSACTIONS: usize = 20_000;

/// Narration tokens that mark a bounced payment or its return charge.
const BOUNCE_TOKENS: [&str; 5] = ["RTN", "RETURN", "RETURNED", "BOUNCE", "INSUFF"];

/// Narration tokens that mark a loan instalment.
const EMI_TOKENS: [&str; 4] = ["EMI", "LOAN", "NACH", "ECS"];

/// One DEPOSIT account statement, reduced to what scoring uses.
#[derive(Debug, Clone, PartialEq, Eq, Zeroize, ZeroizeOnDrop)]
pub struct DepositFi {
    /// `Transactions.startDate`, days since 1970-01-01 (UTC).
    pub start_day: i64,
    /// `Transactions.endDate`, days since 1970-01-01 (UTC), inclusive.
    pub end_day: i64,
    /// Transactions in input order.
    pub transactions: Vec<Txn>,
}

/// One transaction, reduced to what scoring uses.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Zeroize)]
pub struct Txn {
    /// `CREDIT` is true, `DEBIT` is false.
    pub credit: bool,
    /// `amount`, never negative.
    pub amount: Paise,
    /// `currentBalance` after this transaction; negative means overdrawn.
    pub balance: Paise,
    /// `transactionTimestamp`, unix seconds (UTC).
    pub at: i64,
    /// The narration has a bounce token (RTN, RETURN, RETURNED, BOUNCE, INSUFF).
    pub bounce: bool,
    /// The narration has an EMI token (EMI, LOAN, NACH, ECS).
    pub emi_word: bool,
}

/// Why FI data was rejected. Variants carry only schema field names, never
/// bank data.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum FiError {
    /// Not JSON; looks like XML (FORMATS §12).
    #[error("unsupported FI format")]
    UnsupportedFormat,
    /// Invalid JSON, or a value of the wrong JSON type.
    #[error("FI data has the wrong shape")]
    BadShape,
    /// Two members of one object whose names differ only by case.
    #[error("FI data repeats a member")]
    DuplicateKey,
    /// A required member is absent.
    #[error("FI data is missing {0}")]
    MissingField(&'static str),
    /// An enum member has a value outside the ReBIT enumeration.
    #[error("FI data has an unknown {0} value")]
    BadEnum(&'static str),
    /// The FI `type` is not DEPOSIT.
    #[error("FI data is not a DEPOSIT account")]
    NotDeposit,
    /// A money value failed [`crate::money::parse_paise`].
    #[error("FI data has a bad money value: {0}")]
    BadMoney(MoneyError),
    /// A timestamp or date is invalid, or `startDate` is after `endDate`.
    #[error("FI data has a bad {0}")]
    BadTime(&'static str),
    /// More than [`MAX_TRANSACTIONS`] transactions.
    #[error("FI data has too many transactions")]
    TooManyTransactions,
}

impl ErrorCode for FiError {
    fn code(&self) -> &'static str {
        match self {
            Self::UnsupportedFormat => "unsupported_fi_format",
            _ => "bad_fi_data",
        }
    }
}

/// Parses decrypted, FIP-verified DEPOSIT FI bytes.
///
/// # Errors
/// [`FiError`]. Checks run top-down, one object at a time
/// (`docs/FORMATS.md` §1): format, root, wrapper, `type`, `Transactions`,
/// its dates, the transaction count, then each transaction in input order.
pub fn parse_deposit_fi(fi_bytes: &[u8]) -> Result<DepositFi, FiError> {
    // XML exports often start with a UTF-8 byte-order mark; skip one.
    let fi_bytes = fi_bytes.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(fi_bytes);
    if fi_bytes.iter().find(|b| !b.is_ascii_whitespace()) == Some(&b'<') {
        return Err(FiError::UnsupportedFormat);
    }
    let root: &RawValue = serde_json::from_slice(fi_bytes).map_err(|_| FiError::BadShape)?;
    let account = unwrap_account(CiObject::parse(root)?)?;
    if !string(account.require("type")?)?.eq_ignore_ascii_case("DEPOSIT") {
        return Err(FiError::NotDeposit);
    }
    let statement = CiObject::parse(account.require("Transactions")?)?;
    let start_day = date_member(&statement, "startDate")?;
    let end_day = date_member(&statement, "endDate")?;
    if start_day > end_day {
        return Err(FiError::BadTime("endDate"));
    }
    let items = transaction_items(&statement)?;
    // Pre-sized and owned by `fi` from the start: the buffer never
    // reallocates (which would free an unwiped copy), and an error below
    // drops `fi`, whose ZeroizeOnDrop wipes the transactions parsed so far.
    let mut fi = DepositFi {
        start_day,
        end_day,
        transactions: Vec::with_capacity(items.len()),
    };
    for item in items {
        fi.transactions.push(parse_txn(item)?);
    }
    Ok(fi)
}

/// Descends into an optional `Account` wrapper: a root with `account` and no
/// `type` is the wrapper.
fn unwrap_account(root: CiObject<'_>) -> Result<CiObject<'_>, FiError> {
    match (root.get("account"), root.get("type")) {
        (Some(inner), None) => CiObject::parse(inner),
        _ => Ok(root),
    }
}

/// `Transaction` as an array, a single object, or absent (no transactions).
/// The count is checked before any item is parsed. The item pointers are
/// collected first; their memory is bounded by the enclave's request-body
/// cap, not by this check.
fn transaction_items<'a>(statement: &CiObject<'a>) -> Result<Vec<&'a RawValue>, FiError> {
    let Some(raw) = statement.get("Transaction") else {
        return Ok(Vec::new());
    };
    match raw.get().as_bytes().first() {
        Some(b'{') => Ok(vec![raw]),
        Some(b'[') => {
            let items: Vec<&RawValue> =
                serde_json::from_str(raw.get()).map_err(|_| FiError::BadShape)?;
            if items.len() > MAX_TRANSACTIONS {
                return Err(FiError::TooManyTransactions);
            }
            Ok(items)
        }
        _ => Err(FiError::BadShape),
    }
}

/// One transaction. Members are checked in this order: `type`, `mode`,
/// `amount`, `currentBalance`, `transactionTimestamp`, `narration`.
fn parse_txn(raw: &RawValue) -> Result<Txn, FiError> {
    let txn = CiObject::parse(raw)?;
    let credit = one_of(&txn, "type", &["CREDIT", "DEBIT"])? == 0;
    one_of(
        &txn,
        "mode",
        &["CASH", "ATM", "CARD", "UPI", "FT", "OTHERS"],
    )?;
    let amount = money_member(&txn, "amount", Sign::NonNegative)?;
    let balance = money_member(&txn, "currentBalance", Sign::Any)?;
    let timestamp = string(txn.require("transactionTimestamp")?)?;
    let at =
        parse_rebit_timestamp(&timestamp).map_err(|_| FiError::BadTime("transactionTimestamp"))?;
    let (bounce, emi_word) = narration_flags(&txn)?;
    Ok(Txn {
        credit,
        amount,
        balance,
        at,
        bounce,
        emi_word,
    })
}

/// The index in `allowed` of a string member's value, ignoring ASCII case.
fn one_of(obj: &CiObject<'_>, name: &'static str, allowed: &[&str]) -> Result<usize, FiError> {
    let value = string(obj.require(name)?)?;
    allowed
        .iter()
        .position(|a| value.eq_ignore_ascii_case(a))
        .ok_or(FiError::BadEnum(name))
}

fn money_member(obj: &CiObject<'_>, name: &'static str, sign: Sign) -> Result<Paise, FiError> {
    parse_paise(obj.require(name)?.get(), sign).map_err(FiError::BadMoney)
}

fn date_member(obj: &CiObject<'_>, name: &'static str) -> Result<i64, FiError> {
    parse_date(&string(obj.require(name)?)?).map_err(|_| FiError::BadTime(name))
}

/// Bounce and EMI flags from the narration; absent means neither, and
/// `null` is a wrong JSON type (FORMATS §1). The decoded text is wiped on
/// drop, and tokens are compared in place without copies, because narration
/// often names people. Known residual: a narration with JSON escapes is
/// decoded through serde_json's internal scratch buffer, which is freed
/// unwiped.
fn narration_flags(txn: &CiObject<'_>) -> Result<(bool, bool), FiError> {
    let Some(raw) = txn.get("narration") else {
        return Ok((false, false));
    };
    let text = Zeroizing::new(string(raw)?);
    let mut flags = (false, false);
    for token in text.split(|c: char| !c.is_ascii_alphanumeric()) {
        flags.0 |= BOUNCE_TOKENS.iter().any(|k| token.eq_ignore_ascii_case(k));
        flags.1 |= EMI_TOKENS.iter().any(|k| token.eq_ignore_ascii_case(k));
    }
    Ok(flags)
}

/// A JSON string member's value.
fn string(raw: &RawValue) -> Result<String, FiError> {
    serde_json::from_str(raw.get()).map_err(|_| FiError::BadShape)
}

/// One JSON object with member names compared ignoring ASCII case, values
/// kept as raw JSON text. Two names equal ignoring case are rejected rather
/// than letting the last one win silently.
struct CiObject<'a> {
    members: BTreeMap<String, &'a RawValue>,
}

impl<'a> CiObject<'a> {
    fn parse(raw: &'a RawValue) -> Result<Self, FiError> {
        let Entries(entries) = serde_json::from_str(raw.get()).map_err(|_| FiError::BadShape)?;
        let mut members = BTreeMap::new();
        for (name, value) in entries {
            if members.insert(name.to_ascii_lowercase(), value).is_some() {
                return Err(FiError::DuplicateKey);
            }
        }
        Ok(Self { members })
    }

    fn get(&self, name: &str) -> Option<&'a RawValue> {
        self.members.get(&name.to_ascii_lowercase()).copied()
    }

    fn require(&self, name: &'static str) -> Result<&'a RawValue, FiError> {
        self.get(name).ok_or(FiError::MissingField(name))
    }
}

/// Every member of one JSON object, in order, repeats included: serde's own
/// map types would keep only the last of a repeated name.
struct Entries<'a>(Vec<(String, &'a RawValue)>);

impl<'de> Deserialize<'de> for Entries<'de> {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        deserializer.deserialize_map(EntriesVisitor)
    }
}

struct EntriesVisitor;

impl<'de> Visitor<'de> for EntriesVisitor {
    type Value = Entries<'de>;

    fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("a JSON object")
    }

    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Self::Value, A::Error> {
        let mut entries = Vec::new();
        while let Some(entry) = map.next_entry::<String, &'de RawValue>()? {
            entries.push(entry);
        }
        Ok(Entries(entries))
    }
}

#[cfg(test)]
mod tests;
