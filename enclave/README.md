# enclave

The Rust HTTP server around `tio-core`. **Trusted:** it runs inside an AWS
Nitro enclave on Marlin Oyster. Decrypted bank data exists only here, in
memory, for one session.

The routes, limits and error codes are in `docs/FORMATS.md` §10, and the
check order is in §10.1. The trust model is in `docs/ARCHITECTURE.md`.

## What it does

At boot, the enclave creates its FIU RSA key. Its attester key signs the FIU
public key (FORMATS §8.1), so the bank can check that the key belongs to a
registered enclave.

For each session, the enclave:

1. Generates the Curve25519 session key and nonce. The private half never
   leaves.
2. Signs the FI request with its own FIU key, so the untrusted gateway can't
   swap in a key of its own.
3. Verifies the AA signature over the raw fetch response.
4. Verifies the consent.
5. Decrypts the statement: ECDH → HKDF → AES-256-GCM.
6. Verifies the FIP signature.
7. Parses the statement, scores it against the lender's policy, and builds
   the 83-byte payload.
8. Signs the payload with the attested **secp256k1** key.
9. Wipes all secrets from memory (zeroize).

## Build

`enclave/` is its own Cargo workspace, with its own `Cargo.lock`. It is not a
member of the root workspace, and it builds as a Docker image.

```sh
enclave/scripts/build-image.sh                  # arm64 image, built twice, digests compared
enclave/scripts/build-image.sh --push <repo>    # then push (refuses a dirty tree)
```

The image:

- is a static musl binary on `FROM scratch`, about 3 MB;
- builds reproducibly: base image pinned by digest, `cargo --locked`,
  `SOURCE_DATE_EPOCH`, no provenance or SBOM attestations;
- sets `RUSTFLAGS="--cfg polyval_force_soft"`, so the GHASH key is wiped;
- runs as root inside its container. Oyster mounts `/app/ecdsa.sec` with host
  permissions we don't control, and the container is the enclave's only
  workload.

### Image id

Oyster's image id hashes only `docker-compose.yml`, not the Docker image. So
the compose file must pin the image by digest.

The committed compose file pins the pushed image, built reproducibly from
commit `5fe2324`. To check it, recompute the image id and compare it with the
registry entries in `deployments/devnet.json`:

```sh
oyster-cvm compute-image-id --docker-compose enclave/docker-compose.yml --arch arm64
```

Every change makes a new image id. Each new image id must be registered on
chain.

## Run

A local run, with a throwaway attester key:

```sh
head -c 32 /dev/urandom > /tmp/ecdsa.sec
docker buildx build --platform linux/arm64 -f enclave/Dockerfile -t tio-enclave:dev --load .
docker run --rm -p 8080:8080 -v /tmp/ecdsa.sec:/app/ecdsa.sec:ro tio-enclave:dev
curl localhost:8080/v1/info
```

## Test

```sh
cargo test --manifest-path enclave/Cargo.toml --all-features   # needs the test-hooks feature
cargo clippy --manifest-path enclave/Cargo.toml --all-targets --all-features -- -D warnings
```

## Layout

| File | Role |
|---|---|
| `src/main.rs` | Boot: startup guard, attester key, FIU key, serve on `:8080` |
| `src/routes.rs`, `src/flows.rs` | The four §10 routes; session create and evaluate |
| `src/session.rs` | In-memory, single-use sessions (cap, TTL) |
| `src/attester.rs` | secp256k1 signing (§8) and the FIU key binding (§8.1) |
| `src/intent.rs` | The §9 wallet intent and its Ed25519 check |
| `src/guard.rs`, `src/pinned.rs` | Pinned FIP/AA keys and the test-key deny-list (§2) |
| `src/config.rs` | Oracle program, SAS credential and schema, compiled in |
| `src/platform.rs` | The only Oyster-specific code: key path, `proof_type`, port |
| `pinned/` | Demo FIP/AA public keys (`pnpm --filter @tio/sandbox-bank gen:demo-keys`) |

## Rules

- **Pinned keys:** the FIP and AA *public* keys are compiled in (`pinned/`).
  They must be demo keys, never test-vector keys. Otherwise the enclave
  refuses to start (`test_key_pinned`).
- **Attester key:** Oyster provides it at `/app/ecdsa.sec`: 32 raw bytes, new
  on every boot.
- **No outbound calls.** There is no HTTP-client dependency.
- **No filesystem writes.**
- **No logging of payload data.** Logs carry only the session id, stage and
  error code.
- **Test hooks:** the `test-hooks` feature lets tests plant sessions. It
  can't compile into a release build.
