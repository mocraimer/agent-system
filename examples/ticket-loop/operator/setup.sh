#!/usr/bin/env bash
# Set the coordinator up to run the ticket loop on example-org/larkspur.
#
#   OPERATOR=you@example.com REPO_PATH=~/src/larkspur bash examples/ticket-loop/operator/setup.sh
#
# Run from the agent-system checkout after `npm run build`. Every command here writes only to the
# coordinator's state directory (AGENTSYS_STATE, default ./.state); arming the loop is left to you.
#
# Another repository on an installation that already has an operator is set up the same way. Name it
# with SLUG, say which branch its pull requests target with PR_BASE (default dev), and leave
# READ_ONLY_PROJECT empty when it has no production cloud project to protect:
#
#   OPERATOR=<your operator id> REPO_PATH=<its clone> SLUG=owner/name PR_BASE=main READ_ONLY_PROJECT= \
#     bash examples/ticket-loop/operator/setup.sh
#
# POLICY_REF names the branch whose store configuration the dry run reads, for trying a change to it
# before it is merged. The operator is recorded only on an installation that has none.
set -euo pipefail

: "${OPERATOR:?set OPERATOR to your operator id}"
: "${REPO_PATH:?set REPO_PATH to your checkout of the target repository}"
SLUG=${SLUG:-example-org/larkspur}
PR_BASE=${PR_BASE:-dev}
READ_ONLY_PROJECT=${READ_ONLY_PROJECT-larkspur-prod}
SOURCE="agentsys-loop:$SLUG"
agentsys() { node dist/cli/main.js "$@"; }

agentsys config --show | grep -q '"operator"' || agentsys init --operator "$OPERATOR"

# The floor: limits no approval or grant can relax. Integration pull requests target $PR_BASE, and
# nothing may deploy to the production project, when there is one.
agentsys floor --repo "$SLUG" --pr-base "$PR_BASE" --as "$OPERATOR"
if [ -n "$READ_ONLY_PROJECT" ]; then agentsys floor --read-only-project "$READ_ONLY_PROJECT" --as "$OPERATOR"; fi

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
agentsys loop --repo "$REPO_PATH" --once --dry-run ${POLICY_REF:+--policy-ref "$POLICY_REF"}

echo
echo "When the dry run reads right: agentsys loop arm --repo $REPO_PATH --interval 900"
