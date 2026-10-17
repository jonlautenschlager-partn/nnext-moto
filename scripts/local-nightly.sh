#!/bin/zsh
# 11:00 daily full refresh (launchd). Logic lives in local-sync.sh.
exec /bin/zsh "$HOME/nnext-moto/scripts/local-sync.sh" full
