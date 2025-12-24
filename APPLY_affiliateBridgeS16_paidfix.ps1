# APPLY_affiliateBridgeS16_paidfix.ps1
# - server\routes\affiliateBridgeS16.js dosyasını yedekler
# - affiliateBridgeS16.paidfix.js ile overwrite eder

$ErrorActionPreference = "Stop"

$root = if ($PSScriptRoot) { $PSScriptRoot } else { (Get-Location).Path }
Set-Location $root

$src = Join-Path $root "server\routes\affiliateBridgeS16.js"
$bak = Join-Path $root "server\routes\affiliateBridgeS16.js.bak"
$fix = Join-Path $root "affiliateBridgeS16.paidfix.js"

if (-not (Test-Path $src)) { throw "MISSING: $src" }
if (-not (Test-Path $fix)) { throw "MISSING: $fix (server\ klasörüyle aynı seviyede olmalı)" }

Copy-Item $src $bak -Force
Copy-Item $fix $src -Force

Write-Host "OK: affiliateBridgeS16.js patched. Backup => affiliateBridgeS16.js.bak" -ForegroundColor Green
