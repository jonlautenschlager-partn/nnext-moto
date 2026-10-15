#!/bin/zsh
# NNext Moto — local nightly scrape (runs on the Mac via launchd).
# The Mac's residential IP can fetch sites that block GitHub Actions (Wallapop, etc.)
# node comes from fnm (per-shell multishells are ephemeral) — use the stable
# versioned installation path; fall back to whatever `command -v node` finds.
FNM_NODE="$HOME/Library/Application Support/fnm/node-versions"
NODE_VER="$(ls "$FNM_NODE" 2>/dev/null | tail -1)"
if [ -n "$NODE_VER" ]; then
  export PATH="$FNM_NODE/$NODE_VER/installation/bin:$PATH"
else
  NODE_DIR="$(dirname "$(command -v node 2>/dev/null)")"
  [ -n "$NODE_DIR" ] && export PATH="$NODE_DIR:$PATH"
fi
export PATH="$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
export HOME="$HOME"
cd "$HOME/nnext-moto" || exit 1

{
  echo "=== $(date '+%F %T') local nightly scrape ==="
  npm run scrape 2>&1 | tail -12
  node scripts/doctor.js || echo "DOCTOR FOUND ISSUES (see above)"
  node scripts/sync-app.mjs
  git add -A data app inbox 2>/dev/null
  if ! git diff --cached --quiet; then
    git commit -m "local scrape: update data [skip ci]"
    for attempt in 1 2 3; do
      if git push -q; then echo "pushed (attempt $attempt)"; break; fi
      echo "push failed (attempt $attempt), re-syncing"
      git fetch origin main
      git rebase origin/main || { git rebase --abort; git pull --rebase -q origin main; }
    done
  else
    echo "no data changes"
  fi
  echo "=== done ==="
} >> "$HOME/nnext-moto/data/local-scrape.log" 2>&1
