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

    @"
@echo off
"%~dp0gimel.exe" --mode setup-ui %*
"@ | Set-Content -Encoding ASCII "$Root\packaging\dist\Start-Gimel-Setup.bat"

    $Iscc = Get-Command iscc -ErrorAction SilentlyContinue
    if (-not $Iscc -and (Test-Path "C:\Program Files (x86)\Inno Setup 6\ISCC.exe")) {
        $Iscc = Get-Item "C:\Program Files (x86)\Inno Setup 6\ISCC.exe"
    }
    if ($Iscc) {
        Write-Host "==> 4/4 Building Windows UI Installer (Gimel-Setup-x64.exe) via Inno Setup"
        $VerLine = Select-String -Path "$Root\gimel\version.py" -Pattern 'APP_VERSION\s*=\s*"([^"]+)"'
        $AppVer = if ($VerLine) { $VerLine.Matches[0].Groups[1].Value } else { "0.2.2" }
        & $Iscc.FullName "/DAppVersion=$AppVer" "$Root\packaging\windows\gimel-setup.iss"
    } else {
        Write-Host "Note: Inno Setup (iscc) not found; skipped Gimel-Setup-x64.exe."
    }

    Write-Host ""
    Write-Host "Done! Built $Root\packaging\dist\gimel.exe + launchers (+ Gimel-Setup-x64.exe if Inno Setup installed)."
} finally {
    Pop-Location
}
