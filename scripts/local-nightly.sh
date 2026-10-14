#!/bin/zsh
# NNext Moto — local nightly scrape (runs on the Mac via launchd).
# The Mac's residential IP can fetch sites that block GitHub Actions (Wallapop, etc.)
export PATH="$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
export HOME="$HOME"
cd "$HOME/nnext-moto" || exit 1

{
  echo "=== $(date '+%F %T') local nightly scrape ==="
  npm run scrape 2>&1 | tail -12
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
