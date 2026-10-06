//! The only Marlin-Oyster-specific code (ARCHITECTURE §7). Moving to plain
//! AWS Nitro means replacing this file: where the attester key comes from
//! and which `proof_type` the payload carries.

use tio_core::ProofType;

/// Oyster's per-boot secp256k1 key: 32 raw bytes, mounted read-only into
/// the container by `enclave/docker-compose.yml`.
pub const ATTESTER_KEY_PATH: &str = "/app/ecdsa.sec";

/// FORMATS §7 `proof_type`.
pub const PROOF_TYPE: ProofType = ProofType::TeeNitroOyster;

/// The port the server listens on (Oyster forwards 80, 443 and 1024–61439).
pub const LISTEN_PORT: u16 = 8080;
