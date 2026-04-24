#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

export AI_PROXY_PROVIDER="${AI_PROXY_PROVIDER:-trae-cn}"
exec "$ROOT_DIR/claude-proxy.sh" "$@"
