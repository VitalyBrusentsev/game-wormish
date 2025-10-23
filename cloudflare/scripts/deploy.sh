#!/usr/bin/env bash
set -euo pipefail

: "${CLOUDFLARE_KV_ID:?CLOUDFLARE_KV_ID environment variable must be set for production deployments.}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

TMP_CONFIG="$(mktemp)"
cleanup() {
  rm -f "${TMP_CONFIG}"
}
trap cleanup EXIT

sed "s/id = \"REGISTRY_KV_ID_PLACEHOLDER\"/id = \"${CLOUDFLARE_KV_ID}\"/" "${PROJECT_ROOT}/wrangler.toml" > "${TMP_CONFIG}"

cd "${PROJECT_ROOT}"

npx wrangler deploy --env production --config "${TMP_CONFIG}"
