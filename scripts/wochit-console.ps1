<#
.SYNOPSIS
  One click to a working WochIt host: start it if needed, make sure the tailnet link is published,
  open the host console in its own window.

.DESCRIPTION
  Four steps, one line of output each. Nothing is ever killed or restarted.
    1. Probe http://127.0.0.1:<port>/api/health. If a host answers, use it. Otherwise (unless
       -NoStart) run scripts\start-host.cmd /hidden detached, which logs to
       %LOCALAPPDATA%\WochIt\host.log, and wait up to 40 s for health to answer. On a timeout the
       last 20 lines of that log are printed and the script exits 1.
    2. Unless -NoPublish: check "tailscale serve status" for an HTTPS :8443 mapping to the host
       and run scripts\publish-tailnet.ps1 if it is missing. A missing Tailscale CLI, or a mapping
       that cannot be made, is reported and the script carries on.
    3. Unless -NoOpen: open http://127.0.0.1:<port>/?mode=host as a chromeless app window in
       Microsoft Edge (or Chrome, or the default browser when neither is installed).
    4. Print "WochIt console: <url>   Tailnet: <link or 'not published'>".

  scripts\install-shortcut.ps1 puts a "WochIt Host" shortcut to this script on the Desktop;
  scripts\wochit-console.cmd runs it from a double-click with the window kept open on errors.

.PARAMETER Port
  The host's port. Default: WOCHIT_PORT from <repo>\.env, else 8788.

.PARAMETER NoStart
  Do not start the host when nothing answers on the port (exit 1 instead).

.PARAMETER NoOpen
  Do not open the console window.

.PARAMETER NoPublish
  Skip the Tailscale check and publish step.

.PARAMETER Popup
  Also show failures in a message box. The Desktop shortcut passes this because it runs the script
  with a hidden window, where printed text would never be seen.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\wochit-console.ps1

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\wochit-console.ps1 -NoOpen -NoPublish
#>
[CmdletBinding()]
param(
  [int]$Port = 0,
  [switch]$NoStart,
  [switch]$NoOpen,
  [switch]$NoPublish,
  [switch]$Popup
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$startCmd = Join-Path $PSScriptRoot 'start-host.cmd'
$publishScript = Join-Path $PSScriptRoot 'publish-tailnet.ps1'
$logFile = Join-Path $env:LOCALAPPDATA 'WochIt\host.log'
$httpsPort = 8443

# ------------------------------------------------------------------ helpers

function Fail {
  param([string]$Message)
  Write-Host $Message -ForegroundColor Red
  if ($Popup) {
    try { [void](New-Object -ComObject WScript.Shell).Popup($Message, 0, 'WochIt Host', 16) } catch { }
  }
  exit 1
}

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
    if ($r.StatusCode -eq 200 -and ([string]$r.Content) -match '"ok"\s*:\s*true') {
      try { return ($r.Content | ConvertFrom-Json) } catch { return [pscustomobject]@{ ok = $true } }
    }
  } catch { }
  return $null
}

# Run a native program with both streams captured, so stray stderr never trips ErrorActionPreference
# and JSON on stdout stays parseable. Works the same on Windows PowerShell 5.1 and PowerShell 7.
function Invoke-Native {
  param([string]$FilePath, [string[]]$ArgumentList)
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $FilePath
  $psi.Arguments = ($ArgumentList | ForEach-Object { if ($_ -match '[\s"]') { '"' + ($_ -replace '"', '\"') + '"' } else { $_ } }) -join ' '
  $psi.UseShellExecute = $false
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $psi.CreateNoWindow = $true
  try {
    $p = [System.Diagnostics.Process]::Start($psi)
    $errTask = $p.StandardError.ReadToEndAsync()
    $out = $p.StandardOutput.ReadToEnd()
    $p.WaitForExit()
    return [pscustomobject]@{ Code = $p.ExitCode; Out = $out.Trim(); Err = $errTask.Result.Trim() }
  } catch {
    return [pscustomobject]@{ Code = -1; Out = ''; Err = $_.Exception.Message }
  }
}

function Find-Tailscale {
  $cmd = Get-Command tailscale -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  $candidate = Join-Path $env:ProgramFiles 'Tailscale\tailscale.exe'
  if (Test-Path -LiteralPath $candidate) { return $candidate }
  return $null
}

function Get-TailnetDns {
  param([string]$Tailscale)
  $r = Invoke-Native $Tailscale @('status', '--self', '--json')
  if ($r.Code -ne 0 -or -not $r.Out) { return $null }
  try {
    $dns = ([string](($r.Out | ConvertFrom-Json).Self.DNSName)).TrimEnd('.')
    if ($dns) { return $dns }
  } catch { }
  return $null
}

# True when "tailscale serve status" maps https://<dns>:<httpsPort>/ to the host's local URL.
function Test-TailnetMapping {
  param([string]$Tailscale, [string]$Dns, [string]$Target)
  $r = Invoke-Native $Tailscale @('serve', 'status', '--json')
  if ($r.Code -ne 0 -or -not $r.Out -or $r.Out -eq '{}') { return $false }
  try {
    $cfg = $r.Out | ConvertFrom-Json
    $key = "${Dns}:$httpsPort"
    if (-not $cfg.Web) { return $false }
    $site = $cfg.Web.PSObject.Properties[$key]
    if (-not $site) { return $false }
    $handler = $site.Value.Handlers.PSObject.Properties['/']
    if (-not $handler) { return $false }
    return ([string]$handler.Value.Proxy -eq $Target)
  } catch { return $false }
}

function Find-Browser {
  param([string]$Exe, [string[]]$DefaultRelativePaths)
  foreach ($hive in 'HKLM', 'HKCU') {
    $key = "${hive}:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\$Exe"
    $value = (Get-ItemProperty -LiteralPath $key -ErrorAction SilentlyContinue).'(default)'
    if ($value) {
      $value = ([string]$value).Trim().Trim('"')
      if (Test-Path -LiteralPath $value) { return $value }
    }
  }
  foreach ($root in @($env:ProgramFiles, ${env:ProgramFiles(x86)}, $env:LOCALAPPDATA)) {
    if (-not $root) { continue }
    foreach ($rel in $DefaultRelativePaths) {
      $candidate = Join-Path $root $rel
      if (Test-Path -LiteralPath $candidate) { return $candidate }
    }
  }
  return $null
}

# ------------------------------------------------------------------ 0. port

if ($Port -le 0) {
  $dotenv = Read-DotEnv (Join-Path $repo '.env')
  if ($dotenv['WOCHIT_PORT'] -match '^\d+$') { $Port = [int]$dotenv['WOCHIT_PORT'] } else { $Port = 8788 }
}
$localUrl = "http://127.0.0.1:$Port"
$consoleUrl = "$localUrl/?mode=host"

# ------------------------------------------------------------------ 1. host

$health = Test-Health $Port
if ($health) {
  Write-Host "Host already running on $localUrl" -ForegroundColor Green
} elseif ($NoStart) {
  Fail "No host is answering on $localUrl (-NoStart given, so nothing was started)."
} else {
  if (-not (Test-Path -LiteralPath $startCmd)) { Fail "Launcher not found: $startCmd" }
  if (-not (Test-Path -LiteralPath (Join-Path $repo 'host\dist\index.js'))) {
    Fail "The host is not built yet. In $repo run: pnpm install, then pnpm build."
  }
  Write-Host "Starting the host (log: $logFile) ..." -ForegroundColor Cyan
  try {
    $proc = Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', "`"$startCmd`" /hidden" -WorkingDirectory $repo -WindowStyle Hidden -PassThru
  } catch {
    Fail "Could not start $startCmd : $($_.Exception.Message)"
  }
  $deadline = (Get-Date).AddSeconds(40)
  while (-not $health -and (Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 500
    $health = Test-Health $Port
    if (-not $health -and $proc.HasExited) { break }
  }
  if (-not $health) {
    $why = if ($proc.HasExited) { "The host exited (code $($proc.ExitCode)) before answering" } else { 'The host did not answer within 40 s' }
    Write-Host "$why on $localUrl. Last lines of $logFile :" -ForegroundColor Red
    if (Test-Path -LiteralPath $logFile) {
      Get-Content -LiteralPath $logFile -Tail 20 | ForEach-Object { Write-Host "  $_" }
    } else {
      Write-Host '  (no log file was written)'
    }
    Fail "$why. See $logFile"
  }
  Write-Host "Host started on $localUrl" -ForegroundColor Green
}

# ------------------------------------------------------------------ 2. tailnet

$tailnetLink = $null
if (-not $NoPublish) {
  $ts = Find-Tailscale
  if (-not $ts) {
    Write-Host 'Tailscale CLI not found; skipping' -ForegroundColor Yellow
  } else {
    $dns = Get-TailnetDns $ts
    if (-not $dns) {
      Write-Host 'Tailnet link missing (Tailscale is not running or not signed in)' -ForegroundColor Yellow
    } else {
      $url = "https://${dns}:$httpsPort"
      if (Test-TailnetMapping $ts $dns $localUrl) {
        $tailnetLink = $url
      } elseif (Test-Path -LiteralPath $publishScript) {
        $shell = [System.Diagnostics.Process]::GetCurrentProcess().MainModule.FileName
        $pub = Invoke-Native $shell @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', $publishScript, '-Port', "$Port", '-HttpsPort', "$httpsPort")
        if (Test-TailnetMapping $ts $dns $localUrl) {
          $tailnetLink = $url
        } else {
          $detail = (@($pub.Out, $pub.Err) | Where-Object { $_ }) -join ' | '
          Write-Host "Tailnet link missing (publish-tailnet.ps1 exit $($pub.Code): $detail)" -ForegroundColor Yellow
        }
      } else {
        Write-Host "Tailnet link missing (no :$httpsPort mapping and $publishScript not found)" -ForegroundColor Yellow
      }
      if ($tailnetLink) { Write-Host "Tailnet link: $tailnetLink" -ForegroundColor Green }
    }
  }
}

# ------------------------------------------------------------------ 3. window

if (-not $NoOpen) {
  $edge = Find-Browser 'msedge.exe' @('Microsoft\Edge\Application\msedge.exe')
  $chrome = if ($edge) { $null } else { Find-Browser 'chrome.exe' @('Google\Chrome\Application\chrome.exe') }
  $browser = if ($edge) { $edge } else { $chrome }
  try {
    if ($browser) {
      Start-Process -FilePath $browser -ArgumentList "--app=$consoleUrl", '--window-size=1280,900'
      $name = if ($edge) { 'Edge' } else { 'Chrome' }
      Write-Host "Opened the console as a $name app window ($browser)"
    } else {
      Start-Process $consoleUrl
      Write-Host 'Edge and Chrome not found; opened the console in the default browser'
    }
  } catch {
    Write-Host "Could not open a browser: $($_.Exception.Message). Open $consoleUrl yourself." -ForegroundColor Yellow
  }
}

# ------------------------------------------------------------------ 4. summary

$tailnetText = if ($tailnetLink) { $tailnetLink } else { 'not published' }
Write-Host "WochIt console: $consoleUrl   Tailnet: $tailnetText"
exit 0
