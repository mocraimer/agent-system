#!/usr/bin/env bash
# Set the coordinator up to run the ticket loop on example-org/larkspur.
#
#   OPERATOR=you@example.com REPO_PATH=~/src/larkspur bash examples/ticket-loop/operator/setup.sh
#
# Run from the agent-system checkout after `npm run build`. Every command here writes only to the
# coordinator's state directory (AGENTSYS_STATE, default ./.state); arming the loop is left to you.
set -euo pipefail

: "${OPERATOR:?set OPERATOR to your operator id}"
: "${REPO_PATH:?set REPO_PATH to your checkout of the target repository}"
SLUG=${SLUG:-example-org/larkspur}
SOURCE="agentsys-loop:$SLUG"
agentsys() { node dist/cli/main.js "$@"; }

agentsys init --operator "$OPERATOR"

# The floor: limits no approval or grant can relax. Integration pull requests target dev, and
# nothing may deploy to the production project.
agentsys floor --repo "$SLUG" --pr-base dev --as "$OPERATOR"
agentsys floor --read-only-project larkspur-prod --as "$OPERATOR"

# One standing grant per loop stage and runtime. A stage with no grant reports its items as
# blocked and does nothing else.
grant() { # <work class> <runtime(s)> <actions> <max dispatches per 24h> <max attempts>
  agentsys grant create --as "$OPERATOR" --repos "$SLUG" --classes "$1" --runtimes "$2" \
    --actions "$3" --profiles default --sources "$SOURCE" \
    --max-dispatches "$4" --max-attempts "$5" --reason "ticket loop: $1 on $2"
}
for rt in claude-local pi-local; do
  grant loop-shape  "$rt" author-changes                     24 2
  grant loop-assess "$rt" review                             12 2
  grant loop-sweep  "$rt" author-changes,push-branch,open-pr 12 3
  grant loop-fix    "$rt" author-changes,push-branch         12 2
done
grant loop-review pi-local,claude-local review 40 2
# loop-merge (review, merge-dev) only once a stop-line reaches 5 in store-config.

# See what a pass would do, writing nothing.
agentsys loop --repo "$REPO_PATH" --once --dry-run

echo
echo "When the dry run reads right: agentsys loop arm --repo $REPO_PATH --interval 900"
