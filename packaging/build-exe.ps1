# Build standalone Windows Gimel (--onedir bundle + optional Inno Setup Gimel-Setup-x64.exe)
#
# Usage:
#   .\packaging\build-exe.ps1              # Build frontends, PyInstaller --onedir, and Gimel-Setup-x64.exe
#   .\packaging\build-exe.ps1 -SkipInno    # Build PyInstaller --onedir only (e.g. before code-signing gimel.exe)
#   .\packaging\build-exe.ps1 -OnlyInno    # Build Gimel-Setup-x64.exe from existing packaging\dist\gimel\

param(
    [switch]$SkipInno,
    [switch]$OnlyInno
)

$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $PSScriptRoot
$BundleDir = "$Root\packaging\dist\gimel"
Push-Location $Root
try {
    if (-not $OnlyInno) {
        Write-Host "==> 1/4 Building frontend bundles (Portal, Studio, Twin, Agent Lab)"
        Push-Location "$Root\web"
        npm ci --no-audit --no-fund
        npm run build
        Pop-Location

        Push-Location "$Root\agentlab\web"
        npm ci --no-audit --no-fund
        npm run build
        Pop-Location

        Write-Host "==> 2/4 Installing Python package + PyInstaller"
        python -m pip install --upgrade pip
        python -m pip install . "pyinstaller>=6.10"

        Write-Host "==> 3/4 Building gimel (--onedir) via PyInstaller"
        $env:GIMEL_PYINSTALLER_ONEDIR = "1"
        python -m PyInstaller `
            --noconfirm `
            --clean `
            --distpath "$Root\packaging\dist" `
            --workpath "$Root\packaging\build" `
            "$Root\packaging\gimel.spec"

        if (-not (Test-Path "$BundleDir\gimel.exe")) {
            throw "Expected PyInstaller --onedir output at $BundleDir\gimel.exe"
        }

        @"
@echo off
"%~dp0gimel.exe" --mode playground %*
pause
"@ | Set-Content -Encoding ASCII "$BundleDir\Start-Gimel-Playground.bat"

        @"
@echo off
"%~dp0gimel.exe" --mode production %*
pause
"@ | Set-Content -Encoding ASCII "$BundleDir\Start-Gimel-Production.bat"

        @"
@echo off
"%~dp0gimel.exe" --mode both %*
pause
"@ | Set-Content -Encoding ASCII "$BundleDir\Start-Gimel-Both.bat"

        @"
@echo off
"%~dp0gimel.exe" --mode setup-ui %*
"@ | Set-Content -Encoding ASCII "$BundleDir\Start-Gimel-Setup.bat"
    }

    if (-not $SkipInno) {
        $IsccPath = $null
        $IsccCmd = Get-Command iscc -ErrorAction SilentlyContinue
        if ($IsccCmd) {
            $IsccPath = $IsccCmd.Source
        } elseif (Test-Path "C:\Program Files (x86)\Inno Setup 6\ISCC.exe") {
            $IsccPath = "C:\Program Files (x86)\Inno Setup 6\ISCC.exe"
        }
        if ($IsccPath) {
            if (-not (Test-Path "$BundleDir\gimel.exe")) {
                throw "Missing $BundleDir\gimel.exe — run without -OnlyInno first."
            }
            if (-not (Test-Path "$Root\packaging\windows\install-deps.ps1")) {
                throw "Missing $Root\packaging\windows\install-deps.ps1"
            }
            Write-Host "==> 4/4 Building Windows UI Installer (Gimel-Setup-x64.exe) via Inno Setup ($IsccPath)"
            $VerLine = Select-String -Path "$Root\gimel\version.py" -Pattern 'APP_VERSION\s*=\s*"([^"]+)"'
            $AppVer = if ($VerLine) { $VerLine.Matches[0].Groups[1].Value } else { "0.2.4" }
            & $IsccPath "/DAppVersion=$AppVer" "$Root\packaging\windows\gimel-setup.iss"
            if ($LASTEXITCODE -ne 0) { throw "Inno Setup failed with exit code $LASTEXITCODE" }
        } else {
            Write-Host "Note: Inno Setup (iscc) not found; skipped Gimel-Setup-x64.exe."
        }
    }

    Write-Host ""
    Write-Host "Done! Built $BundleDir\gimel.exe (+ Gimel-Setup-x64.exe if Inno Setup ran)."
} finally {
    Pop-Location
}
