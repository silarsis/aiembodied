<#
.SYNOPSIS
  Start the memory engine (see ..\README.md): PostgreSQL with pgvector in a container, then the
  engine's HTTP API. Uses wslc (WSL's built-in container runtime) when it is installed,
  otherwise Docker.

.EXAMPLE
  .\scripts\start.ps1                       # database on 127.0.0.1:5433, engine on http://127.0.0.1:8194
  .\scripts\start.ps1 -DatabaseOnly         # just the database (for tests)
  .\scripts\start.ps1 -DatabaseUrl $env:MEMORY_DATABASE_URL   # a Supabase project: no container
  .\scripts\start.ps1 -Runtime docker       # or set MEMORY_DB_RUNTIME=docker
#>
param(
  [string]$HostName = '127.0.0.1',
  [int]$Port = 8194,
  # Not 5432: majordomo's PostgreSQL runs in WSL, and WSL forwards its ports to localhost.
  [int]$DbPort = $(if ($env:MEMORY_DB_PORT) { [int]$env:MEMORY_DB_PORT } else { 5433 }),
  # Set this to use a database that already exists (Supabase, another machine): no container.
  [string]$DatabaseUrl = $env:MEMORY_DATABASE_URL,
  [string]$Name = 'aiembodied-memory-db',
  [string]$Volume = 'aiembodied-memory-pgdata',
  [string]$Image = 'docker.io/pgvector/pgvector:pg17',
  [ValidateSet('auto', 'wslc', 'docker')]
  [string]$Runtime = $(if ($env:MEMORY_DB_RUNTIME) { $env:MEMORY_DB_RUNTIME } else { 'auto' }),
  [switch]$DatabaseOnly,
  [string]$Venv = $env:MEMORY_VENV
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot

function Start-Database {
  if ($Runtime -eq 'auto') {
    if (Get-Command wslc -ErrorAction SilentlyContinue) { $script:Runtime = 'wslc' }
    elseif (Get-Command docker -ErrorAction SilentlyContinue) { $script:Runtime = 'docker' }
    else { throw 'Neither wslc (WSL 2.9.3+, run "wsl --update") nor Docker is installed.' }
  } elseif (-not (Get-Command $Runtime -ErrorAction SilentlyContinue)) {
    throw "$Runtime is not installed or not on PATH."
  }

  # The database password is made once and kept outside the repo. Hex, so it needs no escaping in a URL.
  $configDir = Join-Path $env:LOCALAPPDATA 'aiembodied\memory'
  New-Item -ItemType Directory -Force -Path $configDir | Out-Null
  $secretFile = Join-Path $configDir 'db-password'
  if (-not (Test-Path $secretFile)) {
    $bytes = New-Object byte[] 24
    [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
    Set-Content -NoNewline -Path $secretFile -Value (($bytes | ForEach-Object { $_.ToString('x2') }) -join '')
  }
  $password = (Get-Content -Raw $secretFile).Trim()

  # Unlike SearXNG, never remove the container first: start the one that exists. The data lives
  # in a named volume either way, so removing it would be safe, but there is no need.
  # Under ErrorActionPreference Stop, a native command's stderr becomes an error, hence the try.
  $started = $false
  try { & $Runtime start $Name *> $null; $started = ($LASTEXITCODE -eq 0) } catch { $started = $false }
  if (-not $started) {
    $envArgs = @('-e', 'POSTGRES_USER=memory', '-e', "POSTGRES_PASSWORD=$password", '-e', 'POSTGRES_DB=memory',
                 '-e', 'PGDATA=/var/lib/postgresql/data/pgdata')
    if ($Runtime -eq 'wslc') {
      # wslc publishes ports on 127.0.0.1 by default.
      wslc run -d --name $Name -p "${DbPort}:5432" -v "${Volume}:/var/lib/postgresql/data" @envArgs $Image | Out-Null
    } else {
      try { docker info *> $null } catch { }
      if ($LASTEXITCODE -ne 0) { throw 'Docker is installed but not running. Start Docker Desktop and try again.' }
      docker run -d --name $Name --restart unless-stopped -p "127.0.0.1:${DbPort}:5432" `
        -v "${Volume}:/var/lib/postgresql/data" @envArgs $Image | Out-Null
    }
    if ($LASTEXITCODE -ne 0) { throw "$Runtime could not start $Name (see '$Runtime logs $Name')." }
  }
  Write-Host "PostgreSQL is starting on 127.0.0.1:$DbPort ($Runtime container $Name, volume $Volume)."
  return "postgresql://memory:${password}@127.0.0.1:${DbPort}/memory"
}

$usingContainer = -not $DatabaseUrl
if ($usingContainer) { $DatabaseUrl = Start-Database }
if ($DatabaseOnly) {
  if ($usingContainer) { Write-Output "MEMORY_TEST_DATABASE_URL=$DatabaseUrl" }
  exit 0
}

if (-not $Venv) { $Venv = Join-Path $root '.venv' }
$python = Join-Path $Venv 'Scripts\python.exe'
# (Re)install when the venv is new or pyproject.toml changed since the last install, so a pull
# that adds a dependency (fastembed in phase 2) just works.
$pyproject = Join-Path $root 'pyproject.toml'
$marker = Join-Path $Venv '.memory-engine-installed'
$stale = (-not (Test-Path $marker)) -or ((Get-Item $pyproject).LastWriteTimeUtc -gt (Get-Item $marker).LastWriteTimeUtc)
if ((-not (Test-Path $python)) -or $stale) {
  if (-not (Get-Command uv -ErrorAction SilentlyContinue)) {
    if (-not (Test-Path $python)) { throw "No Python at $python. Install uv, or create the venv by hand (README), or pass -Venv." }
    Write-Warning 'pyproject.toml changed but uv is not installed; run "pip install -e ." in the venv by hand.'
  } else {
    $ErrorActionPreference = 'Continue'
    if (-not (Test-Path $python)) { Write-Host "Creating $Venv with uv"; uv venv $Venv --python 3.13 }
    uv pip install --python $python -e $root
    $ok = ($LASTEXITCODE -eq 0)
    $ErrorActionPreference = 'Stop'
    if (-not (Test-Path $python)) { throw "Could not create the venv at $Venv." }
    if ($ok) { Set-Content -Path $marker -Value (Get-Date -Format o) }
  }
}

# Passed in the environment, not on the command line, so the password stays out of process lists.
# The engine starts even while the database is still booting, and connects when it is up.
$env:MEMORY_DATABASE_URL = $DatabaseUrl
Write-Host "Starting memory engine on http://${HostName}:$Port (python: $python)"
$ErrorActionPreference = 'Continue'
& $python -m memory_engine serve --host $HostName --port $Port
exit $LASTEXITCODE
