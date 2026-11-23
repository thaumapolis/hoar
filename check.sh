#!/usr/bin/env bash
# One acceptance command, mirroring the org convention: rebuild first so checks can
# never run against a stale artifact (observed: a stale index.html invalidated a whole
# round of conclusions about the breath mechanic).
set -euo pipefail
cd "$(dirname "$0")"

: "${PLAYWRIGHT_ENTRY:?PLAYWRIGHT_ENTRY is not set -- source the dev shell first}"
node --check src/sim.js
node --check src/app.js
node tools/build.mjs

# The artifact must be newer than everything it is built from. Simple and explicit:
# find anything modified after index.html.
newer=$(find src tools -newer index.html -type f | head -1)
if [ -n "$newer" ]; then
  echo "index.html is stale relative to $newer" >&2
  exit 1
fi

node tests/rules.test.mjs
node tests/artifact.test.mjs
echo "check: all phases passed"
