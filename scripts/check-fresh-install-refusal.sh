#!/bin/sh
# The CLI must start from a clean state directory and refuse to run anything, since a fresh
# install has no approvals and no grants. A build that dispatched work here would have lost the
# property the whole design rests on. CI runs this after the build; so does
# `scripts/verify drive authority fresh-install-refusal`.
# Holds docs/adr/20261015-unsafe-actions-refused-before-authority.md.
#
# It always uses a new, empty state directory of its own, whatever AGENTSYS_STATE says, so it can
# never touch a real installation's records.
set -eu
cd "$(dirname "$0")/.."
[ -f dist/cli/main.js ] || { echo "dist/cli/main.js is missing: run npm run build first" >&2; exit 3; }
AGENTSYS_STATE=$(mktemp -d)
export AGENTSYS_STATE
trap 'rm -rf "$AGENTSYS_STATE"' EXIT

node dist/cli/main.js init --operator ci@example.test
set +e
# A valid estimate is supplied deliberately: without it admission would also refuse, and the test
# could pass while the authority check was broken. This way authority is the only thing that can
# stop it.
out=$(node dist/cli/main.js dispatch \
  --task ci-smoke --repo mocraimer/agent-system --class ci-repair \
  --runtime pi-local --profile default --actions author-changes \
  --estimate-five-hour 1 --estimate-weekly 1 --estimate-basis operator-bound \
  --estimate-detail "smoke test bound" \
  --prompt "should not run")
code=$?
set -e
echo "$out"
if [ "$code" -eq 0 ]; then
  echo "FAIL: an unauthorized dispatch exited 0"
  exit 1
fi
echo "$out" | grep -q "Awaiting approval" || {
  echo "FAIL: expected the dispatch to be held for approval"
  exit 1
}
echo "$out" | grep -q "there are no grants" || {
  echo "FAIL: the refusal did not come from the authority check"
  exit 1
}
if echo "$out" | grep -q "Waiting on subscription allowance"; then
  echo "FAIL: admission refused first; this test cannot see the authority check"
  exit 1
fi
echo "ok: a fresh install refused the dispatch at the authority check"
