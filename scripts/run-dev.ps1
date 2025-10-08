# requires -Version 5.1
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

Write-Host "[info] Building renderer..." -ForegroundColor Cyan
pnpm --filter @aiembodied/renderer build

Write-Host "[info] Building main..." -ForegroundColor Cyan
pnpm --filter @aiembodied/main build

Write-Host "[info] Rebuilding native modules for Electron..." -ForegroundColor Cyan
pnpm --filter @aiembodied/main exec electron-builder install-app-deps

if (-not (Test-Path -Path (Join-Path $PSScriptRoot '..' '.env'))) {
  Write-Warning ".env not found at repo root. Ensure REALTIME_API_KEY and PORCUPINE_ACCESS_KEY are set."
}

Write-Host "[info] Launching Electron..." -ForegroundColor Cyan
pnpm --filter @aiembodied/main exec electron dist/main.js

