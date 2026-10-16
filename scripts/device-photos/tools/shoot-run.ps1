# Headless Edge + CDP screenshots of a built dist (no window, no app launch, nothing touches hardware).
#   shoot-run.ps1 -Dist <dir> -Out <dir> -Query "..." -Steps "size:1500x940","wait:2500","shot:home" ...
param([Parameter(Mandatory)] [string]$Dist, [Parameter(Mandatory)] [string]$Out, [string]$Query = "", [Parameter(Mandatory)] [string[]]$Steps, [int]$Port = 9477, [int]$HttpPort = 14711, [string]$Perf = (Join-Path $env:TEMP "onboard-perf\phase1"))
$ErrorActionPreference = "Stop"
$perf = $Perf
$shoot = Join-Path $PSScriptRoot "shoot2.mjs"
New-Item -ItemType Directory -Force $Out | Out-Null
$serve = Start-Process -FilePath node -ArgumentList @((Join-Path $perf "serve.cjs"), $Dist, $HttpPort) -PassThru -WindowStyle Hidden
$profile = Join-Path $env:TEMP "edge-profile-photos-$HttpPort"
if (Test-Path $profile) { Remove-Item -Recurse -Force $profile }
$url = "http://127.0.0.1:$HttpPort/" + $(if ($Query) { "?$Query" } else { "" })
$edge = Start-Process -FilePath "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" -ArgumentList @("--headless=new", "--remote-debugging-port=$Port", "--user-data-dir=$profile", "--window-size=1500,940", "--no-first-run", "--disable-extensions", "--force-device-scale-factor=1", $url) -PassThru -WindowStyle Hidden
$env:CDP_PORT = $Port
try {
  Start-Sleep -Seconds 4
  node $shoot $Out @Steps | Out-String
} finally {
  try { Stop-Process -Id $edge.Id -Force -ErrorAction Stop } catch {}
  Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" | Where-Object { $_.CommandLine -match [regex]::Escape($profile) } | ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop } catch {} }
  try { Stop-Process -Id $serve.Id -Force -ErrorAction Stop } catch {}
  Start-Sleep -Milliseconds 500
  if (Test-Path $profile) { try { Remove-Item -Recurse -Force $profile } catch {} }
}
