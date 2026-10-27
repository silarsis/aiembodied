<#
.SYNOPSIS
  Start the local speech service (see ..\README.md).

.EXAMPLE
  .\scripts\start.ps1 -KokoroDir C:\Users\kevin\repos\github\silarsis\slopcore\experiments\kokoro
  .\scripts\start.ps1 -KokoroDir <dir> -Stt whisper -WhisperModel large-v3-turbo
  .\scripts\start.ps1 -KokoroDir <dir> -SttUrl http://127.0.0.1:1240/v1 -SttModel my-asr
  .\scripts\start.ps1 -Fake          # no models: canned transcript + a tone
#>
param(
  [string]$HostName = '127.0.0.1',
  [int]$Port = 8192,
  # Folder holding kokoro-v1.0.onnx and voices-v1.0.bin
  [string]$KokoroDir = $env:KOKORO_DIR,
  # server: an OpenAI-compatible STT server (Qwen3-ASR from ..\..\..\scripts\start-local-asr.ps1);
  # whisper: faster-whisper inside this service, on the CPU.
  [ValidateSet('server', 'whisper')] [string]$Stt = $(if ($env:STT_ENGINE) { $env:STT_ENGINE } else { 'server' }),
  [string]$SttUrl = $(if ($env:STT_URL) { $env:STT_URL } else { 'http://127.0.0.1:1235/v1' }),
  [string]$SttModel = $(if ($env:STT_MODEL) { $env:STT_MODEL } else { 'qwen3-asr' }),
  [string]$WhisperModel = $(if ($env:WHISPER_MODEL) { $env:WHISPER_MODEL } else { 'small.en' }),
  [string]$Voice = $(if ($env:KOKORO_VOICE) { $env:KOKORO_VOICE } else { 'bf_lily' }),
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
                '--voice', $Voice, '--stt', $Stt, '--stt-url', $SttUrl, '--stt-model', $SttModel,
                '--whisper-model', $WhisperModel)
}

$env:HF_HUB_DISABLE_SYMLINKS_WARNING = '1'
Write-Host "Starting speech service on http://${HostName}:$Port (stt: $Stt, python: $python)"
# Native stderr (llama.cpp/uvicorn logs) must not become terminating errors under 'Stop'.
$ErrorActionPreference = 'Continue'
& $python @cliArgs
exit $LASTEXITCODE
