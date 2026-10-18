<#
.SYNOPSIS
  Publish the WochIt host to your tailnet with Tailscale Serve (tailnet only, not the internet).

.DESCRIPTION
  Runs:
      tailscale serve --bg --https=8443 http://127.0.0.1:8788
  then prints "tailscale serve status" and the URL to open.

  --bg keeps the mapping across reboots, so this is a one-time step. Only the chosen HTTPS port
  is touched: the other app already published on 443 stays exactly as it is. If the chosen port
  already points somewhere else, the script stops and changes nothing unless you pass -Force.
  It never runs "tailscale serve reset" (that would wipe every mapping, including 443).
  If Funnel (public) is on for that port, running this switches it back to tailnet only.

.PARAMETER Port
  The local port the WochIt host listens on. Default: WOCHIT_PORT from .env, else 8788.

.PARAMETER HttpsPort
  The HTTPS port on your tailnet name. Default 8443.

.PARAMETER Force
  Replace an existing mapping on HttpsPort that points somewhere other than the WochIt host.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\publish-tailnet.ps1

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\publish-tailnet.ps1 -WhatIf
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
$url = if ($HttpsPort -eq 443) { "https://$dns" } else { "https://${dns}:$HttpsPort" }

Write-Host "Tailnet name : $dns"
Write-Host "Mapping      : $url  ->  $target"

# Look at what is already published on that port.
$raw = (& $ts serve status --json | Out-String).Trim()
$current = $null
$tcpOnly = $false
$funnelOn = $false
if ($raw -and $raw -ne '{}') {
  $cfg = $raw | ConvertFrom-Json
  if ($cfg.Web -and $cfg.Web.PSObject.Properties[$key]) {
    $handler = $cfg.Web.PSObject.Properties[$key].Value.Handlers.PSObject.Properties['/']
    if ($handler) { $current = [string]$handler.Value.Proxy } else { $current = '(other handlers)' }
  } elseif ($cfg.TCP -and $cfg.TCP.PSObject.Properties["$HttpsPort"]) {
    $tcpOnly = $true
  }
  if ($cfg.AllowFunnel -and $cfg.AllowFunnel.PSObject.Properties[$key]) {
    $funnelOn = [bool]$cfg.AllowFunnel.PSObject.Properties[$key].Value
  }
}

if ($current -eq $target -and -not $funnelOn) {
  Write-Host "Already published: $url -> $target (tailnet only). Nothing to change." -ForegroundColor Green
} elseif ($current -eq $target -and $funnelOn) {
  Write-Host 'Funnel (public internet) is on for this port. Switching it back to tailnet only.' -ForegroundColor Yellow
  if ($PSCmdlet.ShouldProcess($key, "tailscale serve --bg --https=$HttpsPort $target")) {
    Write-Host "Running: tailscale serve --bg --https=$HttpsPort $target" -ForegroundColor Cyan
    & $ts serve --bg "--https=$HttpsPort" $target
    if ($LASTEXITCODE -ne 0) {
      Write-Host "tailscale serve failed (exit code $LASTEXITCODE)." -ForegroundColor Red
      exit $LASTEXITCODE
    }
  }
} else {
  if (($current -or $tcpOnly) -and -not $Force) {
    $what = if ($current) { $current } else { 'a TCP forwarder' }
    Write-Host "Port $HttpsPort is already used by: $what" -ForegroundColor Red
    Write-Host 'Nothing was changed. Pick another -HttpsPort, or pass -Force to replace that mapping.' -ForegroundColor Red
    exit 1
  }
  if ($PSCmdlet.ShouldProcess($key, "tailscale serve --bg --https=$HttpsPort $target")) {
    Write-Host "Running: tailscale serve --bg --https=$HttpsPort $target" -ForegroundColor Cyan
    & $ts serve --bg "--https=$HttpsPort" $target
    if ($LASTEXITCODE -ne 0) {
      Write-Host "tailscale serve failed (exit code $LASTEXITCODE)." -ForegroundColor Red
      exit $LASTEXITCODE
    }
  }
}

Write-Host ''
Write-Host 'Running: tailscale serve status' -ForegroundColor Cyan
& $ts serve status
Write-Host ''
Write-Host "Open on any device in your tailnet (or shared with it): $url" -ForegroundColor Green
Write-Host 'The WochIt host itself must be running (scripts\start-host.cmd) for the page to load.'
