<#
.SYNOPSIS
  Find your posted application comments that leaked AI commentary and clean them.

.DESCRIPTION
  For each issue you name, fetches YOUR comments, strips AI meta-commentary
  (preambles, "Note for Emmanuel", stray --- separators, trailing disclaimers),
  shows you a before/after diff, and edits the comment in place on your approval.

  Editing preserves the application. Deleting would withdraw it, so edit is the
  right default on platforms where the comment IS the application.

.EXAMPLE
  .\cleanup.ps1 -Issues @(
    "shakurJJ/chainsettle-contract#190",
    "CredenceOrg/Credence-Contracts#781"
  )

  .\cleanup.ps1 -FromPosted    # scan the watcher's posted/ folder instead
#>
param(
  [string[]]$Issues,
  [switch]$FromPosted,
  [string]$PostedDir = "$HOME\bounty-automation\watcher\posted",
  [string]$User = "Emmanuellsensai"
)

$ErrorActionPreference = "Stop"

if ($FromPosted) {
  if (-not (Test-Path $PostedDir)) { Write-Host "No posted/ folder at $PostedDir" -ForegroundColor Red; exit 1 }
  $Issues = Get-ChildItem $PostedDir -Filter *.md | ForEach-Object {
    $t = Get-Content $_.FullName -Raw
    $m = [regex]::Match($t, '- Issue:\s*https://github\.com/([^/]+/[^/]+)/issues/(\d+)')
    if ($m.Success) { "$($m.Groups[1].Value)#$($m.Groups[2].Value)" }
  } | Where-Object { $_ }
  Write-Host "Found $($Issues.Count) posted application(s) to check`n" -ForegroundColor Cyan
}

if (-not $Issues) { Write-Host "Nothing to check. Pass -Issues or -FromPosted." -ForegroundColor Yellow; exit }

# Lines that should never appear in a public application comment
$badLine = '(?im)^\s*(note for\b|i wasn''t able\b|i couldn''t\b|i was unable\b|here''s the draft|here is the draft|no problem,|i''ll base the draft|based on what the issue|tool (calls|access)\b|double check the line numbers)'
$sepLine = '(?m)^\s*-{3,}\s*$'

function Clean-Body([string]$body) {
  $lines = $body -split "`r?`n"
  $keep = @()
  foreach ($l in $lines) {
    if ($l -match $badLine) { continue }
    if ($l -match '^\s*-{3,}\s*$') { continue }
    $keep += $l
  }
  # collapse 3+ blank lines and trim
  ($keep -join "`n") -replace "(`n\s*){3,}", "`n`n" | ForEach-Object { $_.Trim() }
}

$cleaned = 0; $skipped = 0

foreach ($ref in $Issues) {
  if ($ref -notmatch '^([^/]+/[^#]+)#(\d+)$') { Write-Host "  bad ref: $ref" -ForegroundColor Red; continue }
  $repo = $Matches[1]; $num = $Matches[2]

  try {
    $comments = gh api "repos/$repo/issues/$num/comments" --paginate 2>$null | ConvertFrom-Json
  } catch {
    Write-Host "  $ref : could not fetch comments" -ForegroundColor Red; continue
  }

  $mine = $comments | Where-Object { $_.user.login -eq $User }
  if (-not $mine) { continue }

  foreach ($c in $mine) {
    $orig = $c.body
    if ($orig -notmatch $badLine -and $orig -notmatch $sepLine) { continue }

    $new = Clean-Body $orig
    if (-not $new) { Write-Host "  $ref : cleaning would empty the comment, skipping" -ForegroundColor Yellow; $skipped++; continue }

    Write-Host ("=" * 78) -ForegroundColor DarkGray
    Write-Host "$repo#$num" -ForegroundColor White
    Write-Host $c.html_url -ForegroundColor DarkCyan
    Write-Host "`n--- CURRENT (will be replaced) ---" -ForegroundColor Red
    Write-Host $orig
    Write-Host "`n--- CLEANED (what it becomes) ---" -ForegroundColor Green
    Write-Host $new
    Write-Host "`n[Enter] apply edit   [s] skip   [o] open in browser   [q] quit" -NoNewline -ForegroundColor Yellow
    $key = [Console]::ReadKey($true); Write-Host ""

    switch ($key.Key) {
      "Q" { Write-Host "`nStopped. Cleaned $cleaned, skipped $skipped." -ForegroundColor Cyan; exit }
      "S" { $skipped++; continue }
      "O" { Start-Process $c.html_url; $skipped++; continue }
    }

    $tmp = [IO.Path]::GetTempFileName()
    Set-Content $tmp $new -NoNewline
    try {
      gh api -X PATCH "repos/$repo/issues/comments/$($c.id)" -F "body=@$tmp" | Out-Null
      Write-Host "  edited" -ForegroundColor Green
      $cleaned++
    } catch {
      Write-Host "  FAILED: $_" -ForegroundColor Red
      $skipped++
    } finally { Remove-Item $tmp -Force }
    Start-Sleep -Milliseconds 600
  }
}

Write-Host "`nDone. Cleaned $cleaned, skipped $skipped." -ForegroundColor Cyan
