<#
.SYNOPSIS
  Start the WochIt host agent ("pnpm host") from the repo root.

.DESCRIPTION
  What it does, in order:
    1. Changes to the repo root (the folder above this script).
    2. With -Build: runs "pnpm build" (shared -> host -> web) and stops if that fails.
    3. Runs "pnpm host" in this window. Stop the host with Ctrl+C.
    4. When the host stops, waits for Enter so any error stays visible (skip with -NoPause).
  It changes nothing else: no installs, no .env edits, no Tailscale changes.

.PARAMETER Build
  Run "pnpm build" first. Use it after "git pull" + "pnpm install", or when host\dist is missing.

.PARAMETER NoPause
  Do not wait for Enter when the host exits.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\start-host.ps1

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\start-host.ps1 -Build
#>
[CmdletBinding()]
param(
  [switch]$Build,
  [switch]$NoPause
)

$ErrorActionPreference = 'Stop'

function Wait-ForEnter {
  if ($NoPause) { return }
  try { [void](Read-Host 'Press Enter to close') } catch { }
}

$repo = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $repo
$Host.UI.RawUI.WindowTitle = 'WochIt host'
Write-Host "WochIt host - $repo"

if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) {
  Write-Host 'pnpm was not found on PATH. Install pnpm, open a new window, and try again.' -ForegroundColor Red
  Wait-ForEnter
  exit 1
}

if (-not (Test-Path -LiteralPath (Join-Path $repo '.env'))) {
  Write-Host 'Note: there is no .env here. Copy .env.example to .env and fill it in. Starting with defaults.' -ForegroundColor Yellow
}

if ($Build) {
  Write-Host 'Running: pnpm build' -ForegroundColor Cyan
  & pnpm build
  if ($LASTEXITCODE -ne 0) {
    Write-Host "pnpm build failed (exit code $LASTEXITCODE). The host was not started." -ForegroundColor Red
    Wait-ForEnter
    exit $LASTEXITCODE
  }
}

if (-not (Test-Path -LiteralPath (Join-Path $repo 'host\dist\index.js'))) {
  Write-Host 'The host is not built yet. Run again with -Build (or run "pnpm install" then "pnpm build").' -ForegroundColor Red
  Wait-ForEnter
  exit 1
}

Write-Host "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] Running: pnpm host   (stop with Ctrl+C)" -ForegroundColor Cyan
Write-Host ''
& pnpm host
$code = $LASTEXITCODE

Write-Host ''
Write-Host "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] WochIt host stopped, exit code $code."
Wait-ForEnter
exit $code
