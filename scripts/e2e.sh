#!/usr/bin/env bash
# Serve web/dist and run the headless smoke test against it.
set -euo pipefail
cd "$(dirname "$0")/.."
PORT=${E2E_PORT:-4179}
(cd web && npx vite preview --port "$PORT" --strictPort >/dev/null 2>&1) &
PID=$!
trap 'kill $PID 2>/dev/null || true' EXIT
for _ in $(seq 1 50); do curl -sf "http://localhost:$PORT" >/dev/null && break; sleep 0.2; done
cd web && BASE_URL="http://localhost:$PORT" NODE_PATH="${NODE_PATH:-$(npm root -g)}" node e2e/smoke.mjs
