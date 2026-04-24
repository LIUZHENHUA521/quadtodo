#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROXY_DIR="$ROOT_DIR/mira-proxy"
CONFIG_FILE="$PROXY_DIR/config.json"
PORT="${MIRA_PROXY_PORT:-8642}"
BASE_URL="http://127.0.0.1:${PORT}"
HEALTH_URL="${BASE_URL}/health"
LOG_FILE="${MIRA_PROXY_LOG_FILE:-${TMPDIR:-/tmp}/mira-proxy.log}"
DESIRED_PROVIDER="${AI_PROXY_PROVIDER:-mira}"

if ! command -v claude >/dev/null 2>&1; then
  echo "error: 'claude' command not found in PATH" >&2
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "error: 'node' command not found in PATH" >&2
  exit 1
fi

if [ ! -f "$CONFIG_FILE" ]; then
  echo "error: missing proxy config at $CONFIG_FILE" >&2
  exit 1
fi

start_proxy() {
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

  echo "error: failed to start proxy, log: $LOG_FILE" >&2
  tail -n 40 "$LOG_FILE" >&2 || true
  exit 1
}

get_health_json() {
  curl -fsS "$HEALTH_URL" 2>/dev/null || true
}

get_current_provider() {
  local health_json
  health_json="$(get_health_json)"
  if [ -z "$health_json" ]; then
    return 1
  fi

  HEALTH_JSON="$health_json" node -e '
    const payload = process.env.HEALTH_JSON || "";
    try {
      const parsed = JSON.parse(payload);
      if (parsed && typeof parsed.provider === "string") {
        process.stdout.write(parsed.provider);
      } else {
        process.exit(1);
      }
    } catch {
      process.exit(1);
    }
  '
}

stop_proxy() {
  local pids
  pids="$(lsof -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null || true)"
  if [ -z "$pids" ]; then
    return 0
  fi

  echo "info: restarting proxy on port $PORT for provider '$DESIRED_PROVIDER'" >&2
  kill $pids 2>/dev/null || true

  for _ in $(seq 1 20); do
    if ! lsof -tiTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.2
  done

  echo "error: failed to stop existing proxy on port $PORT" >&2
  exit 1
}

ensure_proxy() {
  local current_provider=""
  current_provider="$(get_current_provider || true)"

  if [ -n "$current_provider" ] && [ "$current_provider" = "$DESIRED_PROVIDER" ]; then
    return 0
  fi

  if [ -n "$current_provider" ] && [ "$current_provider" != "$DESIRED_PROVIDER" ]; then
    stop_proxy
  fi

  if [ -z "$current_provider" ] && lsof -tiTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "error: port $PORT is occupied by a non-proxy process or unhealthy proxy" >&2
    exit 1
  fi

  start_proxy
}

ensure_proxy

export ANTHROPIC_BASE_URL="$BASE_URL"
export ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY:-dummy}"

exec claude "$@"
