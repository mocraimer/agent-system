# Contributing

Issues and pull requests are welcome. For a change bigger than a fix, open an issue first so we can
agree on the approach.

## Before you open a pull request

Run the project checks; CI runs the same ones.

```
npm ci
npm run typecheck
npm run lint
npm test
npm run test:ui
```

- Add or update tests beside the code you change (`src/**/*.test.ts`, `ui-tests/` for the browser).
- Tests use the made-up repository `example-org/larkspur`. Keep real product names, issue titles and
  local paths out of fixtures.
- Use conventional commit messages: `feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`.
- A decision that shapes the system's structure gets a record in `docs/adr/`; see
  `docs/adr/CONVENTIONS.md`.

## Safety rules the code keeps

Merging, auto-merge, force-push, releases and production deploys are refused before authority is
consulted. A change that weakens that, or lets work run without an approval or grant, will not be
accepted. Report a way around it as described in [SECURITY.md](SECURITY.md).
