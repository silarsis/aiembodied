<#
.SYNOPSIS
  Start the local motion service (see ..\README.md).

.EXAMPLE
  .\scripts\start.ps1                       # ARDY on 127.0.0.1:8190
  .\scripts\start.ps1 -Backend kimodo -Port 8191 -TextEncoderDevice cpu
#>
param(
  [ValidateSet('ardy', 'kimodo')] [string]$Backend = 'ardy',
  [string]$HostName = '127.0.0.1',
  [int]$Port = 8190,
  [ValidateSet('gpu', 'cpu')] [string]$TextEncoderDevice = 'gpu',
  # Folder holding McGill-NLP\LLM2Vec-Meta-Llama-3-8B-Instruct-mntp(-supervised); see README "Text encoder".
  [string]$TextEncodersDir = $env:TEXT_ENCODERS_DIR,
  # venv with torch + kimodo/ardy + this package; defaults to services\motion\.venv-<backend>
  [string]$Venv = $env:MOTION_VENV
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
if (-not $Venv) { $Venv = Join-Path $root ".venv-$Backend" }
$python = Join-Path $Venv 'Scripts\python.exe'
if (-not (Test-Path $python)) { throw "No Python at $python. Create the venv (README) or pass -Venv." }

$cliArgs = @('-m', 'motion_service', '--backend', $Backend, '--host', $HostName, '--port', $Port,
             '--text-encoder-device', $TextEncoderDevice)
if ($TextEncodersDir) { $cliArgs += @('--text-encoders-dir', $TextEncodersDir) }

$env:HF_HUB_DISABLE_SYMLINKS_WARNING = '1'
Write-Host "Starting $Backend motion service on http://${HostName}:$Port (python: $python)"
& $python @cliArgs
exit $LASTEXITCODE
