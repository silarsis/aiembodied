#requires -version 5.1
<#
.SYNOPSIS
    Prepares a Windows developer workstation for the Embodied ChatGPT Assistant project.
.DESCRIPTION
    Ensures that Node.js (v20 or newer) and pnpm are installed. Existing installations
    are reused when they meet the minimum requirements. Node.js is installed via winget
    (or Chocolatey as a fallback) and pnpm is provisioned through Corepack so the version
    aligns with the repository's packageManager field.
#>

$ErrorActionPreference = 'Stop'

$RequiredNodeVersion = [Version]'20.0.0'
$scriptDirectory = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = Resolve-Path (Join-Path $scriptDirectory '..')

function Get-TargetPnpmVersionFromPackageJson {
    $packageJsonPath = Join-Path $repoRoot 'package.json'
    if (-not (Test-Path -Path $packageJsonPath -PathType Leaf)) {
        return $null
    }

    try {
        $packageJson = Get-Content -Path $packageJsonPath -Raw | ConvertFrom-Json
    }
    catch {
        Write-Warning "Unable to parse package.json to determine target pnpm version."
        return $null
    }

    if (-not $packageJson.packageManager) {
        return $null
    }

    $parts = $packageJson.packageManager -split '@', 2
    if ($parts.Length -ne 2 -or [string]::IsNullOrWhiteSpace($parts[1])) {
        Write-Warning "packageManager field in package.json is not in the expected 'pnpm@<version>' format."
        return $null
    }

    return $parts[1]
}

$TargetPnpmVersion = Get-TargetPnpmVersionFromPackageJson
if (-not $TargetPnpmVersion) {
    $TargetPnpmVersion = '9.12.0'
}

function Test-CommandExists {
    param (
        [Parameter(Mandatory = $true)][string]$Name
    )
    try {
        return [bool](Get-Command -Name $Name -ErrorAction Stop)
    }
    catch {
        return $false
    }
}

function Get-NodeVersion {
    if (-not (Test-CommandExists -Name 'node')) {
        return $null
    }

    $rawVersion = node --version 2>$null
    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($rawVersion)) {
        return $null
    }

    return [Version]($rawVersion.Trim().TrimStart('v', 'V'))
}

function Ensure-Node {
    $nodeVersion = Get-NodeVersion
    if ($null -ne $nodeVersion -and $nodeVersion -ge $RequiredNodeVersion) {
        Write-Host "Node.js $($nodeVersion.ToString()) already satisfies the minimum requirement." -ForegroundColor Green
        return
    }

    Write-Host "Installing or upgrading Node.js to meet the $RequiredNodeVersion requirement..." -ForegroundColor Cyan

    if (Test-CommandExists -Name 'winget') {
        winget install --id OpenJS.NodeJS.LTS --source winget --exact --accept-package-agreements --accept-source-agreements
    }
    elseif (Test-CommandExists -Name 'choco') {
        choco install nodejs-lts --yes --no-progress
    }
    else {
        throw 'Neither winget nor Chocolatey were found. Install one of them and re-run this script.'
    }

    $nodeVersion = Get-NodeVersion
    if ($null -eq $nodeVersion -or $nodeVersion -lt $RequiredNodeVersion) {
        throw "Node.js installation did not succeed or is still older than $RequiredNodeVersion."
    }

    Write-Host "Node.js $($nodeVersion.ToString()) is ready." -ForegroundColor Green
}

function Get-PnpmVersion {
    if (-not (Test-CommandExists -Name 'pnpm')) {
        return $null
    }

    $rawVersion = pnpm --version 2>$null
    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($rawVersion)) {
        return $null
    }

    return $rawVersion.Trim()
}

function Get-PnpmStandaloneDirectory {
    if ($env:LOCALAPPDATA) {
        return Join-Path $env:LOCALAPPDATA 'pnpm'
    }

    if ($env:USERPROFILE) {
        return Join-Path $env:USERPROFILE '.pnpm'
    }

    return Join-Path ([System.IO.Path]::GetTempPath()) 'pnpm'
}

function Ensure-Directory {
    param (
        [Parameter(Mandatory = $true)][string]$Path
    )

    if (-not (Test-Path -Path $Path -PathType Container)) {
        New-Item -ItemType Directory -Path $Path | Out-Null
    }
}

$script:CorepackPermissionPatterns = @(
    'EPERM',
    'EACCES',
    'Access is denied',
    'operation not permitted'
)

function Invoke-CorepackCommand {
    param (
        [Parameter(Mandatory = $true)][string[]]$Arguments
    )

    $output = & corepack @Arguments 2>&1
    $exitCode = $LASTEXITCODE
    $message = ($output | Out-String).Trim()

    return [PSCustomObject]@{
        ExitCode = $exitCode
        Message  = $message
    }
}

function Test-CorepackPermissionError {
    param (
        [Parameter(Mandatory = $true)][string]$Message
    )

    foreach ($pattern in $script:CorepackPermissionPatterns) {
        if ($Message -match [Regex]::Escape($pattern)) {
            return $true
        }
    }

    return $false
}

$script:UserPathUpdated = $false

function Add-ToUserPath {
    param (
        [Parameter(Mandatory = $true)][string]$PathToAdd
    )

    if ([string]::IsNullOrWhiteSpace($PathToAdd)) {
        return
    }

    $currentUserPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    $userPathSegments = if ([string]::IsNullOrWhiteSpace($currentUserPath)) { @() } else { $currentUserPath.Split(';') }

    if (-not ($userPathSegments -contains $PathToAdd)) {
        $newUserPath = if ([string]::IsNullOrWhiteSpace($currentUserPath)) { $PathToAdd } else { "$currentUserPath;$PathToAdd" }
        [Environment]::SetEnvironmentVariable('Path', $newUserPath, 'User')
        $script:UserPathUpdated = $true
    }

    if (-not ($env:Path.Split(';') -contains $PathToAdd)) {
        $env:Path = "$PathToAdd;$env:Path"
    }
}

function Install-PnpmStandalone {
    param (
        [Parameter(Mandatory = $true)][string]$Version
    )

    $installDirectory = Get-PnpmStandaloneDirectory
    Ensure-Directory -Path $installDirectory

    $downloadUri = "https://github.com/pnpm/pnpm/releases/download/v$Version/pnpm-win-x64.exe"
    $destinationPath = Join-Path $installDirectory 'pnpm.exe'

    Write-Host "Downloading pnpm $Version to a user-writable directory..." -ForegroundColor Cyan

    try {
        if ([Net.ServicePointManager]::SecurityProtocol -band [Net.SecurityProtocolType]::Tls12 -eq 0) {
            [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
        }
        Invoke-WebRequest -Uri $downloadUri -OutFile $destinationPath -UseBasicParsing | Out-Null
    }
    catch {
        throw "Failed to download pnpm $Version from $downloadUri. $_"
    }

    if (-not (Test-Path -Path $destinationPath -PathType Leaf)) {
        throw "pnpm executable was not created at $destinationPath."
    }

    Add-ToUserPath -PathToAdd $installDirectory
    Write-Host "pnpm $Version downloaded to $installDirectory." -ForegroundColor Green
}

function Ensure-Pnpm {
    $currentVersion = Get-PnpmVersion
    if ($null -ne $currentVersion) {
        try {
            if ([Version]$currentVersion -ge [Version]$TargetPnpmVersion) {
                Write-Host "pnpm $currentVersion already satisfies the requirement." -ForegroundColor Green
                return
            }
        }
        catch {
            Write-Warning "Unable to parse pnpm version '$currentVersion'. Reinstalling via Corepack."
        }
    }

    $activated = $false

    if (Test-CommandExists -Name 'corepack') {
        Write-Host "Activating pnpm $TargetPnpmVersion via Corepack..." -ForegroundColor Cyan

        $enableResult = Invoke-CorepackCommand -Arguments @('enable')
        if ($enableResult.ExitCode -ne 0) {
            if (Test-CorepackPermissionError -Message $enableResult.Message) {
                Write-Warning "Corepack could not enable pnpm due to insufficient permissions. Falling back to a standalone download."
                Install-PnpmStandalone -Version $TargetPnpmVersion
            }
            else {
                throw "corepack enable failed: $($enableResult.Message)"
            }
        }
        else {
            $prepareResult = Invoke-CorepackCommand -Arguments @('prepare', "pnpm@$TargetPnpmVersion", '--activate')
            if ($prepareResult.ExitCode -ne 0) {
                if (Test-CorepackPermissionError -Message $prepareResult.Message) {
                    Write-Warning "Corepack could not activate pnpm due to insufficient permissions. Falling back to a standalone download."
                    Install-PnpmStandalone -Version $TargetPnpmVersion
                }
                else {
                    throw "corepack prepare failed: $($prepareResult.Message)"
                }
            }
            else {
                $activated = $true
            }
        }
    }
    else {
        Write-Warning 'Corepack was not found. Downloading a standalone pnpm build instead.'
        Install-PnpmStandalone -Version $TargetPnpmVersion
    }

    $currentVersion = Get-PnpmVersion
    if ($null -eq $currentVersion) {
        if ($activated) {
            throw 'Failed to activate pnpm via Corepack.'
        }

        throw 'Failed to provision pnpm. Review the warnings above and try running this script from an elevated PowerShell session.'
    }

    Write-Host "pnpm $currentVersion is ready." -ForegroundColor Green
}

try {
    Ensure-Node
    Ensure-Pnpm

    # Optionally align system Node to Electron's embedded Node for native module ABI parity.
    # This requires that workspace dependencies are installed. If Electron is not yet installed,
    # we will skip with a helpful message.
    try {
        $mainPkgDir = Join-Path $repoRoot 'app/main'
        $electronPkgJson = Join-Path $mainPkgDir 'node_modules/electron/package.json'
        if (Test-Path -Path $electronPkgJson -PathType Leaf) {
            Write-Host "Checking Node alignment with Electron..." -ForegroundColor Cyan
            $systemNode = (node -p "process.versions.node" 2>$null).Trim()
            $electronNode = (pnpm --filter @aiembodied/main exec electron -p "process.versions.node" 2>$null).Trim()
            if (-not [string]::IsNullOrWhiteSpace($systemNode) -and -not [string]::IsNullOrWhiteSpace($electronNode)) {
                if ($systemNode -ne $electronNode) {
                    Write-Warning "System Node v$systemNode differs from Electron's Node v$electronNode."
                    $switched = $false
                    if (Test-CommandExists -Name 'nvs') {
                        try {
                            nvs add "node/$electronNode" | Out-Null
                            nvs use "node/$electronNode" | Out-Null
                            $newNode = (node -p "process.versions.node" 2>$null).Trim()
                            if ($newNode -eq $electronNode) { $switched = $true }
                        } catch {}
                    }
                    if (-not $switched -and (Test-CommandExists -Name 'nvm')) {
                        try {
                            nvm install $electronNode | Out-Null
                            nvm use $electronNode | Out-Null
                            $newNode = (node -p "process.versions.node" 2>$null).Trim()
                            if ($newNode -eq $electronNode) { $switched = $true }
                        } catch {}
                    }
                    if ($switched) {
                        Write-Host "Activated Node v$electronNode to match Electron." -ForegroundColor Green
                    }
                    else {
                        Write-Warning "Could not auto-switch Node. Install NVS (https://github.com/jasongin/nvs) or nvm-windows and switch to v$electronNode."
                    }
                }
            }
        }
        else {
            Write-Host "Electron not yet installed (run 'pnpm install'). Skipping Node/Electron alignment check." -ForegroundColor Yellow
        }
    } catch {
        Write-Warning "Node/Electron alignment check skipped: $($_.Exception.Message)"
    }

    Write-Host "All dependencies are installed. You can now run 'pnpm install'." -ForegroundColor Green
    if ($script:UserPathUpdated) {
        Write-Host 'A user-level PATH update was applied. Restart existing shells to pick up the new pnpm location.' -ForegroundColor Yellow
    }
}
catch {
    Write-Error $_
    exit 1
}
