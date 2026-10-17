# Fresh-install test in Windows Sandbox

Tests the beta installer on a clean, throw-away Windows: install silently, check that Equalizer APO (the EQ engine) got installed and set up, start the app, uninstall. Nothing touches your real PC; the Sandbox is deleted when you close it.

Nothing here has been run yet. **Windows Sandbox is not turned on on this PC**, and nothing in this kit turns it on.

## One-time: turn Windows Sandbox on

Needs Windows 10/11 **Pro, Enterprise or Education** and virtualization enabled in the BIOS.

1. Start menu, type **Turn Windows features on or off**, open it.
2. Tick **Windows Sandbox**, click OK, and restart when it asks.

(Or, in an administrator PowerShell: `Enable-WindowsOptionalFeature -Online -FeatureName "Containers-DisposableClientVM" -All`, then restart.)

That is a change to Windows itself, so it is yours to make.

## Run the test (3 clicks)

1. Make sure the installer is built and the files are rendered (`node release/tools/build-release.mjs`). You need `release\SYNQ_<version>_x64-setup.exe`, `release\SHA256SUMS.txt` and `release\sandbox-test\app.json`.
2. **Double-click `onboard-sandbox.wsb`.** A Sandbox window opens (about 30 seconds). A PowerShell window starts the test by itself; if Windows asks for permission inside the Sandbox, click **Yes**.
3. **Wait and don't click inside it.** It takes roughly 3 to 6 minutes. You'll see SYNQ open for about 15 seconds, that is part of the test. It ends with a line like `=== Verdict: PASS with warnings ... ===`.

Then read **`sandbox-results\RESULTS.md`** in the repo folder on your own PC (the Sandbox writes there live, so you can open it while the Sandbox is still up). Close the Sandbox window and choose OK to discard it.

To run it again, close the Sandbox and double-click the file again. Every run starts from a clean Windows.

## The SYNQ Helper test (`synq-helper-sandbox.wsb`)

Double-click **`synq-helper-sandbox.wsb`** instead to test SYNQ Helper on its own, the way the website hands it out. `helper-test.ps1` downloads `synq-helper.exe` from the website's link (checked against `SHA256SUMS.txt`), starts it the way a double-click does, and checks that it installed itself (its folder, the Apps-list entry, the sign-in entry, the port). It then talks to it exactly as synqhub.app does: another site is refused, the "allow this site?" box is answered **Yes** by the script, every command the website sends gets an answer or a plain error, and the next visit pairs without asking. It uninstalls it from the Apps-list command, then installs the SYNQ app and checks that the same download turns the app's own helper on instead of installing a second copy. Windows asks for administrator once (for the app install): click **Yes** inside the Sandbox. Results: `sandbox-results\RESULTS-helper.md`.

## What the test checks

| Step | Looks at |
|---|---|
| Machine | Windows build, WebView2 present, sound outputs, and that Equalizer APO and the app are not already installed |
| Installer file | found, SHA-256 equals `SHA256SUMS.txt`, signature state (unsigned is expected) |
| Install | `installer.exe /S` finishes with exit code 0 |
| Files | app in `Program Files`, version matches the build, uninstall entry, Start-menu and desktop shortcuts, the bundled Equalizer APO installer is byte-identical to the official one |
| Equalizer APO | installed (registry + DLL), version 1.4.2, both effect classes registered with Windows, "protected audio" setting allows it, its update-check task was removed, `config.txt` starts flat, engine is on an active sound output (registry), and SYNQ's own `synq.exe --eq-engine status` agrees |
| Launch | window opens with the app's name, still running 12 s later, WebView2 processes use the app's profile, a screenshot, no Windows crash report, closes cleanly |
| Uninstall | app removed; **Equalizer APO stays** (as `BETA-GUIDE.md` says); your data folder is kept |

## Reading the results

`RESULTS.md` has one line per check: PASS, FAIL, WARN, INFO or SKIP, and an overall verdict.

- **FAIL** is a real problem; the line says what was found. Send it along with `transcript.txt`.
- **WARN** needs a look but is often expected. The usual one in Sandbox: *"EQ engine is on the default sound output"* warns because **a Sandbox has no sound card**, so there is no output to put the engine on. The install, the registration and the flat config are still checked. Setting the engine on a real output is only testable on a real PC (or a Sandbox that happens to have a "Remote Audio" output; the results list what it found in `environment.txt` and `render-endpoints.json`).
- **INFO** is just a fact (for example, the installer is unsigned).

Other files written next to `RESULTS.md`: `RESULTS.json`, `environment.txt`, `installed-files.txt`, `status-after-install.stdout.txt`, `status-after-launch.stdout.txt`, `setup-dry-run.stdout.txt`, `render-endpoints.json`, `app-data-tree.txt`, `app-launched.png` and `transcript.txt`.

## What it cannot check

- A real sound card and real devices (a Sandbox has no USB pass-through).
- The look of the SmartScreen and UAC prompts, and the clicks of the installer wizard (the test installs silently). For those, double-click **`onboard-sandbox-manual.wsb`** instead: same clean Windows, same folders, but the script does not run, so you run `C:\SYNQRelease\<installer>` by hand and click through.

## Safety

- `run-test.ps1` **refuses to run anywhere except inside Windows Sandbox** (it checks for the `WDAGUtilityAccount` user), so double-clicking it by mistake on this PC does nothing but print a message.
- `powershell -File run-test.ps1 -SelfTest` checks the script's own judging logic on made-up data. It installs nothing and is safe on any PC.
- The `.wsb` shares exactly two folders with the Sandbox: `release` (read-only) and `sandbox-results` (read/write). Clipboard, printers, microphone and camera are off. Networking is on only so that WebView2 can be downloaded on a Windows without it.
- If you move the `onboard` folder, edit the two `<HostFolder>` lines in both `.wsb` files.

## Files

- `onboard-sandbox.wsb`: the automatic test.
- `onboard-sandbox-manual.wsb`: the same Sandbox, no script, for clicking through yourself.
- `run-test.ps1`: the test (PowerShell 5.1, ASCII only).
- `app.json`: name, version, exe name, installer name and Equalizer APO facts the script reads. Written by `node release/tools/render-docs.mjs` from `src-tauri/tauri.conf.json`, so the app's name is only ever set in one place.
- `../../sandbox-results/`: where results land on your PC.
