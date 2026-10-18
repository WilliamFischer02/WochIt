<#
.SYNOPSIS
  Remove the WochIt mapping from Tailscale Serve (or Funnel) on HTTPS port 8443.

.DESCRIPTION
  Runs:
      tailscale serve --https=8443 off
  (or "tailscale funnel --https=8443 off" if Funnel is on for that port), then prints
  "tailscale serve status".

  Only the chosen port is touched; the other app on 443 stays published. If the port points
  somewhere other than the WochIt host, the script stops and changes nothing unless you pass
  -Force. It never runs "tailscale serve reset" or "tailscale funnel reset" (those wipe every
  mapping, including 443). Publish again later with scripts\publish-tailnet.ps1.

.PARAMETER Port
  The local port the WochIt host listens on. Default: WOCHIT_PORT from .env, else 8788.

.PARAMETER HttpsPort
  The HTTPS port on your tailnet name. Default 8443.

.PARAMETER Force
  Remove the mapping on HttpsPort even if it points somewhere other than the WochIt host.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\unpublish-tailnet.ps1
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
  [int]$Port = 0,
  [int]$HttpsPort = 8443,
  [switch]$Force
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot

function Find-Tailscale {
  $cmd = Get-Command tailscale -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  $candidate = Join-Path $env:ProgramFiles 'Tailscale\tailscale.exe'
  if (Test-Path -LiteralPath $candidate) { return $candidate }
  throw 'tailscale.exe was not found. Install Tailscale and sign in first.'
}

function Get-EnvPort {
  $envFile = Join-Path $repo '.env'
  if (Test-Path -LiteralPath $envFile) {
    foreach ($line in Get-Content -LiteralPath $envFile) {
      if ($line -match '^\s*WOCHIT_PORT\s*=\s*(\d+)\s*$') { return [int]$Matches[1] }
    }
  }
  return 8788
}

if ($Port -le 0) { $Port = Get-EnvPort }
$target = "http://127.0.0.1:$Port"
$ts = Find-Tailscale

$self = (& $ts status --self --json | Out-String | ConvertFrom-Json).Self
$dns = ([string]$self.DNSName).TrimEnd('.')
if (-not $dns) { throw 'Could not read this machine''s tailnet name. Is Tailscale running and signed in?' }
$key = "${dns}:$HttpsPort"

$raw = (& $ts serve status --json | Out-String).Trim()
$current = $null
$funnelOn = $false
if ($raw -and $raw -ne '{}') {
  $cfg = $raw | ConvertFrom-Json
  if ($cfg.Web -and $cfg.Web.PSObject.Properties[$key]) {
    $handler = $cfg.Web.PSObject.Properties[$key].Value.Handlers.PSObject.Properties['/']
    if ($handler) { $current = [string]$handler.Value.Proxy } else { $current = '(other handlers)' }
  }
  if ($cfg.AllowFunnel -and $cfg.AllowFunnel.PSObject.Properties[$key]) {
    $funnelOn = [bool]$cfg.AllowFunnel.PSObject.Properties[$key].Value
  }
}

if (-not $current) {
  Write-Host "Nothing is published on port $HttpsPort. Nothing to remove." -ForegroundColor Green
} else {
  if ($current -ne $target -and -not $Force) {
    Write-Host "Port $HttpsPort points to $current, not the WochIt host ($target)." -ForegroundColor Red
    Write-Host 'Nothing was changed. Pass -Force if you really want to remove it.' -ForegroundColor Red
    exit 1
  }
  $verb = if ($funnelOn) { 'funnel' } else { 'serve' }
  if ($PSCmdlet.ShouldProcess($key, "tailscale $verb --https=$HttpsPort off")) {
    Write-Host "Running: tailscale $verb --https=$HttpsPort off" -ForegroundColor Cyan
    & $ts $verb "--https=$HttpsPort" off
    if ($LASTEXITCODE -ne 0) {
      Write-Host "tailscale $verb off failed (exit code $LASTEXITCODE)." -ForegroundColor Red
      exit $LASTEXITCODE
    }
  }
}

Write-Host ''
Write-Host 'Running: tailscale serve status' -ForegroundColor Cyan
& $ts serve status
