<#
.SYNOPSIS
  Detect newly assigned bounty issues and run the solver on each.

.DESCRIPTION
  Polls GitHub for issues assigned to you, and for anything not seen before,
  launches solve.ps1 against a local clone of that repo. Everything the solver
  produces is left uncommitted for you to review.

  Repos must already be cloned locally. Map them in repos.json:
    { "Savitura/crowdpay": "C:\\dev\\crowdpay" }

.EXAMPLE
  .\assigned.ps1              one pass
  .\assigned.ps1 -Loop        keep polling
  .\assigned.ps1 -DryRun      show what it would do, run nothing
#>
param(
  [switch]$Loop,
  [switch]$DryRun,
  [int]$IntervalMinutes = 20,
  [string]$Root = "$HOME\bounty-automation"
)

$ErrorActionPreference = "Stop"
$statePath = Join-Path $Root "assigned-state.json"
$reposPath = Join-Path $Root "repos.json"
$solver    = Join-Path $Root "runner\solve.ps1"

if (-not (Test-Path $reposPath)) {
  @{ "owner/repo" = "C:\path\to\local\clone" } | ConvertTo-Json |
    Set-Content $reposPath
  Write-Host "Created $reposPath - map your repos to local clones, then rerun." -ForegroundColor Yellow
  exit 1
}

$repoMap = Get-Content $reposPath -Raw | ConvertFrom-Json
$state = if (Test-Path $statePath) { Get-Content $statePath -Raw | ConvertFrom-Json } else { [pscustomobject]@{} }

function Save-State { $state | ConvertTo-Json -Depth 5 | Set-Content $statePath }

function Invoke-Pass {
  Write-Host "`nChecking assignments..." -ForegroundColor Cyan

  $json = gh issue list --assignee "@me" --state open --limit 50 `
            --json number,title,repository,url 2>$null
  if (-not $json) { Write-Host "  none found (or gh not authenticated)" -ForegroundColor DarkGray; return }

  $issues = $json | ConvertFrom-Json
  Write-Host "  $($issues.Count) open assignment(s)"

  foreach ($i in $issues) {
    $repo = $i.repository.nameWithOwner
    $key  = "$repo#$($i.number)"

    if ($state.PSObject.Properties.Name -contains $key) { continue }

    Write-Host "`n  NEW ASSIGNMENT: $key" -ForegroundColor Green
    Write-Host "    $($i.title)"
    Write-Host "    $($i.url)"

    $local = $repoMap.$repo
    if (-not $local -or -not (Test-Path $local)) {
      Write-Host "    SKIPPED: no local clone mapped for $repo." -ForegroundColor Yellow
      Write-Host "    Clone it, add it to repos.json, then rerun." -ForegroundColor Yellow
      continue
    }

    # slug from the title: lowercase, alphanumeric, first few words
    $slug = ($i.title -replace '[^a-zA-Z0-9 ]', '' -split '\s+' |
             Where-Object { $_ } | Select-Object -First 4) -join '-'
    $slug = $slug.ToLower()
    if (-not $slug) { $slug = "issue-$($i.number)" }

    if ($DryRun) {
      Write-Host "    DRY RUN would execute:" -ForegroundColor DarkCyan
      Write-Host "      cd $local; $solver -Issue $($i.number) -Repo $repo -Slug $slug"
      continue
    }

    Write-Host "    Running solver (this takes a while)..." -ForegroundColor Cyan
    Push-Location $local
    try {
      & $solver -Issue $i.number -Repo $repo -Slug $slug
      $exit = $LASTEXITCODE
      $status = if ($exit -eq 2) { "recon-failed" } elseif ($exit -eq 0) { "ready-to-commit" } else { "error-$exit" }
    } catch {
      $status = "error: $_"
    } finally {
      Pop-Location
    }

    $state | Add-Member -NotePropertyName $key -NotePropertyValue @{
      status = $status
      title  = $i.title
      at     = (Get-Date).ToString("s")
      path   = $local
    } -Force
    Save-State

    switch ($status) {
      "ready-to-commit" {
        Write-Host "    DONE - changes uncommitted in $local" -ForegroundColor Green
        Write-Host "    Read solve-$($i.number).log, then commit and push." -ForegroundColor Green
      }
      "recon-failed" {
        Write-Host "    RECON FAILED - issue does not match the code. Nothing built." -ForegroundColor Yellow
        Write-Host "    See solve-$($i.number).log for the mismatch." -ForegroundColor Yellow
      }
      default { Write-Host "    $status" -ForegroundColor Red }
    }
  }
}

do {
  try { Invoke-Pass } catch { Write-Host "Pass failed: $_" -ForegroundColor Red }
  if ($Loop) {
    Write-Host "`nSleeping $IntervalMinutes min..." -ForegroundColor DarkGray
    Start-Sleep -Seconds ($IntervalMinutes * 60)
  }
} while ($Loop)

Write-Host "`nSummary of handled assignments:" -ForegroundColor Cyan
$state.PSObject.Properties | ForEach-Object {
  "{0,-45} {1}" -f $_.Name, $_.Value.status
}
