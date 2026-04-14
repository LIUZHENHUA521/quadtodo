#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROXY_DIR="$ROOT_DIR/mira-proxy"
CONFIG_FILE="$PROXY_DIR/config.json"
PORT="${MIRA_PROXY_PORT:-8642}"
BASE_URL="http://127.0.0.1:${PORT}"
HEALTH_URL="${BASE_URL}/health"
LOG_FILE="${MIRA_PROXY_LOG_FILE:-${TMPDIR:-/tmp}/mira-proxy.log}"

if ! command -v claude >/dev/null 2>&1; then
  echo "error: 'claude' command not found in PATH" >&2
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "error: 'node' command not found in PATH" >&2
  exit 1
fi

if [ ! -f "$CONFIG_FILE" ]; then
  echo "error: missing Mira proxy config at $CONFIG_FILE" >&2
  exit 1
fi

start_proxy() {
  if curl -fsS "$HEALTH_URL" >/dev/null 2>&1; then
    return 0
  fi

  (
    cd "$PROXY_DIR"
    nohup node server.js >>"$LOG_FILE" 2>&1 &
  )

  for _ in $(seq 1 30); do
    if curl -fsS "$HEALTH_URL" >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.2
  done

  echo "error: failed to start mira-proxy, log: $LOG_FILE" >&2
  tail -n 40 "$LOG_FILE" >&2 || true
  exit 1
}

start_proxy

export ANTHROPIC_BASE_URL="$BASE_URL"
export ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY:-dummy}"

exec claude "$@"
