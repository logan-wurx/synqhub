# OnBoard Hub 0.1.0-beta.5 release notes

Private beta, 2026-10-16. A 24-hour test with one friend and a few testers. Not for sharing further.

| | |
|---|---|
| Installer | `OnBoard Hub_0.1.0-beta.5_x64-setup.exe` |
| Size | 31.1 MB (32,587,907 bytes) |
| SHA-256 | `0ecb4d3a8ed81ddffb978bd398e9ca381a35d4d4cf2011f6a86caa374ac45229` |
| Needs | Windows 10 or 11, 64-bit. WebView2 (built into Windows 11; Windows 10 PCs without it download it during install) |
| Install type | Per machine (`C:\Program Files\OnBoard Hub`), one administrator prompt |
| Signed? | No. Windows SmartScreen shows "Windows protected your PC": **More info**, then **Run anyway** |
| Bundled | Equalizer APO 1.4.2 (`EqualizerAPO-x64-1.4.2.exe`, the official file, checked by size and SHA-256 before it is run) |

Friend's instructions are in `BETA-GUIDE.md`.

## New in beta 5

- **Gear Doctor.** **Run checkup** on the Devices page: about 50 seconds of guided steps for every connected mouse,
  keyboard, controller and the sound output (click chatter, real polling rate, dropouts and sensor jumps, stuck or
  chattering keys, stick drift and circularity, EQ sanity), then a report card per device in plain words. **Fix it**
  uses the device's own guarded settings (debounce, polling, rapid trigger) with a backup and **Undo**. It only listens
  while OnBoard is the window in front.
- **Pro setups.** Inside Keep your feel, collapsed: 41 CS2 and Valorant pros (source and date for each). Their DPI,
  polling and in-game sensitivity translated to your mouse, side by side with yours; **Apply** and **Undo**.
- **Lights.** Your Govee lamps over Bluetooth with no Govee app: colour, white, brightness, painting segment by segment
  on a drawing shaped like the real light, gradients, the lamp's own scenes with moving previews, DIY effects, music mode
  and screen sync (about 1 ms of CPU a second, off by default, an obvious Stop). 85 Govee models, Philips Hue, Nanoleaf,
  Elgato, Twinkly, WiZ, Yeelight and LIFX on your home network (found only when you press Find lights; no accounts, no
  cloud), Windows Dynamic Lighting devices, and USB RGB hubs (NZXT HUE 2, Corsair Lighting Node family, Lian Li Uni Hub
  SL). Only the H6076 floor lamp has been tried on real hardware; everything else says Experimental. Nothing ASUS is ever
  listed or touched.
- **Headphones and headsets.** **Find your headphones** on the Sound page: about 6,000 models from AutoEq, fetched from
  GitHub only when you open it, saved as a preset or used now (with a backup). 27 gaming headsets (SteelSeries Arctis Nova
  7 family, Logitech G535 / PRO X / G733 / G935 families, HyperX Cloud II Wireless): battery, chat-mix and their settings
  behind **Allow changes**.
- **Monitors and webcams.** Monitors over DDC/CI (brightness, contrast, colour preset and balance, volume, input with a
  15-second "keep it?"), webcams over UVC (exposure, focus, zoom, white balance...), read-only until **Allow changes**,
  backed up first, **Put back**. Never a factory reset or a power command.
- **A tidier Devices page.** Cards grouped by type, a type filter once the list is long, "Keep your feel" only where it
  applies, the sidebar saying "N connected" instead of a cut-off list, device pages without a tab bar when they have one
  tab, and an amber (not red) note when the EQ clips. 640 official device pictures (from 527); everything else has a
  drawing of its own shape.
- **Lights and Displays tabs.** The sidebar is now Devices, Lights, Displays, Games, Settings: mice, keyboards, sound,
  controllers and webcams on Devices; every light on Lights; monitors on Displays. A lamp at the edge of Bluetooth reach
  no longer flickers between in range and weak.
- **Open source.** OnBoard is free software under the GNU AGPL 3.0 or later (LICENSE; Settings > About links to the code).
- **Website.** Works in a narrow browser window (the sidebar becomes icons).
- **Accessibility and idle cost.** Every page works from the keyboard (arrow keys in every choice row, a visible focus ring), text meets WCAG AA contrast, "reduce motion" is honoured, and on Windows the device list now updates from plug and unplug events instead of a timer (an idle Devices page measured at about 0.01 % CPU).

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

**Controllers**
- Every controller Windows sees, with its photo or a drawing: a live tester (drift, circularity, deadzones, triggers, buttons, gyro, battery, real polling rate), volatile light and rumble tests on request, and experimental settings for DualSense Edge, GameSir, 8BitDo and Flydigi pads behind **Allow changes**.

**Lights**
- Govee lights over Bluetooth with no Govee app (85 models): colour, white, brightness, painting by segment on a drawing shaped like the light, gradients, the light's own scenes, DIY effects, music mode and screen sync.
- Wi-Fi lights on the home network (Philips Hue, Nanoleaf, Elgato, Twinkly, WiZ, Yeelight, LIFX), found only when you press **Find lights**; Hue and Nanoleaf pair with a guided button press. No accounts, no cloud.
- Windows Dynamic Lighting devices (while OnBoard Hub is in front) and USB RGB hubs (NZXT HUE 2, Corsair Lighting Node family, Lian Li Uni Hub SL) behind **Allow changes**. ASUS lighting is never listed or touched.
- One Lights view for all of them: a look or a gradient to every light or a named group, and screen sync across lights on any monitor (Hue through its Entertainment mode).

**Headphones, headsets, monitors and webcams**
- **Find your headphones:** about 6,000 AutoEq presets by model name, downloaded from GitHub only when opened.
- 27 gaming headsets (SteelSeries Arctis Nova 7 family, Logitech G535 / PRO X / G733 / G935, HyperX Cloud II Wireless): battery and chat-mix, settings behind **Allow changes**.
- Monitors over DDC/CI (brightness, contrast, colour, volume, input with a 15-second "keep it?") and webcams over UVC (exposure, focus, zoom, white balance...), read-only until **Allow changes**, backed up first, with **Put back**.

**Gear Doctor and Pro setups**
- **Run checkup:** about 50 seconds of guided steps and a report card per device; **Fix it** uses the device's own guarded settings, with **Undo**. Listens only while OnBoard Hub is in front.
- 41 CS2 and Valorant pros' setups translated to your mouse, with **Apply** and **Undo** (inside Keep your feel).

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
| **Lights, protocol proven** | Govee H6076 floor lamp (encryption v1) | The handshake, encryption and power commands were proven on the developer's lamp with the same protocol code; the app's lamp pages are checked against simulations, with owner checks in `docs/devices/LIGHTING.md` §8. |
| **Experimental** | Every other light, headset, monitor, webcam, RGB hub, Dynamic Lighting device and controller setting | Built from public protocol documentation and simulations, never tried on the real device. Read first; changes wait for **Allow changes**; every message passes an allowlist mirrored in the Rust bridge. |

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
- **Most of the new hardware support has never met real hardware** (above). Lights, headsets, monitors, webcams and hubs are Experimental until someone with one tries them; Hue's Entertainment stream (OnBoard's own DTLS client) is untested against a real bridge.
- **Windows Dynamic Lighting** devices only take colours while OnBoard Hub is the window in front (Windows only gives background lighting to packaged apps), so they can't follow screen sync.
- **Yeelight** needs LAN Control switched on once in Yeelight's own app; **first-time Wi-Fi setup** of any light is the maker's app.
- **Windows 10/11 x64 only,** English only, no automatic updates (install the next beta over this one), no ARM build.
- **The window is drawn in software** on purpose (it saves about 110 MB of RAM); that can't be changed in this build.
- **A few leftovers in the build,** none of them a risk to a tester: the preview-mode sample data for the browser UI (it includes the developer's own headphone name and DAC) is still in the shipped web bundle but is never used inside the real app, a USB-ID entry names one particular DAC as an "IEM output", and the embedded config still contains the dev-server address `http://localhost:1420`, which the release build never opens.

## How this build was made and checked

- Built with `node release/tools/build-release.mjs` (same `tauri build --bundles nsis` as always, separate target dir, build-machine folder names rewritten out of the exe). `perf-test` is off.
- `release/tools/leak-scan.mjs` checks the exe and the web files inside it for personal paths, secrets and debug ports.
- `release/tools/installer-contents.py` unpacks the installer in memory (nothing run) and confirms the app, the bundled Equalizer APO installer (size and SHA-256) and the hook that runs `--eq-engine install --only-if-missing`.
- `release/sandbox-test/` is the fresh-install test for Windows Sandbox (install silently, check Equalizer APO, start the app, uninstall).
