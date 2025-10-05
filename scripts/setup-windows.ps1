#requires -version 5.1
<#!
.SYNOPSIS
    Prepares a Windows developer workstation for the Embodied ChatGPT Assistant project.
.DESCRIPTION
    Ensures that Node.js (v20 or newer) and pnpm are installed. Existing installations
    are reused when they meet the minimum requirements. Node.js is installed via winget
    (or Chocolatey as a fallback) and pnpm is provisioned through Corepack so the version
    aligns with the repository's packageManager field.
!>

$ErrorActionPreference = 'Stop'

$RequiredNodeVersion = [Version]'20.0.0'
$TargetPnpmVersion = '9.12.0'

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

function Ensure-Pnpm {
    if (-not (Test-CommandExists -Name 'corepack')) {
        throw 'Corepack was not found. Verify that Node.js 16.17+ is installed.'
    }

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

    Write-Host "Activating pnpm $TargetPnpmVersion via Corepack..." -ForegroundColor Cyan
    corepack enable
    corepack prepare "pnpm@$TargetPnpmVersion" --activate

    $currentVersion = Get-PnpmVersion
    if ($null -eq $currentVersion) {
        throw 'Failed to activate pnpm via Corepack.'
    }

    Write-Host "pnpm $currentVersion is ready." -ForegroundColor Green
}

try {
    Ensure-Node
    Ensure-Pnpm

    Write-Host "All dependencies are installed. You can now run 'pnpm install'." -ForegroundColor Green
}
catch {
    Write-Error $_
    exit 1
}
