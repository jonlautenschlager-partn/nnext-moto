#!/bin/zsh
# Every 15 minutes: fill new or incomplete Wallapop/coches.net imports.
# Logic lives in local-sync.sh (shared lock with the 11:00 full refresh).
exec /bin/zsh "$HOME/nnext-moto/scripts/local-sync.sh" new
