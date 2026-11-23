# Gimel One-Time Setup Script (Windows PowerShell)
#
# Usage:
#   .\scripts\setup.ps1
#   .\scripts\setup.ps1 -AdminUser admin -AdminPassword "MyStrongPassword"

param(
    [ValidateSet("both", "playground", "production")]
    [string]$Mode = "both",
    [string]$AdminUser = "",
    [string]$AdminPassword = "",
    [switch]$SkipWeb
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $Root

Write-Host "================================================================"
Write-Host "  Gimel - One-Time Setup (Localnet | Playground + Production)"
Write-Host "================================================================"

if (-not (Get-Command python -ErrorAction SilentlyContinue)) {
    throw "Python 3.11+ is required."
}
if (-not $SkipWeb -and -not (Get-Command npm -ErrorAction SilentlyContinue)) {
    throw "Node.js 20+ / npm is required (or pass -SkipWeb)."
}

Write-Host "[1/4] Setting up Python virtual environment (.venv)..."
if (-not (Test-Path ".venv")) {
    python -m venv .venv
}
& .\.venv\Scripts\python.exe -m pip install --upgrade pip --quiet
& .\.venv\Scripts\python.exe -m pip install -e . --quiet

if (-not $SkipWeb) {
    Write-Host "[2/4] Building Portal, Twin, Studio, and Agent Lab frontends..."
    Push-Location web
    npm ci --no-audit --no-fund
    npm run build
    Pop-Location
    if (Test-Path "agentlab\web\package.json") {
        Push-Location agentlab\web
        npm ci --no-audit --no-fund
        npm run build
        Pop-Location
    }
} else {
    Write-Host "[2/4] Skipping frontend build (-SkipWeb)."
}

Write-Host "[3/4] Initializing localnet Playground sandbox..."
& .\.venv\Scripts\gimel.exe setup --mode playground

if ($Mode -eq "production" -or $Mode -eq "both") {
    Write-Host "[4/4] Initializing localnet Production environment..."
    if ($AdminUser -and $AdminPassword) {
        & .\.venv\Scripts\gimel.exe setup --mode production --admin-user $AdminUser --admin-password $AdminPassword
    } else {
        & .\.venv\Scripts\gimel.exe setup --mode production
    }
}

Write-Host ""
Write-Host "Setup complete! Start Gimel with:"
Write-Host "  Playground (:8040):  .\.venv\Scripts\gimel.exe playground"
Write-Host "  Production (:8041):  .\.venv\Scripts\gimel.exe production"
Write-Host "  Manage accounts:     .\.venv\Scripts\gimel.exe accounts list"
Write-Host "  Check updates:       .\.venv\Scripts\gimel.exe update --check"
