# OnBoard Hub 0.1.0-beta.3 release notes

Private beta, 2026-10-14. A 24-hour test with one friend and a few testers. Not for sharing further.

| | |
|---|---|
| Installer | `OnBoard Hub_0.1.0-beta.3_x64-setup.exe` |
| Size | 24.5 MB (25,655,079 bytes) |
| SHA-256 | `2345afec7f43c4783f0310ca2fb52d639d134aef80527768cfbd1415896cc927` |
| Needs | Windows 10 or 11, 64-bit. WebView2 (built into Windows 11; Windows 10 PCs without it download it during install) |
| Install type | Per machine (`C:\Program Files\OnBoard Hub`), one administrator prompt |
| Signed? | No. Windows SmartScreen shows "Windows protected your PC": **More info**, then **Run anyway** |
| Bundled | Equalizer APO 1.4.2 (`EqualizerAPO-x64-1.4.2.exe`, the official file, checked by size and SHA-256 before it is run) |

Friend's instructions are in `BETA-GUIDE.md`.

## New in beta 3

- **Redesign:** a Devices home with a card per device (inactive devices greyed and sorted last), per-device tabs, a status strip, a click-and-drag key map with one slider for the selection, live key travel, guided Advanced Keys with CS2-legality notes, and full-window layouts at 1080p and 1440p.
- **First-run welcome:** offers OnBoard Helper and an accent colour; a Helper chip in the sidebar.
- **OnBoard Helper (opt-in, under 1 MB, nothing runs unless you turn it on):** per-game profiles that apply when a game starts and restore when it closes (Steam and Epic games found automatically, with cover art); battery alerts at 20, 10 and 5 %; a local bridge so the website can reach Razer, the EQ and the Advanced features.
- **Advanced section:** pairing, button remaps and macros, guided calibration and factory reset where the commands are known. Each needs a confirmation, backs up first, and keeps left click. Firmware updates stay blocked.
- **Keep your feel:** save your setup once, and a new mouse or keyboard of any brand is offered a one-click match, with a CS2/Valorant sensitivity calculator when the exact DPI isn't possible.
- **Device pictures:** official photos for about 540 models (Razer, Logitech, Corsair, ASUS and SteelSeries complete), drawn keyboards and silhouettes for the rest.
- **More keyboards:** MCHOSE (configurable), NuPhy, Royal Kludge (Gcome and 168 older boards), DrunkDeer OEM, Redragon / Epomaker / Womier HE, SparkLink (Royal Kludge M75 HE, AULA HE, Kochi) and Keychron / Lemokey HE. Untested boards start read-only.
- **Web version** (not hosted yet) and OpenMouse 0.42.1.

## What's in it

**Sound**
- System-wide EQ for whatever Windows plays through the current output (up to 20 filters, boosts to +6 dB, cuts to -24 dB, preamp), presets, auto preamp, a band finder, and a backup of the previous setting on every save. It never saves an EQ that would be louder than the source.
- The EQ engine is Equalizer APO. The installer sets it up when it is missing and leaves an existing install alone. In the app, **Set it up** / **Fix it** installs, repairs or puts the engine on an output (one Windows prompt), and **Undo the last engine change** restores the saved registry values. Every change is backed up first and only touches the engine's own registry places. Credit, license (GPL-2.0) and a source link are in the app (Sound > EQ engine panel).
- Headphone names are kept per PC, in the app's own data folder.

**Mouse**
- Logitech HID++ mice through OpenMouse's driver: DPI steps, polling rate (up to 8K where the mouse and receiver allow), lift-off distance, battery and firmware display. The mouse's model name is read from the mouse itself, so a Superlight 2 should show up by name.
- ATK X1 V2 Air+ (8K receiver): DPI steps, polling to 8K, lift-off, angle snapping, ripple control, motion sync, sensor mode and debounce.
- Other mice that OpenMouse has a driver for appear as candidates and are claimed only when a driver recognises them.

**Keyboard**
- ROG Falchion Ace HFX ZywOo: per-key actuation (0.1 mm steps), rapid trigger, deadzones, Speed Tap, lighting, key remaps and polling rate, written over the keyboard's own channel. Armoury Crate is not needed and is left alone.
- MAGIC-REFINER X68 HE: reads the keyboard and, once you allow changes, per-key actuation and rapid trigger, SOCD, lighting, polling rate, advanced keys, profiles and Win lock. Read-only until switched on, with a backup first and a read-back after each change.

**Light on the PC.** Nothing runs when the window is closed. Measured on a release build: about 125 MB private on the Sound page, 11 to 12 MB in RAM while minimized, no CPU when idle (`docs/performance.md`).

## Support tiers (as of this build)

How much OnBoard trusts each device, and what the app lets you do.

| Tier | Devices | What it means |
|---|---|---|
| **Verified** | Logitech PRO X 2 DEX (cable and LIGHTSPEED receiver), ATK X1 V2 Air+ (receiver and cable) | Tested by hand with OnBoard Hub on the exact device. Changes are on from the start. |
| **Expected to work, not hand-tested** | Logitech PRO X SUPERLIGHT 2 | Same OpenMouse Logitech driver and the same panel as the DEX; the driver's own notes say it was tested on the Superlight 2. OnBoard Hub itself hasn't been tried on one. The friend's run is the first real test. |
| **Driver-tested** | Other mice whose OpenMouse driver is marked tested | OnBoard hasn't been tried on them. Shown read-only until you turn on **Allow changes**. |
| **Read-only** | Every other mouse OpenMouse can recognise | Read and displayed; changes stay off until you allow them. |
| **Keyboard, works on one unit** | ROG Falchion Ace HFX ZywOo | Its protocol was captured from Gear Link on the developer's own keyboard, and every encoder is checked byte-for-byte against that capture. One unit, one firmware (1.00.03). |
| **Keyboard, experimental** | MAGIC-REFINER X68 HE | Protocol read from illumipc.com's public code and checked against a simulated keyboard. **Never tried on real hardware.** Starts read-only; the first run produces a diagnostics file for us. |
| **Sound** | Any Windows playback device that allows effects | The engine is a standard Windows audio effect (APO). Developed against one USB DAC with IEMs. |

Safety rules that apply to every device: every outgoing report passes an allowlist (checked again in the Rust bridge). Firmware or bootloader updates, pairing, factory reset, calibration, macros and button remapping on mice, and anything that changes a device's USB identity are not reachable from the app.

## Known gaps

Things we know about and are shipping anyway:

- **Not code-signed.** SmartScreen warns, the permission prompt says "Unknown publisher", and the Apps list shows the publisher as "logan" (taken from the app id). Some antivirus tools are suspicious of unsigned installers; tell us if one removes the file.
- **This exact build hasn't been run on a clean Windows install yet.** The installer's contents and the install script were checked statically, and a Windows Sandbox test kit is ready (`release/sandbox-test/`), but Sandbox isn't enabled on the build PC.
- **X68 HE untested on hardware** (above). Expect surprises in the Keyboard page for that board. Its polling-rate change makes the keyboard drop off USB for a moment, which is expected. Factory reset, firmware and switch calibration stay in illumipc.com on purpose.
- **Superlight 2 untested in OnBoard** (above).
- **EQ engine.** Setting it up needs administrator approval, restarts Windows Audio (sound blips for a second or two), and on some PCs Windows only loads it after a restart. Outputs with "Audio enhancements" turned off, or drivers without an effects slot, can't take the engine; the app says which. Equalizer APO's own Configuration Editor must not be left open at the same time.
- **Uninstalling OnBoard Hub leaves Equalizer APO installed** (by design; the guide says how to remove it). Its own Start-menu entries remain.
- **Mouse limits.** No button remapping, macros or firmware tools. Which settings a given mouse keeps after power-off is shown per setting, and for many third-party mice it is "not verified".
- **Windows 10/11 x64 only,** English only, no automatic updates (install the next beta over this one), no ARM build.
- **The window is drawn in software** on purpose (it saves about 110 MB of RAM); that can't be changed in this build.
- **A few leftovers in the build,** none of them a risk to a tester: the preview-mode sample data for the browser UI (it includes the developer's own headphone name and DAC) is still in the shipped web bundle but is never used inside the real app, a USB-ID entry names one particular DAC as an "IEM output", and the embedded config still contains the dev-server address `http://localhost:1420`, which the release build never opens.

## How this build was made and checked

- Built with `node release/tools/build-release.mjs` (same `tauri build --bundles nsis` as always, separate target dir, build-machine folder names rewritten out of the exe). `perf-test` is off.
- `release/tools/leak-scan.mjs` checks the exe and the web files inside it for personal paths, secrets and debug ports.
- `release/tools/installer-contents.py` unpacks the installer in memory (nothing run) and confirms the app, the bundled Equalizer APO installer (size and SHA-256) and the hook that runs `--eq-engine install --only-if-missing`.
- `release/sandbox-test/` is the fresh-install test for Windows Sandbox (install silently, check Equalizer APO, start the app, uninstall).
