<#
.SYNOPSIS
  Stop the running WochIt host cleanly.

.DESCRIPTION
  Reads WOCHIT_PORT and WOCHIT_PIN from <repo>\.env (the PIN is never printed), then asks the host
  to shut itself down: POST http://127.0.0.1:<port>/api/host/shutdown with the x-wochit-pin header.
  The host answers, closes its sockets the way Ctrl+C would (VLC is left running) and exits; the
  script waits up to 15 s for /api/health to stop answering and prints "Host stopped".

  If the POST cannot be made (a host built before that route existed, a PIN mismatch, no PIN in
  .env) it falls back to finding node.exe processes whose command line contains host/dist/index.js
  and stopping them, and says so.

  -WhatIf shows every action without doing any of it.

.PARAMETER Port
  The host's port. Default: WOCHIT_PORT from .env, else 8788.

.PARAMETER TimeoutSec
  How long to wait for the host to go away after asking. Default 15.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\stop-host.ps1

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\stop-host.ps1 -WhatIf
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
  [int]$Port = 0,
  [int]$TimeoutSec = 15
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot

function Read-DotEnv {
  param([string]$Path)
  $map = @{}
  if (-not (Test-Path -LiteralPath $Path)) { return $map }
  foreach ($line in Get-Content -LiteralPath $Path) {
    if ($line -match '^\s*(#|$)') { continue }
    if ($line -match '^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$') {
      $value = $Matches[2]
      if ($value -match '^"(.*)"$' -or $value -match "^'(.*)'$") { $value = $Matches[1] }
      $map[$Matches[1]] = $value
    }
  }
  return $map
}

function Test-Health {
  param([int]$HostPort)
  try {
    $r = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$HostPort/api/health" -TimeoutSec 2
    return ($r.StatusCode -eq 200 -and ([string]$r.Content) -match '"ok"\s*:\s*true')
  } catch { return $false }
}

function Wait-HostGone {
  param([int]$HostPort, [int]$Seconds)
  $deadline = (Get-Date).AddSeconds($Seconds)
  while ((Get-Date) -lt $deadline) {
    if (-not (Test-Health $HostPort)) { return $true }
    Start-Sleep -Milliseconds 500
  }
  return -not (Test-Health $HostPort)
}

function Get-HostProcesses {
  # node.exe running host/dist/index.js (forward or back slashes), however it was launched.
  # Loading CimCmdlets defines aliases, which -WhatIf would narrate on Windows PowerShell 5.1;
  # reading the process list changes nothing, so WhatIf is off for this function only.
  $WhatIfPreference = $false
  Import-Module CimCmdlets -ErrorAction SilentlyContinue
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and $_.CommandLine -match 'host[\\/]dist[\\/]index\.js' }
}

$dotenv = Read-DotEnv (Join-Path $repo '.env')
if ($Port -le 0) {
  if ($dotenv['WOCHIT_PORT'] -match '^\d+$') { $Port = [int]$dotenv['WOCHIT_PORT'] } else { $Port = 8788 }
}
$pin = [string]$dotenv['WOCHIT_PIN']
$url = "http://127.0.0.1:$Port/api/host/shutdown"

$answering = Test-Health $Port
if ($answering) {
  Write-Host "A host is answering on 127.0.0.1:$Port."
} else {
  Write-Host "No host is answering on 127.0.0.1:$Port." -ForegroundColor Yellow
}

# ------------------------------------------------------------------ 1. ask nicely

$asked = $false
if ($answering) {
  if (-not $pin) {
    Write-Host 'WOCHIT_PIN is empty in .env, and the shutdown route needs it. Falling back to the process list.' -ForegroundColor Yellow
  } elseif ($PSCmdlet.ShouldProcess($url, 'POST (x-wochit-pin header from .env)')) {
    try {
      $r = Invoke-WebRequest -UseBasicParsing -Method Post -Uri $url -Headers @{ 'x-wochit-pin' = $pin } -TimeoutSec 5
      $body = $null
      try { $body = $r.Content | ConvertFrom-Json } catch { }
      $message = if ($body -and $body.message) { $body.message } else { "HTTP $($r.StatusCode)" }
      Write-Host "Host accepted the shutdown request: $message"
      $asked = $true
    } catch {
      $status = 0
      try { $status = [int]$_.Exception.Response.StatusCode } catch { }
      $why = switch ($status) {
        404 { 'this host predates /api/host/shutdown' }
        401 { 'the PIN in .env was rejected (the host may be using a generated PIN)' }
        403 { 'the host did not treat this call as local' }
        default { $_.Exception.Message }
      }
      Write-Host "POST $url failed: $why. Falling back to the process list." -ForegroundColor Yellow
    }
  }
}

if ($asked) {
  if (Wait-HostGone $Port $TimeoutSec) {
    Write-Host 'Host stopped' -ForegroundColor Green
    exit 0
  }
  Write-Host "The host is still answering after $TimeoutSec s. Falling back to the process list." -ForegroundColor Yellow
}

# ------------------------------------------------------------------ 2. fall back to the process list

$procs = @(Get-HostProcesses)
if ($procs.Count -eq 0) {
  if ($answering -and -not $WhatIfPreference) {
    Write-Host "Something answers on port $Port but no node.exe running host/dist/index.js was found; nothing was stopped." -ForegroundColor Red
    Write-Host "  Get-NetTCPConnection -LocalPort $Port -State Listen | Select-Object OwningProcess"
    exit 1
  }
  Write-Host 'No WochIt host process found. Nothing to stop.'
  exit 0
}

$stopped = 0
foreach ($p in $procs) {
  $target = "node.exe PID $($p.ProcessId): $($p.CommandLine)"
  if ($PSCmdlet.ShouldProcess($target, 'Stop-Process')) {
    try {
      Stop-Process -Id $p.ProcessId -Force
      Write-Host "Stopped node.exe PID $($p.ProcessId)"
      $stopped++
    } catch {
      Write-Host "Could not stop PID $($p.ProcessId): $($_.Exception.Message)" -ForegroundColor Red
    }
  }
}

if ($WhatIfPreference) { exit 0 }
if ($stopped -eq 0) { exit 1 }
if (Wait-HostGone $Port $TimeoutSec) {
  Write-Host 'Host stopped' -ForegroundColor Green
  exit 0
}
Write-Host "Processes were stopped but port $Port still answers; another host may be running." -ForegroundColor Red
exit 1
