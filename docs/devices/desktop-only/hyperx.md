# HyperX NGENUITY — findings (target 4, investigation only)

Status: **investigated, no protocol layer built.** NGENUITY turned out not to carry the raw HID bytes in
a form SYNQ can reimplement from the app alone (see Architecture). This documents what was learned so
a later pass (or a USB capture on real hardware) can finish it.

**Source method (nothing was run).** Downloaded the official standalone installer
`HyperX_NGENUITY_Installer_3.1.0.exe` (link from `hyperx.com/pages/ngenuity`,
`files.hyperx.com/.../ngenuity/stable/3.1.0/…`, SHA-256 in `DOWNLOADS.md`). It is a Velopack/Squirrel
package: the overlay is a NuGet ZIP (`NGENUITY.nuspec` + `lib/app/…`). Extracted the managed assemblies
(`NGENUITY.dll`, `NGENUITY.Common.dll`, `NGENUITY.Platform.Windows.dll`) and read their .NET metadata
strings. `ilspycmd` 8.2 could not fully decompile them (newer .NET; it asks for 11.x), so this is from
the metadata/resource strings, not full source.

## Architecture (why the HID bytes aren't here)

NGENUITY 3.x is an **Avalonia .NET** desktop app. Its device code does **not** build HID reports in
managed code. Instead it:

- encodes requests as **FlatBuffers** (`CreateSetSonamiPresetPayload`, `GetRootAsSonamiPreset`, …), and
- ships them over **NetMQ (ZeroMQ, `tcp://`) / NamedPipe** to an **EngineService** process, which
- loads the **native C++ HID libraries** bundled beside it and does the actual USB/HID I/O:
  - `SnxHidLib.dll` — **Sonix** controller (HyperX Alloy keyboards are Sonix-based),
  - `RvcHIDLib641001.dll` / `RvcLib641001.dll` — the mouse/"RVC" stack,
  - `AirohaHidCoreDll.dll` — Airoha Bluetooth (wireless headsets),
  - `dfu1620-hid.dll` + `FWUpdater.dll` — **firmware/DFU** (dangerous; never to be driven),
  - `SONAMIGaming_x64.dll` + `onnxruntime.dll` — the AI mic feature.

So the per-command byte encoding lives in the native libs, not the managed app. Reproducing it would
need either RE of `SnxHidLib`/`RvcHidLib` (C++) or a USB capture from a real device — out of scope for
this optional target.

## Strong cross-reference (the useful result)

HyperX Alloy keyboards use **Sonix** (`SnxHidLib`). SYNQ **already** has a Sonix Hall-effect driver
(`src/lib/kb/fcc`, the "FCC" Sonix HE catalog) and a QMK/VIA path (`src/lib/kb/via`). The most promising
route to HyperX keyboard support is therefore **not** a NGENUITY-derived layer but trying SYNQ's
existing Sonix/VIA drivers against a HyperX Alloy board and confirming the USB ids. The analog boards
(Alloy Rise / Rise 75) expose exactly the fields SYNQ's analog model already has.

## What NGENUITY exposes

- **Analog actuation + rapid trigger** (Alloy Rise / Rise 75 / Rise 75 Wireless): resource/property
  names `ActuationPoint`, `IsRapidTriggerEnabled`, `RapidTriggerPress`, `RapidTriggerRelease`,
  `SyncRapidTriggerPressRelease`, plus `SensitivityMin/MaxTip`. Units/ranges are rendered in the UI from
  engine data — **needs a device** to pin exact min/max/step.
- **Models covered** (from the string table): Alloy Rise, Alloy Rise 75 (+ Wireless), Alloy Origins /
  Origins 2 / Origins 60/65/265 / Origins Core, Alloy Elite 2, Alloy Core (2) RGB, Alloy MKW 100;
  mice Pulsefire Haste 2 (/ Core / Mini / Pro / Wireless), Haste, Fuse, Dart, FPS Pro, Core.
- **USB vendor id:** HyperX uses `0x03F0` (HP era) and `0x0951` (Kingston era); per-model PIDs are kept
  as integers in the engine's device config / FlatBuffers, **not** as readable constants in the managed
  metadata, so they still need a device or the native config to confirm.

## Dangerous surface (would be blocked)
`dfu1620-hid.dll` + `FWUpdater.dll` (firmware/DFU), plus any engine "reset"/"pairing" verbs. A HyperX
layer, if built later, must block these exactly as the Logitech and Corsair layers do.

## Recommendation
1. First try SYNQ's existing `src/lib/kb/fcc` (Sonix) and `src/lib/kb/via` drivers on a HyperX Alloy
   board — HyperX keyboards are Sonix, which SYNQ already speaks.
2. If a dedicated HyperX layer is wanted, get the byte protocol from a **USB capture** on real hardware
   or from the native `SnxHidLib`/`RvcHidLib`, not from NGENUITY's managed code.
