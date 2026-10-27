<#
.SYNOPSIS
  Make sure every local model service the app uses is running, starting any that are down.

.DESCRIPTION
  Checks each service's health URL and starts the missing ones, each in its own PowerShell
  window so its log stays visible and closing the window stops it:

    llm     Qwen Flash-Next on llama-server, :1234      scripts\start-local-llm.ps1
    asr     Qwen3-ASR on llama-server, :1235            scripts\start-local-asr.ps1
    speech  speech service (STT + Kokoro TTS), :8192    services\speech\scripts\start.ps1
    motion  motion service (ARDY), :8190                services\motion\scripts\start.ps1

  Services already running (for example a llama-server slopcore started) are left alone.
  Settings come from the same environment variables the individual scripts read
  (LLAMA_SERVER_EXE, LOCAL_LLM_GGUF, KOKORO_DIR, TEXT_ENCODERS_DIR, ...), loaded from the
  repo's .env when present. `pnpm dev:run` runs this with -NoWait before starting the app.

.EXAMPLE
  .\scripts\start-local-stack.ps1                 # start what's missing, wait until all are ready
  .\scripts\start-local-stack.ps1 -Skip motion    # everything but the motion service
  .\scripts\start-local-stack.ps1 -NoWait         # start what's missing and return
#>
param(
  [ValidateSet('llm', 'asr', 'speech', 'motion')] [string[]]$Skip = @(),
  [switch]$NoWait,
  [int]$TimeoutSeconds = 300,
  # Motion: keep the 8B text encoder off the GPU (~16 GB) so it fits next to Qwen; costs ~0.5 s per move.
  [ValidateSet('gpu', 'cpu')] [string]$MotionTextEncoderDevice = $(if ($env:MOTION_TEXT_ENCODER_DEVICE) {
    $env:MOTION_TEXT_ENCODER_DEVICE } else { 'cpu' })
)
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot

# Pick up the repo's .env for settings the child scripts read; real environment variables win.
$dotEnv = Join-Path $repo '.env'
if (Test-Path $dotEnv) {
  foreach ($line in Get-Content $dotEnv) {
    if ($line -match '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$' -and -not $line.TrimStart().StartsWith('#')) {
      $value = $Matches[2].Trim('"').Trim("'")
      if (-not [Environment]::GetEnvironmentVariable($Matches[1])) { Set-Item -Path "env:$($Matches[1])" -Value $value }
    }
  }
}
if (-not $env:KOKORO_DIR) {
  # slopcore keeps the Kokoro model files here; reuse them rather than downloading another copy.
  $slopcoreKokoro = Join-Path (Split-Path -Parent $repo) 'slopcore\experiments\kokoro'
  if (Test-Path (Join-Path $slopcoreKokoro 'kokoro-v1.0.onnx')) { $env:KOKORO_DIR = $slopcoreKokoro }
}

function Get-Origin([string]$url, [string]$fallback) {
  if (-not $url) { return $fallback }
  $uri = [Uri]$url
  return "$($uri.Scheme)://$($uri.Authority)"
}
$llmOrigin = Get-Origin $env:LOCAL_LLM_BASE_URL 'http://127.0.0.1:1234'
$asrOrigin = Get-Origin $env:STT_URL 'http://127.0.0.1:1235'
$speechOrigin = Get-Origin $env:SPEECH_SERVICE_URL 'http://127.0.0.1:8192'
$motionOrigin = Get-Origin $env:MOTION_SERVICE_URL 'http://127.0.0.1:8190'

$motionArgs = @('-TextEncoderDevice', $MotionTextEncoderDevice)
if ($env:TEXT_ENCODERS_DIR) { $motionArgs += @('-TextEncodersDir', $env:TEXT_ENCODERS_DIR) }

$services = @(
  @{ Name = 'llm'; Health = "$llmOrigin/v1/models"; Script = 'scripts\start-local-llm.ps1'; Args = @() },
  @{ Name = 'asr'; Health = "$asrOrigin/v1/models"; Script = 'scripts\start-local-asr.ps1'; Args = @() },
  @{ Name = 'speech'; Health = "$speechOrigin/health"; Script = 'services\speech\scripts\start.ps1'; Args = @() },
  @{ Name = 'motion'; Health = "$motionOrigin/health"; Script = 'services\motion\scripts\start.ps1'; Args = $motionArgs }
)
# Whisper runs inside the speech service, so there's no ASR server to start.
if ($env:STT_ENGINE -eq 'whisper') { $Skip += 'asr' }

# 'up' = answering; 'ready' = answering and, for services with a /health ready flag, loaded.
function Get-ServiceState($service) {
  try {
    $response = Invoke-WebRequest -Uri $service.Health -UseBasicParsing -TimeoutSec 2
    if ($service.Health.EndsWith('/health')) {
      $body = $response.Content | ConvertFrom-Json
      if ($body.PSObject.Properties.Name -contains 'ready' -and -not $body.ready) { return 'up' }
    }
    return 'ready'
  } catch {
    return 'down'
  }
}

$wanted = $services | Where-Object { $Skip -notcontains $_.Name }
foreach ($service in $wanted) {
  $state = Get-ServiceState $service
  if ($state -ne 'down') {
    Write-Host ("{0,-7} already running ({1})" -f $service.Name, $service.Health)
    continue
  }
  $script = Join-Path $repo $service.Script
  Write-Host ("{0,-7} starting: {1} {2}" -f $service.Name, $service.Script, ($service.Args -join ' '))
  $argList = @('-NoExit', '-File', "`"$script`"") + $service.Args
  Start-Process -FilePath 'powershell.exe' -ArgumentList $argList -WorkingDirectory (Split-Path -Parent $script) `
    -WindowStyle Minimized | Out-Null
}

if ($NoWait) {
  Write-Host 'Not waiting for the services to finish loading; the app picks them up as they come ready.'
  exit 0
}

# Qwen and the motion model take a while to load (Qwen ~1-2 min, motion 30-90 s).
$deadline = (Get-Date).AddSeconds($TimeoutSeconds)
$pending = @($wanted)
while ($pending.Count -gt 0 -and (Get-Date) -lt $deadline) {
  Start-Sleep -Seconds 3
  $pending = @($pending | Where-Object { (Get-ServiceState $_) -ne 'ready' })
}
foreach ($service in $wanted) {
  Write-Host ("{0,-7} {1}" -f $service.Name, (Get-ServiceState $service))
}
if ($pending.Count -gt 0) {
  Write-Warning ("Not ready after {0}s: {1}. Check their windows for errors." -f $TimeoutSeconds, (($pending | ForEach-Object { $_.Name }) -join ', '))
  exit 1
}
Write-Host 'All local services are ready.'
