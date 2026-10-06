//! Compiled-in deployment ids (FORMATS §7) pinned to `deployments/*.json`.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::indexing_slicing,
    clippy::panic
)]

mod common;

use tio_core::ProofType;
use tio_enclave::config::{
    decode_base58_fixed, decode_pubkey, DeploymentIds, ORACLE_PROGRAM_ID, SAS_CREDENTIAL,
    SAS_SCHEMA,
};

use common::{b58_32, load_json, repo_root};

fn deployment(cluster: &str) -> serde_json::Value {
    load_json(
        &repo_root()
            .join("deployments")
            .join(format!("{cluster}.json")),
    )
}

#[test]
fn constants_equal_the_localnet_deployment() {
    let localnet = deployment("localnet");
    assert_eq!(
        ORACLE_PROGRAM_ID,
        localnet["oracle_program"].as_str().expect("oracle")
    );
    assert_eq!(
        SAS_CREDENTIAL,
        localnet["credential"].as_str().expect("credential")
    );
    assert_eq!(SAS_SCHEMA, localnet["schema"].as_str().expect("schema"));
}

#[test]
fn constants_equal_the_devnet_deployment_when_it_exists() {
    let path = repo_root().join("deployments").join("devnet.json");
    if !path.exists() {
        return;
    }
    let devnet = load_json(&path);
    assert_eq!(
        ORACLE_PROGRAM_ID,
        devnet["oracle_program"].as_str().expect("oracle")
    );
    assert_eq!(
        SAS_CREDENTIAL,
        devnet["credential"].as_str().expect("credential")
    );
    assert_eq!(SAS_SCHEMA, devnet["schema"].as_str().expect("schema"));
}

#[test]
fn compiled_in_ids_decode_to_the_32_byte_keys() {
    let ids = DeploymentIds::compiled_in().expect("constants are base58 of 32 bytes");
    assert_eq!(ids.oracle_program_id, b58_32(ORACLE_PROGRAM_ID));
    assert_eq!(ids.sas_credential, b58_32(SAS_CREDENTIAL));
    assert_eq!(ids.sas_schema, b58_32(SAS_SCHEMA));
}

#[test]
fn the_three_compiled_in_ids_are_distinct() {
    let ids = DeploymentIds::compiled_in().expect("ids");
    assert_ne!(ids.oracle_program_id, ids.sas_credential);
    assert_ne!(ids.sas_credential, ids.sas_schema);
    assert_ne!(ids.oracle_program_id, ids.sas_schema);
}

#[test]
fn context_carries_the_ids_the_measurement_id_and_the_oyster_proof_type() {
    let ids = DeploymentIds::compiled_in().expect("ids");
    let ctx = ids.context(7);
    assert_eq!(ctx.measurement_id, 7);
    assert_eq!(ctx.proof_type, ProofType::TeeNitroOyster);
    assert_eq!(ctx.oracle_program_id, ids.oracle_program_id);
    assert_eq!(ctx.sas_credential, ids.sas_credential);
    assert_eq!(ctx.sas_schema, ids.sas_schema);
}

#[test]
fn context_passes_the_measurement_id_through_at_the_extremes() {
    let ids = DeploymentIds::compiled_in().expect("ids");
    assert_eq!(ids.context(0).measurement_id, 0);
    assert_eq!(ids.context(254).measurement_id, 254);
}

#[test]
fn decode_pubkey_accepts_a_32_byte_base58_key() {
    assert_eq!(
        decode_pubkey(ORACLE_PROGRAM_ID),
        Some(b58_32(ORACLE_PROGRAM_ID))
    );
    let all_zero = bs58::encode([0u8; 32]).into_string();
    assert_eq!(decode_pubkey(&all_zero), Some([0u8; 32]));
}

#[test]
fn decode_pubkey_rejects_non_base58_characters() {
    // 0, O, I and l are not in the base58 alphabet.
    assert_eq!(decode_pubkey("0OIl0OIl0OIl0OIl0OIl0OIl0OIl0OIl0OIl"), None);
    assert_eq!(decode_pubkey("not base58 at all!"), None);
}

#[test]
fn decode_pubkey_rejects_empty_input() {
    assert_eq!(decode_pubkey(""), None);
}

#[test]
fn decode_pubkey_rejects_31_and_33_byte_keys() {
    assert_eq!(decode_pubkey(&bs58::encode([7u8; 31]).into_string()), None);
    assert_eq!(decode_pubkey(&bs58::encode([7u8; 33]).into_string()), None);
    assert_eq!(decode_pubkey(&bs58::encode([7u8; 64]).into_string()), None);
}

#[test]
fn decode_pubkey_refuses_text_longer_than_44_digits_before_decoding() {
    // 45 base58 digits can't be 32 bytes; a long run must fail without decoding.
    assert_eq!(decode_pubkey(&"2".repeat(45)), None);
    assert_eq!(decode_pubkey(&"2".repeat(60_000)), None);
    // The longest 32-byte value (all 0xff) still fits in 44 digits.
    let max = bs58::encode([0xffu8; 32]).into_string();
    assert_eq!(max.len(), 44);
    assert_eq!(decode_pubkey(&max), Some([0xff; 32]));
    // Leading zero bytes are leading '1's: still exactly 32 bytes.
    let zeros = bs58::encode([0u8; 32]).into_string();
    assert_eq!(decode_pubkey(&zeros), Some([0; 32]));
}

#[test]
fn decode_base58_fixed_needs_exactly_n_bytes() {
    let short = bs58::encode([7u8; 31]).into_string();
    assert_eq!(decode_base58_fixed::<32>(&short), None);
    let long = bs58::encode([7u8; 33]).into_string();
    assert_eq!(decode_base58_fixed::<32>(&long), None);
    let max64 = bs58::encode([0xffu8; 64]).into_string();
    assert!(max64.len() <= 88, "{}", max64.len());
    assert_eq!(decode_base58_fixed::<64>(&max64), Some([0xff; 64]));
    assert_eq!(decode_base58_fixed::<64>(&"2".repeat(89)), None);
}
