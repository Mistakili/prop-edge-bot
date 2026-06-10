# Registers Windows Scheduled Task — daily at 6:12 PM local (WAT).
# Run once: powershell -ExecutionPolicy Bypass -File register-prop-edge-task.ps1

$ErrorActionPreference = "Stop"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$nodeScript = Join-Path $scriptDir "prop-edge-daily.mjs"
$logDir = Join-Path $env:USERPROFILE ".grok\logs\prop-edge"
$taskLog = Join-Path $logDir "task.log"

New-Item -ItemType Directory -Force -Path $logDir | Out-Null

$node = (Get-Command node -ErrorAction Stop).Source
$taskName = "Soliris-PropEdge-Daily"
$at = "18:12"

$action = New-ScheduledTaskAction `
    -Execute "cmd.exe" `
    -Argument "/c `"$node`" `"$nodeScript`" >> `"$taskLog`" 2>&1"

$trigger = New-ScheduledTaskTrigger -Daily -At $at

$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -ExecutionTimeLimit (New-TimeSpan -Hours 1)

$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited

Register-ScheduledTask `
    -TaskName $taskName `
    -Action $action `
    -Trigger $trigger `
    -Settings $settings `
    -Principal $principal `
    -Description "Daily Prop Edge picks at 6:12 PM local via Soliris MCP." `
    -Force

Write-Host "Registered: $taskName daily at $at local"
Write-Host "Script: $nodeScript"
Write-Host "Log: $taskLog"