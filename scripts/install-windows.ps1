#requires -version 5.1
<#
.SYNOPSIS
    Installs everything a fresh Windows PC needs to run `pnpm dev:run` with the local stack.
.DESCRIPTION
    Idempotent: every component is checked first and skipped when it is already present, and
    existing settings are never overwritten. Paths of installed assets are appended to the
    repo-root .env only when the key is not already defined there (or in the environment).
    One component failing does not stop the others; the exit code is non-zero if any failed.

    Components, in order:
      node            Node.js and pnpm (runs scripts\setup-windows.ps1)
      tools           uv and git (winget); warns when neither wslc nor Docker is present
      llama-cpp       llama-server (GitHub release, Vulkan or CUDA build); sets LLAMA_SERVER_EXE, LLAMA_DEVICE
      kokoro          Kokoro TTS model files; sets KOKORO_DIR
      speech          services\speech venv (uv, Python 3.13) with the engines extra
      asr             Qwen3-ASR-0.6B GGUF and mmproj in the Hugging Face cache
      python-services venvs for memory, coder, switchboard and laya
      pi              the pi coding agent (npm install -g @earendil-works/pi-coding-agent)
      motion          ARDY and Kimodo checkouts and venvs, torch, merged text encoder (~32 GB RAM, 15 GB disk)
      avatar-face     scripts\setup-avatar-face.mjs (face landmarker, background removal)
      comfyui         check only: Comfy Desktop

    Opt-in (run only when named in -Only or -With):
      coder-model     Qwen3-Coder-Next Q4_K_M GGUF (about 45 GB or more)
      avatar-paint    scripts\setup-avatar-paint.mjs (needs ComfyUI's Python)

    Deliberately NOT installed:
      - The Thinking LLM (Qwen Flash-Next GGUF): pick it in Models and servers -> Thinking.
      - The vision model: Models and servers -> Describe the avatar downloads it in the app.
      - Docker / wslc (the memory engine and SearXNG need one; try `wsl --update` for wslc).
      - Comfy Desktop and its image models (https://www.comfy.org/download).

.PARAMETER Only
    Run just these components (opt-in ones included).
.PARAMETER Skip
    Do not run these components.
.PARAMETER With
    Opt-in components to run in addition to the defaults.
.PARAMETER LlamaBackend
    auto (CUDA when an NVIDIA GPU is found, else Vulkan), vulkan or cuda.
.PARAMETER TextEncoderBase
    Llama-3-8B-Instruct repo or folder the motion text encoder is built from (ungated mirror by default).
.PARAMETER RocmTorch
    torch requirement used for AMD GPUs (services\motion\README.md).
.PARAMETER InstallRoot
    Where downloaded assets go (default %USERPROFILE%\.cache\aiembodied).
.PARAMETER Force
    Re-download or reinstall the selected components even when they are present.
.EXAMPLE
    pnpm install:windows
    .\scripts\install-windows.ps1 -Only llama-cpp,kokoro -LlamaBackend vulkan
    .\scripts\install-windows.ps1 -Skip motion -With coder-model
#>
param(
    [string[]]$Only = @(),
    [string[]]$Skip = @(),
    [string[]]$With = @(),
    [ValidateSet('auto', 'vulkan', 'cuda')] [string]$LlamaBackend = 'auto',
    [string]$TextEncoderBase = 'NousResearch/Meta-Llama-3-8B-Instruct',
    [string]$RocmTorch = 'torch[device-gfx1151]==2.12.0+rocm7.14.0',
    [string]$InstallRoot = $(Join-Path $env:USERPROFILE '.cache\aiembodied'),
    [switch]$Force
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch { }

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$envFile = Join-Path $repoRoot '.env'
$hfCache = Join-Path $env:USERPROFILE '.cache\huggingface\hub'

# ---------------------------------------------------------------- helpers

function New-Result([string]$Status, [string]$Detail = '') {
    [pscustomobject]@{ Status = $Status; Detail = $Detail }
}

function Test-Cmd([string]$Name) { [bool](Get-Command $Name -ErrorAction SilentlyContinue) }

function Update-SessionPath {
    $parts = @([Environment]::GetEnvironmentVariable('Path', 'Machine'), [Environment]::GetEnvironmentVariable('Path', 'User'), $env:Path)
    $env:Path = (($parts | Where-Object { $_ }) -join ';')
}

# Runs a native command, shows its output, and throws on a non-zero exit code.
function Invoke-Native([string]$Exe, [string[]]$Arguments) {
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        & $Exe @Arguments | Out-Host
        $code = $LASTEXITCODE
    }
    finally { $ErrorActionPreference = $previous }
    if ($code -ne 0) { throw "$Exe exited with code $code." }
}

# True when a native command exits 0 (output discarded).
function Test-Native([string]$Exe, [string[]]$Arguments) {
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        & $Exe @Arguments *> $null
        return ($LASTEXITCODE -eq 0)
    }
    catch { return $false }
    finally { $ErrorActionPreference = $previous }
}

function Get-EnvFileValue([string]$Key) {
    if (-not (Test-Path $envFile)) { return $null }
    foreach ($line in (Get-Content -Path $envFile)) {
        if ($line -match "^\s*$([regex]::Escape($Key))\s*=\s*(.*)$") {
            return $Matches[1].Trim().Trim('"').Trim("'")
        }
    }
    return $null
}

# Process environment first, then .env.
function Get-Setting([string]$Key) {
    $value = [Environment]::GetEnvironmentVariable($Key)
    if ($value) { return $value }
    return (Get-EnvFileValue $Key)
}

# Appends KEY=value to .env only when KEY is not already set there or in the environment.
function Set-EnvDefault([string]$Key, [string]$Value) {
    if (Get-Setting $Key) { return }
    $text = ''
    if (Test-Path $envFile) { $text = [IO.File]::ReadAllText($envFile) }
    $prefix = ''
    if ($text.Length -gt 0 -and -not $text.EndsWith("`n")) { $prefix = "`r`n" }
    [IO.File]::AppendAllText($envFile, "$prefix$Key=$Value`r`n", (New-Object Text.UTF8Encoding($false)))
    [Environment]::SetEnvironmentVariable($Key, $Value, 'Process')
    Write-Host "  .env: added $Key=$Value"
}

function Save-Download([string]$Url, [string]$Destination) {
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Destination) | Out-Null
    $partial = "$Destination.part"
    Remove-Item -Force -ErrorAction SilentlyContinue $partial
    Write-Host "  downloading $Url"
    Invoke-Native 'curl.exe' @('-L', '--fail', '-o', $partial, $Url)
    Move-Item -Force -Path $partial -Destination $Destination
}

function Get-GpuNames {
    try { return @(Get-CimInstance Win32_VideoController | ForEach-Object { $_.Name }) } catch { return @() }
}
function Test-Nvidia { (Test-Cmd 'nvidia-smi') -or (@(Get-GpuNames) -match 'NVIDIA').Count -gt 0 }
function Test-Amd { (@(Get-GpuNames) -match 'Radeon|AMD').Count -gt 0 }

function Get-HfHeaders {
    if ($env:HF_TOKEN) { return @{ Authorization = "Bearer $($env:HF_TOKEN)" } }
    return @{}
}

function Get-HfFiles([string]$Repo) {
    $info = Invoke-RestMethod -Uri "https://huggingface.co/api/models/$Repo" -Headers (Get-HfHeaders)
    return @($info.siblings | ForEach-Object { $_.rfilename })
}

# hf download into the standard Hugging Face cache, where the start scripts look.
function Invoke-HfDownload([string]$Repo, [string[]]$Include) {
    if (-not (Test-Cmd 'uvx')) { throw 'uvx is not on PATH. Run the tools component first (installs uv).' }
    $cliArgs = @('--from', 'huggingface_hub', 'hf', 'download', $Repo)
    foreach ($pattern in $Include) { $cliArgs += @('--include', $pattern) }
    if ($Force) { $cliArgs += '--force-download' }
    Invoke-Native 'uvx' $cliArgs
}

function Get-VenvPython([string]$Venv) { Join-Path $Venv 'Scripts\python.exe' }

# Creates the venv if needed, installs the editable package(s) and writes the start script's marker.
function Install-PyService([string]$Label, [string]$Dir, [string]$Spec, [string]$PyVersion, [string]$MarkerName, [string]$VenvOverride) {
    $venv = if ($VenvOverride) { $VenvOverride } else { Join-Path $Dir '.venv' }
    $python = Get-VenvPython $venv
    $marker = Join-Path $venv $MarkerName
    $pyproject = Join-Path $Dir 'pyproject.toml'
    $fresh = (Test-Path $python) -and (Test-Path $marker) -and
        ((Get-Item $marker).LastWriteTimeUtc -ge (Get-Item $pyproject).LastWriteTimeUtc)
    if ($fresh -and -not $Force) { return $false }
    if (-not (Test-Path $python)) { Invoke-Native 'uv' @('venv', $venv, '--python', $PyVersion) }
    Invoke-Native 'uv' @('pip', 'install', '--python', $python, '-e', $Spec)
    Set-Content -Path $marker -Value (Get-Date -Format o)
    return $true
}

# ---------------------------------------------------------------- components

function Step-Node {
    $ok = $false
    if ((Test-Cmd 'node') -and (Test-Cmd 'pnpm')) {
        try { $ok = ([Version](& node --version).Trim().TrimStart('v')) -ge [Version]'22.12.0' } catch { $ok = $false }
    }
    $global:LASTEXITCODE = 0
    & (Join-Path $PSScriptRoot 'setup-windows.ps1')
    if ($LASTEXITCODE -ne 0) { throw 'setup-windows.ps1 failed.' }
    Update-SessionPath
    if ($ok) { return New-Result 'already present' }
    return New-Result 'installed'
}

function Install-WingetPackage([string]$Id) {
    if (-not (Test-Cmd 'winget')) { throw "winget is not available; install $Id by hand." }
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try { & winget install --id $Id --exact --source winget --accept-package-agreements --accept-source-agreements | Out-Host }
    finally { $ErrorActionPreference = $previous }
    Update-SessionPath
}

function Step-Tools {
    $installed = @()
    foreach ($tool in @(@{ Cmd = 'uv'; Id = 'astral-sh.uv' }, @{ Cmd = 'git'; Id = 'Git.Git' })) {
        if (Test-Cmd $tool.Cmd) { continue }
        Install-WingetPackage $tool.Id
        if (-not (Test-Cmd $tool.Cmd)) { throw "$($tool.Cmd) is still not on PATH after installing $($tool.Id). Open a new shell and re-run." }
        $installed += $tool.Cmd
    }
    $detail = ''
    if (-not ((Test-Cmd 'wslc') -or (Test-Cmd 'docker'))) {
        $detail = 'WARNING: neither wslc nor Docker found; the memory engine and SearXNG need one (try "wsl --update" for wslc).'
        Write-Warning $detail
    }
    if ($installed.Count -gt 0) { return New-Result 'installed' ("$($installed -join ', ') $detail").Trim() }
    return New-Result 'already present' $detail
}

function Step-LlamaCpp {
    $configured = Get-Setting 'LLAMA_SERVER_EXE'
    $default = Join-Path $env:USERPROFILE '.unsloth\llama.cpp\build\bin\Release\llama-server.exe'
    if (-not $Force) {
        if ($configured -and (Test-Path $configured)) { return New-Result 'already present' $configured }
        if (Test-Path $default) { return New-Result 'already present' $default }
    }
    $backend = $LlamaBackend
    if ($backend -eq 'auto') { $backend = if (Test-Nvidia) { 'cuda' } else { 'vulkan' } }

    # releases/latest can point at a tagged release with no binaries (v0.9.0 in Nov 2026), so walk
    # the recent releases and take the newest one that has the Windows build we want.
    # Piped so Windows PowerShell 5.1 enumerates the JSON array instead of passing it as one object.
    $releases = @(Invoke-RestMethod -Uri 'https://api.github.com/repos/ggml-org/llama.cpp/releases?per_page=30' | ForEach-Object { $_ })
    $tag = $null
    $zips = @()
    foreach ($release in $releases) {
        $assets = @($release.assets)
        $found = @()
        if ($backend -eq 'vulkan') {
            $found += $assets | Where-Object { $_.name -match '^llama-.*-bin-win-vulkan-x64\.zip$' } | Select-Object -First 1
        }
        else {
            # The newest CUDA build (RTX 50-series needs CUDA 12.8+); its cudart zip must match.
            # Older drivers: pass -LlamaBackend vulkan instead.
            $pattern = '-bin-win-cuda-(\d+\.\d+)-x64\.zip$'
            $main = $assets | Where-Object { $_.name -match "^llama-.*$pattern" } |
                Sort-Object { [Version]([regex]::Match($_.name, $pattern).Groups[1].Value) } -Descending | Select-Object -First 1
            if ($main) {
                $cuda = [regex]::Match($main.name, $pattern).Groups[1].Value
                $runtime = $assets | Where-Object { $_.name -eq "cudart-llama-bin-win-cuda-$cuda-x64.zip" } | Select-Object -First 1
                $found += $main
                if ($runtime) { $found += $runtime }
            }
        }
        $found = @($found | Where-Object { $_ })
        if ($found.Count -gt 0) { $tag = $release.tag_name; $zips = $found; break }
    }
    if (-not $tag) { throw "No Windows $backend x64 build in the last $($releases.Count) llama.cpp releases." }

    $target = Join-Path $InstallRoot "llama.cpp\$tag-$backend"
    $exe = Get-ChildItem -Path $target -Recurse -Filter 'llama-server.exe' -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $exe -or $Force) {
        $partial = "$target.partial"
        Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $partial
        foreach ($zip in $zips) {
            $zipPath = Join-Path $InstallRoot "downloads\$($zip.name)"
            Save-Download $zip.browser_download_url $zipPath
            Expand-Archive -Path $zipPath -DestinationPath $partial -Force
            Remove-Item -Force $zipPath
        }
        if (Test-Path $target) { Remove-Item -Recurse -Force $target }
        Move-Item -Path $partial -Destination $target
        $exe = Get-ChildItem -Path $target -Recurse -Filter 'llama-server.exe' | Select-Object -First 1
    }
    if (-not $exe) { throw "llama-server.exe not found in $target." }
    Set-EnvDefault 'LLAMA_SERVER_EXE' $exe.FullName
    Set-EnvDefault 'LLAMA_DEVICE' $(if ($backend -eq 'cuda') { 'CUDA0' } else { 'Vulkan0' })
    return New-Result 'installed' "$tag $backend"
}

function Step-Kokoro {
    $dir = Get-Setting 'KOKORO_DIR'
    if (-not $dir) { $dir = Join-Path $InstallRoot 'kokoro' }
    $base = 'https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/'
    $fetched = 0
    foreach ($name in @('kokoro-v1.0.onnx', 'voices-v1.0.bin')) {
        $path = Join-Path $dir $name
        if ((Test-Path $path) -and -not $Force) { continue }
        Save-Download "$base$name" $path
        $fetched++
    }
    Set-EnvDefault 'KOKORO_DIR' $dir
    if ($fetched -eq 0) { return New-Result 'already present' $dir }
    return New-Result 'installed' $dir
}

function Step-Speech {
    $dir = Join-Path $repoRoot 'services\speech'
    $did = Install-PyService 'speech' $dir "${dir}[engines]" '3.13' '.speech-service-installed' (Get-Setting 'SPEECH_VENV')
    if ($did) { return New-Result 'installed' }
    return New-Result 'already present'
}

function Find-AsrFiles {
    $cache = Join-Path $hfCache 'models--unslothai--Qwen3-ASR-0.6B-GGUF'
    # Same lookup as scripts\start-local-asr.ps1.
    $model = Get-ChildItem $cache -Recurse -Filter 'Qwen3-ASR-*.gguf' -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -notlike 'mmproj*' } | Select-Object -First 1 -ExpandProperty FullName
    $mmproj = Get-ChildItem $cache -Recurse -Filter 'mmproj-*.gguf' -ErrorAction SilentlyContinue |
        Select-Object -First 1 -ExpandProperty FullName
    return @{ Model = $model; Mmproj = $mmproj }
}

function Step-Asr {
    $found = Find-AsrFiles
    if (-not $Force -and ($found.Model -or (Get-Setting 'LOCAL_ASR_GGUF')) -and ($found.Mmproj -or (Get-Setting 'LOCAL_ASR_MMPROJ'))) {
        return New-Result 'already present'
    }
    $repo = 'unslothai/Qwen3-ASR-0.6B-GGUF'
    $files = @(Get-HfFiles $repo | Where-Object { $_ -like '*.gguf' })
    $models = @($files | Where-Object { $_ -notmatch 'mmproj' })
    $mmprojs = @($files | Where-Object { $_ -match 'mmproj' })
    $model = $models | Where-Object { $_ -match 'Q8_0' } | Select-Object -First 1
    if (-not $model) { $model = $models | Select-Object -First 1 }
    $mmproj = $mmprojs | Where-Object { $_ -match 'Q8_0' } | Select-Object -First 1
    if (-not $mmproj) { $mmproj = $mmprojs | Where-Object { $_ -match 'F16' } | Select-Object -First 1 }
    if (-not $mmproj) { $mmproj = $mmprojs | Select-Object -First 1 }
    if (-not $model -or -not $mmproj) { throw "Could not find a model and an mmproj GGUF in $repo." }
    Invoke-HfDownload $repo @($model, $mmproj)
    $found = Find-AsrFiles
    if (-not $found.Model -or -not $found.Mmproj) {
        throw "Downloaded $model and $mmproj, but scripts\start-local-asr.ps1 would not find them (its filters are Qwen3-ASR-*.gguf and mmproj-*.gguf). Set LOCAL_ASR_GGUF and LOCAL_ASR_MMPROJ."
    }
    return New-Result 'installed' "$model, $mmproj"
}

function Step-PythonServices {
    $services = @(
        @{ Name = 'memory'; Py = '3.13'; Marker = '.memory-engine-installed'; Venv = 'MEMORY_VENV' },
        @{ Name = 'coder'; Py = '3.13'; Marker = '.coding-runner-installed'; Venv = 'CODER_VENV' },
        @{ Name = 'switchboard'; Py = '3.13'; Marker = '.switchboard-installed'; Venv = 'SWITCHBOARD_VENV' },
        @{ Name = 'laya'; Py = '3.12'; Marker = '.laya-installed'; Venv = 'LAYA_VENV' }
    )
    $done = @(); $present = @(); $failed = @()
    foreach ($service in $services) {
        $dir = Join-Path $repoRoot "services\$($service.Name)"
        try {
            if (Install-PyService $service.Name $dir $dir $service.Py $service.Marker (Get-Setting $service.Venv)) { $done += $service.Name }
            else { $present += $service.Name }
        }
        catch {
            Write-Warning "$($service.Name): $($_.Exception.Message)"
            $failed += $service.Name
        }
    }
    # Laya names no Hugging Face repo anywhere in services\laya, so its checkpoint is left to the first start.
    $note = 'laya checkpoint downloads on first start'
    if ($failed.Count -gt 0) { return New-Result 'failed' "$($failed -join ', ') failed" }
    if ($done.Count -gt 0) { return New-Result 'installed' "$($done -join ', '); $note" }
    return New-Result 'already present' $note
}

function Step-Pi {
    $command = Get-Setting 'CODER_PI_COMMAND'
    if (-not $command) { $command = 'pi' }
    $first = ($command -split ' ')[0]
    if ((Test-Cmd $first) -and -not $Force) { return New-Result 'already present' $first }
    if (-not (Test-Cmd 'npm')) { throw 'npm is not on PATH. Run the node component first.' }
    Invoke-Native 'npm' @('install', '-g', '@earendil-works/pi-coding-agent')
    return New-Result 'installed'
}

function Install-MotionRepo([string]$Name) {
    $path = Join-Path (Split-Path -Parent $repoRoot) $Name
    if (-not (Test-Path $path)) {
        if (-not (Test-Cmd 'git')) { throw 'git is not on PATH. Run the tools component first.' }
        Invoke-Native 'git' @('clone', "https://github.com/nv-tlabs/$Name.git", $path)
    }
    return $path
}

function Step-Motion {
    $motion = Join-Path $repoRoot 'services\motion'
    $changed = $false
    $nvidia = Test-Nvidia
    if ($nvidia) {
        $indexArgs = @('--index-url', 'https://download.pytorch.org/whl/cu128', '--extra-index-url', 'https://pypi.org/simple', '--index-strategy', 'unsafe-best-match')
        $torch = 'torch'
    }
    elseif (Test-Amd) {
        $indexArgs = @('--index-url', 'https://repo.amd.com/rocm/whl-multi-arch/', '--extra-index-url', 'https://pypi.org/simple', '--index-strategy', 'unsafe-best-match')
        $torch = $RocmTorch
    }
    else {
        $indexArgs = @()
        $torch = 'torch'
    }

    $backends = @(
        @{ Name = 'ardy'; Repo = 'ardy'; Module = 'ardy'; Spec = '..\ardy'; Override = $true },
        @{ Name = 'kimodo'; Repo = 'kimodo'; Module = 'kimodo'; Spec = '..\kimodo[soma]'; Override = $false }
    )
    foreach ($b in $backends) {
        $venv = Join-Path $motion ".venv-$($b.Name)"
        $python = Get-VenvPython $venv
        if (-not $Force -and (Test-Path $python) -and (Test-Native $python @('-c', "import torch, $($b.Module)"))) { continue }
        $repoPath = Install-MotionRepo $b.Repo
        if (-not (Test-Path $python)) { Invoke-Native 'uv' @('venv', $venv, '--python', '3.13') }
        $spec = if ($b.Override) { $repoPath } else { "${repoPath}[soma]" }
        $installArgs = @('pip', 'install', '--python', $python) + $indexArgs
        if ($b.Override) {
            # numpy<2 has no Python 3.13 wheels; ARDY works fine with numpy 2 (services\motion\README.md).
            New-Item -ItemType Directory -Force -Path $InstallRoot | Out-Null
            $overrides = Join-Path $InstallRoot 'ardy-overrides.txt'
            'numpy>=2' | Set-Content -Encoding ascii -Path $overrides
            $installArgs += @('--override', $overrides)
        }
        $installArgs += @($torch, '-e', $spec, '-e', "${motion}[test]")
        # Kimodo's setup.py builds its optional motion_correction C++ extension with CMake and a
        # compiler; the motion service and the text encoder build don't use it, so skip it.
        $env:SKIP_MOTION_CORRECTION_IN_SETUP = '1'
        try { Invoke-Native 'uv' $installArgs } finally { Remove-Item Env:SKIP_MOTION_CORRECTION_IN_SETUP -ErrorAction SilentlyContinue }
        if (-not (Test-Native $python @('-c', "import torch, $($b.Module)"))) { throw "$($b.Name) venv installed, but 'import torch, $($b.Module)' fails." }
        $changed = $true
    }

    $encoders = Get-Setting 'TEXT_ENCODERS_DIR'
    $haveEncoders = $encoders -and (Test-Path $encoders) -and (@(Get-ChildItem $encoders -ErrorAction SilentlyContinue).Count -gt 0)
    if ($haveEncoders -and -not $Force) {
        if ($changed) { return New-Result 'installed' 'venvs; text encoder present' }
        return New-Result 'already present'
    }
    $out = if ($encoders) { $encoders } else { Join-Path $InstallRoot 'text_encoders_merged' }
    $ram = 0
    try { $ram = (Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory / 1GB } catch { }
    if ($ram -gt 0 -and $ram -lt 30 -and -not $Force) {
        # Building it merges an 8B model in memory, and running it needs ~16.5 GB of GPU or system
        # memory, so a small PC should use the motion service on a bigger machine instead.
        return New-Result 'skipped' ("text encoder not built: {0:N0} GB RAM (needs ~32). Point MOTION_SERVICE_URL at a motion service on a bigger PC, or set DEV_START_MOTION=0; -Force tries anyway." -f $ram)
    }
    Write-Host '  Building the motion text encoder needs about 32 GB of RAM and 15 GB of disk.'
    $kimodoPython = Get-VenvPython (Join-Path $motion '.venv-kimodo')
    if (-not (Test-Path $kimodoPython)) { throw 'The Kimodo venv is missing, so the text encoder cannot be built.' }
    Invoke-Native $kimodoPython @((Join-Path $motion 'scripts\build_text_encoder.py'), '--base', $TextEncoderBase, '--out', $out)
    Set-EnvDefault 'TEXT_ENCODERS_DIR' $out
    return New-Result 'installed' "text encoder in $out"
}

function Step-AvatarFace {
    $dir = Get-Setting 'AVATAR_FACE_DIR'
    if (-not $dir) { $dir = Join-Path $repoRoot 'services\avatar-face' }
    if (-not $Force -and (Test-Path (Join-Path $dir '.venv')) -and (Test-Path (Join-Path $dir 'models\face_landmarker.task'))) {
        return New-Result 'already present'
    }
    Push-Location $repoRoot
    try { Invoke-Native 'node' @('scripts/setup-avatar-face.mjs') } finally { Pop-Location }
    return New-Result 'installed'
}

function Step-ComfyUi {
    $dir = Get-Setting 'COMFYUI_DIR'
    if (-not $dir) { $dir = Join-Path $env:LOCALAPPDATA 'Comfy-Desktop\ComfyUI-Installs' }
    if (Test-Path $dir) { return New-Result 'already present' $dir }
    return New-Result 'skipped' 'not installed; get Comfy Desktop from https://www.comfy.org/download'
}

function Step-AvatarPaint {
    Push-Location $repoRoot
    try { Invoke-Native 'node' @('scripts/setup-avatar-paint.mjs') } finally { Pop-Location }
    return New-Result 'installed'
}

function Step-CoderModel {
    $repo = 'Qwen/Qwen3-Coder-Next-GGUF'
    $cache = Join-Path $hfCache 'models--Qwen--Qwen3-Coder-Next-GGUF'
    # Same idea as app/main/src/coding/gguf-finder.ts: a qwen3-coder-next Q4_K_M .gguf in the cache.
    $have = Get-ChildItem $cache -Recurse -Filter '*.gguf' -ErrorAction SilentlyContinue |
        Where-Object { $_.FullName -match 'qwen3-coder-next' -and $_.FullName -match 'q4_k_m' } | Select-Object -First 1
    if ($have -and -not $Force) { return New-Result 'already present' $have.FullName }
    $files = @(Get-HfFiles $repo | Where-Object { $_ -like '*.gguf' -and $_ -match 'Q4_K_M' })
    if ($files.Count -eq 0) { throw "No Q4_K_M GGUF files listed in $repo." }
    Write-Warning "The Qwen3-Coder-Next Q4_K_M download is large (about 45 GB or more): $($files -join ', ')"
    Invoke-HfDownload $repo $files
    return New-Result 'installed' ($files -join ', ')
}

# ---------------------------------------------------------------- run

$registry = [ordered]@{
    'node'            = { Step-Node }
    'tools'           = { Step-Tools }
    'llama-cpp'       = { Step-LlamaCpp }
    'kokoro'          = { Step-Kokoro }
    'speech'          = { Step-Speech }
    'asr'             = { Step-Asr }
    'python-services' = { Step-PythonServices }
    'pi'              = { Step-Pi }
    'motion'          = { Step-Motion }
    'avatar-face'     = { Step-AvatarFace }
    'comfyui'         = { Step-ComfyUi }
    'avatar-paint'    = { Step-AvatarPaint }
    'coder-model'     = { Step-CoderModel }
}
$optIn = @('coder-model', 'avatar-paint')

foreach ($name in @($Only) + @($Skip) + @($With)) {
    if ($name -and -not $registry.Contains($name)) { throw "Unknown component '$name'. Known: $($registry.Keys -join ', ')." }
}
$selected = @($registry.Keys | Where-Object {
    if ($Only.Count -gt 0) { $Only -contains $_ }
    else { ($optIn -notcontains $_) -or ($With -contains $_) }
})

Write-Host "Install root: $InstallRoot"
$summary = @()
foreach ($name in $registry.Keys) {
    if ($selected -notcontains $name -or $Skip -contains $name) {
        $why = 'not selected'
        if ($Skip -contains $name) { $why = 'excluded with -Skip' }
        elseif ($optIn -contains $name) { $why = 'opt-in (use -With or -Only)' }
        $summary += [pscustomobject]@{ Component = $name; Status = 'skipped'; Detail = $why }
        continue
    }
    Write-Host ""
    Write-Host "== $name ==" -ForegroundColor Cyan
    try {
        $output = @(& $registry[$name])
        $result = $output | Where-Object { $_ -and $_.PSObject.Properties['Status'] } | Select-Object -Last 1
        if (-not $result) { $result = New-Result 'installed' }
    }
    catch {
        $result = New-Result 'failed' $_.Exception.Message
        Write-Host "  failed: $($_.Exception.Message)" -ForegroundColor Red
    }
    $summary += [pscustomobject]@{ Component = $name; Status = $result.Status; Detail = $result.Detail }
}

Write-Host ""
Write-Host '== Summary ==' -ForegroundColor Cyan
$summary | Format-Table -AutoSize -Wrap | Out-Host
Write-Host 'Not installed by design: the Thinking model (Models and servers -> Thinking), the vision model (Models and servers -> Describe the avatar), Docker/wslc, Comfy Desktop.'
if (@($summary | Where-Object { $_.Status -eq 'failed' }).Count -gt 0) { exit 1 }
exit 0
