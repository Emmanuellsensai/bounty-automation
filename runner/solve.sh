#!/usr/bin/env bash
# Solve an assigned bounty issue end to end, unattended, stopping before commit.
# Usage: ./solve.sh <issue-number> <owner/repo> <slug> [prefix] [base-remote]
set -euo pipefail

ISSUE="${1:?issue number required}"
REPO="${2:?owner/repo required}"
SLUG="${3:?slug required}"
PREFIX="${4:-feat}"
BASE_REMOTE="${5:-upstream}"
BRANCH="$PREFIX/issue-$ISSUE-$SLUG"
LOG="solve-$ISSUE.log"

echo "== Preparing branch $BRANCH =="
git checkout main >/dev/null
if git remote | grep -q "^$BASE_REMOTE$"; then
  git fetch "$BASE_REMOTE" && git merge "$BASE_REMOTE/main" >/dev/null
else
  git pull origin main >/dev/null
fi
git checkout -b "$BRANCH"

read -r -d '' PROMPT <<EOF || true
Resolve GitHub issue #$ISSUE in $REPO. Use the bounty-solver skill and follow it exactly.

Run autonomously through all phases without asking me for approval between them,
with ONE exception described below. I am not watching the session.

PHASE 0 (recon): verify the issue against the real code before writing anything.
Open every file and line the issue cites. Confirm the described code exists and
matches. Establish the repo's real test runner, test file convention, and
existing patterns for this kind of change.

HARD STOP CONDITION: if the issue does not match reality - the cited code does
not exist, line numbers point past the end of a file, the premise assumes a
different stack, or it asks you to test or verify behaviour that is not
implemented - then STOP IMMEDIATELY. Do not build anything. Print a line
starting with exactly 'RECON-FAIL:' followed by a precise explanation of the
mismatch with quoted real code, and end the session. Never fabricate code,
never rewrite unrelated source to make the issue true, never reframe the issue
until it fits.

If recon passes, continue automatically:

PHASE 1 (design): choose the minimal change that satisfies the acceptance
criteria and fits the existing code. Prefer the smallest reversible option.
Reuse existing repo patterns and dependencies; add no new dependencies. If the
work would exceed roughly 40 test cases or sprawl across unrelated files, scope
this run to the most valuable coherent slice and say so in your summary.

PHASE 2 (implement): write the change and its tests following the repo's actual
conventions. Never modify application source just to make a test pass; if a test
exposes a real bug, report it in the summary instead. Use obviously fake values
in fixtures, never real secrets. Never log secret or key material.

VERIFY: run the repo's own typecheck, lint, test and build scripts, plus the
formatter in check mode on every file you touched including any outside the
default glob. Tests must pass regardless of how they are invoked. If the repo's
suite is already broken on main, compare base vs branch failure counts and
report both numbers rather than trying to fix unrelated debt.

DO NOT COMMIT. DO NOT PUSH. DO NOT open a PR. DO NOT post any GitHub comment.
Leave all changes uncommitted.

FINISH by printing, in this order:
1. A line starting 'SUMMARY:' with what you built.
2. The diff summary (git diff --stat plus a list of untracked files).
3. All verification results verbatim.
4. A line starting 'PR-TITLE:' with a suggested PR title.
5. A block starting 'PR-BODY:' containing a complete PR description following
   references/pr-template.md, honest about scope, deviations, and what was and
   was not verified.
EOF

echo "== Running Claude Code unattended (log: $LOG) =="
printf '%s' "$PROMPT" | claude -p --permission-mode acceptEdits --max-turns 120 2>&1 | tee "$LOG"

echo
if grep -q '^RECON-FAIL:' "$LOG"; then
  echo "== RECON FAILED - nothing was built =="
  grep -A 20 '^RECON-FAIL:' "$LOG"
  echo "Issue likely does not match the codebase. Read $LOG, then decide whether"
  echo "to ask the maintainer to clarify or drop the issue."
  git checkout main >/dev/null
  git branch -D "$BRANCH" >/dev/null
  exit 2
fi

echo "== Done. Nothing committed. =="
git status --short
cat <<'NEXT'

Next steps:
  1. Read the verification output in the log
  2. git add <paths>   (explicit paths, not -A)
  3. git commit -m "..."
  4. git push -u origin <branch>
  5. Open the PR using the PR-TITLE and PR-BODY blocks in the log
NEXT
