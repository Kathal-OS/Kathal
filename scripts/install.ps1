<# 
  KATHAL OS — Windows Installer
  Installs KATHAL as a native Windows service.

  Usage:
    powershell -ExecutionPolicy Bypass -File install.ps1
#>

$KATHAL_VERSION = "0.1.0"
$INSTALL_DIR = "$env:LOCALAPPDATA\kathal"
$DATA_DIR = "$INSTALL_DIR\data"
$PORT = 8080

Write-Host ""
Write-Host "  KATHAL OS Installer (Windows)" -ForegroundColor Green
Write-Host "  ================================" -ForegroundColor Green
Write-Host ""

# Create directories.
if (!(Test-Path $INSTALL_DIR)) {
    New-Item -ItemType Directory -Path $INSTALL_DIR -Force | Out-Null
}
if (!(Test-Path $DATA_DIR)) {
    New-Item -ItemType Directory -Path $DATA_DIR -Force | Out-Null
}

Write-Host "[1/4] Checking Docker..." -ForegroundColor Yellow

$dockerAvailable = $false
try {
    $dockerVersion = docker version --format '{{.Server.Version}}' 2>$null
    if ($LASTEXITCODE -eq 0) {
        $dockerAvailable = $true
        Write-Host "  Docker found: v$dockerVersion" -ForegroundColor Green
    }
} catch {}

if (!$dockerAvailable) {
    Write-Host "  Docker not found — running in system-only mode (Docker optional)" -ForegroundColor DarkYellow
}

Write-Host "[2/4] Downloading KATHAL v$KATHAL_VERSION..." -ForegroundColor Yellow

$downloadUrl = "https://github.com/Kathal-OS/kathal/releases/download/v$KATHAL_VERSION/kathal-$KATHAL_VERSION-windows-amd64.exe"
$binaryPath = "$INSTALL_DIR\kathal.exe"

try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    Invoke-WebRequest -Uri $downloadUrl -OutFile $binaryPath -UseBasicParsing
    Write-Host "  Downloaded to $binaryPath" -ForegroundColor Green
} catch {
    Write-Host "  Download failed. Building from source..." -ForegroundColor DarkYellow
    
    # Check if Go is available.
    try {
        $goVersion = go version 2>$null
        Write-Host "  Building with $goVersion..." -ForegroundColor Gray
        
        $tmpDir = "$env:TEMP\kathal-build"
        if (Test-Path $tmpDir) { Remove-Item -Recurse -Force $tmpDir }
        
        # Download source.
        $zipUrl = "https://github.com/Kathal-OS/kathal/archive/refs/heads/main.zip"
        $zipPath = "$env:TEMP\kathal-source.zip"
        Invoke-WebRequest -Uri $zipUrl -OutFile $zipPath -UseBasicParsing
        Expand-Archive -Path $zipPath -DestinationPath $tmpDir -Force
        
        $srcDir = Get-ChildItem -Path $tmpDir -Directory | Select-Object -First 1
        Push-Location $srcDir.FullName
        go build -o $binaryPath ./cmd/kathal
        Pop-Location
        
        Remove-Item -Recurse -Force $tmpDir -ErrorAction SilentlyContinue
        Remove-Item -Force $zipPath -ErrorAction SilentlyContinue
    } catch {
        Write-Host "  Go not found. Please install Go 1.22+ from https://go.dev/dl/" -ForegroundColor Red
        exit 1
    }
}

Write-Host "[3/4] Creating uninstall script..." -ForegroundColor Yellow

$uninstallScript = @"
# KATHAL OS — Windows Uninstaller
Write-Host "Stopping KATHAL..." -ForegroundColor Yellow
Stop-Process -Name "kathal" -Force -ErrorAction SilentlyContinue
Write-Host "Removing files..." -ForegroundColor Yellow
Remove-Item -Recurse -Force "$INSTALL_DIR" -ErrorAction SilentlyContinue
Write-Host "KATHAL uninstalled." -ForegroundColor Green
"@
$uninstallScript | Out-File -FilePath "$INSTALL_DIR\uninstall.ps1" -Encoding utf8

Write-Host "[4/4] Starting KATHAL..." -ForegroundColor Yellow

Write-Host ""
Write-Host "  Starting KATHAL OS on http://localhost:$PORT" -ForegroundColor Green
Write-Host "  Login: admin@kathal.local / kathal" -ForegroundColor Gray
Write-Host ""
Write-Host "  Press Ctrl+C to stop." -ForegroundColor DarkGray
Write-Host "  Uninstall: powershell -ExecutionPolicy Bypass -File $INSTALL_DIR\uninstall.ps1" -ForegroundColor Gray
Write-Host ""

# Set environment and start KATHAL.
$env:KATHAL_HTTP_ADDR = ":$PORT"
$env:KATHAL_DB_PATH = "$DATA_DIR\kathal.db"
& $binaryPath