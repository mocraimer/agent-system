---
kind: feature
covers: src/ui, src/commands.ts, ui-tests/control-ui.spec.ts
---
# The control UI's coordinator views

The UI's Advanced views over the coordinator itself — Overview, Work, Authority, Safety, Evidence —
available with or without a repository.

## How a user reaches it

- `agentsys ui` with no `--repo`: opens on Advanced. With `--repo`, through the Advanced tab.
- Setup and configuration stay CLI-only; the UI exposes neither `init` nor configuration writes.

## Scenarios

### advanced-views
Run: `npm run --silent build && npx playwright test ui-tests/control-ui.spec.ts`
Proves: the real `agentsys ui` serves every Advanced view, and the full control workflow with a
fake adapter survives a server restart.

## Gotchas

- Every mutation needs the session cookie, the CSRF header and a same-origin request; a test that
  calls the API directly must bootstrap a session first.
