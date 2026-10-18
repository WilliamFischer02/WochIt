<#
.SYNOPSIS
  Register (or with -Remove, delete) the "WochIt Host" scheduled task that starts the host at logon.

.DESCRIPTION
  Without switches: registers a task named "WochIt Host" for the current user that, at logon,
  starts scripts\start-host.cmd /hidden with no visible window (a PowerShell window flashes for
  a moment, then nothing). The host's output goes to %LOCALAPPDATA%\WochIt\host.log. The task
  runs in your own desktop session, so a VLC the host opens appears on your screen as usual.
  If a task with that name already exists it is replaced with this definition.

  With -Remove: deletes that task. A host that is already running keeps running.

  Nothing else is changed. Add -WhatIf to see what would happen without doing it.

.PARAMETER Remove
  Delete the "WochIt Host" task instead of registering it.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\install-autostart.ps1

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\install-autostart.ps1 -Remove
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
  [switch]$Remove
)

$ErrorActionPreference = 'Stop'
$taskName = 'WochIt Host'
$repo = Split-Path -Parent $PSScriptRoot
$launcher = Join-Path $PSScriptRoot 'start-host.cmd'
$logFile = Join-Path $env:LOCALAPPDATA 'WochIt\host.log'
$existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue

if ($Remove) {
  if (-not $existing) {
    Write-Host "No scheduled task named '$taskName' exists. Nothing to remove." -ForegroundColor Green
    exit 0
  }
  Write-Host "Deleting scheduled task '$taskName'."
  if ($PSCmdlet.ShouldProcess($taskName, 'Unregister-ScheduledTask')) {
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
    Write-Host "Deleted. The host will no longer start at logon." -ForegroundColor Green
    Write-Host 'If a host is running right now it keeps running; stop it with:'
    Write-Host '  Get-NetTCPConnection -LocalPort 8788 -State Listen | ForEach-Object { Stop-Process -Id $_.OwningProcess }'
  }
  exit 0
}

if (-not (Test-Path -LiteralPath $launcher)) { throw "Launcher not found: $launcher" }

$user = "$env:USERDOMAIN\$env:USERNAME"
$psExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$q = { param($s) "'" + ($s -replace "'", "''") + "'" }
$inner = "Start-Process -FilePath $(& $q $launcher) -ArgumentList '/hidden' -WorkingDirectory $(& $q $repo) -WindowStyle Hidden"
$arguments = "-NoProfile -NonInteractive -WindowStyle Hidden -Command `"$inner`""

Write-Host "Task name : $taskName"
Write-Host "Runs as   : $user, at logon, in your desktop session, not elevated"
Write-Host "Program   : $psExe"
Write-Host "Arguments : $arguments"
Write-Host "Host log  : $logFile"
if ($existing) { Write-Host "A task named '$taskName' already exists; it will be replaced." -ForegroundColor Yellow }

$action = New-ScheduledTaskAction -Execute $psExe -Argument $arguments -WorkingDirectory $repo
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit (New-TimeSpan -Seconds 0) -MultipleInstances IgnoreNew

if ($PSCmdlet.ShouldProcess($taskName, 'Register-ScheduledTask')) {
  try {
    Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal `
      -Settings $settings -Description 'Starts the WochIt host agent (scripts\start-host.cmd /hidden) at logon.' `
      -Force | Out-Null
  } catch {
    Write-Host "Registering the task failed: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host 'If it says access is denied, run this script from PowerShell opened with "Run as administrator".'
    exit 1
  }
  Write-Host ''
  Write-Host "Registered. The host now starts hidden every time $user logs on." -ForegroundColor Green
  Write-Host 'Start it now without logging off:  Start-ScheduledTask -TaskName ''WochIt Host'''
  Write-Host "Read its output (banner, PIN, errors):  Get-Content `"$logFile`" -Wait"
  Write-Host 'Set WOCHIT_PIN in .env: with no visible window, a generated PIN would only appear in the log.'
  Write-Host 'Undo:  powershell -ExecutionPolicy Bypass -File scripts\install-autostart.ps1 -Remove'
}
