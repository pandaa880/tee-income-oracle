#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

mkdir -p out

echo "Generating Node vectors..."
node gen.mjs

echo "Running Rust integration tests (crosscheck)..."
cd ../../tio-core
cargo test -p tio-core --test crosscheck

echo "Running Rust internal tests (crosscheck_tests)..."
cargo test -p tio-core crosscheck_tests -- --nocapture

echo "Verifying Rust signatures in Node..."
cd ../test-vectors/crosscheck
node verify_rust.mjs

echo "All crosscheck tests passed!"
