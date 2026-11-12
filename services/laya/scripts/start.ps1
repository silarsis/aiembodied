<#
.SYNOPSIS
  Start Laya (see ..\README.md), the small quick-decision model: an HTTP API on 127.0.0.1:8197 that the app asks
  "who is this line aimed at?" and "who wants to reply?". The first start downloads the checkpoint from Hugging Face.

.EXAMPLE
  .\scripts\start.ps1                 # http://127.0.0.1:8197, English checkpoint, CPU
  .\scripts\start.ps1 -Port 8200
  $env:LAYA_DEVICE = 'cuda'; .\scripts\start.ps1
  $env:LAYA_MODELS = 'english,multilingual'; .\scripts\start.ps1
#>
param(
  [string]$HostName = '127.0.0.1',
  [int]$Port = 8197,
  [string]$Venv = $env:LAYA_VENV
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot

if (-not $Venv) { $Venv = Join-Path $root '.venv' }
$python = Join-Path $Venv 'Scripts\python.exe'
$layaServe = Join-Path $Venv 'Scripts\laya-serve.exe'
# (Re)install when the venv is new or pyproject.toml changed since the last install.
$pyproject = Join-Path $root 'pyproject.toml'
$marker = Join-Path $Venv '.laya-installed'
$stale = (-not (Test-Path $marker)) -or ((Get-Item $pyproject).LastWriteTimeUtc -gt (Get-Item $marker).LastWriteTimeUtc)
if ((-not (Test-Path $python)) -or $stale) {
  $ErrorActionPreference = 'Continue'
  $haveUv = [bool](Get-Command uv -ErrorAction SilentlyContinue)
  if (-not (Test-Path $python)) {
    Write-Host "Creating $Venv"
    if ($haveUv) { uv venv $Venv --python 3.12 }
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
if (-not (Test-Path $layaServe)) { throw "laya-serve was not installed in $Venv." }

# Local only, CPU unless asked, and the one checkpoint the app uses loaded at start (not on the first request).
$env:LAYA_HOST = $HostName
$env:LAYA_PORT = "$Port"
if (-not $env:LAYA_DEVICE) { $env:LAYA_DEVICE = 'cpu' }
if (-not $env:LAYA_MODELS) { $env:LAYA_MODELS = 'english' }
if (-not $env:LAYA_DEFAULT_MODEL) { $env:LAYA_DEFAULT_MODEL = 'english' }
$env:LAYA_PRELOAD = '1'

Write-Host "Starting laya on http://${HostName}:$Port (device: $($env:LAYA_DEVICE), models: $($env:LAYA_MODELS), venv: $Venv)"
$ErrorActionPreference = 'Continue'
& $layaServe
exit $LASTEXITCODE
