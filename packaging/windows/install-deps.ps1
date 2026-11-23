# Gimel Dependency Installer (Windows)
# Detects and installs Python 3.12+ and Docker Desktop if missing.
# Logs to %LOCALAPPDATA%\Gimel\logs\install-deps.log and never fails the
# parent installer if offline (exits 0 with a clear log note).

param(
    [switch]$InstallPython,
    [switch]$InstallDocker
)

$ErrorActionPreference = "Continue"

$LogDir = Join-Path $env:LOCALAPPDATA "Gimel\logs"
if (-not (Test-Path $LogDir)) {
    New-Item -ItemType Directory -Path $LogDir -Force | Out-Null
}
$LogFile = Join-Path $LogDir "install-deps.log"

function Write-Log {
    param([string]$Message)
    $ts = (Get-Date).ToString("yyyy-MM-dd HH:mm:ss")
    $line = "[$ts] $Message"
    Write-Host $line
    Add-Content -Path $LogFile -Value $line -Encoding UTF8
}

function Refresh-Path {
    $machinePath = [System.Environment]::GetEnvironmentVariable("Path", "Machine")
    $userPath = [System.Environment]::GetEnvironmentVariable("Path", "User")
    $parts = @()
    if ($machinePath) { $parts += $machinePath }
    if ($userPath) { $parts += $userPath }
    $extra = @(
        "$env:LOCALAPPDATA\Programs\Python\Python312",
        "$env:LOCALAPPDATA\Programs\Python\Python312\Scripts",
        "$env:ProgramFiles\Python312",
        "$env:ProgramFiles\Python312\Scripts",
        "$env:ProgramFiles\Docker\Docker\resources\bin"
    )
    foreach ($p in $extra) {
        if ((Test-Path $p) -and ($parts -notcontains $p)) {
            $parts += $p
        }
    }
    $env:Path = ($parts -join ";")
}

function Test-Python311Plus {
    $candidates = @()
    $cmd = Get-Command python -ErrorAction SilentlyContinue
    if ($cmd) { $candidates += $cmd.Source }
    $pyCmd = Get-Command py -ErrorAction SilentlyContinue
    if ($pyCmd) {
        try {
            $ver = & py -3 -c "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')" 2>$null
            if ($LASTEXITCODE -eq 0 -and $ver -match '^3\.(1[1-9]|[2-9]\d)$') {
                Write-Log "Found Python $ver via py -3 launcher."
                return $true
            }
        } catch {}
    }
    $stdPaths = @(
        "$env:LOCALAPPDATA\Programs\Python\Python312\python.exe",
        "$env:LOCALAPPDATA\Programs\Python\Python311\python.exe",
        "$env:LOCALAPPDATA\Programs\Python\Python313\python.exe",
        "$env:ProgramFiles\Python312\python.exe",
        "$env:ProgramFiles\Python311\python.exe",
        "$env:ProgramFiles\Python313\python.exe",
        "C:\Python312\python.exe",
        "C:\Python311\python.exe"
    )
    foreach ($p in $stdPaths) {
        if (Test-Path $p) { $candidates += $p }
    }
    foreach ($exe in ($candidates | Select-Object -Unique)) {
        try {
            $ver = & $exe -c "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')" 2>$null
            if ($LASTEXITCODE -eq 0 -and $ver -match '^3\.(1[1-9]|[2-9]\d)$') {
                Write-Log "Found Python $ver at $exe."
                return $true
            }
        } catch {}
    }
    return $false
}

function Test-DockerInstalled {
    if (Get-Command docker -ErrorAction SilentlyContinue) {
        Write-Log "Found docker CLI in PATH."
        return $true
    }
    $dockerExe = "$env:ProgramFiles\Docker\Docker\Docker Desktop.exe"
    if (Test-Path $dockerExe) {
        Write-Log "Found Docker Desktop at $dockerExe."
        return $true
    }
    return $false
}

function Install-ViaWinget {
    param([string]$PackageId)
    $winget = Get-Command winget -ErrorAction SilentlyContinue
    if (-not $winget) {
        Write-Log "winget not available."
        return $false
    }
    Write-Log "Installing $PackageId via winget..."
    try {
        & $winget.Source install --id $PackageId -e --silent --accept-package-agreements --accept-source-agreements 2>&1 | ForEach-Object {
            Add-Content -Path $LogFile -Value $_ -Encoding UTF8
        }
        if ($LASTEXITCODE -eq 0) {
            Write-Log "winget installed $PackageId successfully."
            return $true
        }
        Write-Log "winget exited with code $LASTEXITCODE for $PackageId."
    } catch {
        Write-Log "winget failed for ${PackageId}: $_"
    }
    return $false
}

function Download-AndRun {
    param(
        [string]$Url,
        [string]$FileName,
        [string[]]$Arguments
    )
    $tmp = Join-Path $env:TEMP $FileName
    Write-Log "Downloading fallback installer from $Url ..."
    try {
        [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
        Invoke-WebRequest -Uri $Url -OutFile $tmp -UseBasicParsing -TimeoutSec 120
        Write-Log "Running $FileName $($Arguments -join ' ') ..."
        $proc = Start-Process -FilePath $tmp -ArgumentList $Arguments -Wait -PassThru
        Write-Log "$FileName exited with code $($proc.ExitCode)."
        return ($proc.ExitCode -eq 0)
    } catch {
        Write-Log "Offline or download/install failed for ${Url}: $_"
        return $false
    } finally {
        if (Test-Path $tmp) {
            Remove-Item -Path $tmp -Force -ErrorAction SilentlyContinue
        }
    }
}

Write-Log "=== Gimel install-deps.ps1 started (InstallPython=$InstallPython, InstallDocker=$InstallDocker) ==="
Refresh-Path

if ($InstallPython) {
    if (Test-Python311Plus) {
        Write-Log "Python 3.11+ already present; skipping installation."
    } else {
        $ok = Install-ViaWinget -PackageId "Python.Python.3.12"
        if (-not $ok) {
            $ok = Download-AndRun `
                -Url "https://www.python.org/ftp/python/3.12.8/python-3.12.8-amd64.exe" `
                -FileName "python-3.12.8-amd64.exe" `
                -Arguments @("/quiet", "InstallAllUsers=0", "PrependPath=1", "Include_test=0")
        }
        Refresh-Path
        if (Test-Python311Plus) {
            Write-Log "Python 3.12 installation verified."
        } else {
            Write-Log "Note: Python 3.12 could not be installed (possibly offline). Gimel setup continues."
        }
    }
}

if ($InstallDocker) {
    if (Test-DockerInstalled) {
        Write-Log "Docker Desktop already present; skipping installation."
    } else {
        $ok = Install-ViaWinget -PackageId "Docker.DockerDesktop"
        if (-not $ok) {
            $ok = Download-AndRun `
                -Url "https://desktop.docker.com/win/main/amd64/Docker%20Desktop%20Installer.exe" `
                -FileName "DockerDesktopInstaller.exe" `
                -Arguments @("install", "--quiet", "--accept-license")
        }
        Refresh-Path
        if (Test-DockerInstalled) {
            Write-Log "Docker Desktop installation verified."
        } else {
            Write-Log "Note: Docker Desktop could not be installed (possibly offline or requires reboot/admin). Gimel setup continues."
        }
    }
}

Write-Log "=== Gimel install-deps.ps1 finished ==="
exit 0
