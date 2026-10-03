<#
.SYNOPSIS
MadMarket Deployment Script for Windows

.DESCRIPTION
Manages deployment, setup, auth, and execution for the Windows environment.
Assumes Node.js is already installed.
#>

param(
    [Parameter(Position=0, Mandatory=$true)]
    [ValidateSet("setup", "start", "stop", "auth")]
    [string]$Action,

    [Parameter(Position=1)]
    [string]$SessionToken,

    [Parameter(Position=2)]
    [string]$InstanceId
)

$AppDir = $PSScriptRoot

function Setup-App {
    Write-Host "Setting up application in $AppDir..."
    Set-Location $AppDir

    Write-Host "Installing dependencies..."
    npm install --production

    if (-not (Test-Path "config.json")) {
        Write-Host "Copying config.example.json to config.json..."
        Copy-Item -Path "config.example.json" -Destination "config.json"
    }

    Write-Host "Setup complete."
}

function Start-App {
    Write-Host "Starting application in a new process..."
    Set-Location $AppDir
    Start-Process -FilePath "node" -ArgumentList "index.js" -NoNewWindow
    Write-Host "Application started."
}

function Stop-App {
    Write-Host "Stopping node processes running index.js..."
    # Warning: This forcefully kills all node processes. In a real-world scenario, you might want more specific targeting (e.g. tracking PID)
    Get-Process node -ErrorAction SilentlyContinue | Stop-Process -Force
    Write-Host "Application stopped."
}

function Update-Auth {
    if ([string]::IsNullOrWhiteSpace($SessionToken) -or [string]::IsNullOrWhiteSpace($InstanceId)) {
        Write-Error "Usage: .\deploy.ps1 auth <SessionToken> <InstanceId>"
        return
    }

    Set-Location $AppDir

    if (-not (Test-Path "config.json")) {
        Write-Error "config.json not found! Run setup first."
        return
    }

    Write-Host "Updating credentials in config.json..."
    
    $ConfigContent = Get-Content "config.json" -Raw | ConvertFrom-Json
    if (-not $ConfigContent.adapters) { $ConfigContent | Add-Member -MemberType NoteProperty -Name "adapters" -Value @{} }
    if (-not $ConfigContent.adapters.mollybet) { $ConfigContent.adapters | Add-Member -MemberType NoteProperty -Name "mollybet" -Value @{} }
    
    $ConfigContent.adapters.mollybet.sessionToken = $SessionToken
    $ConfigContent.adapters.mollybet.instanceId = $InstanceId

    $ConfigContent | ConvertTo-Json -Depth 10 | Set-Content "config.json"

    Write-Host "Credentials updated."
}

switch ($Action) {
    "setup" { Setup-App }
    "start" { Start-App }
    "stop" { Stop-App }
    "auth" { Update-Auth }
}
