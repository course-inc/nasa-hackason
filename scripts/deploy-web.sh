#!/usr/bin/env bash
# Update the public web app: merge main into the `deploy` branch, refresh the prebuilt WASM
# (web/src/wasm is ignored on main but committed on deploy), and push. tachyon builds `deploy`
# automatically (see tachyon.yml on that branch).
#   mise run deploy-web            merge origin/main, rebuild wasm, push deploy
#   scripts/deploy-web.sh --dry    same, but stop before pushing
# Works in a temporary worktree, so the current checkout and branch are left alone.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT=$(pwd)
DRY=false; [[ "${1:-}" == "--dry" ]] && DRY=true

git fetch -q origin main deploy
if [[ "$(git rev-parse --abbrev-ref HEAD)" == "main" && "$(git rev-parse HEAD)" != "$(git rev-parse origin/main)" ]]; then
  echo "⚠ local main differs from origin/main: deploying origin/main (push main first to include local commits)"
fi

# Temporary worktree of origin/deploy with origin/main merged in; cargo shares ./target.
WT=$(mktemp -d "${TMPDIR:-/tmp}/deploy-web.XXXXXX")
cleanup() { git -C "$ROOT" worktree remove --force "$WT" 2>/dev/null || rm -rf "$WT"; }
trap cleanup EXIT

git worktree add -q --detach "$WT" origin/deploy
cd "$WT"
git merge -q --no-edit origin/main -m "deploy: merge main ($(git rev-parse --short origin/main))"

echo "▶ building wasm"
export CARGO_TARGET_DIR="$ROOT/target"
cargo build -q -p analog-wasm --release --target wasm32-unknown-unknown
wasm-bindgen --target web --out-dir web/src/wasm "$CARGO_TARGET_DIR/wasm32-unknown-unknown/release/analog_wasm.wasm"
git add -f web/src/wasm
git diff --cached --quiet || git commit -q -m "deploy: rebuild wasm for $(git rev-parse --short origin/main)"

echo "▶ checking the web build"
pnpm --dir web install --frozen-lockfile >/dev/null
pnpm --dir web build >/dev/null

if git diff --quiet origin/deploy HEAD; then
  echo "✓ deploy is already up to date with main"; exit 0
fi
git log --oneline origin/deploy..HEAD
if $DRY; then echo "(dry run: not pushed)"; exit 0; fi
git push -q origin HEAD:deploy
echo "✓ pushed deploy ($(git rev-parse --short HEAD)); tachyon will build it"
