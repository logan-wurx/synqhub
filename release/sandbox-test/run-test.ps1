<#
  Fresh-install test for the SYNQ beta installer. It is meant to run INSIDE Windows Sandbox
  (onboard-sandbox.wsb starts it) and refuses to run anywhere else, because it installs the app.

  What it does, in order:
    1. notes the Sandbox (Windows build, WebView2, sound outputs) and that it is a clean machine
    2. checks the installer file (SHA-256 against SHA256SUMS.txt, signature state)
    3. runs the installer silently (/S) and checks the exit code
    4. checks what the installer put on the machine: the app, the bundled Equalizer APO installer,
       the Start menu / desktop shortcuts, the uninstall entry
    5. checks Equalizer APO (EQ engine) the SYNQ installer set up: files, registry, Windows'
       "protected audio" setting, the update-check task removed, a flat EQ config, and whether it is on
       the default sound output (SYNQ's own `--eq-engine status`, plus a direct registry read)
    6. starts SYNQ, waits for its window, checks it keeps running and has its web view, takes a
       screenshot, then closes it
    7. uninstalls silently and checks that Equalizer APO is left installed (as documented)
    8. writes RESULTS.md / RESULTS.json (+ the raw files) to the mapped output folder

  Sandbox has no real sound card. If it shows no sound output, the "on the default output" check is
  reported as a warning, not a failure: installing and registering the engine is still checked.

  Pure PowerShell 5.1, ASCII only (Sandbox's built-in PowerShell reads it as-is).
  `-SelfTest` checks this script's own judging logic on canned data and touches nothing, so it is safe
  to run on a normal PC.
#>
[CmdletBinding()]
param(
  [string]$ReleaseDir = 'C:\SYNQRelease',
  [string]$OutDir = 'C:\Results',
  [switch]$NoUninstall,
  [switch]$Elevated,
  [switch]$SelfTest,
  [switch]$ImOnAThrowawayVm
)

$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'

# ---------------------------------------------------------------------------------------------
# Constants (Equalizer APO 1.4.2, same values as src-tauri/src/engine/model.rs)
# ---------------------------------------------------------------------------------------------
$PreMixClsid  = '{EACD2258-FCAC-4FF4-B36D-419E924A6D79}'
$PostMixClsid = '{EC1CC9CE-FAED-4822-828A-82A81A6F018F}'
$EapoUpdateTask = 'EqualizerAPOUpdateChecker'
$WebView2Guid = '{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}'

# ---------------------------------------------------------------------------------------------
# Results
# ---------------------------------------------------------------------------------------------
$script:Checks = New-Object System.Collections.ArrayList
$script:Started = Get-Date

function Save-Progress {
  if (-not $script:OutReady) { return }
  try {
    $script:Checks | ConvertTo-Json -Depth 4 | Set-Content -Path (Join-Path $OutDir 'progress.json') -Encoding UTF8
  } catch { }
}

function Add-Check {
  param([string]$Id, [string]$Name, [string]$Status, [string]$Detail = '')
  $row = [pscustomobject]@{ id = $Id; name = $Name; status = $Status; detail = $Detail; at = (Get-Date).ToString('HH:mm:ss') }
  [void]$script:Checks.Add($row)
  $color = 'Gray'
  if ($Status -eq 'PASS') { $color = 'Green' }
  elseif ($Status -eq 'FAIL') { $color = 'Red' }
  elseif ($Status -eq 'WARN') { $color = 'Yellow' }
  $line = '[{0}] {1}' -f $Status, $Name
  if ($Detail) { $line += ' - ' + $Detail }
  Write-Host $line -ForegroundColor $color
  Save-Progress
}

function Get-Verdict {
  param($Checks)
  $fail = @($Checks | Where-Object { $_.status -eq 'FAIL' }).Count
  $warn = @($Checks | Where-Object { $_.status -eq 'WARN' }).Count
  if ($fail -gt 0) { return 'FAIL' }
  if ($warn -gt 0) { return 'PASS with warnings' }
  return 'PASS'
}

# ---------------------------------------------------------------------------------------------
# Pure helpers (these are what -SelfTest exercises)
# ---------------------------------------------------------------------------------------------

# SYNQ's `--eq-engine status` prints one JSON document. Anything before the first "{" is ignored.
function ConvertFrom-StatusText {
  param([string]$Text)
  if (-not $Text) { return $null }
  $i = $Text.IndexOf('{')
  if ($i -lt 0) { return $null }
  try { return ($Text.Substring($i) | ConvertFrom-Json) } catch { return $null }
}

# A config SYNQ wrote for a fresh engine: a comment, "Preamp: 0 dB" and nothing else that acts.
function Test-FlatConfig {
  param([string]$Text)
  $problems = @()
  $preamp = $null
  foreach ($raw in ($Text -split "`r?`n")) {
    $line = $raw.Trim()
    if (-not $line -or $line.StartsWith('#')) { continue }
    if ($line -match '^Preamp:\s*(-?[0-9.]+)\s*dB$') { $preamp = [double]$matches[1]; continue }
    $problems += $line
  }
  if ($preamp -eq $null) { $problems += '(no Preamp line)' }
  elseif ($preamp -ne 0) { $problems += "Preamp is $preamp dB" }
  return [pscustomobject]@{ flat = ($problems.Count -eq 0); problems = $problems }
}

# Turns the status JSON into checks. $Where names the moment ("after install", "after launch").
function Get-StatusChecks {
  param($Status, [string]$Where)
  $out = @()
  $tag = $Where -replace '\s+', '-'
  if (-not $Status) {
    return @([pscustomobject]@{ id = "status-$tag"; name = "SYNQ status ($Where)"; status = 'WARN'; detail = 'No JSON came back from "synq.exe --eq-engine status" (a console-less exe can lose its output); the direct registry checks below still apply.' })
  }
  $out += [pscustomobject]@{ id = "status-installed-$tag"; name = "SYNQ sees Equalizer APO installed ($Where)"; status = $(if ($Status.installed -eq $true) { 'PASS' } else { 'FAIL' }); detail = "version $($Status.version), path $($Status.installPath)" }
  $out += [pscustomobject]@{ id = "status-registered-$tag"; name = "Windows knows the engine's effect classes ($Where)"; status = $(if ($Status.registered -eq $true) { 'PASS' } else { 'FAIL' }); detail = '' }
  $out += [pscustomobject]@{ id = "status-bundled-$tag"; name = "Bundled engine installer found next to the app ($Where)"; status = $(if ($Status.installerReady -eq $true) { 'PASS' } else { 'FAIL' }); detail = '' }
  $problems = @()
  if ($Status.problems) { $problems = @($Status.problems | ForEach-Object { $_.message }) }
  $state = [string]$Status.state
  if ($state -eq 'active') {
    $out += [pscustomobject]@{ id = "status-default-$tag"; name = "EQ engine is on the default sound output ($Where)"; status = 'PASS'; detail = [string]$Status.summary }
  } elseif ($state -eq 'noOutput') {
    $out += [pscustomobject]@{ id = "status-default-$tag"; name = "EQ engine is on the default sound output ($Where)"; status = 'WARN'; detail = 'This Sandbox has no sound output, so there was nothing to put the engine on. Test this step on a real PC (or a Sandbox with audio).' }
  } else {
    $out += [pscustomobject]@{ id = "status-default-$tag"; name = "EQ engine is on the default sound output ($Where)"; status = 'FAIL'; detail = ("state '{0}': {1}" -f $state, ($problems -join ' | ')) }
  }
  return $out
}

# ---------------------------------------------------------------------------------------------
# Self test (no install, no registry writes)
# ---------------------------------------------------------------------------------------------
if ($SelfTest) {
  $bad = 0
  function Expect($name, $cond) { if ($cond) { Write-Host "ok   $name" -ForegroundColor Green } else { Write-Host "FAIL $name" -ForegroundColor Red; $script:bad++ } }
  $active = '{"state":"active","summary":"on - Speakers output","installed":true,"version":"1.4.2","installPath":"C:\\Program Files\\EqualizerAPO","registered":true,"problems":[],"installerReady":true}'
  $none = '{"state":"noOutput","summary":"no sound output","installed":true,"version":"1.4.2","installPath":"C:\\Program Files\\EqualizerAPO","registered":true,"problems":[],"installerReady":true}'
  $broken = '{"state":"broken","summary":"x","installed":true,"version":"1.4.2","registered":true,"installerReady":true,"problems":[{"code":"protectedAudio","blocking":true,"message":"A Windows setting the EQ engine needs was reset."}]}'
  $a = Get-StatusChecks (ConvertFrom-StatusText $active) 'test'
  Expect 'active status passes' (@($a | Where-Object { $_.status -ne 'PASS' }).Count -eq 0)
  $n = Get-StatusChecks (ConvertFrom-StatusText $none) 'test'
  Expect 'noOutput is a warning, not a failure' ((@($n | Where-Object { $_.status -eq 'FAIL' }).Count -eq 0) -and (@($n | Where-Object { $_.status -eq 'WARN' }).Count -eq 1))
  $b = Get-StatusChecks (ConvertFrom-StatusText $broken) 'test'
  Expect 'broken status fails and names the problem' ((@($b | Where-Object { $_.status -eq 'FAIL' -and $_.detail -match 'protectedAudio|reset' }).Count -eq 1))
  Expect 'text before the JSON is ignored' ((ConvertFrom-StatusText ("noise`r`n" + $active)).state -eq 'active')
  Expect 'no JSON gives a warning' ((Get-StatusChecks (ConvertFrom-StatusText 'nothing here') 'test')[0].status -eq 'WARN')
  Expect 'flat config accepted' ((Test-FlatConfig "# Written by SYNQ. Hand edits are fine; SYNQ re-reads this file.`r`nPreamp: 0 dB`r`n").flat)
  Expect 'sample config with filters rejected' (-not (Test-FlatConfig "Preamp: -6 dB`r`nInclude: example.txt`r`nFilter: ON PK Fc 100 Hz Gain 3 dB Q 1`r`n").flat)
  Expect 'a preamp other than 0 rejected' (-not (Test-FlatConfig "Preamp: -3 dB`r`n").flat)
  Expect 'empty config rejected' (-not (Test-FlatConfig '').flat)
  $rows = @([pscustomobject]@{ status = 'PASS' }, [pscustomobject]@{ status = 'WARN' })
  Expect 'verdict: warnings' ((Get-Verdict $rows) -eq 'PASS with warnings')
  Expect 'verdict: fail wins' ((Get-Verdict ($rows + [pscustomobject]@{ status = 'FAIL' })) -eq 'FAIL')
  Expect 'verdict: clean' ((Get-Verdict @([pscustomobject]@{ status = 'PASS' })) -eq 'PASS')
  $parseErrors = $null
  $parseTokens = $null
  $null = [System.Management.Automation.Language.Parser]::ParseFile($PSCommandPath, [ref]$parseTokens, [ref]$parseErrors)
  Expect 'script parses with no errors' ($parseErrors.Count -eq 0)
  $nonAscii = [System.IO.File]::ReadAllBytes($PSCommandPath) | Where-Object { $_ -gt 127 }
  Expect 'script is ASCII only' (-not $nonAscii)
  if ($bad -gt 0) { Write-Host "$bad self-test check(s) failed." -ForegroundColor Red; exit 1 }
  Write-Host 'Self-test passed.' -ForegroundColor Green
  exit 0
}

# ---------------------------------------------------------------------------------------------
# Guards: Sandbox only, elevated
# ---------------------------------------------------------------------------------------------
function Test-Admin {
  $id = [Security.Principal.WindowsIdentity]::GetCurrent()
  return ([Security.Principal.WindowsPrincipal]$id).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

if (($env:USERNAME -ne 'WDAGUtilityAccount') -and (-not $ImOnAThrowawayVm)) {
  Write-Host 'This script installs SYNQ and Equalizer APO, so it only runs inside Windows Sandbox (user WDAGUtilityAccount).' -ForegroundColor Red
  Write-Host 'Double-click onboard-sandbox.wsb instead. To check the script itself on this PC without installing anything: run-test.ps1 -SelfTest' -ForegroundColor Red
  exit 9
}

if (-not (Test-Admin)) {
  if ($Elevated) {
    Write-Host 'Still not an administrator after asking Windows. The installer is per-machine and needs it.' -ForegroundColor Red
    exit 8
  }
  Write-Host 'Asking for administrator rights (click Yes if Windows asks)...'
  $argList = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-NoExit', '-File', ('"{0}"' -f $PSCommandPath), '-Elevated', '-ReleaseDir', ('"{0}"' -f $ReleaseDir), '-OutDir', ('"{0}"' -f $OutDir))
  if ($NoUninstall) { $argList += '-NoUninstall' }
  if ($ImOnAThrowawayVm) { $argList += '-ImOnAThrowawayVm' }
  try { Start-Process -FilePath 'powershell.exe' -Verb RunAs -ArgumentList $argList } catch { Write-Host "Could not elevate: $_" -ForegroundColor Red; exit 8 }
  exit 0
}

# ---------------------------------------------------------------------------------------------
# Set-up
# ---------------------------------------------------------------------------------------------
$script:OutReady = $false
try {
  if (-not (Test-Path $OutDir)) { New-Item -ItemType Directory -Path $OutDir -Force | Out-Null }
  $script:OutReady = $true
} catch {
  $OutDir = Join-Path $env:USERPROFILE 'Desktop\onboard-results'
  New-Item -ItemType Directory -Path $OutDir -Force | Out-Null
  $script:OutReady = $true
  Write-Host "The mapped results folder isn't there; writing to $OutDir inside the Sandbox instead." -ForegroundColor Yellow
}
$Work = Join-Path $env:TEMP 'onboard-test'
New-Item -ItemType Directory -Path $Work -Force | Out-Null
Start-Transcript -Path (Join-Path $OutDir 'transcript.txt') -Force | Out-Null

$cfgPath = Join-Path $PSScriptRoot 'app.json'
$cfg = $null
if (Test-Path $cfgPath) { $cfg = Get-Content $cfgPath -Raw | ConvertFrom-Json }
if (-not $cfg) {
  Write-Host 'app.json is missing next to this script (node release/tools/render-docs.mjs makes it); using built-in defaults.' -ForegroundColor Yellow
  $cfg = [pscustomobject]@{ name = 'SYNQ'; identifier = 'com.logan.onboard'; version = ''; exe = 'synq.exe'; installer = ''; eapo = [pscustomobject]@{ version = '1.4.2'; file = 'EqualizerAPO-x64-1.4.2.exe'; size = 11980366; sha256 = '7403be7427bbe1936a40dded082829b6e217fc4f5990fee5cba501f0ae055afa' } }
}
$AppName = $cfg.name
Write-Host ''
Write-Host "=== $AppName $($cfg.version) fresh-install test ===" -ForegroundColor Cyan
Write-Host "Started $($script:Started)"

function Invoke-Step {
  param([string]$Name, [scriptblock]$Body)
  try { & $Body } catch { Add-Check -Id "error-$Name" -Name "Step '$Name' hit an error" -Status 'FAIL' -Detail ($_.Exception.Message) }
}

function Wait-Until {
  param([scriptblock]$Condition, [int]$Seconds, [int]$EveryMs = 500)
  $deadline = (Get-Date).AddSeconds($Seconds)
  while ((Get-Date) -lt $deadline) {
    if (& $Condition) { return $true }
    Start-Sleep -Milliseconds $EveryMs
  }
  return [bool](& $Condition)
}

function Get-Sha256 {
  param([string]$Path)
  return (Get-FileHash -Algorithm SHA256 -Path $Path).Hash.ToLower()
}

function Find-Uninstall {
  param([string]$DisplayName)
  foreach ($root in @('HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall', 'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall')) {
    if (-not (Test-Path $root)) { continue }
    foreach ($k in Get-ChildItem $root -ErrorAction SilentlyContinue) {
      $p = Get-ItemProperty $k.PSPath -ErrorAction SilentlyContinue
      if ($p -and $p.DisplayName -eq $DisplayName) { return $p }
    }
  }
  return $null
}

# Sound outputs as Windows lists them, with whether the engine's classes are on each.
function Get-RenderEndpoints {
  $base = 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\MMDevices\Audio\Render'
  $rows = @()
  if (-not (Test-Path $base)) { return $rows }
  foreach ($k in Get-ChildItem $base -ErrorAction SilentlyContinue) {
    # DeviceState: low bits are 1 active, 2 disabled, 4 not present, 8 unplugged (higher bits are flags).
    $state = [int64](Get-ItemProperty $k.PSPath -ErrorAction SilentlyContinue).DeviceState -band 15
    $props = Get-ItemProperty (Join-Path $k.PSPath 'Properties') -ErrorAction SilentlyContinue
    $desc = ''
    $iface = ''
    if ($props) {
      $d = $props.PSObject.Properties['{a45c254e-df1c-4efd-8020-67d146a850e0},2']
      if ($d) { $desc = [string]$d.Value }
      $f = $props.PSObject.Properties['{b3f8fa53-0004-438e-9003-51a46e139bfc},6']
      if ($f) { $iface = [string]$f.Value }
    }
    $hasEngine = $false
    $fx = Get-ItemProperty (Join-Path $k.PSPath 'FxProperties') -ErrorAction SilentlyContinue
    if ($fx) {
      foreach ($p in $fx.PSObject.Properties) {
        $v = [string]$p.Value
        if ($v -and ($v.ToUpper().Contains($PreMixClsid.ToUpper()) -or $v.ToUpper().Contains($PostMixClsid.ToUpper()))) { $hasEngine = $true }
      }
    }
    $rows += [pscustomobject]@{ id = $k.PSChildName; state = $state; name = ("{0} ({1})" -f $desc, $iface); engine = $hasEngine }
  }
  return $rows
}

# Runs `synq.exe --eq-engine <args>` with its output captured to a file (the exe has no console of
# its own, so the output has to be redirected to be seen).
function Invoke-Helper {
  param([string]$Exe, [string[]]$HelperArgs, [string]$Tag, [int]$TimeoutSec = 90)
  $so = Join-Path $Work "$Tag.stdout.txt"
  $se = Join-Path $Work "$Tag.stderr.txt"
  Remove-Item $so, $se -ErrorAction SilentlyContinue
  $p = Start-Process -FilePath $Exe -ArgumentList $HelperArgs -PassThru -NoNewWindow -RedirectStandardOutput $so -RedirectStandardError $se
  $null = $p.Handle
  $done = $p.WaitForExit($TimeoutSec * 1000)
  if (-not $done) { try { $p.Kill() } catch { } }
  $text = ''
  if (Test-Path $so) { $text = Get-Content $so -Raw -ErrorAction SilentlyContinue }
  $errText = ''
  if (Test-Path $se) { $errText = Get-Content $se -Raw -ErrorAction SilentlyContinue }
  Copy-Item $so (Join-Path $OutDir "$Tag.stdout.txt") -ErrorAction SilentlyContinue
  if ($errText) { Copy-Item $se (Join-Path $OutDir "$Tag.stderr.txt") -ErrorAction SilentlyContinue }
  $code = $null
  if ($done) { $code = $p.ExitCode }
  return [pscustomobject]@{ timedOut = (-not $done); exitCode = $code; stdout = $text; stderr = $errText }
}

function Save-Screenshot {
  param([string]$Path)
  try {
    Add-Type -AssemblyName System.Windows.Forms, System.Drawing
    $b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
    $bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size)
    $bmp.Save($Path, [System.Drawing.Imaging.ImageFormat]::Png)
    $g.Dispose(); $bmp.Dispose()
    return $true
  } catch { return $false }
}

$InstDir = $null
$Exe = $null

# ---------------------------------------------------------------------------------------------
# 1. The machine
# ---------------------------------------------------------------------------------------------
Invoke-Step 'machine' {
  $os = Get-CimInstance Win32_OperatingSystem
  $wv = $null
  foreach ($path in @("HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\$WebView2Guid", "HKLM:\SOFTWARE\Microsoft\EdgeUpdate\Clients\$WebView2Guid")) {
    if (Test-Path $path) { $wv = (Get-ItemProperty $path).pv; break }
  }
  $ends = @(Get-RenderEndpoints | Where-Object { $_.state -eq 1 })
  $audio = Get-Service -Name Audiosrv -ErrorAction SilentlyContinue
  $outsLine = "Active sound outputs: $($ends.Count)"
  if ($ends.Count -gt 0) { $outsLine += ' - ' + (($ends | ForEach-Object { $_.name }) -join '; ') }
  $netUp = '?'
  try { $netUp = @(Get-NetAdapter -ErrorAction Stop | Where-Object { $_.Status -eq 'Up' }).Count } catch { }
  $lines = @(
    "Windows: $($os.Caption) $($os.Version) (build $($os.BuildNumber)), $($os.OSArchitecture)",
    "User: $env:USERNAME, administrator: $(Test-Admin)",
    "WebView2 runtime: $(if ($wv) { $wv } else { 'not installed' })",
    "Windows Audio service: $(if ($audio) { $audio.Status } else { 'missing' })",
    $outsLine,
    "Network adapters up: $netUp"
  )
  $lines | Set-Content (Join-Path $OutDir 'environment.txt') -Encoding UTF8
  $lines | ForEach-Object { Write-Host "  $_" }
  Add-Check 'env-webview2' 'WebView2 runtime present (SYNQ needs it)' $(if ($wv) { 'PASS' } else { 'WARN' }) $(if ($wv) { "version $wv" } else { 'not installed: the SYNQ installer will try to download it (needs the network)' })
  if (Test-Path 'HKLM:\SOFTWARE\EqualizerAPO') { Add-Check 'env-fresh-eapo' 'Machine starts without Equalizer APO' 'WARN' 'Equalizer APO is already here, so the "install when missing" path is NOT being tested.' }
  else { Add-Check 'env-fresh-eapo' 'Machine starts without Equalizer APO' 'PASS' '' }
  if (Find-Uninstall $AppName) { Add-Check 'env-fresh-app' "Machine starts without $AppName" 'WARN' 'already installed; this is an upgrade/repair test, not a fresh install' }
  else { Add-Check 'env-fresh-app' "Machine starts without $AppName" 'PASS' '' }
  if ($ends.Count -eq 0) { Add-Check 'env-audio' 'Sandbox has a sound output' 'INFO' 'none: the "on the default output" check will be a warning' }
  else { Add-Check 'env-audio' 'Sandbox has a sound output' 'INFO' "$($ends.Count) active" }
}

# ---------------------------------------------------------------------------------------------
# 2. The installer file
# ---------------------------------------------------------------------------------------------
$Installer = $null
Invoke-Step 'installer-file' {
  $candidate = $null
  if ($cfg.installer) { $candidate = Join-Path $ReleaseDir $cfg.installer }
  if (-not $candidate -or -not (Test-Path $candidate)) {
    $found = Get-ChildItem $ReleaseDir -Filter '*_x64-setup.exe' -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if ($found) { $candidate = $found.FullName }
  }
  if (-not $candidate -or -not (Test-Path $candidate)) { Add-Check 'installer-found' 'Installer file found in the mapped release folder' 'FAIL' "none in $ReleaseDir"; return }
  $local = Join-Path $Work (Split-Path $candidate -Leaf)
  Copy-Item $candidate $local -Force
  $script:Installer = $local
  $size = (Get-Item $local).Length
  $sha = Get-Sha256 $local
  Add-Check 'installer-found' 'Installer file found in the mapped release folder' 'PASS' ("{0} ({1:N0} bytes)" -f (Split-Path $candidate -Leaf), $size)
  $sums = Join-Path $ReleaseDir 'SHA256SUMS.txt'
  if (Test-Path $sums) {
    $expected = ((Get-Content $sums | Where-Object { $_ -match [regex]::Escape((Split-Path $candidate -Leaf)) } | Select-Object -First 1) -split '\s+')[0]
    if ($expected -and $expected.ToLower() -eq $sha) { Add-Check 'installer-sha' 'Installer SHA-256 matches SHA256SUMS.txt' 'PASS' $sha }
    else { Add-Check 'installer-sha' 'Installer SHA-256 matches SHA256SUMS.txt' 'FAIL' "got $sha, expected $expected" }
  } else { Add-Check 'installer-sha' 'Installer SHA-256' 'INFO' "$sha (no SHA256SUMS.txt to compare with)" }
  $sig = Get-AuthenticodeSignature $local
  Add-Check 'installer-signature' 'Installer signature' 'INFO' "$($sig.Status) (unsigned is expected for the beta: Windows SmartScreen will warn)"
}

# ---------------------------------------------------------------------------------------------
# 3. Install, silently
# ---------------------------------------------------------------------------------------------
$Installed = $false
if ($script:Installer) {
  Invoke-Step 'install' {
    Write-Host ''
    Write-Host 'Installing silently (the EQ engine step can take a minute)...' -ForegroundColor Cyan
    $t0 = Get-Date
    $p = Start-Process -FilePath $script:Installer -ArgumentList '/S' -PassThru
    $null = $p.Handle
    $done = $p.WaitForExit(600000)
    $secs = [int]((Get-Date) - $t0).TotalSeconds
    if (-not $done) {
      try { Stop-Process -Id $p.Id -Force } catch { }
      Add-Check 'install-exit' 'Silent install finished' 'FAIL' "still running after $secs s (killed)"
      return
    }
    if ($p.ExitCode -eq 0) { Add-Check 'install-exit' 'Silent install finished with exit code 0' 'PASS' "$secs s"; $script:Installed = $true }
    else { Add-Check 'install-exit' 'Silent install finished with exit code 0' 'FAIL' "exit code $($p.ExitCode) after $secs s" }
  }
} else {
  Add-Check 'install-exit' 'Silent install' 'SKIP' 'no installer'
}

# ---------------------------------------------------------------------------------------------
# 4. What the installer put on the machine
# ---------------------------------------------------------------------------------------------
Invoke-Step 'files' {
  $u = Find-Uninstall $AppName
  if (-not $u) { Add-Check 'files-uninstall-entry' "$AppName is in Apps & features (uninstall entry)" 'FAIL' 'no entry'; }
  else {
    Add-Check 'files-uninstall-entry' "$AppName is in Apps & features (uninstall entry)" 'PASS' "DisplayVersion $($u.DisplayVersion), publisher '$($u.Publisher)'"
    if ($cfg.version) {
      if ($u.DisplayVersion -eq $cfg.version) { Add-Check 'files-version' 'Installed version is the one that was built' 'PASS' $u.DisplayVersion }
      else { Add-Check 'files-version' 'Installed version is the one that was built' 'FAIL' "installed $($u.DisplayVersion), built $($cfg.version)" }
    }
    $script:InstDir = ([string]$u.InstallLocation).Trim('"')
  }
  if (-not $script:InstDir) { $script:InstDir = Join-Path ${env:ProgramFiles} $AppName }
  $script:Exe = Join-Path $script:InstDir $cfg.exe
  if (Test-Path $script:Exe) {
    $vi = (Get-Item $script:Exe).VersionInfo
    Add-Check 'files-exe' "$($cfg.exe) installed in Program Files" 'PASS' ("{0} - file version {1}, {2:N0} bytes" -f $script:InstDir, $vi.FileVersion, (Get-Item $script:Exe).Length)
  } else { Add-Check 'files-exe' "$($cfg.exe) installed in Program Files" 'FAIL' "not at $($script:Exe)" }
  if ($script:InstDir -and $script:InstDir.StartsWith(${env:ProgramFiles}, [StringComparison]::OrdinalIgnoreCase)) { Add-Check 'files-per-machine' 'Installed per machine (Program Files)' 'PASS' '' }
  else { Add-Check 'files-per-machine' 'Installed per machine (Program Files)' 'FAIL' $script:InstDir }

  $bundled = Join-Path $script:InstDir ('eq-engine\' + $cfg.eapo.file)
  if (Test-Path $bundled) {
    $sz = (Get-Item $bundled).Length
    $sha = Get-Sha256 $bundled
    if (($sz -eq [int64]$cfg.eapo.size) -and ($sha -eq $cfg.eapo.sha256)) { Add-Check 'files-eapo-installer' 'Bundled Equalizer APO installer is the official file (size and SHA-256)' 'PASS' $sha }
    else { Add-Check 'files-eapo-installer' 'Bundled Equalizer APO installer is the official file (size and SHA-256)' 'FAIL' "size $sz sha $sha" }
  } else { Add-Check 'files-eapo-installer' 'Bundled Equalizer APO installer is the official file (size and SHA-256)' 'FAIL' "missing: $bundled" }

  $uninst = Join-Path $script:InstDir 'uninstall.exe'
  Add-Check 'files-uninstaller' 'uninstall.exe installed' $(if (Test-Path $uninst) { 'PASS' } else { 'FAIL' }) ''
  $sm = Join-Path $env:ProgramData ("Microsoft\Windows\Start Menu\Programs\{0}.lnk" -f $AppName)
  Add-Check 'files-startmenu' 'Start menu shortcut' $(if (Test-Path $sm) { 'PASS' } else { 'WARN' }) $sm
  $desk = @((Join-Path $env:PUBLIC ("Desktop\{0}.lnk" -f $AppName)), (Join-Path ([Environment]::GetFolderPath('Desktop')) ("{0}.lnk" -f $AppName)))
  $deskFound = $desk | Where-Object { Test-Path $_ } | Select-Object -First 1
  Add-Check 'files-desktop' 'Desktop shortcut (silent installs add one)' $(if ($deskFound) { 'PASS' } else { 'WARN' }) $(if ($deskFound) { $deskFound } else { 'none found' })
  Get-ChildItem $script:InstDir -Recurse -ErrorAction SilentlyContinue | Select-Object FullName, Length | Format-Table -AutoSize -Wrap | Out-String -Width 220 | Set-Content (Join-Path $OutDir 'installed-files.txt') -Encoding UTF8
}

# ---------------------------------------------------------------------------------------------
# 5. Equalizer APO (the EQ engine)
# ---------------------------------------------------------------------------------------------
Invoke-Step 'eapo' {
  $key = 'HKLM:\SOFTWARE\EqualizerAPO'
  $installPath = $null
  if (Test-Path $key) { $installPath = (Get-ItemProperty $key).InstallPath }
  if (-not $installPath) { Add-Check 'eapo-installed' 'Equalizer APO installed (registry InstallPath)' 'FAIL' 'HKLM\SOFTWARE\EqualizerAPO has no InstallPath'; }
  else {
    Add-Check 'eapo-installed' 'Equalizer APO installed (registry InstallPath)' 'PASS' $installPath
    $dll = Join-Path $installPath 'EqualizerAPO.dll'
    Add-Check 'eapo-dll' 'EqualizerAPO.dll is in the install folder' $(if (Test-Path $dll) { 'PASS' } else { 'FAIL' }) $dll
    $ver = (Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\EqualizerAPO' -ErrorAction SilentlyContinue).DisplayVersion
    if ($ver -eq $cfg.eapo.version) { Add-Check 'eapo-version' "Equalizer APO is version $($cfg.eapo.version)" 'PASS' $ver } else { Add-Check 'eapo-version' "Equalizer APO is version $($cfg.eapo.version)" 'FAIL' "found '$ver'" }
  }
  foreach ($c in @($PreMixClsid, $PostMixClsid)) {
    $inClsid = Test-Path ("Registry::HKEY_CLASSES_ROOT\CLSID\" + $c)
    $inApo = Test-Path ("Registry::HKEY_CLASSES_ROOT\AudioEngine\AudioProcessingObjects\" + $c)
    Add-Check "eapo-class-$c" "Effect class $c registered with Windows (CLSID + AudioProcessingObjects)" $(if ($inClsid -and $inApo) { 'PASS' } else { 'FAIL' }) "CLSID=$inClsid APO=$inApo"
  }
  $dg = (Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Audio' -ErrorAction SilentlyContinue).DisableProtectedAudioDG
  Add-Check 'eapo-protected-dg' 'Windows allows unsigned audio effects (DisableProtectedAudioDG = 1)' $(if ($dg -eq 1) { 'PASS' } else { 'FAIL' }) "value: $dg"
  $task = Get-ScheduledTask -TaskName $EapoUpdateTask -ErrorAction SilentlyContinue
  Add-Check 'eapo-no-update-task' 'Equalizer APO update-check task was removed (nothing runs at logon)' $(if (-not $task) { 'PASS' } else { 'FAIL' }) $(if ($task) { "task $EapoUpdateTask exists" } else { '' })

  $cfgDir = $null
  if (Test-Path $key) { $cfgDir = (Get-ItemProperty $key).ConfigPath }
  if (-not $cfgDir -and $installPath) { $cfgDir = Join-Path $installPath 'config' }
  $conf = $null
  if ($cfgDir) { $conf = Join-Path $cfgDir 'config.txt' }
  if ($conf -and (Test-Path $conf)) {
    $r = Test-FlatConfig (Get-Content $conf -Raw)
    Add-Check 'eapo-flat-config' 'EQ starts flat (config.txt has no filters, 0 dB preamp)' $(if ($r.flat) { 'PASS' } else { 'FAIL' }) $(if ($r.flat) { $conf } else { ($r.problems | Select-Object -First 3) -join ' | ' })
    Copy-Item $conf (Join-Path $OutDir 'eapo-config.txt') -ErrorAction SilentlyContinue
  } else { Add-Check 'eapo-flat-config' 'EQ starts flat (config.txt has no filters, 0 dB preamp)' 'WARN' "no config.txt at $conf" }

  $ends = @(Get-RenderEndpoints)
  $ends | ConvertTo-Json -Depth 3 | Set-Content (Join-Path $OutDir 'render-endpoints.json') -Encoding UTF8
  $active = @($ends | Where-Object { $_.state -eq 1 })
  $withEngine = @($active | Where-Object { $_.engine })
  if ($active.Count -eq 0) { Add-Check 'eapo-registry-on-output' 'Engine is on an active sound output (direct registry read)' 'WARN' 'no active sound output in this Sandbox' }
  elseif ($withEngine.Count -gt 0) { Add-Check 'eapo-registry-on-output' 'Engine is on an active sound output (direct registry read)' 'PASS' (($withEngine | ForEach-Object { $_.name }) -join '; ') }
  else { Add-Check 'eapo-registry-on-output' 'Engine is on an active sound output (direct registry read)' 'FAIL' ("active outputs without it: " + (($active | ForEach-Object { $_.name }) -join '; ')) }

  # SYNQ's own view
  if ($script:Exe -and (Test-Path $script:Exe)) {
    $h = Invoke-Helper -Exe $script:Exe -HelperArgs @('--eq-engine', 'status') -Tag 'status-after-install'
    if ($h.timedOut) { Add-Check 'status-after-install' 'synq.exe --eq-engine status answered' 'FAIL' 'timed out' }
    else {
      $st = ConvertFrom-StatusText $h.stdout
      foreach ($c in (Get-StatusChecks $st 'after install')) { Add-Check $c.id $c.name $c.status $c.detail }
    }
    # A second dry run that must not write anything: shows what setup would do from here.
    $d = Invoke-Helper -Exe $script:Exe -HelperArgs @('--eq-engine', 'setup', '--dry-run') -Tag 'setup-dry-run' -TimeoutSec 60
    Add-Check 'setup-dry-run' 'synq.exe --eq-engine setup --dry-run runs (read-only)' $(if (-not $d.timedOut) { 'INFO' } else { 'WARN' }) $(if ($d.timedOut) { 'timed out' } else { "exit code $($d.exitCode); output saved as setup-dry-run.stdout.txt" })
  }
  $dataDir = Join-Path $env:APPDATA $cfg.identifier
  if (Test-Path (Join-Path $dataDir 'eq-engine\backups')) {
    Get-ChildItem (Join-Path $dataDir 'eq-engine\backups') | Select-Object Name, Length | Out-String | Set-Content (Join-Path $OutDir 'eq-engine-backups.txt') -Encoding UTF8
    Add-Check 'eapo-backup' 'Setup saved a backup of the values it changed (so it can be undone)' 'PASS' $dataDir
  } else {
    Add-Check 'eapo-backup' 'Setup saved a backup of the values it changed (so it can be undone)' 'INFO' 'none (expected when the Sandbox has no sound output: nothing was changed to undo)'
  }
}

# ---------------------------------------------------------------------------------------------
# 6. Start the app
# ---------------------------------------------------------------------------------------------
$AppProc = $null
if ($script:Exe -and (Test-Path $script:Exe)) {
  Invoke-Step 'launch' {
    Write-Host ''
    Write-Host "Starting $AppName..." -ForegroundColor Cyan
    # Windows Sandbox can list one WebView2 version in its registry while another is on disk (the host's runtime updated
    # itself): the WebView2 loader then says "not found" for every app there. Point the app at the folder that exists.
    $wvKey = Get-ItemProperty "HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\$WebView2Guid" -ErrorAction SilentlyContinue
    if ($wvKey -and $wvKey.location -and $wvKey.pv -and -not (Test-Path (Join-Path $wvKey.location $wvKey.pv))) {
      $real = Get-ChildItem $wvKey.location -Directory -ErrorAction SilentlyContinue | Where-Object { Test-Path (Join-Path $_.FullName 'msedgewebview2.exe') } | Sort-Object Name -Descending | Select-Object -First 1
      if ($real) {
        $env:WEBVIEW2_BROWSER_EXECUTABLE_FOLDER = $real.FullName
        Add-Check 'launch-wv2-sandbox' 'WebView2 version mismatch in this Sandbox worked around' 'INFO' ("registry says $($wvKey.pv), the disk has $($real.Name); the app is pointed at it for this launch (a Sandbox quirk, real PCs match)")
      }
    }
    $t0 = Get-Date
    $script:AppProc = Start-Process -FilePath $script:Exe -PassThru
    $null = $script:AppProc.Handle
    $seen = Wait-Until -Seconds 45 -Condition {
      $script:AppProc.Refresh()
      return ($script:AppProc.HasExited -or ($script:AppProc.MainWindowHandle -ne [IntPtr]::Zero -and $script:AppProc.MainWindowTitle))
    }
    $script:AppProc.Refresh()
    if ($script:AppProc.HasExited) { Add-Check 'launch-window' "$AppName window opens" 'FAIL' "the process exited with code $($script:AppProc.ExitCode)"; return }
    if (-not $seen) { Add-Check 'launch-window' "$AppName window opens" 'FAIL' 'no window after 45 s'; return }
    $title = $script:AppProc.MainWindowTitle
    Add-Check 'launch-window' "$AppName window opens" 'PASS' ("title '{0}' after {1:N1} s" -f $title, ((Get-Date) - $t0).TotalSeconds)
    if ($title -ne $AppName) { Add-Check 'launch-title' 'Window title is the app name' 'WARN' "'$title' (expected '$AppName')" }

    Start-Sleep -Seconds 12
    $script:AppProc.Refresh()
    if ($script:AppProc.HasExited) { Add-Check 'launch-stays' 'Still running 12 s after the window opened' 'FAIL' "exited with code $($script:AppProc.ExitCode)" }
    else {
      $ws = [int]($script:AppProc.WorkingSet64 / 1MB)
      Add-Check 'launch-stays' 'Still running 12 s after the window opened' 'PASS' "$ws MB working set"
    }
    $web = @(Get-CimInstance Win32_Process -Filter "Name='msedgewebview2.exe'" -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -and $_.CommandLine -like "*$($cfg.identifier)*" })
    Add-Check 'launch-webview' 'The app has its own web view processes (WebView2)' $(if ($web.Count -gt 0) { 'PASS' } else { 'FAIL' }) "$($web.Count) msedgewebview2 process(es) using the app's profile"
    $wvData = Join-Path $env:LOCALAPPDATA ($cfg.identifier + '\EBWebView')
    Add-Check 'launch-webview-data' "Web view profile folder created" $(if (Test-Path $wvData) { 'PASS' } else { 'WARN' }) $wvData
    if (Save-Screenshot (Join-Path $OutDir 'app-launched.png')) { Add-Check 'launch-screenshot' 'Screenshot of the Sandbox desktop saved (app-launched.png)' 'INFO' 'look at it: the window should show the Sound page, not a blank or white window' }
    else { Add-Check 'launch-screenshot' 'Screenshot saved' 'WARN' 'could not capture the screen' }

    if ($script:Exe) {
      $h = Invoke-Helper -Exe $script:Exe -HelperArgs @('--eq-engine', 'status') -Tag 'status-after-launch' -TimeoutSec 60
      if (-not $h.timedOut) {
        $st = ConvertFrom-StatusText $h.stdout
        $ch = @(Get-StatusChecks $st 'after launch' | Where-Object { $_.id -like 'status-default-*' -or $_.id -like 'status-after-launch*' -or $_.id -like 'status-installed-*' })
        foreach ($c in $ch) { Add-Check $c.id $c.name $c.status $c.detail }
      }
    }
    $dataDir = Join-Path $env:APPDATA $cfg.identifier
    Add-Check 'launch-appdata' 'Per-user data folder exists after the first run' $(if (Test-Path $dataDir) { 'PASS' } else { 'INFO' }) $dataDir
    if (Test-Path $dataDir) {
      Get-ChildItem $dataDir -Recurse -ErrorAction SilentlyContinue | Select-Object FullName, Length | Out-String -Width 220 | Set-Content (Join-Path $OutDir 'app-data-tree.txt') -Encoding UTF8
    }
  }
  Invoke-Step 'close' {
    if ($script:AppProc -and -not $script:AppProc.HasExited) {
      [void]$script:AppProc.CloseMainWindow()
      if (-not $script:AppProc.WaitForExit(8000)) { Stop-Process -Id $script:AppProc.Id -Force -ErrorAction SilentlyContinue; Add-Check 'close-clean' 'App closes when asked' 'WARN' 'had to be ended after 8 s' }
      else { Add-Check 'close-clean' 'App closes when asked' 'PASS' '' }
    }
    Get-CimInstance Win32_Process -Filter "Name='msedgewebview2.exe'" -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -like "*$($cfg.identifier)*" } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    $crash = @(Get-WinEvent -FilterHashtable @{ LogName = 'Application'; Id = 1000, 1001; StartTime = $script:Started } -ErrorAction SilentlyContinue | Where-Object { $_.Message -match [regex]::Escape($cfg.exe) -or $_.Message -match 'onboard' })
    Add-Check 'launch-no-crash' 'No Windows crash report for the app during the test' $(if ($crash.Count -eq 0) { 'PASS' } else { 'FAIL' }) $(if ($crash.Count -gt 0) { ($crash | Select-Object -First 1).Message.Split("`n")[0] } else { '' })
  }
} else {
  Add-Check 'launch-window' "$AppName window opens" 'SKIP' 'app not installed'
}

# ---------------------------------------------------------------------------------------------
# 7. Uninstall
# ---------------------------------------------------------------------------------------------
if ($NoUninstall) {
  Add-Check 'uninstall' 'Silent uninstall' 'SKIP' '-NoUninstall'
} elseif ($script:InstDir -and (Test-Path (Join-Path $script:InstDir 'uninstall.exe'))) {
  Invoke-Step 'uninstall' {
    Write-Host ''
    Write-Host 'Uninstalling silently...' -ForegroundColor Cyan
    $p = Start-Process -FilePath (Join-Path $script:InstDir 'uninstall.exe') -ArgumentList '/S' -PassThru
    $null = $p.Handle
    [void]$p.WaitForExit(120000)
    # NSIS uninstallers hand over to a temporary copy and return at once, so wait for the result.
    $gone = Wait-Until -Seconds 90 -Condition { -not (Test-Path $script:Exe) -and -not (Find-Uninstall $AppName) }
    Add-Check 'uninstall-removed' "$AppName is removed (exe gone, no uninstall entry)" $(if ($gone) { 'PASS' } else { 'FAIL' }) $(if ($gone) { '' } else { 'still there after 90 s' })
    $eapoStays = (Test-Path 'HKLM:\SOFTWARE\EqualizerAPO') -and (Test-Path (Join-Path ((Get-ItemProperty 'HKLM:\SOFTWARE\EqualizerAPO' -ErrorAction SilentlyContinue).InstallPath) 'EqualizerAPO.dll'))
    Add-Check 'uninstall-keeps-eapo' 'Uninstalling SYNQ leaves Equalizer APO installed (as the guide says)' $(if ($eapoStays) { 'PASS' } else { 'WARN' }) $(if ($eapoStays) { '' } else { 'the engine was removed too; BETA-GUIDE.md says it stays' })
    $dataDir = Join-Path $env:APPDATA $cfg.identifier
    Add-Check 'uninstall-keeps-data' 'Per-user data (presets, backups) is kept' 'INFO' $(if (Test-Path $dataDir) { 'kept' } else { 'removed' })
  }
} else {
  Add-Check 'uninstall' 'Silent uninstall' 'SKIP' 'nothing to uninstall'
}

# ---------------------------------------------------------------------------------------------
# 8. Results
# ---------------------------------------------------------------------------------------------
$verdict = Get-Verdict $script:Checks
$elapsed = [int]((Get-Date) - $script:Started).TotalSeconds
$counts = $script:Checks | Group-Object status | ForEach-Object { "{0} {1}" -f $_.Count, $_.Name }
$md = New-Object System.Collections.ArrayList
[void]$md.Add("# $AppName $($cfg.version) fresh-install test")
[void]$md.Add('')
[void]$md.Add("**Verdict: $verdict**  ($($counts -join ', '); $elapsed s; $(Get-Date -Format 'yyyy-MM-dd HH:mm'))")
[void]$md.Add('')
[void]$md.Add('| Result | Check | Detail |')
[void]$md.Add('|---|---|---|')
foreach ($c in $script:Checks) {
  $detail = ([string]$c.detail).Replace('|', '/').Replace("`r", ' ').Replace("`n", ' ')
  [void]$md.Add(('| {0} | {1} | {2} |' -f $c.status, $c.name.Replace('|', '/'), $detail))
}
[void]$md.Add('')
[void]$md.Add('Other files here: environment.txt, installed-files.txt, status-*.stdout.txt, setup-dry-run.stdout.txt, render-endpoints.json, app-launched.png, transcript.txt.')
$md | Set-Content (Join-Path $OutDir 'RESULTS.md') -Encoding UTF8
[pscustomobject]@{ app = $AppName; version = $cfg.version; verdict = $verdict; seconds = $elapsed; checks = $script:Checks } | ConvertTo-Json -Depth 5 | Set-Content (Join-Path $OutDir 'RESULTS.json') -Encoding UTF8
Remove-Item (Join-Path $OutDir 'progress.json') -ErrorAction SilentlyContinue

Write-Host ''
$vc = 'Green'
if ($verdict -eq 'FAIL') { $vc = 'Red' } elseif ($verdict -ne 'PASS') { $vc = 'Yellow' }
Write-Host "=== Verdict: $verdict ($($counts -join ', ')) ===" -ForegroundColor $vc
Write-Host "Results: $(Join-Path $OutDir 'RESULTS.md')  (on your PC: the sandbox-results folder next to the onboard folder)"
Write-Host 'You can close this window and the Sandbox now. Nothing in it is kept.'
try { Stop-Transcript | Out-Null } catch { }
