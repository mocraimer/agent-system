#!/usr/bin/env bash
# Deploy origin/main to the checkout an armed loop runs from: this script's own
# checkout, or AGENTSYS_DEPLOY_DIR.
#
#   scripts/deploy.sh             back up dist, fast-forward, build; the running loop is left alone
#   scripts/deploy.sh --restart   the same, then restart agentsys-loop if no model run is in flight
#
# Exit codes: 1 checkout not clean, 2 package files changed (run npm ci by hand first),
# 3 the loop has a child run (re-run once it sleeps), 4 dist does not match the new HEAD.
#
# Everything runs inside main so bash has read the whole file before the fast-forward
# rewrites it: this script lives in the checkout it updates.
set -euo pipefail

main() {
  local dir=${AGENTSYS_DEPLOY_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}
  export XDG_RUNTIME_DIR=${XDG_RUNTIME_DIR:-/run/user/$(id -u)}
  cd "$dir"
  test -z "$(git status --porcelain)" || { echo "checkout not clean"; exit 1; }
  git fetch origin
  local old new
  old=$(git rev-parse HEAD)
  new=$(git rev-parse origin/main)
  echo "old=$old new=$new"
  if [ "$old" != "$new" ]; then
    if git diff --name-only "$old" "$new" | grep -E '^(package.json|package-lock.json)$'; then
      echo "package files changed; stopping"; exit 2
    fi
    local backup
    backup=$dir-dist-backup-$(date -u +%Y%m%d-%H%M%S)
    cp -a "$dir/dist" "$backup"
    echo "dist backup: $backup"
    git merge --ff-only origin/main
    npm run build
  else
    echo "already at origin/main"
  fi
  # stamp-build.mjs records the revision and whether the tree was dirty when dist was built.
  if ! node -e '
    const id = require(process.argv[1]);
    process.exit(id.revision === process.argv[2] && id.dirty === false ? 0 : 1);
  ' "$dir/dist/build-identity.json" "$new"; then
    echo "dist was not built from a clean $new; not restarting"; exit 4
  fi
  echo "build check ok: dist is $new"
  if [ "${1:-}" = "--restart" ]; then
    local pid
    pid=$(systemctl --user show agentsys-loop -p MainPID --value)
    if [ -n "$(pgrep -P "$pid" || true)" ]; then echo "loop has a child run; not restarting"; exit 3; fi
    echo "pre-check $(date -u +%FT%TZ): MainPID=$pid children=none"
    systemctl --user restart agentsys-loop
    echo "restarted $(date -u +%FT%TZ)"
  fi
}

main "$@"
exit
