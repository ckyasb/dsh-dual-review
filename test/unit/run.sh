#!/bin/sh
# Unit tests for what the e2e suite cannot reach. They import the DSH packages
# the plugin declares as peer dependencies from the dsh on PATH, so they need
# the same global dsh 0.2.1-rc.5 install as test/e2e/run.sh.
set -eu

repo=$(cd "$(dirname "$0")/../.." && pwd)
modules="$(npm root -g)/@deepseek-ai/dsh/node_modules"
if [ ! -d "$modules/@deepseek-ai/dsh-llm" ]; then
  echo "no global @deepseek-ai/dsh install under $(npm root -g)" >&2
  exit 1
fi
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
cp -R "$repo/lib" "$repo/test" "$work/"
ln -s "$modules" "$work/node_modules"
node --test "$work"/test/unit/*.test.mjs
