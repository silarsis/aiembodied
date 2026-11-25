<#
.SYNOPSIS
  Start the workflows service (see ..\README.md): Temporal workflows that give the avatars a sense of time, with an
  HTTP API on 127.0.0.1:8198. It needs the Temporal server (..\..\temporal\scripts\start.ps1) and degrades
  gracefully while that is not running.

.EXAMPLE
  .\scripts\start.ps1                 # http://127.0.0.1:8198
  .\scripts\start.ps1 -Port 8200
  $env:AGENT_LIFE = '0'; .\scripts\start.ps1
#>
param(
  [string]$HostName = '127.0.0.1',
  [int]$Port = 8198,
  [string]$Venv = $env:WORKFLOWS_VENV
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot

if (-not $Venv) { $Venv = Join-Path $root '.venv' }
$python = Join-Path $Venv 'Scripts\python.exe'
# (Re)install when the venv is new or pyproject.toml changed since the last install.
$pyproject = Join-Path $root 'pyproject.toml'
$marker = Join-Path $Venv '.workflows-installed'
$stale = (-not (Test-Path $marker)) -or ((Get-Item $pyproject).LastWriteTimeUtc -gt (Get-Item $marker).LastWriteTimeUtc)
if ((-not (Test-Path $python)) -or $stale) {
  $ErrorActionPreference = 'Continue'
  $haveUv = [bool](Get-Command uv -ErrorAction SilentlyContinue)
  if (-not (Test-Path $python)) {
    Write-Host "Creating $Venv"
    if ($haveUv) { uv venv $Venv --python 3.13 }
    elseif (Get-Command py -ErrorAction SilentlyContinue) { py -3 -m venv $Venv }
    else { python -m venv $Venv }
  }
  if (-not (Test-Path $python)) { throw "Could not create the venv at $Venv." }
  # A venv made by uv has no pip, so install with uv whenever it is available.
  if ($haveUv) { uv pip install --python $python --quiet -e $root }
  else { & $python -m pip install --quiet -e $root }
  $ok = ($LASTEXITCODE -eq 0)
  $ErrorActionPreference = 'Stop'
  if (-not $ok) { throw 'pip install failed.' }
  Set-Content -Path $marker -Value (Get-Date -Format o)
}

Write-Host "Starting workflows on http://${HostName}:$Port (python: $python)"
$ErrorActionPreference = 'Continue'
& $python -m aiembodied_workflows serve --host $HostName --port $Port
exit $LASTEXITCODE
