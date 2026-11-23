# Build standalone Windows gimel.exe (bundles both Playground and Production modes)
$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $PSScriptRoot
Push-Location $Root
try {
    Write-Host "==> 1/3 Building frontend bundles (Portal, Studio, Twin, Agent Lab)"
    Push-Location "$Root\web"
    npm ci --no-audit --no-fund
    npm run build
    Pop-Location

    Push-Location "$Root\agentlab\web"
    npm ci --no-audit --no-fund
    npm run build
    Pop-Location

    Write-Host "==> 2/3 Installing Python package + PyInstaller"
    python -m pip install --upgrade pip
    python -m pip install . "pyinstaller>=6.10"

    Write-Host "==> 3/3 Building gimel.exe via PyInstaller"
    python -m PyInstaller `
        --noconfirm `
        --clean `
        --distpath "$Root\packaging\dist" `
        --workpath "$Root\packaging\build" `
        "$Root\packaging\gimel.spec"

    @"
@echo off
"%~dp0gimel.exe" --mode playground %*
pause
"@ | Set-Content -Encoding ASCII "$Root\packaging\dist\Start-Gimel-Playground.bat"

    @"
@echo off
"%~dp0gimel.exe" --mode production %*
pause
"@ | Set-Content -Encoding ASCII "$Root\packaging\dist\Start-Gimel-Production.bat"

    @"
@echo off
"%~dp0gimel.exe" --mode both %*
pause
"@ | Set-Content -Encoding ASCII "$Root\packaging\dist\Start-Gimel-Both.bat"

    Write-Host ""
    Write-Host "Done! Built $Root\packaging\dist\gimel.exe + Playground/Production .bat launchers."
} finally {
    Pop-Location
}
