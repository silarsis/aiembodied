# requires -Version 5.1
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

Write-Host "[info] Building renderer..." -ForegroundColor Cyan
pnpm --filter @aiembodied/renderer build

Write-Host "[info] Building main..." -ForegroundColor Cyan
pnpm --filter @aiembodied/main build

Write-Host "[info] Rebuilding native modules for Electron..." -ForegroundColor Cyan
pnpm --filter @aiembodied/main exec electron-builder install-app-deps

$repoRoot = Split-Path -Path $PSScriptRoot -Parent
$envFilePath = Join-Path -Path $repoRoot -ChildPath '.env'
if (-not (Test-Path -Path $envFilePath)) {
  Write-Warning ".env not found at repo root. Ensure REALTIME_API_KEY and PORCUPINE_ACCESS_KEY are set."
}

Write-Host "[info] Launching Electron..." -ForegroundColor Cyan
pnpm --filter @aiembodied/main exec electron dist/main.js

