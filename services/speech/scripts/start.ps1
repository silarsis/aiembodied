<#
.SYNOPSIS
  Start the local speech service (see ..\README.md).

.EXAMPLE
  .\scripts\start.ps1 -KokoroDir C:\Users\kevin\repos\github\silarsis\slopcore\experiments\kokoro
  .\scripts\start.ps1 -WhisperModel large-v3-turbo -Voice am_michael
  .\scripts\start.ps1 -Fake          # no models: canned transcript + a tone
#>
param(
  [string]$HostName = '127.0.0.1',
  [int]$Port = 8192,
  # Folder holding kokoro-v1.0.onnx and voices-v1.0.bin
  [string]$KokoroDir = $env:KOKORO_DIR,
  [string]$WhisperModel = $(if ($env:WHISPER_MODEL) { $env:WHISPER_MODEL } else { 'small.en' }),
  [string]$Voice = $(if ($env:KOKORO_VOICE) { $env:KOKORO_VOICE } else { 'bm_george' }),
  [switch]$Fake,
  [string]$Venv = $env:SPEECH_VENV
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
if (-not $Venv) { $Venv = Join-Path $root '.venv' }
$python = Join-Path $Venv 'Scripts\python.exe'
if (-not (Test-Path $python)) { throw "No Python at $python. Create the venv (README) or pass -Venv." }

$cliArgs = @('-m', 'speech_service', '--host', $HostName, '--port', $Port)
if ($Fake) {
  $cliArgs += @('--engines', 'fake')
} else {
  if (-not $KokoroDir) { throw 'Pass -KokoroDir (or set KOKORO_DIR) to the folder with kokoro-v1.0.onnx and voices-v1.0.bin.' }
  $cliArgs += @('--kokoro-model', (Join-Path $KokoroDir 'kokoro-v1.0.onnx'),
                '--kokoro-voices', (Join-Path $KokoroDir 'voices-v1.0.bin'),
                '--whisper-model', $WhisperModel, '--voice', $Voice)
}

$env:HF_HUB_DISABLE_SYMLINKS_WARNING = '1'
Write-Host "Starting speech service on http://${HostName}:$Port (python: $python)"
# Native stderr (llama.cpp/uvicorn logs) must not become terminating errors under 'Stop'.
$ErrorActionPreference = 'Continue'
& $python @cliArgs
exit $LASTEXITCODE
