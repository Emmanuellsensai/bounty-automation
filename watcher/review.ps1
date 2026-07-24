<#
.SYNOPSIS
  Review drafted applications from the watcher inbox and post them fast.

.DESCRIPTION
  Shows each drafted application one at a time with the issue title, points,
  comment count and link. One keypress decides it:

    Enter  post the application as a GitHub comment, then archive the file
    s      skip (leave in inbox for later)
    e      open in your editor first, then post the edited version
    d      discard (delete without posting)
    q      quit

  Posting uses `gh issue comment`, so you must be authenticated (`gh auth status`).

.EXAMPLE
  .\review.ps1
  .\review.ps1 -Inbox "C:\Users\PC\bounty-automation\watcher\inbox"
#>
param(
  [string]$Inbox = "$HOME\bounty-automation\watcher\inbox",
  [string]$Editor = "notepad"
)

$ErrorActionPreference = "Stop"
$archive = Join-Path (Split-Path $Inbox -Parent) "posted"
New-Item -ItemType Directory -Force -Path $archive | Out-Null

$files = Get-ChildItem $Inbox -Filter *.md -ErrorAction SilentlyContinue | Sort-Object Name
if (-not $files) { Write-Host "Inbox is empty. Run: node watch.js" -ForegroundColor Yellow; exit }

Write-Host "$($files.Count) drafted application(s) to review" -ForegroundColor Cyan
Write-Host "Enter = post   s = skip   e = edit then post   d = discard   q = quit`n" -ForegroundColor DarkGray

$posted = 0; $skipped = 0

foreach ($f in $files) {
  $text = Get-Content $f.FullName -Raw

  # Pull the metadata lines and the drafted application section
  $title   = ($text -split "`n" | Select-Object -First 1) -replace '^#\s*',''
  $url     = ([regex]::Match($text, '- Issue:\s*(\S+)')).Groups[1].Value
  $points  = ([regex]::Match($text, '- Points:\s*(.+)')).Groups[1].Value.Trim()
  $comments= ([regex]::Match($text, '- Comments so far:\s*(\d+)')).Groups[1].Value
  $marker  = '## Drafted application (REVIEW AND EDIT BEFORE POSTING)'
  $idx     = $text.IndexOf($marker)
  $draft   = if ($idx -ge 0) { $text.Substring($idx + $marker.Length).Trim() } else { "" }

  Write-Host ("=" * 78) -ForegroundColor DarkGray
  Write-Host $title -ForegroundColor White
  Write-Host "$url   |   $points   |   $comments comment(s)" -ForegroundColor DarkCyan
  Write-Host ""
  Write-Host $draft
  Write-Host ""
  Write-Host "[Enter] post   [s] skip   [e] edit   [d] discard   [q] quit" -NoNewline -ForegroundColor Yellow
  $key = [Console]::ReadKey($true)
  Write-Host ""

  switch ($key.Key) {
    "Q" { Write-Host "`nStopped. Posted $posted, skipped $skipped." -ForegroundColor Cyan; exit }
    "S" { $skipped++; continue }
    "D" { Remove-Item $f.FullName; Write-Host "  discarded" -ForegroundColor DarkGray; continue }
    "E" {
      $tmp = [IO.Path]::GetTempFileName() + ".md"
      Set-Content $tmp $draft
      Start-Process $Editor $tmp -Wait
      $draft = (Get-Content $tmp -Raw).Trim()
      Remove-Item $tmp
    }
  }

  if (-not $url) { Write-Host "  no issue URL found, skipping" -ForegroundColor Red; $skipped++; continue }
  if (-not $draft) { Write-Host "  empty draft, skipping" -ForegroundColor Red; $skipped++; continue }
  if ($draft -match "DRAFT-FAILED|no ANTHROPIC_API_KEY set") {
    Write-Host "  placeholder/failed draft - NOT posting. Use [e] to write it yourself." -ForegroundColor Red
    $skipped++; continue
  }
  if ($draft -match "(?im)^\s*(note for|i wasn't able|i couldn't|here's the draft|no problem,)" -or $draft -match "(?m)^\s*---\s*$") {
    Write-Host "  draft contains AI commentary - NOT posting. Use [e] to clean it up." -ForegroundColor Red
    $skipped++; continue
  }

  try {
    $draft | gh issue comment $url --body-file -
    Move-Item $f.FullName (Join-Path $archive $f.Name) -Force
    $posted++
    Write-Host "  posted" -ForegroundColor Green
  } catch {
    Write-Host "  FAILED: $_" -ForegroundColor Red
    $skipped++
  }
  Start-Sleep -Milliseconds 800   # be polite to the API
}

Write-Host "`nDone. Posted $posted, skipped $skipped." -ForegroundColor Cyan
