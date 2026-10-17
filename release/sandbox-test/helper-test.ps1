<#
  SYNQ Helper on its own, tested the way the website uses it. Meant to run INSIDE Windows Sandbox
  (synq-helper-sandbox.wsb starts it); it refuses to run anywhere else, because it installs things.

  Part A, a clean PC (no SYNQ app):
    1. downloads synq-helper.exe from the website's own link (GitHub's latest release) and checks its SHA-256
       against SHA256SUMS.txt (falls back to the copy in the release folder when there is no network)
    2. starts it the way a double-click does (through Explorer, not elevated) and checks that it installed
       itself: %LOCALAPPDATA%\SYNQ Helper, the Apps-list entry, the sign-in entry, its settings, the
       process, the port 127.0.0.1:17860
    3. starts the downloaded file again: it must say it is already running (and nothing else happens)
    4. talks to it as https://synqhub.app does (a WebSocket with that Origin): another site is refused,
       the "allow this site?" question comes up and is answered Yes, then every command the website sends
       gets an answer or a plain error (never a crash), and a second visit pairs with the saved token,
       with no question
    5. removes it the way Windows' Apps list does (its UninstallString) and checks that nothing is left
  Part B, with the SYNQ app installed (needs administrator, asked once):
    6. installs the app silently, starts the downloaded helper again, and checks that it turned the app's
       own helper on instead of installing a second copy

  Writes RESULTS-helper.md / RESULTS-helper.json to the mapped results folder.
  Pure PowerShell 5.1, ASCII only.
#>
[CmdletBinding()]
param(
  [string]$ReleaseDir = 'C:\SYNQRelease',
  [string]$OutDir = 'C:\Results',
  [switch]$Elevated,
  [switch]$SkipPartB,
  [switch]$ImOnAThrowawayVm
)

$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'

$Site = 'https://synqhub.app'
$Download = 'https://github.com/logan-wurx/synqhub/releases/latest/download/synq-helper.exe'
$Port = 17860
$DirName = 'SYNQ Helper'
$UninstallKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\SYNQ Helper'
$RunKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$RunValue = 'OnBoardHelper'
$AppDir = Join-Path $env:APPDATA 'com.logan.onboard'

# ---------------------------------------------------------------------------------------------
# Results
# ---------------------------------------------------------------------------------------------
$script:Checks = New-Object System.Collections.ArrayList
$script:Started = Get-Date

function Add-Check {
  param([string]$Id, [string]$Name, [string]$Status, [string]$Detail = '')
  $row = [pscustomobject]@{ id = $Id; name = $Name; status = $Status; detail = $Detail; at = (Get-Date).ToString('HH:mm:ss') }
  [void]$script:Checks.Add($row)
  $color = 'Gray'
  if ($Status -eq 'PASS') { $color = 'Green' } elseif ($Status -eq 'FAIL') { $color = 'Red' } elseif ($Status -eq 'WARN') { $color = 'Yellow' }
  $line = '[{0}] {1}' -f $Status, $Name
  if ($Detail) { $line += ' - ' + $Detail }
  Write-Host $line -ForegroundColor $color
  try { $script:Checks | ConvertTo-Json -Depth 4 | Set-Content -Path (Join-Path $OutDir 'progress-helper.json') -Encoding UTF8 } catch { }
}

function Check {
  param([string]$Id, [string]$Name, [bool]$Ok, [string]$Detail = '', [string]$Else = 'FAIL')
  if ($Ok) { Add-Check $Id $Name 'PASS' $Detail } else { Add-Check $Id $Name $Else $Detail }
}

function Wait-Until {
  param([scriptblock]$Test, [int]$Seconds = 15)
  $until = (Get-Date).AddSeconds($Seconds)
  while ((Get-Date) -lt $until) {
    if (& $Test) { return $true }
    Start-Sleep -Milliseconds 300
  }
  return [bool](& $Test)
}

function Get-Sha256 { param([string]$Path) (Get-FileHash -Algorithm SHA256 -Path $Path).Hash.ToLowerInvariant() }

function Port-Open {
  try { $c = New-Object System.Net.Sockets.TcpClient; $c.Connect('127.0.0.1', $Port); $c.Close(); return $true } catch { return $false }
}

function Helper-Processes { @(Get-Process -Name 'synq-helper' -ErrorAction SilentlyContinue) }

# ---------------------------------------------------------------------------------------------
# Dialogs (the helper's message boxes, titled "SYNQ Helper"), through UI Automation
# ---------------------------------------------------------------------------------------------
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
$AE = [System.Windows.Automation.AutomationElement]

function Find-HelperDialog {
  param([int]$Seconds = 10)
  $cond = New-Object System.Windows.Automation.PropertyCondition($AE::NameProperty, 'SYNQ Helper')
  $until = (Get-Date).AddSeconds($Seconds)
  do {
    $w = $AE::RootElement.FindFirst([System.Windows.Automation.TreeScope]::Children, $cond)
    if ($w) { return $w }
    Start-Sleep -Milliseconds 250
  } while ((Get-Date) -lt $until)
  return $null
}

function Get-DialogText {
  param($Window)
  $cond = New-Object System.Windows.Automation.PropertyCondition($AE::ControlTypeProperty, [System.Windows.Automation.ControlType]::Text)
  $parts = @()
  foreach ($t in $Window.FindAll([System.Windows.Automation.TreeScope]::Descendants, $cond)) { $parts += $t.Current.Name }
  return ($parts -join ' ')
}

function Press-DialogButton {
  param($Window, [string]$Name)
  $cond = New-Object System.Windows.Automation.AndCondition(
    (New-Object System.Windows.Automation.PropertyCondition($AE::ControlTypeProperty, [System.Windows.Automation.ControlType]::Button)),
    (New-Object System.Windows.Automation.PropertyCondition($AE::NameProperty, $Name)))
  $b = $Window.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $cond)
  if (-not $b) { return $false }
  $b.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
  return $true
}

# ---------------------------------------------------------------------------------------------
# The website's side of the bridge: a WebSocket with the site's Origin, JSON {id, cmd, args}
# ---------------------------------------------------------------------------------------------
function Open-Bridge {
  param([string]$Origin)
  $ws = New-Object System.Net.WebSockets.ClientWebSocket
  $ws.Options.SetRequestHeader('Origin', $Origin)
  try {
    if (-not $ws.ConnectAsync([Uri]("ws://127.0.0.1:{0}/" -f $Port), [Threading.CancellationToken]::None).Wait(5000)) { return $null }
  } catch { return $null }
  if ($ws.State -ne [System.Net.WebSockets.WebSocketState]::Open) { return $null }
  return $ws
}

function Send-Bridge {
  param($Ws, [int]$Id, [string]$Cmd, $CmdArgs)
  if ($CmdArgs -eq $null) { $CmdArgs = @{} }
  $json = (@{ id = $Id; cmd = $Cmd; args = $CmdArgs } | ConvertTo-Json -Compress -Depth 8)
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($json)
  $seg = New-Object 'System.ArraySegment[byte]' -ArgumentList @(, $bytes)
  [void]$Ws.SendAsync($seg, [System.Net.WebSockets.WebSocketMessageType]::Text, $true, [Threading.CancellationToken]::None).Wait(5000)
}

# The answer to request $Id (events in between are skipped); $null after $TimeoutMs.
function Receive-Bridge {
  param($Ws, [int]$Id, [int]$TimeoutMs = 30000)
  $until = (Get-Date).AddMilliseconds($TimeoutMs)
  $buf = New-Object byte[] 262144
  while ((Get-Date) -lt $until) {
    $ms = New-Object System.IO.MemoryStream
    do {
      $seg = New-Object 'System.ArraySegment[byte]' -ArgumentList @(, $buf)
      $task = $Ws.ReceiveAsync($seg, [Threading.CancellationToken]::None)
      $left = [int][math]::Max(1, ($until - (Get-Date)).TotalMilliseconds)
      if (-not $task.Wait($left)) { return $null }
      $r = $task.Result
      if ($r.MessageType -eq [System.Net.WebSockets.WebSocketMessageType]::Close) { return $null }
      $ms.Write($buf, 0, $r.Count)
    } while (-not $r.EndOfMessage)
    $text = [System.Text.Encoding]::UTF8.GetString($ms.ToArray())
    try { $msg = $text | ConvertFrom-Json } catch { continue }
    if ($msg.id -eq $Id) { return $msg }
  }
  return $null
}

$script:NextId = 10
function Call-Bridge {
  param($Ws, [string]$Cmd, $CmdArgs, [int]$TimeoutMs = 30000)
  $script:NextId++
  Send-Bridge $Ws $script:NextId $Cmd $CmdArgs
  return Receive-Bridge $Ws $script:NextId $TimeoutMs
}

function Brief { param($Value) if ($Value -eq $null) { return 'null' }; $t = ($Value | ConvertTo-Json -Compress -Depth 4); if ($t.Length -gt 160) { $t = $t.Substring(0, 160) + '...' }; return $t }

# ---------------------------------------------------------------------------------------------
# Where this runs
# ---------------------------------------------------------------------------------------------
if (($env:USERNAME -ne 'WDAGUtilityAccount') -and (-not $ImOnAThrowawayVm)) {
  Write-Host 'This script installs SYNQ Helper (and, in part B, the SYNQ app), so it only runs inside Windows Sandbox.' -ForegroundColor Red
  return
}
$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $admin -and -not $SkipPartB -and -not $Elevated) {
  # Part B installs the app (per machine): ask for administrator once, up front. The helper itself is still
  # started through Explorer, not elevated, as a double-click would.
  $argList = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-NoExit', '-File', ('"{0}"' -f $PSCommandPath), '-Elevated', '-ReleaseDir', ('"{0}"' -f $ReleaseDir), '-OutDir', ('"{0}"' -f $OutDir))
  if ($ImOnAThrowawayVm) { $argList += '-ImOnAThrowawayVm' }
  try { Start-Process powershell.exe -Verb RunAs -ArgumentList $argList; return } catch { Write-Host 'No administrator: running part A only.' -ForegroundColor Yellow; $SkipPartB = $true }
}
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

# ---------------------------------------------------------------------------------------------
# Part A: a clean PC
# ---------------------------------------------------------------------------------------------
Write-Host '=== Part A: SYNQ Helper on a PC without the SYNQ app ===' -ForegroundColor Cyan
$ownDir = Join-Path $env:LOCALAPPDATA $DirName
$ownExe = Join-Path $ownDir 'synq-helper.exe'
Check 'clean' 'Clean machine: no SYNQ Helper installed or running, port free' ((-not (Test-Path $ownDir)) -and ((Helper-Processes).Count -eq 0) -and (-not (Port-Open)))

$sums = @{}
$sumsFile = Join-Path $ReleaseDir 'SHA256SUMS.txt'
if (Test-Path $sumsFile) {
  foreach ($l in Get-Content $sumsFile) { if ($l -match '^([0-9a-fA-F]{64})\s+\*?(.+)$') { $sums[$matches[2].Trim()] = $matches[1].ToLowerInvariant() } }
}
$want = $sums['synq-helper.exe']
$downloads = Join-Path $env:USERPROFILE 'Downloads'
New-Item -ItemType Directory -Force -Path $downloads | Out-Null
# The file under test is the release folder's (what is about to ship, or just shipped); the website's link is checked
# against it, so a build can be tested before it is published.
$exe = Join-Path $downloads 'synq-helper.exe'
Copy-Item (Join-Path $ReleaseDir 'synq-helper.exe') $exe -Force
$h = Get-Sha256 $exe
Check 'file' 'The helper under test is the one SHA256SUMS.txt lists' ($h -eq $want) "sha256 $h"
$raw = [System.Text.Encoding]::ASCII.GetString([IO.File]::ReadAllBytes($exe))
Check 'no-vcruntime' 'Needs no Visual C++ runtime (no VCRUNTIME140.dll, which a fresh Windows lacks)' (-not ($raw -match '(?i)vcruntime140(_1)?\.dll|msvcp140\.dll'))
$web = Join-Path $env:TEMP 'synq-helper-web.exe'
try {
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  Invoke-WebRequest -Uri $Download -OutFile $web -UseBasicParsing -TimeoutSec 120
  $wh = Get-Sha256 $web
  Check 'download' "The website's link ($Download) serves this file" ($wh -eq $h) "link sha256 $wh" 'WARN'
} catch {
  Add-Check 'download' "The website's link serves this file" 'WARN' "Couldn't download it in the Sandbox: $($_.Exception.Message)"
}

# Windows' own "can't start" box (a missing DLL) is titled "<exe> - System Error"; the test names it when it shows.
function Find-SystemError {
  $cond = New-Object System.Windows.Automation.PropertyCondition($AE::NameProperty, 'synq-helper.exe - System Error')
  $w = $AE::RootElement.FindFirst([System.Windows.Automation.TreeScope]::Children, $cond)
  if ($w) { return (Get-DialogText $w) }
  return ''
}

# A double-click: Explorer starts it, not elevated.
Start-Process explorer.exe -ArgumentList ('"{0}"' -f $exe)
$installed = Wait-Until { Test-Path $ownExe } 20
$sysErr = Find-SystemError
if ($sysErr) { Add-Check 'starts' 'Windows could start it' 'FAIL' $sysErr }
Check 'installed' "Installed itself in $ownDir" $installed
if ($installed) { Check 'installed-same' 'The installed copy is the downloaded file' ((Get-Sha256 $ownExe) -eq $h) }
$running = Wait-Until { (Port-Open) -and (@(Helper-Processes | Where-Object { $_.Path -eq $ownExe }).Count -gt 0) } 20
Check 'running' 'Running from its own folder and listening on 127.0.0.1:17860' $running ((Helper-Processes | ForEach-Object { $_.Path }) -join '; ')
$dlg = Find-HelperDialog 2
Check 'no-dialog' 'No message box on a first install (only the tray notice)' (-not $dlg) $(if ($dlg) { Get-DialogText $dlg } else { '' })
if ($dlg) { [void](Press-DialogButton $dlg 'OK') }

$u = Get-ItemProperty -Path $UninstallKey -ErrorAction SilentlyContinue
Check 'apps-entry' "Listed in Windows' installed apps" ($u -and $u.DisplayName -eq 'SYNQ Helper') $(if ($u) { "DisplayName '$($u.DisplayName)', version '$($u.DisplayVersion)', publisher '$($u.Publisher)'" } else { 'no Uninstall key' })
Check 'apps-uninstall' 'Its uninstall command removes only itself' ($u -and ([string]$u.UninstallString) -like "*$ownExe*--uninstall-self*") ([string]$u.UninstallString)
$run = (Get-ItemProperty -Path $RunKey -ErrorAction SilentlyContinue).$RunValue
Check 'autostart' 'Starts with Windows (sign-in entry points at the installed copy)' (([string]$run) -like "*$ownExe*") ([string]$run)
$settings = $null
try { $settings = Get-Content (Join-Path $AppDir 'helper.json') -Raw | ConvertFrom-Json } catch { }
Check 'settings' 'Its settings: on, website bridge on' ($settings -and $settings.enabled -eq $true -and $settings.webBridge -eq $true) (Brief $settings) 'WARN'

# Again: it must only say it is running.
Start-Process explorer.exe -ArgumentList ('"{0}"' -f $exe)
$dlg = Find-HelperDialog 10
$txt = $(if ($dlg) { Get-DialogText $dlg } else { '' })
Check 'again' 'Started again: says it is already running' ($txt -like '*already running*') $txt
if ($dlg) { [void](Press-DialogButton $dlg 'OK') }
Start-Sleep -Seconds 1
Check 'again-one' 'Still one helper' ((Helper-Processes).Count -eq 1) "$((Helper-Processes).Count) running"

# The website.
$bad = Open-Bridge 'https://evil.example'
Check 'origin-refused' 'Another website is refused' (-not $bad)
if ($bad) { $bad.Dispose() }
$ws = Open-Bridge $Site
Check 'connect' "Connects as $Site" ([bool]$ws)
$token = $null
if ($ws) {
  Send-Bridge $ws 1 'hello' @{}
  $dlg = Find-HelperDialog 15
  $txt = $(if ($dlg) { Get-DialogText $dlg } else { '' })
  Check 'consent' 'Asks "allow this site?" with the site named' ($txt -like "*synqhub.app*") $txt
  if ($dlg) { [void](Press-DialogButton $dlg 'Yes') }
  $hello = Receive-Bridge $ws 1 20000
  $token = $(if ($hello -and $hello.ok) { $hello.ok.token } else { $null })
  Check 'paired' 'Paired after Yes (a token for next time)' ([bool]$token) (Brief $hello)

  # Every command the website sends: an answer, or a plain error. Never a crash or a dropped connection.
  $calls = @(
    @('hid_list', @{}, 'list'),
    @('devices_list', @{}, 'list'),
    @('screen_monitors', @{}, 'list'),
    @('net_lights_find', @{}, 'list'),
    @('net_sync_state', @{}, 'any'),
    @('eq_load', @{}, 'any'),
    @('eq_presets', @{}, 'any'),
    @('eq_engine_status', @{}, 'any'),
    @('sound_names_load', @{}, 'any'),
    @('eq_engine_setup', @{}, 'err:desktop app'),
    @('hid_send_report', @{ key = 'nope'; reportId = 1; data = @(1, 2) }, 'err'),
    @('rgbhub_read', @{ vid = '1e71'; pid = '2001'; timeoutMs = 10 }, 'any'),
    @('rgbhub_write', @{ vid = '1e71'; pid = '2001'; reportId = 153; data = @(1) }, 'err:Refused'),
    @('rgbhub_write', @{ vid = '0b05'; pid = '1d1d'; reportId = 0; data = @(1) }, 'err:Refused'),
    @('hue_areas', @{ bridge = 'none' }, 'err'),
    @('net_light_send', @{ brand = 'wiz'; id = 'none'; message = @{ kind = 'http'; method = 'DELETE'; path = '/' } }, 'err'),
    @('webcam_controls', @{ id = 'none' }, 'err'),
    @('monitor_caps', @{ id = 'none' }, 'err'),
    @('helper_set', @{}, 'err'),
    @('games_save', @{}, 'err')
  )
  $monitors = @()
  foreach ($c in $calls) {
    $r = Call-Bridge $ws $c[0] $c[1]
    $name = "Website command $($c[0])"
    if (-not $r) { Add-Check "cmd-$($c[0])" $name 'FAIL' 'no answer'; continue }
    $err = [string]$r.err
    switch -Wildcard ($c[2]) {
      'list' { Check "cmd-$($c[0])" $name (($r.PSObject.Properties.Name -contains 'ok') -and -not $err) ("{0} item(s): {1}" -f @($r.ok).Count, (Brief $r.ok)) }
      'any' { Check "cmd-$($c[0])" $name (($r.PSObject.Properties.Name -contains 'ok') -or [bool]$err) $(if ($err) { "error: $err" } else { Brief $r.ok }) }
      'err' { Check "cmd-$($c[0])" "$name is refused or fails plainly" ([bool]$err) $err }
      'err:*' { $wantText = $c[2].Substring(4); Check "cmd-$($c[0])" "$name is refused ($wantText)" ($err -like "*$wantText*") $err }
    }
    if ($c[0] -eq 'devices_list' -and $r.ok) { $monitors = @($r.ok | Where-Object { $_.kind -eq 'monitor' }) }
  }
  # A monitor the helper listed: its DDC/CI read answers or fails plainly (the Sandbox's display has no DDC/CI).
  foreach ($m in $monitors | Select-Object -First 1) {
    $r = Call-Bridge $ws 'monitor_caps' @{ id = $m.path } 20000
    Check 'cmd-monitor-real' "A listed monitor ($($m.name)): capabilities or a plain error" ([bool]$r) $(if ($r.err) { "error: $($r.err)" } else { Brief $r.ok }) 'FAIL'
  }
  Check 'alive' 'Helper still running after every command' ((Helper-Processes).Count -eq 1 -and (Port-Open))
  try { [void]$ws.CloseAsync([System.Net.WebSockets.WebSocketCloseStatus]::NormalClosure, 'done', [Threading.CancellationToken]::None).Wait(3000) } catch { }
  $ws.Dispose()
}

# A second visit: the saved token pairs without asking.
if ($token) {
  $ws = Open-Bridge $Site
  if ($ws) {
    Send-Bridge $ws 2 'hello' @{ token = $token }
    $again = Receive-Bridge $ws 2 8000
    $dlg = Find-HelperDialog 1
    Check 'repair' 'Next visit: paired with the saved token, no question' ($again -and $again.ok -and $again.ok.paired -eq $true -and -not $dlg) (Brief $again)
    if ($dlg) { [void](Press-DialogButton $dlg 'No') }
    $ws.Dispose()
  } else { Add-Check 'repair' 'Next visit: paired with the saved token' 'FAIL' 'no connection' }
}

# Removed from the Apps list.
$un = [string](Get-ItemProperty -Path $UninstallKey -ErrorAction SilentlyContinue).UninstallString
if ($un -match '^"([^"]+)"\s*(.*)$') { Start-Process -FilePath $matches[1] -ArgumentList $matches[2] }
$gone = Wait-Until { ((Helper-Processes).Count -eq 0) -and -not (Test-Path $UninstallKey) -and -not (Test-Path $ownDir) } 20
$runAfter = (Get-ItemProperty -Path $RunKey -ErrorAction SilentlyContinue).$RunValue
Check 'uninstall' 'Uninstall: stopped, folder, Apps entry and sign-in entry gone' ($gone -and -not $runAfter) ("process {0}, folder {1}, entry {2}, sign-in '{3}'" -f (Helper-Processes).Count, (Test-Path $ownDir), (Test-Path $UninstallKey), $runAfter)
Check 'uninstall-port' 'Port 17860 free again' (Wait-Until { -not (Port-Open) } 5)

# ---------------------------------------------------------------------------------------------
# Part B: with the SYNQ app installed
# ---------------------------------------------------------------------------------------------
if (-not $SkipPartB) {
  Write-Host '=== Part B: the same download with the SYNQ app installed ===' -ForegroundColor Cyan
  $setup = Get-ChildItem -Path $ReleaseDir -Filter 'SYNQ_*_x64-setup.exe' | Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if (-not $setup) { Add-Check 'b-setup' 'SYNQ installer in the release folder' 'FAIL' 'none found' }
  else {
    $p = Start-Process -FilePath $setup.FullName -ArgumentList '/S' -Wait -PassThru
    Check 'b-install' "SYNQ app installed silently ($($setup.Name))" ($p.ExitCode -eq 0) "exit $($p.ExitCode)"
    $loc = (Get-ItemProperty 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\SYNQ' -ErrorAction SilentlyContinue).InstallLocation
    $appHelper = $(if ($loc) { Join-Path ($loc.Trim('"')) 'synq-helper.exe' } else { '' })
    Check 'b-app-helper' "The app's own helper is there" ($appHelper -and (Test-Path $appHelper)) $appHelper
    # The app's installer may have started its helper already; the test is what the download does.
    Get-Process -Name 'synq-helper' -ErrorAction SilentlyContinue | Stop-Process -Force
    Start-Sleep -Seconds 1
    Start-Process explorer.exe -ArgumentList ('"{0}"' -f $exe)
    $ok = Wait-Until { (Port-Open) -and (@(Helper-Processes | Where-Object { $_.Path -eq $appHelper }).Count -gt 0) } 20
    Check 'b-uses-app' "The download turned the app's helper on (running from the app's folder)" $ok ((Helper-Processes | ForEach-Object { $_.Path }) -join '; ')
    Check 'b-no-copy' 'No second copy installed' (-not (Test-Path $ownDir)) $ownDir
    $run = (Get-ItemProperty -Path $RunKey -ErrorAction SilentlyContinue).$RunValue
    Check 'b-autostart' "Sign-in entry points at the app's helper" (([string]$run) -like "*$appHelper*") ([string]$run)
    $dlg = Find-HelperDialog 2
    if ($dlg) { Add-Check 'b-dialog' 'A message box came up' 'WARN' (Get-DialogText $dlg); [void](Press-DialogButton $dlg 'OK') }
    $ws = Open-Bridge $Site
    if ($ws) {
      Send-Bridge $ws 3 'hello' @{}
      $dlg = Find-HelperDialog 15
      if ($dlg) { [void](Press-DialogButton $dlg 'Yes') }
      $hello = Receive-Bridge $ws 3 20000
      $r = Call-Bridge $ws 'devices_list' @{}
      Check 'b-website' 'The website pairs with the app helper and lists devices' ($hello -and $hello.ok -and $r -and ($r.PSObject.Properties.Name -contains 'ok')) (Brief $r)
      $ws.Dispose()
    } else { Add-Check 'b-website' 'The website pairs with the app helper' 'FAIL' 'no connection' }
  }
}

# ---------------------------------------------------------------------------------------------
# Report
# ---------------------------------------------------------------------------------------------
$fail = @($script:Checks | Where-Object { $_.status -eq 'FAIL' }).Count
$warn = @($script:Checks | Where-Object { $_.status -eq 'WARN' }).Count
$pass = @($script:Checks | Where-Object { $_.status -eq 'PASS' }).Count
$verdict = $(if ($fail) { 'FAIL' } elseif ($warn) { 'PASS with warnings' } else { 'PASS' })
$elapsed = [int]((Get-Date) - $script:Started).TotalSeconds
$md = New-Object System.Collections.ArrayList
[void]$md.Add('# SYNQ Helper on its own: Sandbox test')
[void]$md.Add('')
[void]$md.Add("**Verdict: $verdict**  ($pass pass, $warn warn, $fail fail; $elapsed s; $(Get-Date -Format 'yyyy-MM-dd HH:mm'))")
[void]$md.Add('')
[void]$md.Add('| | Check | Detail |')
[void]$md.Add('|---|---|---|')
foreach ($c in $script:Checks) { [void]$md.Add(('| {0} | {1} | {2} |' -f $c.status, $c.name, ($c.detail -replace '\|', '/' -replace "`r?`n", ' '))) }
$md | Set-Content (Join-Path $OutDir 'RESULTS-helper.md') -Encoding UTF8
$script:Checks | ConvertTo-Json -Depth 4 | Set-Content (Join-Path $OutDir 'RESULTS-helper.json') -Encoding UTF8
$vc = $(if ($fail) { 'Red' } elseif ($warn) { 'Yellow' } else { 'Green' })
Write-Host "=== Verdict: $verdict ($pass pass, $warn warn, $fail fail) ===" -ForegroundColor $vc
Write-Host "Results: $(Join-Path $OutDir 'RESULTS-helper.md')"
