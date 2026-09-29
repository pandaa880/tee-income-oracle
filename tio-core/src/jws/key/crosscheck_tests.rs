#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::indexing_slicing,
    clippy::panic
)]

use crate::jws::key::{verify_signature, Alg, FiuSigningKey};
use crate::jws::JwsError;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use rand_chacha::rand_core::SeedableRng;
use rand_chacha::ChaCha20Rng;
use rsa::{traits::PublicKeyParts, BigUint, RsaPublicKey};
use serde::{Deserialize, Serialize};

#[derive(Serialize)]
struct RustSignedOut {
    public_jwk: PublicJwk,
    kid: String,
    cases: Vec<OutCase>,
}

#[derive(Serialize)]
struct PublicJwk {
    kty: String,
    n: String,
    e: String,
}

#[derive(Serialize)]
struct OutCase {
    jws: String,
    body_b64: String,
}

#[test]
fn test_generate_rust_vectors() {
    let mut rng = ChaCha20Rng::from_seed([0u8; 32]);
    let kid = "rust-fiu-key-1".to_string();
    let key = FiuSigningKey::generate(kid.clone(), &mut rng).unwrap();

    let public_key = RsaPublicKey::from(key.key());
    let n_b64 = URL_SAFE_NO_PAD.encode(public_key.n().to_bytes_be());
    let e_b64 = URL_SAFE_NO_PAD.encode(public_key.e().to_bytes_be());

    let out = RustSignedOut {
        public_jwk: PublicJwk {
            kty: "RSA".to_string(),
            n: n_b64,
            e: e_b64,
        },
        kid,
        cases: vec![
            OutCase {
                body_b64: URL_SAFE_NO_PAD.encode(b""),
                jws: key.sign_detached(b"", &mut rng).unwrap(),
            },
            OutCase {
                body_b64: URL_SAFE_NO_PAD.encode(b"a.b"),
                jws: key.sign_detached(b"a.b", &mut rng).unwrap(),
            },
            OutCase {
                body_b64: URL_SAFE_NO_PAD.encode(b"\x80\xff"),
                jws: key.sign_detached(b"\x80\xff", &mut rng).unwrap(),
            },
        ],
    };

    let manifest_dir = env!("CARGO_MANIFEST_DIR");
    let out_path = format!(
        "{}/../test-vectors/crosscheck/out/rust_signed.json",
        manifest_dir
    );
    std::fs::write(out_path, serde_json::to_string_pretty(&out).unwrap()).unwrap();
}

#[derive(Deserialize)]
struct WycheproofFile {
    #[serde(rename = "numberOfTests")]
    number_of_tests: usize,
    #[serde(rename = "testGroups")]
    test_groups: Vec<TestGroup>,
}

#[derive(Deserialize)]
struct TestGroup {
    #[serde(rename = "publicKey")]
    public_key: PublicKey,
    tests: Vec<TestCase>,
}

#[derive(Deserialize)]
struct PublicKey {
    modulus: String,
    #[serde(rename = "publicExponent")]
    public_exponent: String,
}

#[derive(Deserialize)]
struct TestCase {
    #[serde(rename = "tcId")]
    tc_id: usize,
    msg: String,
    sig: String,
    result: String,
}

fn run_wycheproof(file_contents: &str, alg: Alg) {
    let wycheproof: WycheproofFile = serde_json::from_str(file_contents).unwrap();
    let mut total_cases = 0;
    let mut bad_keys = 0;

    for group in wycheproof.test_groups {
        let n = BigUint::from_bytes_be(&hex::decode(&group.public_key.modulus).unwrap());
        let e = BigUint::from_bytes_be(&hex::decode(&group.public_key.public_exponent).unwrap());

        let key_opt = RsaPublicKey::new(n, e).ok();

        for case in group.tests {
            total_cases += 1;
            let msg = hex::decode(&case.msg).unwrap();
            let sig = hex::decode(&case.sig).unwrap();

            if let Some(key) = &key_opt {
                let result = verify_signature(key, alg, &msg, &sig);
                match case.result.as_str() {
                    "valid" => {
                        assert!(
                            result.is_ok(),
                            "tcId {}: expected valid, got {:?}",
                            case.tc_id,
                            result
                        );
                    }
                    "invalid" => {
                        assert_eq!(
                            result,
                            Err(JwsError::BadSignature),
                            "tcId {}: expected invalid, got {:?}",
                            case.tc_id,
                            result
                        );
                    }
                    "acceptable" => {
                        println!("tcId {}: acceptable, result was {:?}", case.tc_id, result);
                    }
                    _ => panic!("unknown result type {}", case.result),
                }
            } else {
                bad_keys += 1;
                assert_eq!(
                    case.result, "invalid",
                    "tcId {}: key is malformed but test case is not invalid",
                    case.tc_id
                );
            }
        }
    }

    assert_eq!(
        total_cases, wycheproof.number_of_tests,
        "number of tests mismatch"
    );
    println!(
        "Wycheproof {:?}: {} total cases ({} skipped due to invalid key)",
        alg, total_cases, bad_keys
    );
}

#[test]
fn test_wycheproof_rs256() {
    let contents = include_str!(
        "../../../../test-vectors/crosscheck/wycheproof/rsa_signature_2048_sha256_test.json"
    );
    run_wycheproof(contents, Alg::Rs256);
}

#[test]
fn test_wycheproof_rs512() {
    let contents = include_str!(
        "../../../../test-vectors/crosscheck/wycheproof/rsa_signature_2048_sha512_test.json"
    );
    run_wycheproof(contents, Alg::Rs512);
}
