<#
.SYNOPSIS
  Start the local voice service (speech-to-text + text-to-speech, see ..\README.md).
  First run creates services\voice\.venv and downloads the Kokoro model files (~350 MB);
  faster-whisper fetches its model from Hugging Face on first load.

.EXAMPLE
  .\scripts\start.ps1                          # 127.0.0.1:8191, whisper small.en, voice af_heart
  .\scripts\start.ps1 -SttModel base.en -Voice bf_emma
#>
param(
  [string]$HostName = '127.0.0.1',
  [int]$Port = 8191,
  [string]$SttModel = $(if ($env:STT_MODEL) { $env:STT_MODEL } else { 'small.en' }),
  [string]$Voice = $(if ($env:TTS_VOICE) { $env:TTS_VOICE } else { 'af_heart' }),
  [string]$Venv = $env:VOICE_VENV
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
if (-not $Venv) { $Venv = Join-Path $root '.venv' }
$python = Join-Path $Venv 'Scripts\python.exe'

if (-not (Test-Path $python)) {
  Write-Host "Creating $Venv"
  python -m venv $Venv
  & $python -m pip install --upgrade pip
  & $python -m pip install -e "$root[local]"
}

$models = Join-Path $root 'models'
New-Item -ItemType Directory -Force -Path $models | Out-Null
$release = 'https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0'
foreach ($file in 'kokoro-v1.0.onnx', 'voices-v1.0.bin') {
  $target = Join-Path $models $file
  if (-not (Test-Path $target)) {
    Write-Host "Downloading $file"
    Invoke-WebRequest -Uri "$release/$file" -OutFile $target
  }
}

$env:HF_HUB_DISABLE_SYMLINKS_WARNING = '1'
Write-Host "Starting voice service on http://${HostName}:$Port (python: $python)"
& $python -m voice_service --backend local --host $HostName --port $Port --stt-model $SttModel --voice $Voice `
  --kokoro-model (Join-Path $models 'kokoro-v1.0.onnx') --kokoro-voices (Join-Path $models 'voices-v1.0.bin')
exit $LASTEXITCODE
