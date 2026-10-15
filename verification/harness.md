---
ask-first: ask
doctor: scripts/verify-doctor.sh
---
- Build first: every scenario that runs tests or the CLI uses `dist/`, so most start with
  `npm run --silent build`. `npm ci` must have run once (`verify doctor` checks).
- Scenarios that test the CLI give it a new, empty state directory (`AGENTSYS_STATE=$(mktemp -d)`).
  Those that read a real store or dispatch for real use the installation `AGENTSYS_STATE` names
  (or `.state/` here), because that is where its authority lives.
- Browser scenarios need Chromium for Playwright: `npx playwright install chromium`, once.
- `VERIFY_TARGET_REPO` names a target repository's checkout (its `origin` on GitHub, `gh` logged in)
  for the loop and console recipes that read a real store. Without it those scenarios report
  unreachable rather than failing.
- Ask-first recipes start real agent runs on your subscriptions or write to GitHub under your
  account. The node and browser suites never do: they use fake stores, fake `gh` and fixture files,
  though the CLI integration tests run an installed `claude` or `pi` read-only for readiness and usage.
