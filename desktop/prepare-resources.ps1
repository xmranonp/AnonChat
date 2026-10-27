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
    $env:ANON_BIN = "C:\path\to\anon.exe"     # must be listed in anon-sha256.txt
    .\prepare-resources.ps1
#>

$ErrorActionPreference = "Stop"
$Here        = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectRoot = Split-Path -Parent $Here
$Res         = Join-Path $Here "resources"
$NodeVersion = if ($env:NODE_VERSION) { $env:NODE_VERSION } else { "24.22.1" }   # 24.22.1+: Node security release of 21 Oct 2026 (CVE-2026-111497, Brotli decoder)

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

# Everything is copied to, or downloaded into, a new folder of this run, and the file checked is the file used: nothing left in
# %TEMP% by an earlier run (or by anything else) is reused, and nothing can be swapped in between the check and the use.
$Work = Join-Path $env:TEMP ("anonchat-prep-" + [guid]::NewGuid().ToString())
New-Item -ItemType Directory -Force -Path $Work | Out-Null

# The anon binary must be one listed in anon-sha256.txt: the exact builds this project has checked and decided to ship.
$AnonCopy = Join-Path $Work "anon.exe"
Copy-Item $AnonPath $AnonCopy -Force
$AnonSha = (Get-FileHash -Algorithm SHA256 -Path $AnonCopy).Hash.ToLower()
$Pins = Join-Path $Here "anon-sha256.txt"
$Pinned = $null
if (Test-Path $Pins) {
  $Pinned = Get-Content $Pins | Where-Object { $_ -notmatch '^\s*#' -and $_.Trim() -ne '' } |
    Where-Object { ($_.Trim() -split '\s+')[0].ToLower() -eq $AnonSha } | Select-Object -First 1
}
if (-not $Pinned) {
  Write-Host "!! this anon binary is not in desktop\anon-sha256.txt:" -ForegroundColor Red
  Write-Host "     $AnonPath"
  Write-Host "     SHA-256 $AnonSha"
  Write-Host "   If it comes from the release you mean to ship (checked as anon-sha256.txt describes), add this line to that file:"
  Write-Host "     $AnonSha  win-x64  anon <version>"
  Remove-Item -Recurse -Force $Work
  throw "anon binary not pinned"
}
Write-Host "    anon pinned:  $((($Pinned.Trim() -split '\s+', 2)[1]))"

Write-Host "==> staging Node runtime"
$RuntimeDir = Join-Path $Res "runtime"
New-Item -ItemType Directory -Force -Path $RuntimeDir | Out-Null
$NodeName = "node-v$NodeVersion-win-x64.zip"
$NodeZip = Join-Path $Work $NodeName
if ($env:NODE_ZIP) {
  Copy-Item $env:NODE_ZIP $NodeZip -Force
} else {
  $Url = "https://nodejs.org/dist/v$NodeVersion/$NodeName"
  Write-Host "    downloading $Url"
  Invoke-WebRequest -Uri $Url -OutFile $NodeZip -UseBasicParsing
}
# Check the runtime against the SHA-256 list Node publishes for this release before bundling it (as prepare-resources.sh does).
$Sums = (Invoke-WebRequest -Uri "https://nodejs.org/dist/v$NodeVersion/SHASUMS256.txt" -UseBasicParsing).Content
if ($Sums -is [byte[]]) { $Sums = [System.Text.Encoding]::ASCII.GetString($Sums) }
$Want = $null
foreach ($line in ($Sums -split "`r?`n")) {
  $f = $line.Trim() -split '\s+'
  if ($f.Count -ge 2 -and $f[1] -eq $NodeName) { $Want = $f[0].ToLower(); break }
}
$Got = (Get-FileHash -Algorithm SHA256 -Path $NodeZip).Hash.ToLower()
if (-not $Want -or $Want -ne $Got) {
  Write-Host "!! Node runtime checksum mismatch for $NodeName" -ForegroundColor Red
  Write-Host "   expected: $(if ($Want) { $Want } else { '<not listed>' })"
  Write-Host "   got:      $Got"
  Remove-Item -Recurse -Force $Work
  throw "Node runtime checksum mismatch"
}
Write-Host "    checksum OK ($Got)"
$TmpN = Join-Path $Work "node"
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
Copy-Item $AnonCopy (Join-Path $RuntimeDir "anon.exe") -Force          # the copy whose hash was checked above
$AnonSrcDir = Split-Path -Parent $AnonPath
foreach ($g in @("geoip", "geoip6")) {
  $gp = Join-Path $AnonSrcDir $g
  if (Test-Path $gp) { Copy-Item $gp (Join-Path $RuntimeDir $g) -Force }
}
Write-Host "    anon.exe staged"
Remove-Item -Recurse -Force $Work

Write-Host ""
Write-Host "==> done. Resources ready under $Res"
Write-Host ""
Write-Host "    Next steps:"
Write-Host "      npm ci             # one-time: Electron + electron-builder (exact versions)"
Write-Host "      npm start          # dev mode (sandboxed; npm run start:nosandbox only if the sandbox can't start)"
Write-Host "      npm run build      # produces dist\AnonChat Setup *.exe (+ portable)"
