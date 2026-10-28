<#
.SYNOPSIS
  Start llama-server with Qwen Flash-Next for the local conversation backend.

.DESCRIPTION
  Same server and flags slopcore uses (its `llama` service), so either project can start it and
  the other will find it on the same port. The app reaches it through LOCAL_LLM_BASE_URL
  (default http://127.0.0.1:1234/v1) and asks for LOCAL_LLM_MODEL (default qwen-next-flash,
  the --alias below). It needs ~92 GB, so stop ComfyUI first if it holds Qwen-Image.
  The context size comes from -Context or LOCAL_LLM_CONTEXT (default 65536).

.EXAMPLE
  .\scripts\start-local-llm.ps1 -LlamaServer C:\...\llama-server.exe -Model C:\...\model-00001-of-00002.gguf
#>
param(
  [string]$LlamaServer = $(if ($env:LLAMA_SERVER_EXE) { $env:LLAMA_SERVER_EXE } else {
    Join-Path $env:USERPROFILE '.unsloth\llama.cpp\build\bin\Release\llama-server.exe' }),
  [string]$Model = $env:LOCAL_LLM_GGUF,
  [string]$Alias = 'qwen-next-flash',
  [int]$Port = 1234,
  # 64K costs only ~1.5 GB more commit than 16K: the ~86 GB is almost all weights.
  [int]$Context = $(if ($env:LOCAL_LLM_CONTEXT) { [int]$env:LOCAL_LLM_CONTEXT } else { 65536 }),
  [string]$Device = 'Vulkan0'
)
$ErrorActionPreference = 'Stop'
if (-not (Test-Path $LlamaServer)) { throw "llama-server not found at $LlamaServer. Pass -LlamaServer or set LLAMA_SERVER_EXE." }
if (-not $Model) {
  # The Qwen3.8 Flash-Next GGUF slopcore uses, if it is in the Hugging Face cache.
  $Model = Get-ChildItem (Join-Path $env:USERPROFILE '.cache\huggingface\hub\models--orcarouter--Qwen3.8-Flash-Next-Uncensored-GGUF') `
    -Recurse -Filter '*-00001-of-*.gguf' -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty FullName
}
if (-not $Model -or -not (Test-Path $Model)) { throw 'Model GGUF not found. Pass -Model or set LOCAL_LLM_GGUF.' }

$cliArgs = @('-m', $Model, '--port', $Port, '--host', '127.0.0.1', '--alias', $Alias,
             '-c', $Context, '--parallel', '1', '--flash-attn', 'on', '--no-context-shift',
             '-ngl', '-1', '--jinja', '--device', $Device)
Write-Host "Starting llama-server ($Alias) on http://127.0.0.1:$Port/v1"
# Native stderr (llama.cpp/uvicorn logs) must not become terminating errors under 'Stop'.
$ErrorActionPreference = 'Continue'
& $LlamaServer @cliArgs
exit $LASTEXITCODE
