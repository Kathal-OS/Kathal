<# 
  KATHAL OS — Windows Installer
  Installs KATHAL as a Windows service via NSSM or direct run.
  
  Usage:
    powershell -ExecutionPolicy Bypass -File install.ps1
#>

$KATHAL_VERSION = "0.1.0"
$INSTALL_DIR = "$env:LOCALAPPDATA\kathal"
$PORT = 8080

Write-Host ""
Write-Host "  🍈 KATHAL OS Installer (Windows)" -ForegroundColor Green
Write-Host "  ================================"
Write-Host ""

# Create install directory.
if (!(Test-Path $INSTALL_DIR)) {
    New-Item -ItemType Directory -Path $INSTALL_DIR -Force | Out-Null
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
    Write-Host "  Docker not found. KATHAL will run in system-only mode." -ForegroundColor DarkYellow
    Write-Host "  Install Docker Desktop for container management:" -ForegroundColor Gray
    Write-Host "  https://docs.docker.com/desktop/install/windows-install/" -ForegroundColor Gray
    Write-Host ""
}

Write-Host "[2/4] Downloading KATHAL v$KATHAL_VERSION..." -ForegroundColor Yellow

$downloadUrl = "https://github.com/bakeweb/kathal-os/releases/download/v$KATHAL_VERSION/kathal-$KATHAL_VERSION-windows-amd64.exe"
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
        $zipUrl = "https://github.com/bakeweb/kathal-os/archive/refs/heads/master.zip"
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

Write-Host "[3/4] Configuring KATHAL..." -ForegroundColor Yellow

# Create default config.
$configPath = "$INSTALL_DIR\config.json"
if (!(Test-Path $configPath)) {
    @"
{
    "port": $PORT,
    "logLevel": "info",
    "dbPath": "$($INSTALL_DIR -replace '\\', '/')/kathal.db"
}
"@ | Out-File -FilePath $configPath -Encoding utf8
    Write-Host "  Config created at $configPath" -ForegroundColor Green
} else {
    Write-Host "  Config exists, skipping." -ForegroundColor Gray
}

Write-Host "[4/4] Starting KATHAL..." -ForegroundColor Yellow

Write-Host ""
Write-Host "  Starting KATHAL OS on http://localhost:$PORT" -ForegroundColor Green
Write-Host "  Login: admin@kathal.local / kathal" -ForegroundColor Gray
Write-Host ""
Write-Host "  Press Ctrl+C to stop." -ForegroundColor DarkGray
Write-Host ""

# Start KATHAL.
& $binaryPath
