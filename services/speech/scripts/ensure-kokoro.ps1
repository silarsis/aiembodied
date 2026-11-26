<#
.SYNOPSIS
  Make sure Kokoro's two model files (kokoro-v1.0.onnx, voices-v1.0.bin) are in a folder, downloading any that are
  missing or the wrong size from the kokoro-onnx GitHub release. Writes the folder path as its only output.

.DESCRIPTION
  The folder is -Dir, else KOKORO_DIR, else <TTS_MODELS_DIR or %USERPROFILE%\.cache\aiembodied\tts-models>\kokoro.
  pnpm dev:run points USERPROFILE at .dev-home, so the real home (AIEMBODIED_HOST_USERPROFILE) is used for the
  default. A file is downloaded to <name>.partial, checked (size, and SHA-256 when one is pinned below) and only
  then moved into place, so an interrupted download never leaves a broken model behind.

.EXAMPLE
  .\scripts\ensure-kokoro.ps1                        # the default cache folder
  .\scripts\ensure-kokoro.ps1 -Dir D:\models\kokoro
#>
param(
  [string]$Dir = $env:KOKORO_DIR,
  [string]$BaseUrl = 'https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/',
  # Tests only: the expected files, as JSON ([{"name","size","sha256"}]).
  [string]$FilesJson
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'  # Windows PowerShell 5.1 downloads many times slower with the progress bar

# Sizes from the GitHub release (model-files-v1.0), which publishes no digests. The SHA-256 values were taken from
# the downloaded files and match the copies in the Hugging Face repo fastrtc/kokoro-onnx (its LFS ids).
$files = @(
  @{ name = 'kokoro-v1.0.onnx'; size = 325532387; sha256 = '7d5df8ecf7d4b1878015a32686053fd0eebe2bc377234608764cc0ef3636a6c5' },
  @{ name = 'voices-v1.0.bin'; size = 28214398; sha256 = 'bca610b8308e8d99f32e6fe4197e7ec01679264efed0cac9140fe9c29f1fbf7d' }
)
if ($FilesJson) {
  # Windows PowerShell 5.1 passes a JSON array down the pipe as one object; enumerate it from a variable.
  $parsed = $FilesJson | ConvertFrom-Json
  $files = @($parsed | ForEach-Object { @{ name = $_.name; size = [long]$_.size; sha256 = $_.sha256 } })
}

if (-not $Dir) {
  $models = $env:TTS_MODELS_DIR
  if (-not $models) {
    $realHome = $env:AIEMBODIED_HOST_USERPROFILE
    if (-not $realHome) { $realHome = $env:USERPROFILE }
    if (-not $realHome) { $realHome = [Environment]::GetFolderPath('UserProfile') }
    $models = Join-Path $realHome '.cache\aiembodied\tts-models'
  }
  $Dir = Join-Path $models 'kokoro'
}
New-Item -ItemType Directory -Force -Path $Dir | Out-Null

foreach ($file in $files) {
  $path = Join-Path $Dir $file.name
  if ((Test-Path $path) -and ((Get-Item $path).Length -eq $file.size)) { continue }
  $partial = "$path.partial"
  Remove-Item -Force -ErrorAction SilentlyContinue $partial
  Write-Host "Downloading $($file.name) ($([math]::Round($file.size / 1MB)) MB) into $Dir"
  Invoke-WebRequest -Uri "$BaseUrl$($file.name)" -OutFile $partial -UseBasicParsing
  $got = (Get-Item $partial).Length
  if ($got -ne $file.size) {
    Remove-Item -Force $partial
    throw "$($file.name): expected $($file.size) bytes, got $got. Not installing it."
  }
  if ($file.sha256) {
    $actual = (Get-FileHash -Algorithm SHA256 -Path $partial).Hash.ToLower()
    if ($actual -ne $file.sha256.ToLower()) {
      Remove-Item -Force $partial
      throw "$($file.name): SHA-256 mismatch (expected $($file.sha256), got $actual). Not installing it."
    }
  }
  Move-Item -Force -Path $partial -Destination $path
}

Write-Output $Dir
