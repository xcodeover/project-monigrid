$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$sourceDist = Join-Path $projectRoot 'node_modules\electron\dist'
$outputRoot = Join-Path $projectRoot 'release\portable-win-unpacked-fixed'
$appRoot = Join-Path $outputRoot 'resources\app'

if (-not (Test-Path $sourceDist)) {
    throw "Electron distribution not found at $sourceDist"
}

if (Test-Path $outputRoot) {
    Remove-Item $outputRoot -Recurse -Force
}

Copy-Item $sourceDist $outputRoot -Recurse

New-Item -ItemType Directory -Force (Join-Path $appRoot 'electron') | Out-Null
New-Item -ItemType Directory -Force (Join-Path $appRoot 'dist') | Out-Null

$portablePackageJson = @'
{
  "name": "monitoringdashboard",
  "version": "0.0.1",
  "main": "electron/main.cjs"
}
'@

[System.IO.File]::WriteAllText((Join-Path $appRoot 'package.json'), $portablePackageJson, [System.Text.UTF8Encoding]::new($false))

Copy-Item (Join-Path $projectRoot 'electron\main.cjs') (Join-Path $appRoot 'electron\main.cjs') -Force
Copy-Item (Join-Path $projectRoot 'electron\preload.cjs') (Join-Path $appRoot 'electron\preload.cjs') -Force
Copy-Item (Join-Path $projectRoot 'dist\*') (Join-Path $appRoot 'dist') -Recurse -Force
Copy-Item (Join-Path $outputRoot 'electron.exe') (Join-Path $outputRoot 'MonitoringDashboard.exe') -Force

Write-Host "Portable Electron package created at $outputRoot"