# requires -Version 5.1
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Assert-LastExit {
  param(
    [Parameter(Mandatory = $true)][string]$Step
  )
  if ($LASTEXITCODE -ne 0) {
    throw "Step failed: $Step (exit $LASTEXITCODE)"
  }
}

Write-Host "[info] Checking workspace install..." -ForegroundColor Cyan
$repoRoot = Split-Path -Path $PSScriptRoot -Parent
$rootNodeModules = Join-Path -Path $repoRoot -ChildPath 'node_modules'
if (-not (Test-Path -Path $rootNodeModules -PathType Container)) {
  Write-Host "[info] Installing dependencies with pnpm..." -ForegroundColor Cyan
  pnpm install
  Assert-LastExit 'pnpm install'
}

Write-Host "[info] Building renderer..." -ForegroundColor Cyan
pnpm --filter @aiembodied/renderer build
Assert-LastExit '@aiembodied/renderer build'

Write-Host "[info] Building main..." -ForegroundColor Cyan
pnpm --filter @aiembodied/main build
Assert-LastExit '@aiembodied/main build'

Write-Host "[info] Rebuilding native modules for Electron..." -ForegroundColor Cyan
pnpm --filter @aiembodied/main exec electron-builder install-app-deps
Assert-LastExit 'electron-builder install-app-deps'

# With pnpm, ensure native deps are rebuilt against Electron headers explicitly
try {
  $electronVersion = pnpm --filter @aiembodied/main exec node -p "require('electron/package.json').version"
  if (-not [string]::IsNullOrWhiteSpace($electronVersion)) {
    $env:npm_config_runtime = 'electron'
    $env:npm_config_target = $electronVersion.Trim()
    pnpm --filter @aiembodied/main rebuild better-sqlite3 keytar | Out-Null
  }
} catch {
  Write-Warning "Optional electron native rebuild step failed: $($_.Exception.Message)"
}

# Ensure a CommonJS preload shim exists so Electron can load the preload in dev
try {
  $mainDist = Join-Path -Path $repoRoot -ChildPath 'app/main/dist'
  $esmPreload = Join-Path -Path $mainDist -ChildPath 'preload.js'
  $cjsShim = Join-Path -Path $mainDist -ChildPath 'preload.cjs'
  if (Test-Path -Path $esmPreload -PathType Leaf) {
    $shim = @'
// Auto-generated CommonJS shim to load the ESM preload build
const { pathToFileURL } = require('url');
const path = require('path');
// eslint-disable-next-line no-console
console.info('[preload shim] Starting preload shim');
(async () => {
  try {
    const esmPath = path.join(__dirname, 'preload.js');
    const href = pathToFileURL(esmPath).href;
    // eslint-disable-next-line no-console
    console.info('[preload shim] Importing ESM preload at', href);
    await import(href);
    // eslint-disable-next-line no-console
    console.info('[preload shim] ESM preload imported successfully');
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('[preload shim] Failed to import ESM preload:', e && (e.stack || e.message || e));
    throw e;
  }
})();
'@
    Set-Content -Path $cjsShim -Value $shim -NoNewline
  }
} catch {
  Write-Warning "Failed to create preload shim: $($_.Exception.Message)"
}

function Get-DotEnvValues {
  param([string]$Path)
  $map = @{}
  if (-not (Test-Path -Path $Path -PathType Leaf)) { return $map }
  foreach ($line in Get-Content -Path $Path) {
    if ($line -match '^[ \t]*#') { continue }
    if ($line.Trim().Length -eq 0) { continue }
    $kv = $line -split '=',2
    if ($kv.Length -ne 2) { continue }
    $k = $kv[0].Trim()
    $v = $kv[1].Trim().Trim('"').Trim("'")
    if ($k) { $map[$k] = $v }
  }
  return $map
}

$envFilePath = Join-Path -Path $repoRoot -ChildPath '.env'
$envFromFile = Get-DotEnvValues -Path $envFilePath
$hasRealtime = ([string]::IsNullOrWhiteSpace($env:REALTIME_API_KEY) -eq $false) -or ($envFromFile.ContainsKey('REALTIME_API_KEY') -and -not [string]::IsNullOrWhiteSpace($envFromFile['REALTIME_API_KEY']))
$hasPorcupine = ([string]::IsNullOrWhiteSpace($env:PORCUPINE_ACCESS_KEY) -eq $false) -or ($envFromFile.ContainsKey('PORCUPINE_ACCESS_KEY') -and -not [string]::IsNullOrWhiteSpace($envFromFile['PORCUPINE_ACCESS_KEY']))

if (-not (Test-Path -Path $envFilePath)) {
  Write-Warning ".env not found at repo root. Ensure REALTIME_API_KEY and PORCUPINE_ACCESS_KEY are set."
}

if (-not $hasPorcupine) {
  Write-Error "Missing PORCUPINE_ACCESS_KEY. Add it to $envFilePath or export it in the environment."
  Write-Host "Example .env entries:" -ForegroundColor Yellow
  Write-Host "  PORCUPINE_ACCESS_KEY=your_porcupine_key_here" -ForegroundColor Yellow
  Write-Host "  REALTIME_API_KEY=your_openai_key_here" -ForegroundColor Yellow
  exit 1
}

Write-Host "[info] Launching Electron..." -ForegroundColor Cyan
$mainDir = Join-Path -Path $repoRoot -ChildPath 'app/main'
$electronCmd = Join-Path -Path $mainDir -ChildPath 'node_modules/.bin/electron.cmd'
$env:AIEMBODIED_ENABLE_DIAGNOSTICS = '1'
if (Test-Path -Path $electronCmd -PathType Leaf) {
  Push-Location $mainDir
  & $electronCmd 'dist/main.js'
  $code = $LASTEXITCODE
  Pop-Location
  if ($code -ne 0) { Write-Warning "Electron exited with code $code" }
} else {
  pnpm --filter @aiembodied/main exec electron dist/main.js
  if ($LASTEXITCODE -ne 0) { Write-Warning "Electron exited with code $LASTEXITCODE" }
}

