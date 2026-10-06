# Enclave image for Marlin Oyster (arm64). Build context: the repo root
# (the binary depends on ../tio-core). Use enclave/scripts/build-image.sh,
# which builds twice and checks the digests match.
#
# Reproducibility: the base image is pinned by digest, dependencies by
# enclave/Cargo.lock (--locked), timestamps by SOURCE_DATE_EPOCH and
# buildx's rewrite-timestamp. The Oyster image id hashes only
# docker-compose.yml, which pins this image by digest.

FROM rust:1.89-slim-bookworm@sha256:d7fc7de78bb8c1469933aeecbf801314d30d7d6e9f0578bba4cfa285bfa37fe6 AS build

# The musl target's std (and its self-contained crt objects) for this exact
# toolchain: a static binary for the empty final image, without apt.
ARG TARGET=aarch64-unknown-linux-musl
RUN rustup target add "$TARGET"

ARG SOURCE_DATE_EPOCH
# polyval_force_soft: polyval 0.6's autodetected backend never wipes the
# GHASH key; the soft backend does (tio-core/Cargo.toml). With --target,
# RUSTFLAGS reach only the target build, not proc-macros or build scripts.
ENV RUSTFLAGS="--cfg polyval_force_soft" \
    CARGO_TERM_COLOR=never

WORKDIR /src
COPY tio-core/ tio-core/
COPY enclave/ enclave/
RUN cargo build --locked --release --target "$TARGET" --manifest-path enclave/Cargo.toml \
    && cp "enclave/target/$TARGET/release/tio-enclave" /tio-enclave

FROM scratch
COPY --from=build /tio-enclave /tio-enclave
# Runs as root inside its own container: Oyster mounts /app/ecdsa.sec with
# host permissions we don't control, and the container is the enclave's
# only workload.
EXPOSE 8080
ENTRYPOINT ["/tio-enclave"]
