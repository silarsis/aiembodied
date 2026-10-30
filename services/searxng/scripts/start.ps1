<#
.SYNOPSIS
  Start SearXNG in a container for the web_search tool (see ..\README.md).
  Uses wslc (WSL's built-in container runtime) when it is installed, otherwise Docker.

.EXAMPLE
  .\scripts\start.ps1                   # http://127.0.0.1:8888
  .\scripts\start.ps1 -Port 8890
  .\scripts\start.ps1 -Runtime docker   # or set SEARXNG_RUNTIME=docker
#>
param(
  [int]$Port = 8888,
  [string]$Name = 'aiembodied-searxng',
  [string]$Image = 'docker.io/searxng/searxng:latest',
  [ValidateSet('auto', 'wslc', 'docker')]
  [string]$Runtime = $(if ($env:SEARXNG_RUNTIME) { $env:SEARXNG_RUNTIME } else { 'auto' })
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot

if ($Runtime -eq 'auto') {
  if (Get-Command wslc -ErrorAction SilentlyContinue) { $Runtime = 'wslc' }
  elseif (Get-Command docker -ErrorAction SilentlyContinue) { $Runtime = 'docker' }
  else { throw 'Neither wslc (WSL 2.9.3+, run "wsl --update") nor Docker is installed.' }
} elseif (-not (Get-Command $Runtime -ErrorAction SilentlyContinue)) {
  throw "$Runtime is not installed or not on PATH."
}

# SearXNG writes into its config folder, so it gets a copy outside the repo.
$configDir = Join-Path $env:LOCALAPPDATA 'aiembodied\searxng'
New-Item -ItemType Directory -Force -Path $configDir | Out-Null
Copy-Item -Force (Join-Path $root 'settings.yml') (Join-Path $configDir 'settings.yml')
$secretFile = Join-Path $configDir 'secret'
if (-not (Test-Path $secretFile)) {
  $bytes = New-Object byte[] 32
  [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  Set-Content -NoNewline -Path $secretFile -Value ([Convert]::ToBase64String($bytes))
}
$secret = (Get-Content -Raw $secretFile).Trim()
$envArgs = @('-e', "SEARXNG_SECRET=$secret", '-e', "SEARXNG_BASE_URL=http://127.0.0.1:${Port}/")

# This script only runs when nothing answers on the port, so start from a fresh container each
# time: a changed port, settings.yml or image always applies. Settings and the secret live on the
# host. Under ErrorActionPreference Stop, Windows PowerShell turns a native command's stderr into
# an error, and rm writes one when there is no old container to remove.
if ($Runtime -eq 'wslc') {
  # wslc publishes ports on 127.0.0.1 by default.
  try { wslc rm -f $Name *> $null } catch { }
  wslc run -d --name $Name -p "${Port}:8080" -v "${configDir}:/etc/searxng" @envArgs $Image | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "wslc could not start $Name (see 'wslc logs $Name')." }
} else {
  try { docker info *> $null } catch { }
  if ($LASTEXITCODE -ne 0) { throw 'Docker is installed but not running. Start Docker Desktop and try again.' }
  try { docker rm -f $Name *> $null } catch { }
  docker run -d --name $Name --restart unless-stopped `
    -p "127.0.0.1:${Port}:8080" `
    -v "${configDir}:/etc/searxng" `
    @envArgs $Image | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "docker could not start $Name." }
}
Write-Output "SearXNG is starting at http://127.0.0.1:$Port ($Runtime container $Name)."
