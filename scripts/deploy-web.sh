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
echo "✓ pushed deploy ($(git rev-parse --short HEAD))"

# tachyon starts a "Tachyon Build" check run within seconds of a push, but has once missed one.
# If none shows up, push an empty commit to retrigger it.
command -v gh >/dev/null || { echo "(gh not found: check the build on platform.txcloud.app)"; exit 0; }
checks() { gh api "repos/course-inc/nasa-hackason/commits/$(git rev-parse HEAD)/check-runs" --jq '.total_count' 2>/dev/null || echo 0; }
for attempt in 1 2; do
  for _ in 1 2 3 4 5 6; do [[ "$(checks)" != "0" ]] && break 2; sleep 10; done
  echo "⚠ no tachyon build started: pushing an empty commit to retrigger"
  git commit -q --allow-empty -m "deploy: retrigger tachyon build"
  git push -q origin HEAD:deploy
done
[[ "$(checks)" != "0" ]] && echo "✓ tachyon build started: https://github.com/course-inc/nasa-hackason/commits/deploy" \
  || echo "⚠ tachyon still hasn't started a build: check platform.txcloud.app"
