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
    [switch]$SkipWeb,
    [switch]$SkipDocker,
    [switch]$WithPiper,
    [string]$PiperVoice = "de_DE-thorsten-medium"
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $Root

Write-Host "================================================================"
Write-Host "  Gimel - One-Time Setup (Localnet | Playground + Production)"
Write-Host "================================================================"

function Refresh-EnvPath {
    $machinePath = [System.Environment]::GetEnvironmentVariable("Path", "Machine")
    $userPath = [System.Environment]::GetEnvironmentVariable("Path", "User")
    $parts = @()
    if ($machinePath) { $parts += $machinePath }
    if ($userPath) { $parts += $userPath }
    foreach ($p in @(
        "$env:LOCALAPPDATA\Programs\Python\Python312",
        "$env:LOCALAPPDATA\Programs\Python\Python312\Scripts",
        "$env:ProgramFiles\Python312",
        "$env:ProgramFiles\Python312\Scripts",
        "$env:ProgramFiles\Docker\Docker\resources\bin"
    )) {
        if ((Test-Path $p) -and ($parts -notcontains $p)) { $parts += $p }
    }
    $env:Path = ($parts -join ";")
}

$DepsScript = Join-Path $Root "packaging\windows\install-deps.ps1"
$NeedPython = -not (Get-Command python -ErrorAction SilentlyContinue)
if (-not $NeedPython) {
    try {
        $pyVer = & python -c "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')" 2>$null
        if ($LASTEXITCODE -ne 0 -or $pyVer -notmatch '^3\.(1[1-9]|[2-9]\d)$') {
            $NeedPython = $true
        }
    } catch {
        $NeedPython = $true
    }
}
$NeedDocker = (-not $SkipDocker) -and (-not (Get-Command docker -ErrorAction SilentlyContinue)) -and (-not (Test-Path "$env:ProgramFiles\Docker\Docker\Docker Desktop.exe"))

if (($NeedPython -or $NeedDocker) -and (Test-Path $DepsScript)) {
    Write-Host "[0/4] Checking/installing system dependencies (Python 3.12 / Docker)..."
    $depArgs = @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $DepsScript)
    if ($NeedPython) { $depArgs += "-InstallPython" }
    if ($NeedDocker) { $depArgs += "-InstallDocker" }
    & powershell.exe @depArgs
    Refresh-EnvPath
}

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

if ($WithPiper) {
    Write-Host "[Opt-In] Installing local Piper TTS (GPL-3.0) + voice $PiperVoice..."
    & .\.venv\Scripts\gimel.exe piper-install --voice $PiperVoice --accept-gpl
}

Write-Host ""
Write-Host "Setup complete! Start Gimel with:"
Write-Host "  Playground (:8040):  .\.venv\Scripts\gimel.exe playground"
Write-Host "  Production (:8041):  .\.venv\Scripts\gimel.exe production"
Write-Host "  Manage accounts:     .\.venv\Scripts\gimel.exe accounts list"
Write-Host "  Check updates:       .\.venv\Scripts\gimel.exe update --check"
