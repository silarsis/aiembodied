<#
.SYNOPSIS
  Start llama-server with Qwen3-ASR-0.6B for the speech service's speech-to-text.

.DESCRIPTION
  A second llama-server, separate from the LLM's (scripts/start-local-llm.ps1), so each can be
  moved or swapped on its own. The speech service reaches it through STT_URL (default
  http://127.0.0.1:1235/v1) and asks for STT_MODEL (default qwen3-asr, the --alias below).
  It needs ~1 GB and runs alongside Qwen Flash-Next without slowing it.

.EXAMPLE
  .\scripts\start-local-asr.ps1
  .\scripts\start-local-asr.ps1 -Model C:\...\Qwen3-ASR-0.6B-Q8_0.gguf -Mmproj C:\...\mmproj-Qwen3-ASR-0.6B-Q8_0.gguf
#>
param(
  [string]$LlamaServer = $(if ($env:LLAMA_SERVER_EXE) { $env:LLAMA_SERVER_EXE } else {
    Join-Path $env:USERPROFILE '.unsloth\llama.cpp\build\bin\Release\llama-server.exe' }),
  [string]$Model = $env:LOCAL_ASR_GGUF,
  [string]$Mmproj = $env:LOCAL_ASR_MMPROJ,
  [string]$Alias = 'qwen3-asr',
  [int]$Port = 1235,
  [string]$Device = 'Vulkan0'
)
$ErrorActionPreference = 'Stop'
if (-not (Test-Path $LlamaServer)) { throw "llama-server not found at $LlamaServer. Pass -LlamaServer or set LLAMA_SERVER_EXE." }
# Defaults: unsloth's Qwen3-ASR-0.6B GGUF in the Hugging Face cache
# (huggingface-cli download unslothai/Qwen3-ASR-0.6B-GGUF).
$cache = Join-Path $env:USERPROFILE '.cache\huggingface\hub\models--unslothai--Qwen3-ASR-0.6B-GGUF'
if (-not $Model) {
  $Model = Get-ChildItem $cache -Recurse -Filter 'Qwen3-ASR-*.gguf' -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -notlike 'mmproj*' } | Select-Object -First 1 -ExpandProperty FullName
}
if (-not $Mmproj) {
  $Mmproj = Get-ChildItem $cache -Recurse -Filter 'mmproj-*.gguf' -ErrorAction SilentlyContinue |
    Select-Object -First 1 -ExpandProperty FullName
}
if (-not $Model -or -not (Test-Path $Model)) { throw 'ASR model GGUF not found. Pass -Model or set LOCAL_ASR_GGUF.' }
if (-not $Mmproj -or -not (Test-Path $Mmproj)) { throw 'ASR mmproj (audio encoder) not found. Pass -Mmproj or set LOCAL_ASR_MMPROJ.' }

$cliArgs = @('-m', $Model, '--mmproj', $Mmproj, '--port', $Port, '--host', '127.0.0.1', '--alias', $Alias,
             '-c', '4096', '--parallel', '1', '-ngl', '-1', '--device', $Device)
Write-Host "Starting llama-server ($Alias) on http://127.0.0.1:$Port/v1"
# Native stderr (llama.cpp logs) must not become terminating errors under 'Stop'.
$ErrorActionPreference = 'Continue'
& $LlamaServer @cliArgs
exit $LASTEXITCODE
