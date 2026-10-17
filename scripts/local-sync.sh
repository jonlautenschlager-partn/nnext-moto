#!/bin/zsh
# Shared local scrape/sync runner (launchd).
#   local-sync.sh full   -> refresh every listing (11:00 daily)
#   local-sync.sh new    -> only new / incomplete local imports (every 15 min)
#
# Generated data (data/, app/data.js, app/kb.json) is never merged with a
# rebase. On push rejection we reset to origin and scrape again, so conflicts
# cannot leave the repository in a rebase state.
set -u

MODE="${1:-full}"
REPO="$HOME/nnext-moto"
LOCK="$REPO/data/.scrape-lock"
LOG="$REPO/data/local-scrape.log"

# node comes from fnm; launchd does not inherit the shell PATH
FNM_NODE="$HOME/Library/Application Support/fnm/node-versions"
NODE_VER="$(ls "$FNM_NODE" 2>/dev/null | tail -1)"
if [ -n "$NODE_VER" ]; then
  export PATH="$FNM_NODE/$NODE_VER/installation/bin:$PATH"
fi
export PATH="$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
export HOME="$HOME"

cd "$REPO" || exit 1

if ! mkdir "$LOCK" 2>/dev/null; then
  echo "=== $(date '+%F %T') local $MODE skipped: another scrape is running ===" >> "$LOG"
  exit 0
fi
trap 'rmdir "$LOCK" 2>/dev/null' EXIT

exec >> "$LOG" 2>&1
echo "=== $(date '+%F %T') local $MODE scrape ==="

# An interrupted rebase from an older version of this script must never block
# the job. All conflicted files here are generated.
git rebase --abort >/dev/null 2>&1 || true
if [ -d .git/rebase-merge ] || [ -d .git/rebase-apply ]; then
  rm -rf .git/rebase-merge .git/rebase-apply
fi

# Pull before scraping: links added from the dashboard/web live on origin.
if ! git fetch origin main; then
  echo "warning: fetch failed; using the local checkout"
fi
if [ -n "$(git status --porcelain)" ]; then
  git stash push -u -m "auto-stash before $MODE scrape $(date '+%F %T')" >/dev/null 2>&1 \
    || echo "warning: could not stash local changes"
fi
git checkout main >/dev/null 2>&1 || echo "warning: checkout main failed"
git reset --hard origin/main >/dev/null 2>&1 || echo "warning: reset to origin/main failed"

run_scrape() {
  if [ "$MODE" = "new" ]; then
    npm run scrape -- --local-new
  else
    npm run scrape
  fi
}

run_checks() {
  node scripts/doctor.js || return 1
  node scripts/sync-app.mjs || echo "warning: app sync failed (UI unchanged?)"
}

run_scrape || { echo "scrape failed; leaving the working tree for diagnosis"; exit 1; }
run_checks || { echo "doctor failed; not committing"; exit 1; }

git add -A data app inbox
if git diff --cached --quiet; then
  echo "no data changes"
  echo "=== done ==="
  exit 0
fi
git commit -m "local $MODE: update data [skip ci]" >/dev/null

for attempt in 1 2 3; do
  if git push -q; then
    echo "pushed (attempt $attempt)"
    echo "=== done ==="
    exit 0
  fi
  echo "push failed (attempt $attempt) — re-syncing with remote"
  git fetch origin main || true
  git reset --hard origin/main >/dev/null 2>&1 || true
  run_scrape || { echo "re-scrape failed; leaving the working tree for diagnosis"; exit 1; }
  run_checks || { echo "doctor failed after re-sync"; exit 1; }
  git add -A data app inbox
  if git diff --cached --quiet; then
    echo "no data changes after re-sync"
    echo "=== done ==="
    exit 0
  fi
  git commit -m "local $MODE: update data [skip ci]" >/dev/null
done

echo "giving up after 3 attempts"
exit 1
