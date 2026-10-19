#Requires -Version 5.1
<#
  prepare-resources.ps1 - Windows equivalent of prepare-resources.sh.

  Stages everything the Windows build (NSIS / portable) bundles:
    desktop\resources\app\          -> server.js, start.js, lib\, public\, app_modules\
    desktop\resources\runtime\node.exe  -> portable Node runtime
    desktop\resources\runtime\anon.exe  -> anon daemon (from the Windows release)

  The backend deps are pure JavaScript (express, ws, axios, socks-proxy-agent),
  so no compiler toolchain is required for `npm ci`.

  Usage (PowerShell):
    $env:ANON_BIN = "C:\path\to\anon.exe"
    .\prepare-resources.ps1
#>

$ErrorActionPreference = "Stop"
$Here        = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectRoot = Split-Path -Parent $Here
$Res         = Join-Path $Here "resources"
$NodeVersion = if ($env:NODE_VERSION) { $env:NODE_VERSION } else { "22.23.1" }

Write-Host "==> AnonChat resource staging (Windows)"
Write-Host "    project root: $ProjectRoot"
Write-Host "    resources:    $Res"

if (-not $env:ANON_BIN) { throw "ANON_BIN is required (full path to anon.exe)" }
$AnonPath = $env:ANON_BIN
if (Test-Path $AnonPath -PathType Container) {
  $Inner = Join-Path $AnonPath "anon.exe"
  if (-not (Test-Path $Inner -PathType Leaf)) { throw "ANON_BIN is a folder with no anon.exe inside: $AnonPath" }
  $AnonPath = $Inner
}
if (-not (Test-Path $AnonPath -PathType Leaf)) { throw "ANON_BIN not found: $AnonPath" }
Write-Host "    anon:         $AnonPath"

Write-Host "==> staging Node runtime"
$RuntimeDir = Join-Path $Res "runtime"
New-Item -ItemType Directory -Force -Path $RuntimeDir | Out-Null
$NodeZip = Join-Path $env:TEMP "node-v$NodeVersion-win-x64.zip"
if (-not (Test-Path $NodeZip)) {
  $Url = "https://nodejs.org/dist/v$NodeVersion/node-v$NodeVersion-win-x64.zip"
  Write-Host "    downloading $Url"
  Invoke-WebRequest -Uri $Url -OutFile $NodeZip
}
$TmpN = Join-Path $env:TEMP ("node-" + [guid]::NewGuid().ToString())
Expand-Archive -Path $NodeZip -DestinationPath $TmpN -Force
$NodeExe = Get-ChildItem -Path $TmpN -Recurse -Filter "node.exe" | Select-Object -First 1
if (-not $NodeExe) { throw "could not find node.exe inside $NodeZip" }
$NodeDir = Split-Path -Parent $NodeExe.FullName
Copy-Item $NodeExe.FullName (Join-Path $RuntimeDir "node.exe") -Force
$BundledNode = Join-Path $RuntimeDir "node.exe"
Write-Host "    node -> $(& $BundledNode --version)"

Write-Host "==> staging app code"
$AppDir = Join-Path $Res "app"
if (Test-Path $AppDir) { Remove-Item -Recurse -Force $AppDir }
New-Item -ItemType Directory -Force -Path $AppDir | Out-Null
Copy-Item (Join-Path $ProjectRoot "server.js")    $AppDir
Copy-Item (Join-Path $ProjectRoot "start.js")     $AppDir
Copy-Item (Join-Path $ProjectRoot "package.json") $AppDir
$Lock = Join-Path $ProjectRoot "package-lock.json"
if (Test-Path $Lock) { Copy-Item $Lock $AppDir }
Copy-Item -Recurse (Join-Path $ProjectRoot "lib")    $AppDir
Copy-Item -Recurse (Join-Path $ProjectRoot "public") $AppDir

Write-Host "==> installing production node_modules"
$env:PATH = "$NodeDir;$env:PATH"
Push-Location $AppDir
try {
  if (Test-Path (Join-Path $AppDir "package-lock.json")) {
    Write-Host "    lockfile found -> npm ci (reproducible)"
    & npm ci --omit=dev --no-audit --no-fund --loglevel=warn
  } else {
    Write-Host "    WARNING: no package-lock.json - build is NOT reproducible."
    & npm install --omit=dev --no-audit --no-fund --loglevel=warn
  }
} finally { Pop-Location }

# electron-builder strips any dir literally named "node_modules" from
# extraResources; rename so it survives. start.js points NODE_PATH here.
$NM = Join-Path $AppDir "node_modules"
if (Test-Path $NM) {
  $AM = Join-Path $AppDir "app_modules"
  if (Test-Path $AM) { Remove-Item -Recurse -Force $AM }
  Move-Item $NM $AM
  Write-Host "    node_modules -> app_modules"
}

Write-Host "==> staging anon.exe"
Copy-Item $AnonPath (Join-Path $RuntimeDir "anon.exe") -Force
$AnonSrcDir = Split-Path -Parent $AnonPath
foreach ($g in @("geoip", "geoip6")) {
  $gp = Join-Path $AnonSrcDir $g
  if (Test-Path $gp) { Copy-Item $gp (Join-Path $RuntimeDir $g) -Force }
}
Write-Host "    anon.exe staged"

Write-Host ""
Write-Host "==> done. Resources ready under $Res"
Write-Host ""
Write-Host "    Next steps:"
Write-Host "      npm ci             # one-time: Electron + electron-builder (exact versions)"
Write-Host "      npm start          # dev mode (sandboxed; npm run start:nosandbox only if the sandbox can't start)"
Write-Host "      npm run build      # produces dist\AnonChat Setup *.exe (+ portable)"
