# enclave

The trusted part: a thin Rust HTTP server around `tio-core`, running inside an
**AWS Nitro enclave on Marlin Oyster**. Raw bank data exists in decrypted form
only here, in memory, for one session.

Per session:
1. Generate the Curve25519 session key and nonce. The private half never
   leaves.
2. Sign the FI request with the enclave's own FIU RSA key, so the untrusted
   gateway can't swap in its own key. At boot the attester key signs the FIU
   public key (FORMATS §8.1), so the bank can check it belongs to a
   registered enclave.
3. Verify the AA signature over the raw fetch response.
4. Verify the consent.
5. ECDH → HKDF → AES-256-GCM decrypt.
6. Verify the FIP signature.
7. Parse, score against the lender's policy, and build the 83-byte payload.
8. Sign it with the attested **secp256k1** key.
9. Wipe all secrets from memory (zeroize).

The routes, limits and error codes are in `docs/FORMATS.md` §10; the check
order in §10.1; the trust model in `docs/ARCHITECTURE.md`.

## Layout

| File | Role |
|---|---|
| `src/main.rs` | boot: startup guard, attester key, FIU key, serve on `:8080` |
| `src/routes.rs`, `src/flows.rs` | the four §10 routes; session create and evaluate |
| `src/session.rs` | in-memory, single-use sessions (cap, TTL) |
| `src/attester.rs` | secp256k1 signing (§8) and the FIU key binding (§8.1) |
| `src/intent.rs` | the §9 wallet intent and its Ed25519 check |
| `src/guard.rs`, `src/pinned.rs` | pinned FIP/AA keys and the test-key deny-list (§2) |
| `src/config.rs` | oracle program, SAS credential and schema, compiled in |
| `src/platform.rs` | the only Oyster-specific code (key path, `proof_type`, port) |
| `pinned/` | demo FIP/AA public keys (`pnpm --filter @tio/sandbox-bank gen:demo-keys`) |

## Build, test, run

It is its own Cargo workspace (own `Cargo.lock`), not a member of the root
one, and builds as a Docker image.

```sh
cargo test --manifest-path enclave/Cargo.toml --all-features   # needs the test-hooks feature
cargo clippy --manifest-path enclave/Cargo.toml --all-targets --all-features -- -D warnings
enclave/scripts/build-image.sh                  # arm64 image, built twice, digests compared
enclave/scripts/build-image.sh --push <repo>    # then push (refuses a dirty tree)
```

Local run with a throwaway attester key:

```sh
head -c 32 /dev/urandom > /tmp/ecdsa.sec
docker buildx build --platform linux/arm64 -f enclave/Dockerfile -t tio-enclave:dev --load .
docker run --rm -p 8080:8080 -v /tmp/ecdsa.sec:/app/ecdsa.sec:ro tio-enclave:dev
curl localhost:8080/v1/info
```

- **Image:** static musl binary on `FROM scratch` (about 3 MB), base image
  pinned by digest, `cargo --locked`, `SOURCE_DATE_EPOCH`, no provenance/SBOM
  attestations, and `RUSTFLAGS="--cfg polyval_force_soft"` so the GHASH key
  is wiped. It runs as root inside its container: Oyster mounts
  `/app/ecdsa.sec` with host permissions we don't control, and the container
  is the enclave's only workload.
- **Image id:** Oyster's image id hashes `docker-compose.yml` only, not the
  Docker image, so the compose file must pin the image by digest. The
  committed file pins the pushed image (built reproducibly from commit
  `5fe2324`); recompute its id with `oyster-cvm compute-image-id
  --docker-compose enclave/docker-compose.yml --arch arm64` and compare it
  with the registry entries in `deployments/devnet.json`. Every change makes a new image id,
  which must be registered on chain.
- **Keys:** FIP/AA *public* keys are compiled in (`pinned/`). Demo keys only,
  never test-vector keys; the enclave refuses to start otherwise
  (`test_key_pinned`). The attester key comes from Oyster (`/app/ecdsa.sec`,
  32 raw bytes, new on every boot).
- **Rules:** no outbound calls (no HTTP-client dependency), no filesystem
  writes, and no logging of payload data (only the session id, stage and
  error code). The `test-hooks` feature (tests plant sessions) can't compile
  into a release build.
