# Registers Windows Scheduled Tasks — primary + MLB evening pass (WAT).
# Run once: powershell -ExecutionPolicy Bypass -File register-prop-edge-task.ps1

$ErrorActionPreference = "Stop"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$nodeScript = Join-Path $scriptDir "prop-edge-daily.mjs"
$logDir = Join-Path $env:USERPROFILE ".grok\logs\prop-edge"
$taskLog = Join-Path $logDir "task.log"

New-Item -ItemType Directory -Force -Path $logDir | Out-Null

$node = (Get-Command node -ErrorAction Stop).Source
$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -ExecutionTimeLimit (New-TimeSpan -Hours 1)

$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited

function Register-PropEdgeTask {
    param([string]$Name, [string]$At, [string]$Description)
    $action = New-ScheduledTaskAction `
        -Execute "cmd.exe" `
        -Argument "/c `"$node`" `"$nodeScript`" >> `"$taskLog`" 2>&1"
    $trigger = New-ScheduledTaskTrigger -Daily -At $At
    Register-ScheduledTask `
        -TaskName $Name `
        -Action $action `
        -Trigger $trigger `
        -Settings $settings `
        -Principal $principal `
        -Description $Description `
        -Force
    Write-Host "Registered: $Name daily at $At local"
}

Register-PropEdgeTask `
    -Name "Soliris-PropEdge-Daily" `
    -At "18:12" `
    -Description "Primary Prop Edge pass at 6:12 PM WAT."

Register-PropEdgeTask `
    -Name "Soliris-PropEdge-MLB" `
    -At "21:12" `
    -Description "MLB evening pass at 9:12 PM WAT when lines post."

Write-Host "Script: $nodeScript"
Write-Host "Log: $taskLog"