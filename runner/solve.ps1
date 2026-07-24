<#
.SYNOPSIS
  Solve an assigned bounty issue end to end, unattended, stopping before commit.

.DESCRIPTION
  Creates the branch, runs Claude Code headlessly through recon -> design ->
  implement -> verify with no tool prompts, and leaves everything staged-but-
  uncommitted for you to review and commit.

  It self-gates: if recon finds the issue does not match the real code, the run
  aborts and writes the reason to the log instead of building something false.

.EXAMPLE
  .\solve.ps1 -Issue 468 -Repo Savitura/crowdpay -Slug campaign-search-vector
#>
param(
  [Parameter(Mandatory = $true)][int]$Issue,
  [Parameter(Mandatory = $true)][string]$Repo,
  [Parameter(Mandatory = $true)][string]$Slug,
  [string]$Prefix = "feat",
  [string]$BaseRemote = "upstream",
  [int]$MaxTurns = 120
)

$ErrorActionPreference = "Stop"
$branch = "$Prefix/issue-$Issue-$Slug"
$log = Join-Path (Get-Location) "solve-$Issue.log"

Write-Host "== Preparing branch $branch ==" -ForegroundColor Cyan
git checkout main | Out-Null
try { git fetch $BaseRemote 2>$null; git merge "$BaseRemote/main" | Out-Null }
catch { Write-Host "  no $BaseRemote remote, using origin" ; git pull origin main | Out-Null }
git checkout -b $branch

$prompt = @"
Resolve GitHub issue #$Issue in $Repo. Use the bounty-solver skill and follow it exactly.

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
"@

Write-Host "== Running Claude Code unattended (log: $log) ==" -ForegroundColor Cyan
$prompt | claude -p --permission-mode acceptEdits --max-turns $MaxTurns 2>&1 |
  Tee-Object -FilePath $log

Write-Host ""
if (Select-String -Path $log -Pattern '^RECON-FAIL:' -Quiet) {
  Write-Host "== RECON FAILED - nothing was built ==" -ForegroundColor Yellow
  Select-String -Path $log -Pattern '^RECON-FAIL:' -Context 0, 20 |
    ForEach-Object { $_.Line; $_.Context.PostContext }
  Write-Host "Issue likely does not match the codebase. Read $log, then decide" -ForegroundColor Yellow
  Write-Host "whether to ask the maintainer to clarify or drop the issue." -ForegroundColor Yellow
  Write-Host "Cleaning up the empty branch..." -ForegroundColor Yellow
  git checkout main | Out-Null
  git branch -D $branch | Out-Null
  exit 2
}

Write-Host "== Done. Nothing committed. ==" -ForegroundColor Green
git status --short
Write-Host ""
Write-Host "Next steps:" -ForegroundColor Cyan
Write-Host "  1. Read the verification output in $log"
Write-Host "  2. git add <paths>   (explicit paths, not -A)"
Write-Host "  3. git commit -m ""..."" "
Write-Host "  4. git push -u origin $branch"
Write-Host "  5. Open the PR using the PR-TITLE and PR-BODY blocks in $log"
