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
try {
  # Prefer running from the package directory to minimize odd workspace/env scans on Windows
  Push-Location (Join-Path $repoRoot 'app/renderer')
  pnpm run -s build
  $code = $LASTEXITCODE
  Pop-Location
  if ($code -ne 0) { throw "renderer-build-failed:$code" }
} catch {
  $msg = $_.Exception.Message
  Write-Warning "Renderer build failed ($msg). Retrying with isolated env..."
  # Retry with env overrides that discourage home-directory config scans and update notifiers
  $prev = @{
    BROWSERSLIST = $env:BROWSERSLIST
    BROWSERSLIST_DISABLE_CACHE = $env:BROWSERSLIST_DISABLE_CACHE
    NO_UPDATE_NOTIFIER = $env:NO_UPDATE_NOTIFIER
    npm_config_update_notifier = $env:npm_config_update_notifier
  }
  $env:BROWSERSLIST = 'defaults'
  $env:BROWSERSLIST_DISABLE_CACHE = '1'
  $env:NO_UPDATE_NOTIFIER = '1'
  $env:npm_config_update_notifier = 'false'
  try {
    Push-Location (Join-Path $repoRoot 'app/renderer')
    pnpm run -s build -- --debug
    $code = $LASTEXITCODE
    Pop-Location
    if ($code -ne 0) { throw "renderer-build-failed:$code" }
  } finally {
    $env:BROWSERSLIST = $prev.BROWSERSLIST
    $env:BROWSERSLIST_DISABLE_CACHE = $prev.BROWSERSLIST_DISABLE_CACHE
    $env:NO_UPDATE_NOTIFIER = $prev.NO_UPDATE_NOTIFIER
    $env:npm_config_update_notifier = $prev.npm_config_update_notifier
  }
}

Write-Host "[info] Building main..." -ForegroundColor Cyan
try {
  # Prefer running from the package directory to minimize odd workspace/env scans on Windows
  Push-Location (Join-Path $repoRoot 'app/main')
  pnpm run -s build
  $code = $LASTEXITCODE
  Pop-Location
  if ($code -ne 0) { throw "main-build-failed:$code" }
} catch {
  $msg = $_.Exception.Message
  Write-Warning "Main build failed ($msg). Retrying with isolated env..."
  # Retry with env overrides that discourage home-directory config scans and update notifiers
  $prev = @{
    BROWSERSLIST = $env:BROWSERSLIST
    BROWSERSLIST_DISABLE_CACHE = $env:BROWSERSLIST_DISABLE_CACHE
    NO_UPDATE_NOTIFIER = $env:NO_UPDATE_NOTIFIER
    npm_config_update_notifier = $env:npm_config_update_notifier
  }
  $env:BROWSERSLIST = 'defaults'
  $env:BROWSERSLIST_DISABLE_CACHE = '1'
  $env:NO_UPDATE_NOTIFIER = '1'
  $env:npm_config_update_notifier = 'false'
  try {
    Push-Location (Join-Path $repoRoot 'app/main')
    pnpm run -s build
    $code = $LASTEXITCODE
    Pop-Location
    if ($code -ne 0) { throw "main-build-failed:$code" }
  } finally {
    $env:BROWSERSLIST = $prev.BROWSERSLIST
    $env:BROWSERSLIST_DISABLE_CACHE = $prev.BROWSERSLIST_DISABLE_CACHE
    $env:NO_UPDATE_NOTIFIER = $prev.NO_UPDATE_NOTIFIER
    $env:npm_config_update_notifier = $prev.npm_config_update_notifier
  }
}

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

# Build a true CommonJS preload to avoid dynamic import issues
try {
  Write-Host "[info] Building CommonJS preload..." -ForegroundColor Cyan
  Push-Location (Join-Path $repoRoot 'app/main')
  pnpm --filter @aiembodied/main exec tsc -p tsconfig.preload.cjs.json
  $code = $LASTEXITCODE
  Pop-Location
  if ($code -ne 0) { throw "cjs-preload-build-failed:$code" }

  $mainDir = Join-Path -Path $repoRoot -ChildPath 'app/main'
  $builtCjs = Join-Path -Path $mainDir -ChildPath 'dist-cjs/preload.js'
  if (-not (Test-Path -Path $builtCjs -PathType Leaf)) { throw "missing-cjs:$builtCjs" }

  $distDir = Join-Path -Path $mainDir -ChildPath 'dist'
  if (-not (Test-Path -Path $distDir -PathType Container)) { New-Item -ItemType Directory -Force -Path $distDir | Out-Null }
  $target = Join-Path -Path $distDir -ChildPath 'preload.cjs'
  Copy-Item -Path $builtCjs -Destination $target -Force
  Write-Host "[info] Wrote CommonJS preload at: $target" -ForegroundColor Cyan
} catch {
  Write-Warning "Failed to build CommonJS preload: $($_.Exception.Message). Falling back to dynamic-import shim."
  try {
    $mainDist = Join-Path -Path $repoRoot -ChildPath 'app/main/dist'
    $esmPreload = Join-Path -Path $mainDist -ChildPath 'preload.js'
    $cjsShim = Join-Path -Path $mainDist -ChildPath 'preload.cjs'
    if (Test-Path -Path $esmPreload -PathType Leaf) {
      $shim = @'
// Auto-generated CommonJS shim to load the ESM preload build
const { pathToFileURL } = require('url');
const path = require('path');
let ipcRenderer;
try { ({ ipcRenderer } = require('electron')); } catch {}
const forward = (level, message, meta) => { try { if (ipcRenderer) ipcRenderer.send('diagnostics:preload-log', { level, message, meta, ts: Date.now() }); } catch {} };
console.info('[preload shim] Starting preload shim');
forward('info', 'preload-shim:starting');
(async () => { try { const href = pathToFileURL(path.join(__dirname, 'preload.js')).href; forward('info', 'preload-shim:importing', { href }); await import(href); forward('info', 'preload-shim:imported'); } catch (e) { forward('error', 'preload-shim:import-failed', { message: e && (e.message || e) }); throw e; } })();
'@
      Set-Content -Path $cjsShim -Value $shim -NoNewline
    }
  } catch {
    Write-Warning "Failed to create preload shim: $($_.Exception.Message)"
  }
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

