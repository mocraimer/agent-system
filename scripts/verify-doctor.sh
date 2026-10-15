#!/bin/sh
# Prerequisites for scripts/verify scenarios; starts nothing and spends nothing.
cd "$(dirname "$0")/.." || exit 1
ok=0
[ -d node_modules ] || { echo "node_modules is missing: run npm ci"; ok=1; }
[ -f dist/cli/main.js ] || echo "note: dist/ is not built yet; scenarios build it themselves"
ls "${PLAYWRIGHT_BROWSERS_PATH:-$HOME/.cache/ms-playwright}" 2>/dev/null | grep -q '^chromium' \
  || echo "note: no Playwright Chromium found; browser scenarios need: npx playwright install chromium"
command -v gh >/dev/null || echo "note: gh is not on PATH; recipes that read a real store need it"
exit $ok
