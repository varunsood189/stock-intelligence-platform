#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET_FILE="${ROOT_DIR}/extension/config.js"
ENV_FILE="${ROOT_DIR}/.env"

if [[ -f "${ENV_FILE}" ]]; then
  # Load .env as single source of truth for local secrets.
  set -a
  # shellcheck disable=SC1090
  source "${ENV_FILE}"
  set +a
fi

if [[ -z "${GEMINI_API_KEY:-}" ]]; then
  echo "GEMINI_API_KEY is not set."
  echo "Add it to ${ENV_FILE} as:"
  echo "GEMINI_API_KEY='AIza...'"
  exit 1
fi

cat > "${TARGET_FILE}" <<EOF
// Auto-generated from .env GEMINI_API_KEY. Do not commit this file.
window.ENV_GEMINI_API_KEY = "${GEMINI_API_KEY}";
EOF

echo "Wrote ${TARGET_FILE}"
