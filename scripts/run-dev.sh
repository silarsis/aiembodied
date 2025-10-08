#!/usr/bin/env bash
set -euo pipefail

echo "[info] Building renderer..."
pnpm --filter @aiembodied/renderer build

echo "[info] Building main..."
pnpm --filter @aiembodied/main build

echo "[info] Rebuilding native modules for Electron..."
pnpm --filter @aiembodied/main exec electron-builder install-app-deps

if [[ ! -f "$(pwd)/.env" ]]; then
  echo "[warn] .env not found at repo root. Ensure REALTIME_API_KEY and PORCUPINE_ACCESS_KEY are set." >&2
fi

echo "[info] Launching Electron..."
pnpm --filter @aiembodied/main exec electron dist/main.js

