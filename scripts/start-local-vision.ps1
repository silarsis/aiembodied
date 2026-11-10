<#
.SYNOPSIS
  Start llama-server with a small vision model (Qwen3-VL) for "Describe the avatar" and Check poses.

.DESCRIPTION
  The app starts this on demand (app/main/src/local-vision/vision-server.ts) when a job is routed to
  the "Vision model on this PC" server, and stops it after ten idle minutes. It is not started by
  pnpm dev:run. The model and its vision projector (mmproj) are downloaded in the app under
  Models and servers -> Describe the avatar; the app passes their paths as -Model and -Mmproj.
  The app reaches it at http://127.0.0.1:1237/v1 and asks for the model `qwen3-vl` (the --alias).
  llama-server comes from -LlamaServer, LLAMA_SERVER_EXE or the Unsloth build folder.

.EXAMPLE
  .\scripts\start-local-vision.ps1 -Model C:\...\Qwen3-VL-8B-Instruct-Q4_K_M.gguf -Mmproj C:\...\mmproj-F16.gguf
#>
param(
  [string]$LlamaServer = $(if ($env:LLAMA_SERVER_EXE) { $env:LLAMA_SERVER_EXE } else {
    Join-Path $env:USERPROFILE '.unsloth\llama.cpp\build\bin\Release\llama-server.exe' }),
  [string]$Model = $env:LOCAL_VISION_GGUF,
  [string]$Mmproj = $env:LOCAL_VISION_MMPROJ,
  [string]$Alias = 'qwen3-vl',
  [int]$Port = 1237,
  # An avatar screenshot is a few hundred image tokens plus a short prompt and reply.
  [int]$Context = 8192,
  [string]$Device = 'Vulkan0'
)
$ErrorActionPreference = 'Stop'
if (-not (Test-Path $LlamaServer)) { throw "llama-server not found at $LlamaServer. Pass -LlamaServer or set LLAMA_SERVER_EXE." }
if (-not $Model -or -not (Test-Path $Model)) { throw 'Vision model GGUF not found. Download it in the app (Models and servers -> Describe the avatar), or pass -Model or set LOCAL_VISION_GGUF.' }
if (-not $Mmproj -or -not (Test-Path $Mmproj)) { throw 'Vision projector (mmproj GGUF) not found. Download the vision model in the app, or pass -Mmproj or set LOCAL_VISION_MMPROJ.' }

$cliArgs = @('-m', $Model, '--mmproj', $Mmproj, '--port', $Port, '--host', '127.0.0.1', '--alias', $Alias,
             '-c', $Context, '--parallel', '1', '-ngl', '-1', '--jinja', '--device', $Device)
Write-Host "Starting llama-server ($Alias, vision) on http://127.0.0.1:$Port/v1"
# Native stderr (llama.cpp logs) must not become terminating errors under 'Stop'.
$ErrorActionPreference = 'Continue'
& $LlamaServer @cliArgs
exit $LASTEXITCODE
