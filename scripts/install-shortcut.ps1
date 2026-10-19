<#
.SYNOPSIS
  Put a "WochIt Host" shortcut on the Desktop (and, with -StartMenu, in the Start menu).

.DESCRIPTION
  The shortcut runs scripts\wochit-console.ps1 with a hidden PowerShell window: it starts the host
  if it is not running, checks the tailnet link and opens the host console as its own app window.
  Failures are shown in a message box, since the hidden window cannot be read.

  Target  : powershell.exe
  Args    : -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "<repo>\scripts\wochit-console.ps1" -Popup
  Start in: <repo>
  Icon    : <repo>\scripts\wochit.ico   (built by: node scripts\make-ico.mjs)

  -Remove deletes the shortcut from both places. -WhatIf shows what would happen.

.PARAMETER StartMenu
  Also create the shortcut in the Start menu's Programs folder for the current user.

.PARAMETER Remove
  Delete the shortcut(s) instead of creating them.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install-shortcut.ps1

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install-shortcut.ps1 -StartMenu

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install-shortcut.ps1 -Remove
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
  [switch]$StartMenu,
  [switch]$Remove
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$launcher = Join-Path $PSScriptRoot 'wochit-console.ps1'
$icon = Join-Path $PSScriptRoot 'wochit.ico'
$shortcutName = 'WochIt Host.lnk'

$desktop = [Environment]::GetFolderPath('Desktop')
$programs = [Environment]::GetFolderPath('Programs')
$desktopLnk = Join-Path $desktop $shortcutName
$programsLnk = Join-Path $programs $shortcutName

if ($Remove) {
  $removed = 0
  foreach ($path in @($desktopLnk, $programsLnk)) {
    if (-not (Test-Path -LiteralPath $path)) { continue }
    if ($PSCmdlet.ShouldProcess($path, 'Remove-Item')) {
      Remove-Item -LiteralPath $path -Force
      Write-Host "Removed $path"
      $removed++
    }
  }
  if ($removed -eq 0 -and -not $WhatIfPreference) { Write-Host 'No WochIt Host shortcut found. Nothing to remove.' -ForegroundColor Green }
  exit 0
}

if (-not (Test-Path -LiteralPath $launcher)) { throw "Launcher not found: $launcher" }
if (-not (Test-Path -LiteralPath $icon)) {
  Write-Host "Icon not found at $icon; building it with node scripts\make-ico.mjs" -ForegroundColor Yellow
  & node (Join-Path $PSScriptRoot 'make-ico.mjs')
  if (-not (Test-Path -LiteralPath $icon)) { throw "Could not build $icon (is node on PATH?)" }
}

$psExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$launcher`" -Popup"

$targets = @($desktopLnk)
if ($StartMenu) { $targets += $programsLnk }

Write-Host "Target    : $psExe"
Write-Host "Arguments : $arguments"
Write-Host "Start in  : $repo"
Write-Host "Icon      : $icon"

$shell = New-Object -ComObject WScript.Shell
try {
  foreach ($path in $targets) {
    if (-not $PSCmdlet.ShouldProcess($path, 'Create shortcut')) { continue }
    $dir = Split-Path -Parent $path
    if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    $lnk = $shell.CreateShortcut($path)
    $lnk.TargetPath = $psExe
    $lnk.Arguments = $arguments
    $lnk.WorkingDirectory = $repo
    $lnk.IconLocation = "$icon,0"
    $lnk.Description = 'Start the WochIt host and open its console'
    $lnk.WindowStyle = 7   # minimised: the PowerShell window flashes less before it hides itself
    $lnk.Save()
    Write-Host "Created $path" -ForegroundColor Green
  }
} finally {
  [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($shell)
}

if (-not $WhatIfPreference) {
  Write-Host ''
  Write-Host 'Double-click "WochIt Host" to start the host and open the console.'
  Write-Host 'Undo:  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install-shortcut.ps1 -Remove'
}
