<#
.SYNOPSIS
  Start the Temporal dev server (see ..\README.md) on 127.0.0.1 with a SQLite file, in the foreground. Finds
  temporal.exe, or downloads the pinned CLI release and checks its SHA-256 first.

.EXAMPLE
  .\scripts\start.ps1                           # gRPC 127.0.0.1:7233, UI http://127.0.0.1:8233
  .\scripts\start.ps1 -Port 7300 -UiPort 8300
  $env:TEMPORAL_EXE = 'D:\tools\temporal.exe'; .\scripts\start.ps1
  $env:TEMPORAL_DB = 'D:\temporal.db'; .\scripts\start.ps1
#>
param(
  [int]$Port = 7233,
  [int]$UiPort = 8233,
  [string]$DbFile = $(if ($env:TEMPORAL_DB) { $env:TEMPORAL_DB } else { Join-Path $env:LOCALAPPDATA 'aiembodied\temporal\temporal.db' })
)
$ErrorActionPreference = 'Stop'

$CliVersion = '1.10.1'
$Base = "https://github.com/temporalio/cli/releases/download/v$CliVersion"
$Archive = "temporal_cli_${CliVersion}_windows_amd64.zip"

$exe = $env:TEMPORAL_EXE
if (-not $exe) { $exe = Join-Path $env:LOCALAPPDATA 'aiembodied\bin\temporal.exe' }

if (-not (Test-Path $exe)) {
  $dir = Split-Path -Parent $exe
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  $tmp = Join-Path ([System.IO.Path]::GetTempPath()) "temporal-cli-$([guid]::NewGuid().ToString('N'))"
  New-Item -ItemType Directory -Force -Path $tmp | Out-Null
  try {
    $zip = Join-Path $tmp $Archive
    Write-Host "Downloading Temporal CLI v$CliVersion"
    Invoke-WebRequest -Uri "$Base/$Archive" -OutFile $zip -UseBasicParsing
    $sums = (Invoke-WebRequest -Uri "$Base/checksums.txt" -UseBasicParsing).Content
    $line = ($sums -split "`n" | Where-Object { $_ -match [regex]::Escape($Archive) } | Select-Object -First 1)
    if (-not $line) { throw "checksums.txt has no entry for $Archive." }
    $expected = ($line.Trim() -split '\s+')[0].ToLower()
    $actual = (Get-FileHash -Algorithm SHA256 -Path $zip).Hash.ToLower()
    if ($actual -ne $expected) { throw "SHA-256 mismatch for ${Archive}: expected $expected, got $actual. Not installing." }
    Write-Host "SHA-256 verified ($actual)"
    Expand-Archive -Path $zip -DestinationPath $tmp -Force
    $found = Get-ChildItem -Path $tmp -Recurse -Filter 'temporal.exe' | Select-Object -First 1
    if (-not $found) { throw 'temporal.exe was not in the archive.' }
    Copy-Item -Path $found.FullName -Destination $exe -Force
  } finally {
    Remove-Item -Recurse -Force -Path $tmp -ErrorAction SilentlyContinue
  }
}

New-Item -ItemType Directory -Force -Path (Split-Path -Parent $DbFile) | Out-Null

Write-Host "Starting Temporal on 127.0.0.1:$Port (UI http://127.0.0.1:$UiPort, db: $DbFile)"
$ErrorActionPreference = 'Continue'
# The namespace and the search attributes are passed on every start; that is harmless when they already exist.
& $exe server start-dev --ip 127.0.0.1 --port $Port --ui-port $UiPort --db-filename $DbFile `
  --namespace aiembodied `
  --search-attribute AgentId=Keyword --search-attribute Owner=Keyword `
  --search-attribute Purpose=Keyword --search-attribute Flow=Keyword `
  --log-level warn --log-format pretty
exit $LASTEXITCODE
