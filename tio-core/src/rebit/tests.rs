#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::indexing_slicing,
    clippy::panic
)]

use serde_json::{json, Map, Value};

use super::*;
use crate::money::MoneyError;

// ---- fixture helpers -------------------------------------------------------

/// 2026-04-01T09:12:00Z in unix seconds (Python stdlib datetime, UTC).
const BASE_AT: i64 = 1_775_034_720;
/// 2026-03-26 and 2026-09-26 in days since epoch (Python date arithmetic).
const START_DAY: i64 = 20_538;
const END_DAY: i64 = 20_722;

fn txn() -> Value {
    json!({
        "type": "CREDIT",
        "mode": "UPI",
        "amount": 100,
        "currentBalance": "500.00",
        "transactionTimestamp": "2026-04-01T09:12:00.000Z",
        "narration": "NEFT-SAL-ACME"
    })
}

fn fi_with(transactions: Vec<Value>) -> Value {
    json!({
        "type": "DEPOSIT",
        "Transactions": {
            "startDate": "2026-03-26",
            "endDate": "2026-09-26",
            "Transaction": transactions
        }
    })
}

fn valid_fi() -> Value {
    fi_with(vec![txn()])
}

fn bytes(value: &Value) -> Vec<u8> {
    serde_json::to_vec(value).unwrap()
}

fn parse(value: &Value) -> Result<DepositFi, FiError> {
    parse_deposit_fi(&bytes(value))
}

fn txn_mut(fi: &mut Value, index: usize) -> &mut Map<String, Value> {
    fi["Transactions"]["Transaction"][index]
        .as_object_mut()
        .unwrap()
}

fn transactions_mut(fi: &mut Value) -> &mut Map<String, Value> {
    fi["Transactions"].as_object_mut().unwrap()
}

fn root_mut(fi: &mut Value) -> &mut Map<String, Value> {
    fi.as_object_mut().unwrap()
}

/// FI with one transaction that has `field` set to `value`.
fn with_txn_field(field: &str, value: Value) -> Value {
    let mut fi = valid_fi();
    txn_mut(&mut fi, 0).insert(field.to_owned(), value);
    fi
}

fn lowercase_keys(value: &Value) -> Value {
    match value {
        Value::Object(map) => Value::Object(
            map.iter()
                .map(|(k, v)| (k.to_ascii_lowercase(), lowercase_keys(v)))
                .collect(),
        ),
        Value::Array(items) => Value::Array(items.iter().map(lowercase_keys).collect()),
        other => other.clone(),
    }
}

fn flags_for(narration: &str) -> (bool, bool) {
    let fi = with_txn_field("narration", json!(narration));
    let parsed = parse(&fi).unwrap_or_else(|e| panic!("narration {narration:?}: {e:?}"));
    (
        parsed.transactions[0].bounce,
        parsed.transactions[0].emi_word,
    )
}

fn persona_fi(persona_json: &str) -> Vec<u8> {
    let persona: Value = serde_json::from_str(persona_json).unwrap();
    serde_json::to_vec(&persona["fi"]).unwrap()
}

fn salaried() -> DepositFi {
    parse_deposit_fi(&persona_fi(include_str!(
        "../../../test-vectors/personas/salaried_steady.json"
    )))
    .unwrap()
}

fn stressed() -> DepositFi {
    parse_deposit_fi(&persona_fi(include_str!(
        "../../../test-vectors/personas/stressed.json"
    )))
    .unwrap()
}

fn trader() -> DepositFi {
    parse_deposit_fi(&persona_fi(include_str!(
        "../../../test-vectors/personas/trader_lumpy.json"
    )))
    .unwrap()
}

// ---- accept: shape leniency ------------------------------------------------

#[test]
fn parses_minimal_valid_fi_into_typed_values() {
    let fi = parse(&valid_fi()).unwrap();
    assert_eq!(fi.start_day, START_DAY);
    assert_eq!(fi.end_day, END_DAY);
    assert_eq!(
        fi.transactions,
        vec![Txn {
            credit: true,
            amount: Paise::new(10_000),
            balance: Paise::new(50_000),
            at: BASE_AT,
            bounce: false,
            emi_word: false,
        }]
    );
}

#[test]
fn debit_type_is_not_credit() {
    let fi = parse(&with_txn_field("type", json!("DEBIT"))).unwrap();
    assert!(!fi.transactions[0].credit);
}

#[test]
fn keeps_transactions_in_input_order() {
    let mut second = txn();
    second["amount"] = json!(200);
    second["type"] = json!("DEBIT");
    let fi = parse(&fi_with(vec![txn(), second])).unwrap();
    let amounts: Vec<i64> = fi
        .transactions
        .iter()
        .map(|t| t.amount.into_inner())
        .collect();
    assert_eq!(amounts, vec![10_000, 20_000]);
}

#[test]
fn accepts_capitalised_account_wrapper() {
    let wrapped = json!({ "Account": valid_fi() });
    assert_eq!(parse(&wrapped).unwrap(), parse(&valid_fi()).unwrap());
}

#[test]
fn accepts_lowercase_account_wrapper() {
    let wrapped = json!({ "account": valid_fi() });
    assert_eq!(parse(&wrapped).unwrap(), parse(&valid_fi()).unwrap());
}

#[test]
fn accepts_all_lowercase_keys() {
    let lower = lowercase_keys(&valid_fi());
    assert_eq!(parse(&lower).unwrap(), parse(&valid_fi()).unwrap());
}

#[test]
fn accepts_all_lowercase_keys_under_a_wrapper() {
    let lower = lowercase_keys(&json!({ "Account": valid_fi() }));
    assert_eq!(parse(&lower).unwrap(), parse(&valid_fi()).unwrap());
}

#[test]
fn accepts_single_transaction_object() {
    let mut fi = valid_fi();
    transactions_mut(&mut fi).insert("Transaction".to_owned(), txn());
    let parsed = parse(&fi).unwrap();
    assert_eq!(parsed, parse(&valid_fi()).unwrap());
    assert_eq!(parsed.transactions.len(), 1);
}

#[test]
fn accepts_lowercase_deposit_type() {
    let mut fi = valid_fi();
    root_mut(&mut fi).insert("type".to_owned(), json!("deposit"));
    assert_eq!(parse(&fi).unwrap(), parse(&valid_fi()).unwrap());
}

#[test]
fn accepts_mixed_case_deposit_type() {
    let mut fi = valid_fi();
    root_mut(&mut fi).insert("type".to_owned(), json!("Deposit"));
    assert!(parse(&fi).is_ok());
}

#[test]
fn accepts_lowercase_enums() {
    let mut fi = valid_fi();
    txn_mut(&mut fi, 0).insert("type".to_owned(), json!("debit"));
    txn_mut(&mut fi, 0).insert("mode".to_owned(), json!("upi"));
    let parsed = parse(&fi).unwrap();
    assert!(!parsed.transactions[0].credit);
}

#[test]
fn accepts_every_mode_in_the_rebit_enumeration() {
    for mode in ["CASH", "ATM", "CARD", "UPI", "FT", "OTHERS"] {
        let fi = with_txn_field("mode", json!(mode));
        assert!(parse(&fi).is_ok(), "mode {mode:?}");
    }
}

#[test]
fn accepts_every_mode_in_lowercase() {
    for mode in ["cash", "atm", "card", "upi", "ft", "others"] {
        let fi = with_txn_field("mode", json!(mode));
        assert!(parse(&fi).is_ok(), "mode {mode:?}");
    }
}

#[test]
fn accepts_pretty_printed_json_with_whitespace_around_every_value() {
    let text = r#"
        {
          "type" : "DEPOSIT" ,
          "Transactions" : {
            "startDate" : "2026-03-26" ,
            "endDate" : "2026-09-26" ,
            "Transaction" : [
              {
                "type" : "CREDIT" ,
                "mode" : "UPI" ,
                "amount" : 100 ,
                "currentBalance" : "500.00" ,
                "transactionTimestamp" : "2026-04-01T09:12:00.000Z" ,
                "narration" : "NEFT-SAL-ACME"
              }
            ]
          }
        }
    "#;
    let parsed = parse_deposit_fi(text.as_bytes()).unwrap();
    assert_eq!(parsed, parse(&valid_fi()).unwrap());
}

#[test]
fn accepts_pretty_printed_money_as_a_bare_number_with_spacing() {
    let text = "{\"type\":\"DEPOSIT\",\"Transactions\":{\"startDate\":\"2026-03-26\",\
        \"endDate\":\"2026-09-26\",\"Transaction\":{\"type\":\"CREDIT\",\"mode\":\"UPI\",\
        \"amount\":\n\t 100.5 \n,\"currentBalance\": \"500.00\" ,\
        \"transactionTimestamp\":\"2026-04-01T09:12:00.000Z\"}}}";
    let parsed = parse_deposit_fi(text.as_bytes()).unwrap();
    assert_eq!(parsed.transactions[0].amount, Paise::new(10_050));
}

#[test]
fn accepts_pretty_printed_output_of_serde_json() {
    let text = serde_json::to_vec_pretty(&valid_fi()).unwrap();
    assert_eq!(
        parse_deposit_fi(&text).unwrap(),
        parse(&valid_fi()).unwrap()
    );
}

#[test]
fn accepts_leading_whitespace_before_the_root_object() {
    let mut text = b" \n\t\r ".to_vec();
    text.extend(bytes(&valid_fi()));
    assert_eq!(
        parse_deposit_fi(&text).unwrap(),
        parse(&valid_fi()).unwrap()
    );
}

#[test]
fn ignores_unknown_extra_members_everywhere() {
    let mut fi = valid_fi();
    root_mut(&mut fi).insert("maskedAccNumber".to_owned(), json!("XXXX1234"));
    root_mut(&mut fi).insert("Extra".to_owned(), json!([1, 2, { "a": null }]));
    transactions_mut(&mut fi).insert("mystery".to_owned(), json!(true));
    txn_mut(&mut fi, 0).insert("txnId".to_owned(), json!("abc"));
    txn_mut(&mut fi, 0).insert("valueDate".to_owned(), json!("not even a date"));
    assert_eq!(parse(&fi).unwrap(), parse(&valid_fi()).unwrap());
}

#[test]
fn never_reads_holder_when_it_is_an_array() {
    let mut fi = valid_fi();
    root_mut(&mut fi).insert(
        "Profile".to_owned(),
        json!({ "Holders": { "type": "JOINT", "Holder": [{ "name": "A" }, { "name": "B" }] } }),
    );
    assert_eq!(parse(&fi).unwrap(), parse(&valid_fi()).unwrap());
}

#[test]
fn never_reads_holder_when_it_is_garbage() {
    let mut fi = valid_fi();
    root_mut(&mut fi).insert(
        "Profile".to_owned(),
        json!({ "Holders": { "Holder": [1, "x", null, { "name": 5 }] } }),
    );
    assert_eq!(parse(&fi).unwrap(), parse(&valid_fi()).unwrap());
}

#[test]
fn never_reads_profile_or_summary_even_when_they_are_not_objects() {
    let mut fi = valid_fi();
    root_mut(&mut fi).insert("Profile".to_owned(), json!("garbage"));
    root_mut(&mut fi).insert("Summary".to_owned(), json!(42));
    assert_eq!(parse(&fi).unwrap(), parse(&valid_fi()).unwrap());
}

#[test]
fn absent_transaction_member_yields_zero_transactions() {
    let mut fi = valid_fi();
    transactions_mut(&mut fi).remove("Transaction");
    let parsed = parse(&fi).unwrap();
    assert_eq!(parsed.start_day, START_DAY);
    assert_eq!(parsed.end_day, END_DAY);
    assert!(parsed.transactions.is_empty());
}

#[test]
fn empty_transaction_array_yields_zero_transactions() {
    let parsed = parse(&fi_with(vec![])).unwrap();
    assert!(parsed.transactions.is_empty());
}

#[test]
fn missing_narration_sets_both_flags_false() {
    let mut fi = valid_fi();
    txn_mut(&mut fi, 0).remove("narration");
    let parsed = parse(&fi).unwrap();
    assert!(!parsed.transactions[0].bounce);
    assert!(!parsed.transactions[0].emi_word);
}

#[test]
fn start_date_given_as_full_timestamp_uses_its_written_date() {
    let mut fi = valid_fi();
    transactions_mut(&mut fi).insert("startDate".to_owned(), json!("2026-03-26T23:30:00+05:30"));
    assert_eq!(parse(&fi).unwrap().start_day, START_DAY);
}

#[test]
fn end_date_given_as_full_timestamp_uses_its_written_date() {
    let mut fi = valid_fi();
    transactions_mut(&mut fi).insert("endDate".to_owned(), json!("2026-09-26T00:30:00+05:30"));
    assert_eq!(parse(&fi).unwrap().end_day, END_DAY);
}

#[test]
fn start_date_equal_to_end_date_is_accepted() {
    let mut fi = valid_fi();
    transactions_mut(&mut fi).insert("endDate".to_owned(), json!("2026-03-26"));
    let parsed = parse(&fi).unwrap();
    assert_eq!(parsed.start_day, parsed.end_day);
}

#[test]
fn transaction_timestamp_offset_is_converted_to_utc() {
    let fi = with_txn_field(
        "transactionTimestamp",
        json!("2026-04-01T09:12:00.000+0530"),
    );
    // 09:12 at +05:30 is 03:42 UTC (Python datetime).
    assert_eq!(parse(&fi).unwrap().transactions[0].at, 1_775_014_920);
}

#[test]
fn negative_current_balance_is_accepted() {
    let fi = with_txn_field("currentBalance", json!("-12833.80"));
    assert_eq!(
        parse(&fi).unwrap().transactions[0].balance,
        Paise::new(-1_283_380)
    );
}

#[test]
fn zero_amount_is_accepted() {
    let fi = with_txn_field("amount", json!(0));
    assert_eq!(parse(&fi).unwrap().transactions[0].amount, Paise::new(0));
}

#[test]
fn accepts_exactly_max_transactions() {
    let fi = fi_with(vec![txn(); MAX_TRANSACTIONS]);
    assert_eq!(parse(&fi).unwrap().transactions.len(), MAX_TRANSACTIONS);
}

// ---- reject: exact variants ------------------------------------------------

#[test]
fn rejects_xml_as_unsupported_format() {
    let xml = br#"<Account type="deposit"><Transactions/></Account>"#;
    assert_eq!(parse_deposit_fi(xml), Err(FiError::UnsupportedFormat));
}

#[test]
fn rejects_xml_after_leading_whitespace_as_unsupported_format() {
    let xml = b"  \n<?xml version=\"1.0\"?><Account/>";
    assert_eq!(parse_deposit_fi(xml), Err(FiError::UnsupportedFormat));
}

#[test]
fn unsupported_format_error_code_is_unsupported_fi_format() {
    let err = parse_deposit_fi(b"<Account/>").unwrap_err();
    assert_eq!(err.code(), "unsupported_fi_format");
}

#[test]
fn rejects_non_json_shapes_as_bad_shape() {
    let cases: &[&[u8]] = &[
        b"",
        b"   ",
        b"not json",
        b"{",
        b"{\"type\":\"DEPOSIT\"",
        b"{\"type\":\"DEPOSIT\"} trailing",
        b"[]",
        b"[{\"type\":\"DEPOSIT\"}]",
        b"\"DEPOSIT\"",
        b"42",
        b"null",
        b"true",
        b"\xff\xfe{}",
    ];
    for input in cases {
        assert_eq!(
            parse_deposit_fi(input),
            Err(FiError::BadShape),
            "input {:?}",
            String::from_utf8_lossy(input)
        );
    }
}

#[test]
fn rejects_wrapper_whose_account_is_not_an_object() {
    for account in [json!(5), json!("x"), json!(null), json!([valid_fi()])] {
        let wrapped = json!({ "account": account });
        assert_eq!(parse(&wrapped), Err(FiError::BadShape), "account {account}");
    }
}

#[test]
fn rejects_duplicate_amount_key_in_a_transaction() {
    let fi = with_txn_field("Amount", json!(1));
    assert_eq!(parse(&fi), Err(FiError::DuplicateKey));
}

#[test]
fn rejects_duplicate_key_at_root() {
    let mut fi = valid_fi();
    root_mut(&mut fi).insert("TYPE".to_owned(), json!("DEPOSIT"));
    assert_eq!(parse(&fi), Err(FiError::DuplicateKey));
}

#[test]
fn rejects_duplicate_key_in_transactions() {
    let mut fi = valid_fi();
    transactions_mut(&mut fi).insert("startdate".to_owned(), json!("2026-03-26"));
    assert_eq!(parse(&fi), Err(FiError::DuplicateKey));
}

#[test]
fn rejects_duplicate_key_between_account_and_lowercase_wrapper() {
    let wrapped = json!({ "Account": valid_fi(), "account": valid_fi() });
    assert_eq!(parse(&wrapped), Err(FiError::DuplicateKey));
}

#[test]
fn rejects_duplicate_key_even_when_values_are_identical() {
    let text = br#"{"type":"DEPOSIT","Type":"DEPOSIT"}"#;
    assert_eq!(parse_deposit_fi(text), Err(FiError::DuplicateKey));
}

#[test]
fn rejects_duplicate_key_spelled_with_a_json_escape() {
    // "type" decodes to "type": names are compared after decoding.
    let text = br#"{"type":"DEPOSIT","type":"DEPOSIT"}"#;
    assert_eq!(parse_deposit_fi(text), Err(FiError::DuplicateKey));
}

// --- Checks run top-down, one object at a time (FORMATS §1) ---

#[test]
fn statement_dates_are_checked_before_any_transaction_shape() {
    let mut bad_txn = txn();
    bad_txn["type"] = json!(5);
    let mut fi = fi_with(vec![bad_txn]);
    transactions_mut(&mut fi).insert("startDate".to_owned(), json!("2026-02-30"));
    assert_eq!(parse(&fi), Err(FiError::BadTime("startDate")));
}

#[test]
fn an_earlier_transaction_error_beats_a_later_duplicate_key() {
    let mut first = txn();
    first["amount"] = json!("1,000");
    let mut second = txn();
    second["Amount"] = json!(1);
    let fi = fi_with(vec![first, second]);
    assert_eq!(parse(&fi), Err(FiError::BadMoney(MoneyError::BadFormat)));
}

// --- Byte-order mark ---

#[test]
fn skips_a_leading_utf8_byte_order_mark() {
    let mut text = b"\xEF\xBB\xBF".to_vec();
    text.extend(bytes(&valid_fi()));
    assert!(parse_deposit_fi(&text).is_ok());
}

#[test]
fn xml_after_a_byte_order_mark_is_unsupported_format() {
    let text = b"\xEF\xBB\xBF<?xml version=\"1.0\"?><Account/>";
    assert_eq!(parse_deposit_fi(text), Err(FiError::UnsupportedFormat));
}

#[test]
fn rejects_each_missing_required_transaction_field() {
    for field in [
        "type",
        "mode",
        "amount",
        "currentBalance",
        "transactionTimestamp",
    ] {
        let mut fi = valid_fi();
        txn_mut(&mut fi, 0).remove(field);
        assert_eq!(
            parse(&fi),
            Err(FiError::MissingField(field)),
            "missing {field}"
        );
    }
}

#[test]
fn rejects_missing_transactions_member() {
    let mut fi = valid_fi();
    root_mut(&mut fi).remove("Transactions");
    assert_eq!(parse(&fi), Err(FiError::MissingField("Transactions")));
}

#[test]
fn rejects_transactions_that_is_not_an_object() {
    for value in [json!(5), json!("x"), json!([]), json!(null)] {
        let mut fi = valid_fi();
        root_mut(&mut fi).insert("Transactions".to_owned(), value.clone());
        assert_eq!(parse(&fi), Err(FiError::BadShape), "Transactions {value}");
    }
}

#[test]
fn rejects_missing_start_date() {
    let mut fi = valid_fi();
    transactions_mut(&mut fi).remove("startDate");
    assert_eq!(parse(&fi), Err(FiError::MissingField("startDate")));
}

#[test]
fn rejects_missing_end_date() {
    let mut fi = valid_fi();
    transactions_mut(&mut fi).remove("endDate");
    assert_eq!(parse(&fi), Err(FiError::MissingField("endDate")));
}

#[test]
fn rejects_unparseable_start_date() {
    let mut fi = valid_fi();
    transactions_mut(&mut fi).insert("startDate".to_owned(), json!("2026-02-30"));
    assert_eq!(parse(&fi), Err(FiError::BadTime("startDate")));
}

#[test]
fn rejects_unparseable_end_date() {
    let mut fi = valid_fi();
    transactions_mut(&mut fi).insert("endDate".to_owned(), json!("26/09/2026"));
    assert_eq!(parse(&fi), Err(FiError::BadTime("endDate")));
}

#[test]
fn rejects_start_date_after_end_date() {
    let mut fi = valid_fi();
    transactions_mut(&mut fi).insert("startDate".to_owned(), json!("2026-09-27"));
    assert_eq!(parse(&fi), Err(FiError::BadTime("endDate")));
}

#[test]
fn rejects_unknown_mode() {
    let fi = with_txn_field("mode", json!("NEFT"));
    assert_eq!(parse(&fi), Err(FiError::BadEnum("mode")));
}

#[test]
fn rejects_unknown_transaction_type() {
    let fi = with_txn_field("type", json!("TRANSFER"));
    assert_eq!(parse(&fi), Err(FiError::BadEnum("type")));
}

#[test]
fn rejects_non_deposit_fi_type() {
    for kind in ["LOAN", "MUTUAL_FUNDS", "", "DEPOSITS"] {
        let mut fi = valid_fi();
        root_mut(&mut fi).insert("type".to_owned(), json!(kind));
        assert_eq!(parse(&fi), Err(FiError::NotDeposit), "type {kind:?}");
    }
}

#[test]
fn not_deposit_is_reported_before_missing_transactions() {
    let mut fi = valid_fi();
    root_mut(&mut fi).insert("type".to_owned(), json!("LOAN"));
    root_mut(&mut fi).remove("Transactions");
    assert_eq!(parse(&fi), Err(FiError::NotDeposit));
}

#[test]
fn not_deposit_is_reported_under_a_wrapper() {
    let mut inner = valid_fi();
    root_mut(&mut inner).insert("type".to_owned(), json!("LOAN"));
    assert_eq!(
        parse(&json!({ "Account": inner })),
        Err(FiError::NotDeposit)
    );
}

#[test]
fn rejects_wrong_json_type_for_a_member_as_bad_shape() {
    let cases = [
        ("type", json!(5)),
        ("type", json!(null)),
        ("type", json!(["CREDIT"])),
        ("mode", json!(5)),
        ("mode", json!({})),
        ("transactionTimestamp", json!(5)),
        ("narration", json!(5)),
        ("narration", json!(["EMI"])),
        // Deliberate strictness (FORMATS §1): null is a wrong type, not absent.
        ("narration", json!(null)),
    ];
    for (field, value) in cases {
        let fi = with_txn_field(field, value.clone());
        assert_eq!(parse(&fi), Err(FiError::BadShape), "{field} = {value}");
    }
}

#[test]
fn non_numeric_money_json_is_a_money_error() {
    let values = [json!(null), json!(true), json!({}), json!([]), json!([1])];
    for field in ["amount", "currentBalance"] {
        for value in &values {
            let fi = with_txn_field(field, value.clone());
            assert_eq!(
                parse(&fi),
                Err(FiError::BadMoney(MoneyError::BadFormat)),
                "{field} = {value}"
            );
        }
    }
}

#[test]
fn rejects_numeric_fi_type_as_bad_shape() {
    let mut fi = valid_fi();
    root_mut(&mut fi).insert("type".to_owned(), json!(5));
    assert_eq!(parse(&fi), Err(FiError::BadShape));
}

#[test]
fn rejects_thousands_separator_in_amount() {
    let fi = with_txn_field("amount", json!("1,000"));
    assert_eq!(parse(&fi), Err(FiError::BadMoney(MoneyError::BadFormat)));
}

#[test]
fn rejects_negative_amount() {
    let fi = with_txn_field("amount", json!(-5));
    assert_eq!(parse(&fi), Err(FiError::BadMoney(MoneyError::Negative)));
}

#[test]
fn rejects_amount_with_sub_paise_precision() {
    let fi = with_txn_field("amount", json!(1.234));
    assert_eq!(
        parse(&fi),
        Err(FiError::BadMoney(MoneyError::NotWholePaise))
    );
}

#[test]
fn rejects_malformed_current_balance() {
    let fi = with_txn_field("currentBalance", json!("1,000"));
    assert_eq!(parse(&fi), Err(FiError::BadMoney(MoneyError::BadFormat)));
}

#[test]
fn rejects_current_balance_with_sub_paise_precision() {
    let fi = with_txn_field("currentBalance", json!("10.005"));
    assert_eq!(
        parse(&fi),
        Err(FiError::BadMoney(MoneyError::NotWholePaise))
    );
}

#[test]
fn rejects_bad_transaction_timestamps() {
    for stamp in [
        "2026-02-30T00:00:00Z",
        "2025-02-29T00:00:00Z",
        "2026-04-01T24:00:00Z",
        "2026-04-01T12:60:00Z",
        "2026-04-01T12:00:00+0530x",
        "2026-04-01T12:00:00z",
        "2026-04-01",
        "yesterday",
        "",
    ] {
        let fi = with_txn_field("transactionTimestamp", json!(stamp));
        assert_eq!(
            parse(&fi),
            Err(FiError::BadTime("transactionTimestamp")),
            "stamp {stamp:?}"
        );
    }
}

#[test]
fn rejects_transaction_that_is_not_an_object_or_array() {
    for value in [json!(5), json!("x"), json!(null), json!(true)] {
        let mut fi = valid_fi();
        transactions_mut(&mut fi).insert("Transaction".to_owned(), value.clone());
        assert_eq!(parse(&fi), Err(FiError::BadShape), "Transaction {value}");
    }
}

#[test]
fn rejects_array_transaction_item_that_is_not_an_object() {
    let fi = fi_with(vec![txn(), json!(5)]);
    assert_eq!(parse(&fi), Err(FiError::BadShape));
}

#[test]
fn rejects_more_than_max_transactions() {
    let fi = fi_with(vec![txn(); MAX_TRANSACTIONS + 1]);
    assert_eq!(parse(&fi), Err(FiError::TooManyTransactions));
}

#[test]
fn checks_transaction_count_before_parsing_any_item() {
    // Every item is invalid (missing all fields); the count still wins.
    let fi = fi_with(vec![json!({}); MAX_TRANSACTIONS + 1]);
    assert_eq!(parse(&fi), Err(FiError::TooManyTransactions));
}

// ---- precedence ------------------------------------------------------------

#[test]
fn first_failing_transaction_wins() {
    let mut first = txn();
    first["amount"] = json!("1,000");
    let mut second = txn();
    second["mode"] = json!("NEFT");
    assert_eq!(
        parse(&fi_with(vec![first, second])),
        Err(FiError::BadMoney(MoneyError::BadFormat))
    );
}

#[test]
fn later_failing_transaction_is_reported_when_earlier_ones_are_valid() {
    let mut bad = txn();
    bad["mode"] = json!("NEFT");
    assert_eq!(
        parse(&fi_with(vec![txn(), bad])),
        Err(FiError::BadEnum("mode"))
    );
}

#[test]
fn bad_type_is_reported_before_bad_amount_within_a_transaction() {
    let mut bad = txn();
    bad["type"] = json!("TRANSFER");
    bad["amount"] = json!(-5);
    assert_eq!(parse(&fi_with(vec![bad])), Err(FiError::BadEnum("type")));
}

#[test]
fn bad_mode_is_reported_before_bad_amount_within_a_transaction() {
    let mut bad = txn();
    bad["mode"] = json!("NEFT");
    bad["amount"] = json!(-5);
    assert_eq!(parse(&fi_with(vec![bad])), Err(FiError::BadEnum("mode")));
}

#[test]
fn bad_amount_is_reported_before_bad_timestamp_within_a_transaction() {
    let mut bad = txn();
    bad["amount"] = json!(-5);
    bad["transactionTimestamp"] = json!("nope");
    assert_eq!(
        parse(&fi_with(vec![bad])),
        Err(FiError::BadMoney(MoneyError::Negative))
    );
}

#[test]
fn bad_transactions_date_is_reported_before_transaction_errors() {
    let mut fi = with_txn_field("mode", json!("NEFT"));
    transactions_mut(&mut fi).insert("startDate".to_owned(), json!("2026-09-27"));
    assert_eq!(parse(&fi), Err(FiError::BadTime("endDate")));
}

// ---- narration flags -------------------------------------------------------

#[test]
fn narration_flag_table() {
    // (narration, bounce, emi_word)
    let cases: &[(&str, bool, bool)] = &[
        ("ACH RTN CHRG EMI BOUNCE", true, true),
        ("NEFT-SAL-ACME", false, false),
        ("ACH-DR-HDFC HOME LOAN EMI", false, true),
        ("SECS PAYMENT", false, false),
        ("emi bounce", true, true),
        ("Ach Rtn Chrg", true, false),
        ("INSUFF FUNDS", true, false),
        ("INSUFF", true, false),
        ("RETURN", true, false),
        ("RETURNED CHEQUE", true, false),
        ("RTN", true, false),
        ("BOUNCE", true, false),
        ("NACH/ECS", false, true),
        ("NACH", false, true),
        ("ECS-DR", false, true),
        ("LOAN", false, true),
        ("EMI", false, true),
        ("UPI-CR-CASHBACK", false, false),
        ("", false, false),
        // Whole tokens only: substrings of longer words must not match.
        ("EMIRATES", false, false),
        ("BOUNCER", false, false),
        ("RETURNS", false, false),
        ("LOANS", false, false),
        ("SECS", false, false),
        ("INSUFFICIENT", false, false),
        // Separators split tokens.
        ("ACH/RTN/EMI", true, true),
        ("A-EMI-B", false, true),
        ("xx_emi_yy", false, true),
    ];
    for (narration, bounce, emi_word) in cases {
        assert_eq!(
            flags_for(narration),
            (*bounce, *emi_word),
            "narration {narration:?}"
        );
    }
}

// ---- code() mapping --------------------------------------------------------

#[test]
fn every_fi_error_code_is_bad_fi_data_except_unsupported_format() {
    let bad_data = [
        FiError::BadShape,
        FiError::DuplicateKey,
        FiError::MissingField("type"),
        FiError::BadEnum("mode"),
        FiError::NotDeposit,
        FiError::BadMoney(MoneyError::BadFormat),
        FiError::BadMoney(MoneyError::Negative),
        FiError::BadTime("endDate"),
        FiError::TooManyTransactions,
    ];
    for err in bad_data {
        assert_eq!(err.code(), "bad_fi_data", "{err:?}");
    }
    assert_eq!(FiError::UnsupportedFormat.code(), "unsupported_fi_format");
}

#[test]
fn parser_errors_carry_the_documented_code() {
    let err = parse(&with_txn_field("mode", json!("NEFT"))).unwrap_err();
    assert_eq!(err.code(), "bad_fi_data");
}

// ---- persona fixtures ------------------------------------------------------
// Expected facts were computed independently with a Python stdlib script over
// the fixture JSON (json, datetime): counts, dates as days since 1970-01-01,
// timestamps as UTC unix seconds, money as decimal string * 100.

#[test]
fn salaried_steady_transaction_count_and_dates() {
    let fi = salaried();
    assert_eq!(fi.transactions.len(), 158);
    // startDate 2025-09-26, endDate 2026-09-26.
    assert_eq!(fi.start_day, 20_357);
    assert_eq!(fi.end_day, 20_722);
}

#[test]
fn salaried_steady_first_and_last_transaction() {
    let fi = salaried();
    // First: 2025-09-28T19:02:00.000Z CREDIT 0.30, balance 50000.30.
    let first = fi.transactions[0];
    assert!(first.credit);
    assert_eq!(first.at, 1_759_086_120);
    assert_eq!(first.amount, Paise::new(30));
    assert_eq!(first.balance, Paise::new(5_000_030));
    // Last: 2026-09-23T20:43:00.000Z, amount 1950.98, balance 407159.87.
    let last = fi.transactions[157];
    assert_eq!(last.at, 1_790_196_180);
    assert_eq!(last.amount, Paise::new(195_098));
    assert_eq!(last.balance, Paise::new(40_715_987));
}

#[test]
fn salaried_steady_parses_a_seven_paise_cashback_exactly() {
    // Index 96 is a CREDIT of amount 0.07 in the fixture.
    let txn = salaried().transactions[96];
    assert!(txn.credit);
    assert_eq!(txn.amount, Paise::new(7));
}

#[test]
fn salaried_steady_has_24_credits_and_no_bounce_flags() {
    let fi = salaried();
    assert_eq!(fi.transactions.iter().filter(|t| t.credit).count(), 24);
    assert!(fi.transactions.iter().all(|t| !t.bounce));
}

#[test]
fn salaried_steady_has_no_negative_balances() {
    assert!(salaried()
        .transactions
        .iter()
        .all(|t| t.balance.into_inner() >= 0));
}

#[test]
fn stressed_transaction_count_and_dates() {
    let fi = stressed();
    assert_eq!(fi.transactions.len(), 84);
    // startDate 2026-03-26, endDate 2026-09-26.
    assert_eq!(fi.start_day, 20_538);
    assert_eq!(fi.end_day, 20_722);
}

#[test]
fn stressed_first_and_last_transaction_with_negative_balance() {
    let fi = stressed();
    // First: 2026-03-26T17:18:00.000Z DEBIT 833.80, balance 1166.20.
    let first = fi.transactions[0];
    assert!(!first.credit);
    assert_eq!(first.at, 1_774_545_480);
    assert_eq!(first.amount, Paise::new(83_380));
    assert_eq!(first.balance, Paise::new(116_620));
    // Index 1 balance "-12833.80" (overdrawn).
    assert_eq!(fi.transactions[1].balance, Paise::new(-1_283_380));
    // Last: 2026-09-25T20:53:00.000Z, amount 1093.24, balance -28115.10.
    let last = fi.transactions[83];
    assert_eq!(last.at, 1_790_369_580);
    assert_eq!(last.amount, Paise::new(109_324));
    assert_eq!(last.balance, Paise::new(-2_811_510));
}

#[test]
fn stressed_has_6_credits_and_83_negative_balances() {
    let fi = stressed();
    assert_eq!(fi.transactions.iter().filter(|t| t.credit).count(), 6);
    let negative = fi
        .transactions
        .iter()
        .filter(|t| t.balance.into_inner() < 0)
        .count();
    assert_eq!(negative, 83);
}

#[test]
fn stressed_bounce_narration_sets_both_flags() {
    // Index 28 narration is "ACH RTN CHRG EMI BOUNCE".
    let txn = stressed().transactions[28];
    assert!(txn.bounce);
    assert!(txn.emi_word);
}

#[test]
fn stressed_first_transaction_narration_sets_no_flags() {
    // Index 0 narration is "UPI-DR-MERCHANT".
    let txn = stressed().transactions[0];
    assert!(!txn.bounce);
    assert!(!txn.emi_word);
}

#[test]
fn trader_lumpy_transaction_count_and_dates() {
    let fi = trader();
    assert_eq!(fi.transactions.len(), 76);
    // startDate 2025-12-26, endDate 2026-09-26.
    assert_eq!(fi.start_day, 20_448);
    assert_eq!(fi.end_day, 20_722);
}

#[test]
fn trader_lumpy_first_and_last_transaction() {
    let fi = trader();
    // First: 2026-01-01T08:28:00.000Z CREDIT 248025.53, balance 548025.53.
    let first = fi.transactions[0];
    assert!(first.credit);
    assert_eq!(first.at, 1_767_256_080);
    assert_eq!(first.amount, Paise::new(24_802_553));
    assert_eq!(first.balance, Paise::new(54_802_553));
    // Last: 2026-09-24T21:04:00.000Z, amount 204202.51, balance 2639914.24.
    let last = fi.transactions[75];
    assert_eq!(last.at, 1_790_283_840);
    assert_eq!(last.amount, Paise::new(20_420_251));
    assert_eq!(last.balance, Paise::new(263_991_424));
}

#[test]
fn trader_lumpy_has_34_credits() {
    assert_eq!(
        trader().transactions.iter().filter(|t| t.credit).count(),
        34
    );
}
