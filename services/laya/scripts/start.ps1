<#
.SYNOPSIS
  Start Laya (see ..\README.md), the small quick-decision model: an HTTP API on 127.0.0.1:8197 that the app asks
  "who is this line aimed at?" and "who wants to reply?". The first start downloads the checkpoint from Hugging Face.

.EXAMPLE
  .\scripts\start.ps1                 # http://127.0.0.1:8197, English checkpoint, CPU
  .\scripts\start.ps1 -Port 8200
  $env:LAYA_DEVICE = 'cuda'; .\scripts\start.ps1
  $env:LAYA_MODELS = 'english,multilingual'; .\scripts\start.ps1
#>
param(
  [string]$HostName = '127.0.0.1',
  [int]$Port = 8197,
  [string]$Venv = $env:LAYA_VENV
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot

if (-not $Venv) { $Venv = Join-Path $root '.venv' }
$python = Join-Path $Venv 'Scripts\python.exe'
$layaServe = Join-Path $Venv 'Scripts\laya-serve.exe'
# (Re)install when the venv is new or pyproject.toml changed since the last install.
$pyproject = Join-Path $root 'pyproject.toml'
$marker = Join-Path $Venv '.laya-installed'
$stale = (-not (Test-Path $marker)) -or ((Get-Item $pyproject).LastWriteTimeUtc -gt (Get-Item $marker).LastWriteTimeUtc)
if ((-not (Test-Path $python)) -or $stale) {
  $ErrorActionPreference = 'Continue'
  $haveUv = [bool](Get-Command uv -ErrorAction SilentlyContinue)
  if (-not (Test-Path $python)) {
    Write-Host "Creating $Venv"
    if ($haveUv) { uv venv $Venv --python 3.12 }
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
if (-not (Test-Path $layaServe)) { throw "laya-serve was not installed in $Venv." }

# Local only, CPU unless asked, and the one checkpoint the app uses loaded at start (not on the first request).
$env:LAYA_HOST = $HostName
$env:LAYA_PORT = "$Port"
if (-not $env:LAYA_DEVICE) { $env:LAYA_DEVICE = 'cpu' }
if (-not $env:LAYA_MODELS) { $env:LAYA_MODELS = 'english' }
if (-not $env:LAYA_DEFAULT_MODEL) { $env:LAYA_DEFAULT_MODEL = 'english' }
$env:LAYA_PRELOAD = '1'

# The fine-tuned floor-routing checkpoint (laya-floor-v1) is public on Hugging Face. Fetch it on first start and
# register it with the server. LAYA_FLOOR_REPO=off skips all of this; any failure only costs the floor model
# (the app falls back to the chat model).
$floorRepo = $env:LAYA_FLOOR_REPO
if (-not $floorRepo) { $floorRepo = 'silarsis/laya-floor-v1' }
if ($floorRepo -ne 'off') {
  try {
    $modelsDir = $env:LAYA_MODELS_DIR
    if (-not $modelsDir) {
      # pnpm dev:run points USERPROFILE at .dev-home; models belong in the real home.
      $realHome = $env:AIEMBODIED_HOST_USERPROFILE
      if (-not $realHome) { $realHome = $env:USERPROFILE }
      if (-not $realHome) { $realHome = [Environment]::GetFolderPath('UserProfile') }
      $modelsDir = Join-Path $realHome '.cache\aiembodied\laya-models'
    }
    $floorDir = Join-Path $modelsDir 'laya-floor-v1'
    # A laya-floor-v1 entry already in LAYA_EXTRA_MODELS (a local checkpoint) needs no download.
    $explicit = $env:LAYA_EXTRA_MODELS -and (($env:LAYA_EXTRA_MODELS | ConvertFrom-Json).PSObject.Properties.Name -contains 'laya-floor-v1')
    if ($explicit) {
      $listed = @($env:LAYA_MODELS -split '[,\s]+' | Where-Object { $_ })
      if ($listed -notcontains 'laya-floor-v1') { $env:LAYA_MODELS = (@($listed) + 'laya-floor-v1') -join ',' }
    }
    elseif (-not (Test-Path (Join-Path $floorDir 'model.safetensors'))) {
      Write-Host "Downloading the floor model $floorRepo to $floorDir (about 850 MB, first start only)"
      $ErrorActionPreference = 'Continue'
      & $python -c "import huggingface_hub" 2>$null
      if ($LASTEXITCODE -ne 0) {
        Write-Host 'Installing huggingface_hub'
        if (Get-Command uv -ErrorAction SilentlyContinue) { uv pip install --python $python --quiet huggingface_hub }
        else { & $python -m pip install --quiet huggingface_hub }
      }
      New-Item -ItemType Directory -Force -Path $modelsDir | Out-Null
      & $python -c "import sys; from huggingface_hub import snapshot_download; snapshot_download(repo_id=sys.argv[1], local_dir=sys.argv[2])" $floorRepo $floorDir
      $downloaded = ($LASTEXITCODE -eq 0)
      $ErrorActionPreference = 'Stop'
      if ($downloaded) { Write-Host 'Floor model downloaded.' }
      else { Write-Warning "Could not download $floorRepo; continuing without the floor model (the chat model decides)." }
    }
    $ErrorActionPreference = 'Stop'
    if ((-not $explicit) -and (Test-Path (Join-Path $floorDir 'model.safetensors'))) {
      # Keep any existing LAYA_EXTRA_MODELS entries; an explicit laya-floor-v1 entry wins.
      $extra = [ordered]@{}
      if ($env:LAYA_EXTRA_MODELS) {
        $parsed = $env:LAYA_EXTRA_MODELS | ConvertFrom-Json
        foreach ($prop in $parsed.PSObject.Properties) { $extra[$prop.Name] = $prop.Value }
      }
      if (-not $extra.Contains('laya-floor-v1')) { $extra['laya-floor-v1'] = ($floorDir -replace '\\', '/') }
      $env:LAYA_EXTRA_MODELS = ConvertTo-Json -InputObject $extra -Compress
      $listed = @($env:LAYA_MODELS -split '[,\s]+' | Where-Object { $_ })
      if ($listed -notcontains 'laya-floor-v1') { $env:LAYA_MODELS = (@($listed) + 'laya-floor-v1') -join ',' }
    }
  }
  catch {
    $ErrorActionPreference = 'Stop'
    Write-Warning "Floor model unavailable: $($_.Exception.Message). Continuing without it."
  }
}

Write-Host "Starting laya on http://${HostName}:$Port (device: $($env:LAYA_DEVICE), models: $($env:LAYA_MODELS), venv: $Venv)"
$ErrorActionPreference = 'Continue'
& $layaServe
exit $LASTEXITCODE
