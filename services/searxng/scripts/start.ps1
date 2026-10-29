<#
.SYNOPSIS
  Start SearXNG in Docker for the web_search tool (see ..\README.md).

.EXAMPLE
  .\scripts\start.ps1              # http://127.0.0.1:8888
  .\scripts\start.ps1 -Port 8890
  .\scripts\start.ps1 -Recreate    # pick up a changed settings.yml or a newer image
#>
param(
  [int]$Port = 8888,
  [string]$Name = 'aiembodied-searxng',
  [string]$Image = 'docker.io/searxng/searxng:latest',
  [switch]$Recreate
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
  throw 'Docker is not installed or not on PATH. Install Docker Desktop (SearXNG does not run natively on Windows).'
}
docker info *> $null
if ($LASTEXITCODE -ne 0) { throw 'Docker is installed but not running. Start Docker Desktop and try again.' }

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

$existing = docker ps -a --filter "name=^$Name$" --format '{{.Names}}'
if ($existing -and $Recreate) {
  docker rm -f $Name | Out-Null
  $existing = $null
}
if ($existing) {
  docker start $Name | Out-Null
} else {
  docker run -d --name $Name --restart unless-stopped `
    -p "127.0.0.1:${Port}:8080" `
    -v "${configDir}:/etc/searxng" `
    -e "SEARXNG_SECRET=$secret" `
    -e "SEARXNG_BASE_URL=http://127.0.0.1:${Port}/" `
    $Image | Out-Null
}
if ($LASTEXITCODE -ne 0) { throw "docker could not start $Name." }
Write-Output "SearXNG is starting at http://127.0.0.1:$Port (container $Name)."
