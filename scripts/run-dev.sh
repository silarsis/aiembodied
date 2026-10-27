#!/usr/bin/env bash
set -euo pipefail

echo "[info] Building renderer..."
pnpm --filter @aiembodied/renderer build

echo "[info] Building main..."
pnpm --filter @aiembodied/main build

echo "[info] Ensuring the Electron binary is downloaded..."
pnpm --filter @aiembodied/main exec install-electron

if [[ ! -f "$(pwd)/.env" ]]; then
  echo "[warn] .env not found at repo root. Ensure REALTIME_API_KEY is set." >&2
fi

echo "[info] Launching Electron..."
pnpm --filter @aiembodied/main exec electron dist/main.js

