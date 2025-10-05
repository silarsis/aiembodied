#!/usr/bin/env bash
set -euo pipefail

REQUIRED_NODE_VERSION="20.0.0"
TARGET_PNPM_VERSION="9.12.0"

version_ge() {
  local current="$1"
  local required="$2"
  if [[ "$(printf '%s\n%s\n' "$required" "$current" | sort -V | tail -n1)" == "$current" ]]; then
    return 0
  fi
  return 1
}

has_command() {
  command -v "$1" >/dev/null 2>&1
}

get_node_version() {
  if ! has_command node; then
    return 1
  fi
  node --version | tr -d 'v'
}

ensure_homebrew() {
  if has_command brew; then
    return
  fi
  cat <<'MSG'
Homebrew is required to install Node.js automatically on macOS but was not found.
Install Homebrew from https://brew.sh/ and re-run this script.
MSG
  exit 1
}

ensure_node() {
  local current
  if current=$(get_node_version); then
    if version_ge "$current" "$REQUIRED_NODE_VERSION"; then
      echo "Node.js ${current} already satisfies the minimum requirement."
      return
    fi
  fi

  echo "Installing Node.js via Homebrew..."
  ensure_homebrew
  brew update
  if brew list node >/dev/null 2>&1; then
    brew upgrade node
  else
    brew install node
  fi

  if ! current=$(get_node_version); then
    echo "Node.js installation failed." >&2
    exit 1
  fi

  if ! version_ge "$current" "$REQUIRED_NODE_VERSION"; then
    echo "Node.js ${current} does not meet the ${REQUIRED_NODE_VERSION}+ requirement." >&2
    exit 1
  fi

  echo "Node.js ${current} is ready."
}

get_pnpm_version() {
  if ! has_command pnpm; then
    return 1
  fi
  pnpm --version
}

ensure_pnpm() {
  if ! has_command corepack; then
    echo "Corepack was not found. Verify that Node.js 16.17+ is installed." >&2
    exit 1
  fi

  local current
  if current=$(get_pnpm_version); then
    if version_ge "$current" "$TARGET_PNPM_VERSION"; then
      echo "pnpm ${current} already satisfies the requirement."
      return
    fi
  fi

  echo "Activating pnpm ${TARGET_PNPM_VERSION} via Corepack..."
  corepack enable
  corepack prepare "pnpm@${TARGET_PNPM_VERSION}" --activate

  if ! current=$(get_pnpm_version); then
    echo "Failed to activate pnpm via Corepack." >&2
    exit 1
  fi

  echo "pnpm ${current} is ready."
}

ensure_node
ensure_pnpm

echo "All dependencies are installed. You can now run 'pnpm install'."
