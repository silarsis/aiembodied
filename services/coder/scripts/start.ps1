<#
.SYNOPSIS
  Start the coding runner (see ..\README.md): an HTTP API on 127.0.0.1:8195 that runs the pi coding
  agent on tasks, each in its own git worktree.

.EXAMPLE
  .\scripts\start.ps1                 # http://127.0.0.1:8195
  .\scripts\start.ps1 -Port 8200
  $env:CODER_PI_COMMAND = 'pi'; .\scripts\start.ps1
#>
param(
  [string]$HostName = '127.0.0.1',
  [int]$Port = 8195,
  [string]$Venv = $env:CODER_VENV
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot

if (-not $Venv) { $Venv = Join-Path $root '.venv' }
$python = Join-Path $Venv 'Scripts\python.exe'
# (Re)install when the venv is new or pyproject.toml changed since the last install.
$pyproject = Join-Path $root 'pyproject.toml'
$marker = Join-Path $Venv '.coding-runner-installed'
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

if (-not (Get-Command git -ErrorAction SilentlyContinue)) { Write-Warning 'git is not on PATH; the runner needs it.' }
$piCommand = if ($env:CODER_PI_COMMAND) { $env:CODER_PI_COMMAND } else { 'pi' }
if (-not (Get-Command ($piCommand -split ' ')[0] -ErrorAction SilentlyContinue)) {
  Write-Warning "Cannot find '$piCommand'. Install it with: npm install -g @earendil-works/pi-coding-agent"
}

Write-Host "Starting coding runner on http://${HostName}:$Port (python: $python)"
$ErrorActionPreference = 'Continue'
& $python -m coder --host $HostName --port $Port
exit $LASTEXITCODE
