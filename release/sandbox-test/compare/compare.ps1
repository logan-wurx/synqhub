<#
  Head-to-head footprint test: one app per run, in a fresh Windows Sandbox (compare-<app>.wsb starts it), measured the
  same way for every app. It refuses to run anywhere but the Sandbox, because it installs software.

    1. notes what a clean Sandbox runs (processes, services, sign-in entries, scheduled tasks, folder sizes)
    2. gets the installer: SYNQ from the mapped release folder; a maker's from its own server, and only when the
       file is exactly the size that was approved (a different size is a different file: the run stops)
    3. installs it (the maker's silent switch where it has one; otherwise the setup's buttons are pressed by
       name: privacy-friendly answers first, never a sign-in, nothing typed)
    4. with the app's window open and idle: memory and CPU of everything the install added, for 2 minutes
    5. with the window closed (what keeps running in the background): the same, for 5 minutes
    6. what stays on the PC: processes, services, sign-in entries, scheduled tasks, disk, and what the installer
       downloaded
    7. writes <app>.json and <app>.md to the mapped results folder

  No mouse, keyboard or headset reaches the Sandbox, so every app is measured with no device attached, and the
  Sandbox has no GPU, so window drawing costs CPU for every app alike. Memory, processes, services and disk are the
  fair numbers; CPU is reported for the closed-window (background) phase only.
  Pure PowerShell 5.1, ASCII only.
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][ValidateSet('synq', 'ghub', 'synapse', 'icue', 'gg')][string]$App,
  [string]$ReleaseDir = 'C:\SYNQRelease',
  [string]$OutDir = 'C:\Results',
  [switch]$Elevated
)
$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'

$Apps = @{
  synq    = @{ Name = 'SYNQ 0.1.0'; File = 'SYNQ_0.1.0_x64-setup.exe'; Local = $true; Args = '/S'; Exes = @('synq.exe') }
  ghub    = @{ Name = 'Logitech G HUB'; Url = 'https://download01.logi.com/web/ftp/pub/techsupport/gaming/lghub_installer.exe'; File = 'lghub_installer.exe'; Size = 70346392; Args = '--silent'; Exes = @('lghub.exe') }
  synapse = @{ Name = 'Razer Synapse 4'; Url = 'https://dl.razerzone.com/drivers/Synapse4/RazerSynapseInstaller.exe'; File = 'RazerSynapseInstaller.exe'; Size = 14923464; Args = ''; Exes = @('RazerAppEngine.exe', 'Razer Synapse.exe') }
  icue    = @{ Name = 'Corsair iCUE 5'; Url = 'https://www3.corsair.com/software/CUE_V5/public/modules/windows/installer/Install%20iCUE.exe'; File = 'Install iCUE.exe'; Size = 3392688; Args = ''; Exes = @('iCUE.exe') }
  gg      = @{ Name = 'SteelSeries GG'; Url = 'https://engine.steelseriescdn.com/SteelSeriesGG121.0.0Setup.exe'; File = 'SteelSeriesGG121.0.0Setup.exe'; Size = 433340936; Args = '/S'; Exes = @('SteelSeriesGG.exe') }
}
$A = $Apps[$App]

if ($env:USERNAME -ne 'WDAGUtilityAccount') {
  Write-Host 'This installs software, so it only runs inside Windows Sandbox (user WDAGUtilityAccount).' -ForegroundColor Red
  exit 9
}
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
  if ($Elevated) { Write-Host 'Still not administrator after asking; stopping.' -ForegroundColor Red; exit 8 }
  $argList = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-NoExit', '-File', ('"{0}"' -f $PSCommandPath), '-App', $App, '-Elevated', '-ReleaseDir', ('"{0}"' -f $ReleaseDir), '-OutDir', ('"{0}"' -f $OutDir))
  Start-Process -FilePath 'powershell.exe' -Verb RunAs -ArgumentList $argList
  exit 0
}

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$log = Join-Path $OutDir ("$App.log")
function Say([string]$m) { $line = '{0:HH:mm:ss}  {1}' -f (Get-Date), $m; Write-Host $line; Add-Content -Path $log -Value $line }
Set-Content -Path $log -Value ("Head-to-head: {0}, started {1:yyyy-MM-dd HH:mm}" -f $A.Name, (Get-Date))

# ------------------------------------------------------------------------------------------------- what a clean PC runs
function Folder-MB([string]$p) {
  if (-not (Test-Path $p)) { return 0 }
  $s = (Get-ChildItem -LiteralPath $p -Recurse -Force -File -ErrorAction SilentlyContinue | Measure-Object -Property Length -Sum).Sum
  return [math]::Round(($s / 1MB), 1)
}
$Roots = @($env:ProgramFiles, ${env:ProgramFiles(x86)}, $env:ProgramData, $env:LOCALAPPDATA, $env:APPDATA)
function Snapshot {
  [pscustomobject]@{
    Procs    = @(Get-Process | Select-Object -ExpandProperty Id)
    Services = @(Get-Service | Select-Object -ExpandProperty Name)
    Run      = @(foreach ($k in 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Run', 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run', 'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Run') {
        if (Test-Path $k) { (Get-Item $k).Property | ForEach-Object { "$k\$_" } } })
    Tasks    = @(Get-ScheduledTask -ErrorAction SilentlyContinue | ForEach-Object { $_.TaskPath + $_.TaskName })
    Disk     = @{}
    Net      = (Get-NetAdapterStatistics -ErrorAction SilentlyContinue | Measure-Object -Property ReceivedBytes -Sum).Sum
  }
}
Say 'Clean Sandbox: taking stock'
$Before = Snapshot
foreach ($r in $Roots) { $Before.Disk[$r] = Folder-MB $r }

# ------------------------------------------------------------------------------------------------- the installer
$inst = Join-Path $env:USERPROFILE ('Downloads\' + $A.File)
if ($A.Local) {
  $inst = Join-Path $ReleaseDir $A.File
  if (-not (Test-Path $inst)) { Say "Not found: $inst"; exit 2 }
} else {
  Say ('Downloading {0} from {1}' -f $A.File, $A.Url)
  try { Invoke-WebRequest -Uri $A.Url -OutFile $inst -UseBasicParsing -UserAgent 'Mozilla/5.0' } catch { Say "Download failed: $_"; exit 3 }
  $len = (Get-Item $inst).Length
  if ($len -ne $A.Size) { Say ('Downloaded {0:N0} bytes, approved {1:N0}: a different file than approved. Stopping without running it.' -f $len, $A.Size); exit 4 }
  Say ('OK, {0:N0} bytes as approved' -f $len)
}
$installerMB = [math]::Round(((Get-Item $inst).Length / 1MB), 1)

# ------------------------------------------------------------------------------------------------- install
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
# Pressed by name, in this order of preference: the privacy-friendly answer first, then the ones that move a setup on.
$Prefer = @('No thanks', 'No, thanks', 'Decline', 'Decline all', "Don't share", 'Do not share', 'Opt out', 'Skip', 'Skip for now', 'Not now', 'Maybe later', 'Later', 'Continue as guest', 'Guest')
$Advance = @('I agree', 'I Agree', 'I accept', 'Accept', 'Agree', 'Agree and continue', 'Install', 'Install now', 'Install Now', 'INSTALL', 'Next', 'Next >', 'Continue', 'OK', 'Yes', 'Finish', 'Done', 'Get started', 'Launch', 'Start')
$Pressed = New-Object System.Collections.ArrayList
function Press-Buttons([int[]]$pids) {
  $root = [System.Windows.Automation.AutomationElement]::RootElement
  $wins = $root.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)
  foreach ($w in $wins) {
    if ($pids -notcontains $w.Current.ProcessId) { continue }
    # A licence box to tick first, if the window has one.
    $boxes = $w.FindAll([System.Windows.Automation.TreeScope]::Descendants, (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::CheckBox)))
    foreach ($b in $boxes) {
      $n = $b.Current.Name
      if ($n -match '(?i)(agree|accept).*(terms|licen|agreement|eula)') {
        try { $t = $b.GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern); if ($t.Current.ToggleState -ne 'On') { $t.Toggle(); [void]$Pressed.Add("tick: $n") } } catch { }
      }
    }
    $btns = $w.FindAll([System.Windows.Automation.TreeScope]::Descendants, (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Button)))
    foreach ($want in ($Prefer + $Advance)) {
      foreach ($b in $btns) {
        if ($b.Current.Name -eq $want -and $b.Current.IsEnabled) {
          try { $b.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke(); [void]$Pressed.Add("press: $want"); return $true } catch { }
        }
      }
    }
  }
  return $false
}
function New-Pids { @(Get-Process | Where-Object { $Before.Procs -notcontains $_.Id } | Select-Object -ExpandProperty Id) }
function Main-Running { foreach ($e in $A.Exes) { if (Get-Process -Name ([IO.Path]::GetFileNameWithoutExtension($e)) -ErrorAction SilentlyContinue) { return $true } }; return $false }

Say ('Installing: "{0}" {1}' -f $inst, $A.Args)
$t0 = Get-Date
$p = if ($A.Args) { Start-Process -FilePath $inst -ArgumentList $A.Args -PassThru } else { Start-Process -FilePath $inst -PassThru }
$deadline = (Get-Date).AddMinutes(30)
$quiet = 0
while ((Get-Date) -lt $deadline) {
  Start-Sleep -Seconds 3
  if (Press-Buttons (New-Pids)) { $quiet = 0; continue }
  if ($p.HasExited -and (Main-Running)) { $quiet++ } elseif ($p.HasExited) { $quiet++ }
  # Done when the setup has gone and nothing new has asked anything for a minute.
  if ($quiet -ge 20) { break }
}
$installMin = [math]::Round(((Get-Date) - $t0).TotalMinutes, 1)
Say ("Setup finished in {0} min; pressed: {1}" -f $installMin, (($Pressed | Select-Object -Unique) -join ', '))

if (-not (Main-Running)) {
  foreach ($e in $A.Exes) {
    $found = Get-ChildItem -Path $env:ProgramFiles, ${env:ProgramFiles(x86)}, $env:LOCALAPPDATA -Recurse -Filter $e -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($found) { Say "Starting $($found.FullName)"; Start-Process -FilePath $found.FullName; break }
  }
}

# ------------------------------------------------------------------------------------------------- measure
$cores = [Environment]::ProcessorCount
function Sample([int]$seconds) {
  $pids = New-Pids
  $start = @{}; foreach ($i in $pids) { $q = Get-Process -Id $i -ErrorAction SilentlyContinue; if ($q) { $start[$i] = $q.TotalProcessorTime.TotalSeconds } }
  $t = Get-Date
  $mem = New-Object System.Collections.ArrayList
  while (((Get-Date) - $t).TotalSeconds -lt $seconds) {
    Start-Sleep -Seconds 5
    $ps = @(Get-Process | Where-Object { $Before.Procs -notcontains $_.Id })
    [void]$mem.Add([pscustomobject]@{ Private = ($ps | Measure-Object PrivateMemorySize64 -Sum).Sum; Working = ($ps | Measure-Object WorkingSet64 -Sum).Sum; Count = $ps.Count })
  }
  $cpu = 0.0
  foreach ($i in $start.Keys) { $q = Get-Process -Id $i -ErrorAction SilentlyContinue; if ($q) { $cpu += $q.TotalProcessorTime.TotalSeconds - $start[$i] } }
  $wall = ((Get-Date) - $t).TotalSeconds
  $ps = @(Get-Process | Where-Object { $Before.Procs -notcontains $_.Id })
  [pscustomobject]@{
    PrivateMB = [math]::Round((($mem | Measure-Object Private -Average).Average / 1MB), 1)
    WorkingMB = [math]::Round((($mem | Measure-Object Working -Average).Average / 1MB), 1)
    Processes = [int](($mem | Measure-Object Count -Maximum).Maximum)
    CpuPct    = [math]::Round((100 * $cpu / ($wall * $cores)), 2)
    Names     = @($ps | Select-Object -ExpandProperty Name -Unique | Sort-Object)
  }
}
Say 'Window open: settling 90 s, then 2 minutes'
Start-Sleep -Seconds 90
$open = Sample 120
Say ("  open: {0} MB private, {1} processes" -f $open.PrivateMB, $open.Processes)

Say 'Closing the app window(s)'
foreach ($q in (Get-Process | Where-Object { ($Before.Procs -notcontains $_.Id) -and $_.MainWindowHandle -ne 0 })) { try { [void]$q.CloseMainWindow() } catch { } }
Start-Sleep -Seconds 60
$closed = Sample 300
Say ("  closed: {0} MB private, {1} processes, {2} % CPU" -f $closed.PrivateMB, $closed.Processes, $closed.CpuPct)

# ------------------------------------------------------------------------------------------------- what stays
$After = Snapshot
$disk = 0.0; foreach ($r in $Roots) { $disk += (Folder-MB $r) - $Before.Disk[$r] }
$newSvc = @(Get-Service | Where-Object { $Before.Services -notcontains $_.Name })
$result = [pscustomobject]@{
  app = $App; name = $A.Name; date = (Get-Date -Format 'yyyy-MM-dd HH:mm'); installer_mb = $installerMB
  downloaded_during_install_mb = [math]::Round((($After.Net - $Before.Net) / 1MB) - $(if ($A.Local) { 0 } else { $installerMB }), 0)
  install_minutes = $installMin; disk_mb = [math]::Round($disk, 0)
  open = $open; closed = $closed
  services = @($newSvc | ForEach-Object { [pscustomobject]@{ name = $_.Name; status = "$($_.Status)"; start = "$($_.StartType)" } })
  startup_entries = @($After.Run | Where-Object { $Before.Run -notcontains $_ })
  scheduled_tasks = @($After.Tasks | Where-Object { $Before.Tasks -notcontains $_ })
  setup_answers = @($Pressed | Select-Object -Unique)
}
$result | ConvertTo-Json -Depth 5 | Set-Content -Path (Join-Path $OutDir "$App.json") -Encoding UTF8
$md = @(
  "# $($A.Name): footprint in a fresh Windows Sandbox ($($result.date))", '',
  '| | |', '|---|---|',
  "| Installer | $installerMB MB, then $($result.downloaded_during_install_mb) MB downloaded while installing |",
  "| Disk used | $($result.disk_mb) MB |",
  "| Window open, idle | $($open.PrivateMB) MB private ($($open.WorkingMB) MB working set), $($open.Processes) processes |",
  "| Window closed | $($closed.PrivateMB) MB private, $($closed.Processes) processes, $($closed.CpuPct) % CPU over 5 min |",
  "| Services added | $($newSvc.Count) ($(@($newSvc | Where-Object Status -eq 'Running').Count) running) |",
  "| Starts with Windows | $(@($result.startup_entries).Count) sign-in entries, $(@($result.scheduled_tasks).Count) scheduled tasks |",
  '', "Processes while closed: $($closed.Names -join ', ')", "Setup answers: $($result.setup_answers -join ', ')"
)
Set-Content -Path (Join-Path $OutDir "$App.md") -Value $md -Encoding UTF8
Say "Done: $OutDir\$App.md. Close the Sandbox to throw everything away."
