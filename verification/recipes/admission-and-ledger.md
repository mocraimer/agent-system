---
kind: feature
covers: src/core/admission.ts, src/core/ledger.ts, src/core/usage.ts, src/cli/usage.ts
---
# Admission and the paid-call ledger

Before every dispatch, a fresh usage reading is checked against every window the subscription
meters, after reservations and the margin; paid provider calls reserve a bound against their own
allowance before they run.

## How a user reaches it

- `agentsys usage` (readings and the ceiling in force per window), `policy --subscription`
  (thresholds, windows, ramp), `ledger` (allowance, reserve, settle, release).
- Every `dispatch`, which prints the admission arithmetic before it decides.
- The control UI's Advanced → Safety view and the MCP `usage` tool.

## Scenarios

### unit
Run: `npm run --silent build && node --test dist/core/admission.test.js dist/core/ledger.test.js dist/core/usage.test.js dist/cli/usage.test.js`
Proves: thresholds, declared windows, the weekly ramp, unusable or stale readings blocking work,
reservations outliving the process, and the ledger's reserve, settle and release rules.

## Gotchas

- A missing reading blocks; a test that expects admission to pass must supply a reading for every
  declared window.
- `agentsys usage` against a real install reads the vendors' own interfaces; it is not exercised here.
