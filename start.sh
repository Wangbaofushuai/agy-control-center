#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOST="${HOST:-0.0.0.0}"
PORT="${PORT:-8787}"

cd "$SCRIPT_DIR"
exec python3 -m manager.web_server --host "$HOST" --port "$PORT" "$@"
