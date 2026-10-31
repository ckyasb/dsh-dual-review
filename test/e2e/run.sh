#!/bin/sh
# End-to-end test: install the packed plugin into a scratch DSH headless
# profile, then drive one shell tool call per scenario against the mock
# endpoint and check whether it ran, was finally denied, or asked a human.
# Requires node >= 24.9, dsh 0.2.1-rc.5 and pnpm 11 on PATH.
set -u

repo=$(cd "$(dirname "$0")/../.." && pwd)
fixtures="$repo/test/e2e"
work=$(mktemp -d)
mock_pid=
trap 'kill "$mock_pid" 2>/dev/null; rm -rf "$work"' EXIT

export DSH_HOME="$work/home" MOCK_API_KEY=mock MOCK_PORT="${MOCK_PORT:-18080}"
export MOCK_LOG="$work/mock.log" MARKER="$work/marker.txt"
cd "$work" || exit 1

(cd "$repo" && npm pack --silent --pack-destination "$work") >/dev/null || exit 1
tarball=$(ls "$work"/dsh-dual-review-*.tgz)
dsh plugin --profile headless add "$tarball" >"$work/install.log" 2>&1 || { cat "$work/install.log"; exit 1; }

node "$fixtures/mock-llm.mjs" &
mock_pid=$!
sleep 1

failures=0
# scenario NAME R1 R2 EXPECTED_MARKER EXPECTED_REVIEWS EXPECTED_RESULT_SUBSTRING
scenario() {
  name=$1; expect_marker=$4; expect_reviews=$5; expect_result=$6
  rm -f "$MARKER"; : >"$MOCK_LOG"
  echo "please run the shell command" | R1=$2 R2=$3 timeout 120 \
    dsh --profile headless --patch "$fixtures/test.cordis.yml" --json - >"$work/$name.jsonl" 2>"$work/$name.err"
  marker=no; [ -f "$MARKER" ] && marker=yes
  reviews=$(grep -c '"isReview":true' "$MOCK_LOG")
  result=$(node -e '
    for (const line of require("fs").readFileSync(process.argv[1], "utf8").split("\n")) {
      try { const e = JSON.parse(line); if (e.type === "tool_result" || e.type === "error") { console.log(e.type === "error" ? e.message : e.result); break; } } catch {}
    }' "$work/$name.jsonl")
  if [ "$marker" = "$expect_marker" ] && [ "$reviews" = "$expect_reviews" ] && case "$result" in *"$expect_result"*) true;; *) false;; esac; then
    echo "ok   $name (ran=$marker reviews=$reviews)"
  else
    echo "FAIL $name: ran=$marker (want $expect_marker) reviews=$reviews (want $expect_reviews) result=$result"
    tail -n 5 "$work/$name.err" | sed "s/^/       /"
    failures=$((failures + 1))
  fi
}

scenario both-allow  allow-model allow2-model yes 2 ""
scenario both-deny   deny-model  deny-model   no  2 "Auto review rejected tool"
scenario split       allow-model deny-model   no  2 "requires approval"
scenario one-failed  allow-model fail-model   no  2 "requires approval"
scenario no-reviewer ""          ""           yes 0 ""

[ "$failures" -eq 0 ] && echo "all scenarios passed" || echo "$failures scenario(s) failed"
exit "$failures"
