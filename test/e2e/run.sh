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
# scenario NAME R1 R2 EXPECTED_MARKER EXPECTED_REVIEWS EXPECTED_RESULT_SUBSTRING [OVERLAY]
scenario() {
  name=$1; expect_marker=$4; expect_reviews=$5; expect_result=$6; overlay=${7:-test.cordis.yml}
  rm -f "$MARKER"; : >"$MOCK_LOG"
  echo "please run the shell command" | R1=$2 R2=$3 timeout 120 \
    dsh --profile headless --patch "$fixtures/$overlay" --json - >"$work/$name.jsonl" 2>"$work/$name.err"
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
# The same checks with the reviewers as DSH provider routes.
scenario routed-both-allow allow-model allow2-model yes 2 ""                  test.routed.cordis.yml
scenario routed-split      allow-model deny-model   no  2 "requires approval" test.routed.cordis.yml

# plan_scenario NAME R1 R2 EXPECT_MARKER EXPECT_PLAN EXPECT_COMPLETION EXPECT_STEERED
# The same flow with the plan-review / completion-check workflow: counts the
# plan reviews, completion checks and steer replies in the mock log.
plan_scenario() {
  name=$1; expect_marker=$4; expect_plan=$5; expect_completion=$6; expect_steered=$7
  rm -f "$MARKER"; : >"$MOCK_LOG"
  echo "please run the shell command" | R1=$2 R2=$3 timeout 120 \
    dsh --profile headless --patch "$fixtures/test.plan.cordis.yml" --json - >"$work/$name.jsonl" 2>"$work/$name.err"
  marker=no; [ -f "$MARKER" ] && marker=yes
  plan=$(grep -c '"kind":"plan"' "$MOCK_LOG")
  completion=$(grep -c '"kind":"completion"' "$MOCK_LOG")
  steered=$(grep -c '"steered":true' "$MOCK_LOG")
  # Every plan review and completion check must see the current turn.
  empty=$(grep -E '"kind":"(plan|completion)"' "$MOCK_LOG" | grep -c -v '"currentTurn":[1-9]')
  if [ "$marker" = "$expect_marker" ] && [ "$plan" = "$expect_plan" ] && [ "$empty" = 0 ] \
     && [ "$completion" = "$expect_completion" ] && [ "$steered" = "$expect_steered" ]; then
    echo "ok   $name (ran=$marker plan=$plan completion=$completion steered=$steered)"
  else
    echo "FAIL $name: ran=$marker (want $expect_marker) plan=$plan (want $expect_plan) completion=$completion (want $expect_completion) steered=$steered (want $expect_steered) empty-transcripts=$empty (want 0)"
    tail -n 5 "$work/$name.err" | sed "s/^/       /"
    failures=$((failures + 1))
  fi
}

plan_scenario plan-approved          ok-model ok2-model      yes 2 2 0
plan_scenario plan-incomplete        ok-model incomplete-model yes 2 2 1
plan_scenario plan-completion-failed ok-model donefail-model yes 2 2 0
plan_scenario plan-revise            ok-model revise-model   no  4 0 0
# A failed review falls back to a human without using up a revision round, so
# each of the mock's three submissions is reviewed again: 3 x 2 requests.
plan_scenario plan-review-failed     ok-model planfail-model no  6 0 0

# gate_scenario NAME R1 R2 EXPECT_MARKER EXPECT_PLAN EXPECT_COMPLETION
# The plan-gate flow with riskGate.mode = requirePlan: an eager agent model
# first tries the risky shell command in plan mode (refused by the guard,
# logged as refused), then submits its plan, and only writes the marker after
# approval. No reviewer request may carry the "risk" kind.
gate_scenario() {
  name=$1; expect_marker=$4; expect_plan=$5; expect_completion=$6
  rm -f "$MARKER"; : >"$MOCK_LOG"
  echo "please run the shell command" | AGENT=eager-model R1=$2 R2=$3 timeout 120 \
    dsh --profile headless --patch "$fixtures/test.plan-gate.cordis.yml" --json - >"$work/$name.jsonl" 2>"$work/$name.err"
  marker=no; [ -f "$MARKER" ] && marker=yes
  plan=$(grep -c '"kind":"plan"' "$MOCK_LOG")
  completion=$(grep -c '"kind":"completion"' "$MOCK_LOG")
  risk=$(grep -c '"kind":"risk"' "$MOCK_LOG")
  refused=$(grep -c '"refused":1' "$MOCK_LOG")
  empty=$(grep -E '"kind":"(plan|completion)"' "$MOCK_LOG" | grep -c -v '"currentTurn":[1-9]')
  if [ "$marker" = "$expect_marker" ] && [ "$plan" = "$expect_plan" ] && [ "$completion" = "$expect_completion" ] \
     && [ "$refused" = 1 ] && [ "$risk" = 0 ] && [ "$empty" = 0 ]; then
    echo "ok   $name (ran=$marker plan=$plan completion=$completion refused=$refused risk=$risk)"
  else
    echo "FAIL $name: ran=$marker (want $expect_marker) plan=$plan (want $expect_plan) completion=$completion (want $expect_completion) refused=$refused (want 1) risk=$risk (want 0) empty-transcripts=$empty (want 0)"
    tail -n 5 "$work/$name.err" | sed "s/^/       /"
    failures=$((failures + 1))
  fi
}
gate_scenario gate-before-plan ok-model ok2-model yes 2 2

# skipPresets and reportFallbackPresets are covered by test/unit: the one-shot
# headless runner refuses Sessions that run under an agent preset.

# risk_scenario NAME R1 R2 OVERLAY EXPECT_MARKER EXPECT_RISK_REVIEWS
# The risk-gate flow on non-Auto sessions: counts the risk reviews in the
# mock log and whether the marker-writing command actually ran.
risk_scenario() {
  name=$1; overlay=$4; expect_marker=$5; expect_risk=$6
  rm -f "$MARKER"; : >"$MOCK_LOG"
  echo "please run the shell command" | R1=$2 R2=$3 timeout 120 \
    dsh --profile headless --patch "$fixtures/$overlay" --json - >"$work/$name.jsonl" 2>"$work/$name.err"
  marker=no; [ -f "$MARKER" ] && marker=yes
  risk=$(grep -c '"kind":"risk"' "$MOCK_LOG")
  if [ "$marker" = "$expect_marker" ] && [ "$risk" = "$expect_risk" ]; then
    echo "ok   $name (ran=$marker risk=$risk)"
  else
    echo "FAIL $name: ran=$marker (want $expect_marker) risk=$risk (want $expect_risk)"
    tail -n 5 "$work/$name.err" | sed "s/^/       /"
    failures=$((failures + 1))
  fi
}

risk_scenario risk-allow       ok-model ok2-model       test.risk.cordis.yml       yes 2
risk_scenario risk-deny        ok-model riskdeny-model  test.risk.cordis.yml       no  2
risk_scenario risk-failed      ok-model riskfail-model  test.risk.cordis.yml       no  2
risk_scenario risk-not-matched ok-model riskdeny-model  test.risk-miss.cordis.yml  yes 0

[ "$failures" -eq 0 ] && echo "all scenarios passed" || echo "$failures scenario(s) failed"
exit "$failures"
