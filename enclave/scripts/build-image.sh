#!/usr/bin/env bash
# Reproducible arm64 build of the enclave image.
#
#   enclave/scripts/build-image.sh                 build twice, compare digests
#   enclave/scripts/build-image.sh --push <repo>   then push to <repo> (e.g.
#                                                  docker.io/<user>/tio-enclave)
#
# Both builds run without cache from the same commit time
# (SOURCE_DATE_EPOCH) with layer timestamps rewritten to it, so equal
# digests mean the image is a function of the source. Paste the printed
# digest into enclave/docker-compose.yml, then run
# `oyster-cvm compute-image-id --docker-compose enclave/docker-compose.yml --arch arm64`.
set -euo pipefail

cd "$(dirname "$0")/../.."
repo=""
if [[ "${1:-}" == "--push" ]]; then
  repo="${2:?usage: build-image.sh --push <repo>}"
  # A pushed digest must be reproducible from a commit: the release notes
  # list the image id with the commit that built it.
  if [[ -n "$(git status --porcelain)" ]]; then
    echo "refusing to push from a dirty tree: commit first" >&2
    exit 1
  fi
fi

SOURCE_DATE_EPOCH="$(git log -1 --format=%ct)"
export SOURCE_DATE_EPOCH
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

# build <output> <metadata file>
# No provenance or SBOM attestations: they record per-build data
# (invocation, timestamps), so two builds of the same source would differ.
build() {
  docker buildx build --platform linux/arm64 --no-cache \
    --provenance=false --sbom=false \
    -f enclave/Dockerfile --build-arg SOURCE_DATE_EPOCH \
    --output "$1" --metadata-file "$2" .
}

digest_of() {
  sed -n 's/.*"containerimage.digest": *"\(sha256:[0-9a-f]*\)".*/\1/p' "$1"
}

for run in 1 2; do
  build "type=oci,dest=$work/image-$run.tar,rewrite-timestamp=true" "$work/meta-$run.json"
done
first="$(digest_of "$work/meta-1.json")"
second="$(digest_of "$work/meta-2.json")"
echo "build 1: $first"
echo "build 2: $second"
if [[ -z "$first" || "$first" != "$second" ]]; then
  echo "NOT reproducible: digests differ" >&2
  exit 1
fi
echo "reproducible: $first"

if [[ -n "$repo" ]]; then
  build "type=registry,name=$repo,oci-mediatypes=true,rewrite-timestamp=true" "$work/meta-push.json"
  pushed="$(digest_of "$work/meta-push.json")"
  echo "pushed: $repo@$pushed"
  if [[ "$pushed" != "$first" ]]; then
    echo "pushed digest differs from the local builds" >&2
    exit 1
  fi
fi
