<#
.SYNOPSIS
  Start llama-server with Qwen Flash-Next for the local conversation backend.

.DESCRIPTION
  Same server and flags slopcore uses (its `llama` service), so either project can start it and
  the other will find it on the same port. The app reaches it through LOCAL_LLM_BASE_URL
  (default http://127.0.0.1:1234/v1) and asks for LOCAL_LLM_MODEL (default qwen-next-flash,
  the --alias below). It needs ~92 GB, so stop ComfyUI first if it holds Qwen-Image.
  -Slots (or LOCAL_LLM_SLOTS, default 2, 1 to 8) is how many conversations it serves at once, one
  slot per avatar so each keeps its own prompt cache. -Context (or LOCAL_LLM_CONTEXT, default
  65536) is the context PER SLOT; llama-server's own -c is the total, so it is given Context x Slots.
  Two slots of 64K reserve 128K tokens of context in all. A larger model may want fewer or smaller.
  A model downloaded from Hugging Face in the app (Models and servers -> Thinking) is passed in as
  -Model and -Alias by the app and by pnpm dev:run.
  -Device (default LLAMA_DEVICE, else Vulkan0) is the llama.cpp device: Vulkan0 or CUDA0.
  scripts/install-windows.ps1 sets LLAMA_DEVICE in .env to match the llama.cpp build it installs.

.EXAMPLE
  .\scripts\start-local-llm.ps1 -LlamaServer C:\...\llama-server.exe -Model C:\...\model-00001-of-00002.gguf
#>
param(
  [string]$LlamaServer = $(if ($env:LLAMA_SERVER_EXE) { $env:LLAMA_SERVER_EXE } else {
    Join-Path $env:USERPROFILE '.unsloth\llama.cpp\build\bin\Release\llama-server.exe' }),
  [string]$Model = $env:LOCAL_LLM_GGUF,
  [string]$Alias = 'qwen-next-flash',
  [int]$Port = 1234,
  # Conversations at once; each slot keeps its own prompt cache.
  [int]$Slots = $(if ($env:LOCAL_LLM_SLOTS) { [int]$env:LOCAL_LLM_SLOTS } else { 2 }),
  # Context per slot. 64K costs only ~1.5 GB more commit than 16K: the ~86 GB is almost all weights.
  [int]$Context = $(if ($env:LOCAL_LLM_CONTEXT) { [int]$env:LOCAL_LLM_CONTEXT } else { 65536 }),
  [string]$Device = $(if ($env:LLAMA_DEVICE) { $env:LLAMA_DEVICE } else { 'Vulkan0' })
)
$ErrorActionPreference = 'Stop'
if (-not (Test-Path $LlamaServer)) { throw "llama-server not found at $LlamaServer. Pass -LlamaServer or set LLAMA_SERVER_EXE." }
if (-not $Model) {
  # The Qwen3.8 Flash-Next GGUF slopcore uses, if it is in the Hugging Face cache.
  $Model = Get-ChildItem (Join-Path $env:USERPROFILE '.cache\huggingface\hub\models--orcarouter--Qwen3.8-Flash-Next-Uncensored-GGUF') `
    -Recurse -Filter '*-00001-of-*.gguf' -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty FullName
}
if (-not $Model -or -not (Test-Path $Model)) { throw 'Model GGUF not found. Pass -Model or set LOCAL_LLM_GGUF.' }

$Slots = [Math]::Min(8, [Math]::Max(1, $Slots))
$TotalContext = $Context * $Slots
$cliArgs = @('-m', $Model, '--port', $Port, '--host', '127.0.0.1', '--alias', $Alias,
             '-c', $TotalContext, '--parallel', $Slots, '--flash-attn', 'on', '--no-context-shift',
             '-ngl', '-1', '--jinja', '--device', $Device)
Write-Host "Starting llama-server ($Alias) on http://127.0.0.1:$Port/v1 with $Slots slot(s) of $Context tokens of context each ($TotalContext in all)"
# Native stderr (llama.cpp/uvicorn logs) must not become terminating errors under 'Stop'.
$ErrorActionPreference = 'Continue'
& $LlamaServer @cliArgs
exit $LASTEXITCODE
