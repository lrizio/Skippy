# Runs the Skippy server hidden in the background: starts when you sign in to Windows and restarts if it crashes.
#   background.ps1 -Action Install   set it up and start it now
#   background.ps1 -Action Remove    stop it and remove the startup task
#   background.ps1 -Action Status    show whether it is running
param(
  [ValidateSet('Install', 'Remove', 'Status')][string]$Action = 'Install',
  [string]$TaskName = 'Skippy Server',
  [int]$Port = 8470
)
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$loop = Join-Path $here 'run-server.cmd'
$vbs  = Join-Path $here 'run-hidden.vbs'

function Stop-ServerLoop {
  # the restart loop is a cmd.exe running *this folder's* run-server.cmd; /T also ends the node.exe under it
  $procs = Get-CimInstance Win32_Process -Filter "Name='cmd.exe'" | Where-Object { $_.CommandLine -like "*$loop*" }
  foreach ($p in $procs) { & taskkill /PID $p.ProcessId /T /F | Out-Null }
  return @($procs).Count
}
function Get-State {
  $running = @(Get-CimInstance Win32_Process -Filter "Name='cmd.exe'" | Where-Object { $_.CommandLine -like "*$loop*" }).Count -gt 0
  $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  [pscustomobject]@{ Running = $running; StartsAtSignIn = [bool]$task }
}

switch ($Action) {
  'Install' {
    $node = (Get-Command node -ErrorAction SilentlyContinue).Source
    if (-not $node) { throw 'Node.js was not found. Install Node.js 22.13+ from https://nodejs.org, then run this again.' }
    if (-not (Test-Path (Join-Path $here 'node_modules'))) { throw 'Run "npm install" in this folder first.' }
    Stop-ServerLoop | Out-Null

    # restart loop: if the server ever exits, start it again after 5 s. Output goes to server.log.
    @"
@echo off
cd /d "%~dp0"
set PORT=$Port
:loop
"$node" server.js >> server.log 2>&1
timeout /t 5 /nobreak >nul
goto loop
"@ | Set-Content -Path $loop -Encoding ASCII
    # a .vbs launcher so no console window appears
    "CreateObject(""WScript.Shell"").Run """"""$loop"""""", 0, False" | Set-Content -Path $vbs -Encoding ASCII

    $action   = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument "//B `"$vbs`"" -WorkingDirectory $here
    $trigger  = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
    $settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -StartWhenAvailable `
                  -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew
    Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings `
      -Description 'Skippy video-conferencing server (runs hidden, starts at sign-in)' -Force | Out-Null
    Start-ScheduledTask -TaskName $TaskName
    Write-Host ''
    Write-Host "Skippy server is now running in the background on port $Port and will start whenever you sign in."
    Write-Host "Log file:   $(Join-Path $here 'server.log')"
    Write-Host 'To stop it and remove it from startup, run "Stop Skippy Server Background.bat".'
    $ips = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object { $_.IPAddress -notmatch '^(127|169\.254)\.' } | Select-Object -ExpandProperty IPAddress
    if ($ips) { Write-Host ('Address for the app:  ' + (($ips | ForEach-Object { "ws://${_}:$Port" }) -join '   or   ')) }
  }
  'Remove' {
    $n = Stop-ServerLoop
    if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) { Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false }
    Remove-Item $loop, $vbs -ErrorAction SilentlyContinue
    Write-Host ($(if ($n) { 'Server stopped. ' } else { 'Server was not running. ' }) + 'It will no longer start at sign-in.')
  }
  'Status' { Get-State | Format-List }
}
