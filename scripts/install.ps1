# KATHAL OS — Self-Hosted Windows Installer (No Docker, No Cloud Required)
param(
  [int]$Port = 3000,
  [switch]$RegisterStartupTask
)

$ErrorActionPreference = "Stop"

$RootDir = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$DataDir = if ($env:KATHAL_DATA_DIR) { $env:KATHAL_DATA_DIR } else { Join-Path $RootDir "data" }
$AppsDir = if ($env:KATHAL_APPS_DIR) { $env:KATHAL_APPS_DIR } else { Join-Path $DataDir "apps" }

Write-Host "=== KATHAL OS Self-Hosted Windows Installer ===" -ForegroundColor Green
Write-Host "Install root : $RootDir"
Write-Host "Data dir     : $DataDir"
Write-Host "Apps dir     : $AppsDir"

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  if (Get-Command winget -ErrorAction SilentlyContinue) {
    Write-Host "Installing Node.js LTS via winget..." -ForegroundColor Yellow
    winget install --id OpenJS.NodeJS.LTS --silent --accept-package-agreements --accept-source-agreements
  } else {
    throw "Node.js 20+ is required. Install Node.js LTS from https://nodejs.org/ and re-run this script."
  }
}

$NodeVersionRaw = (node -p "process.versions.node.split('.')[0]")
if ([int]$NodeVersionRaw -lt 20) {
  throw "Node.js 20+ is required (detected major v$NodeVersionRaw)."
}

New-Item -ItemType Directory -Force -Path $DataDir | Out-Null
New-Item -ItemType Directory -Force -Path $AppsDir | Out-Null

Push-Location $RootDir
try {
  Write-Host "[1/3] Installing npm dependencies locally..." -ForegroundColor Cyan
  npm install
  if ($LASTEXITCODE -ne 0) { throw "npm install failed with exit code $LASTEXITCODE" }

  Write-Host "[2/3] Building frontend & verifying TypeScript..." -ForegroundColor Cyan
  npm run build
  if ($LASTEXITCODE -ne 0) { throw "npm run build failed with exit code $LASTEXITCODE" }
} finally {
  Pop-Location
}

if ($RegisterStartupTask) {
  $NodeExe = (Get-Command node).Source
  $TsxCli = Join-Path $RootDir "node_modules\tsx\dist\cli.mjs"
  $ServerFile = Join-Path $RootDir "server.ts"
  $Action = New-ScheduledTaskAction -Execute $NodeExe -Argument "`"$TsxCli`" `"$ServerFile`"" -WorkingDirectory $RootDir
  $Trigger = New-ScheduledTaskTrigger -AtLogOn
  Register-ScheduledTask -TaskName "KathalOS" -Action $Action -Trigger $Trigger -Description "KATHAL OS Self-Hosted Local Panel" -Force | Out-Null
  Write-Host "Registered Windows startup Scheduled Task 'KathalOS'." -ForegroundColor Green
}

Write-Host "[3/3] Setup complete!" -ForegroundColor Green
Write-Host ""
Write-Host "Start KATHAL OS locally (http://127.0.0.1:$Port):"
Write-Host "  npm run dev"
Write-Host "Or launch Desktop App:"
Write-Host "  npm run desktop"
Write-Host "Optional Windows login auto-start:"
Write-Host "  powershell -ExecutionPolicy Bypass -File scripts/install.ps1 -RegisterStartupTask"
