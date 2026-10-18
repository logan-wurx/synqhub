# Corsair keyboards & mice (desktop-only: iCUE 5 / BRAGI)

How SYNQ talks to Corsair peripherals that Corsair's **Web Hub does not cover** — above all the
magnetic-switch board **K70 MAX (MGX)** and the K-series RGB boards + Corsair mice. All use Corsair's
**BRAGI / Corsair V2** HID protocol. Wave 3a owns the Web Hub path (`src/lib/brands/corsair/`); this is
the separate iCUE path (`src/lib/brands/corsair-icue/`).

**Source method (nothing was run; iCUE was never launched, no Corsair service started/stopped).**
iCUE 5 is installed at `C:\Program Files\Corsair\Corsair iCUE5 Software` (≈960 MB). Three of its
DLLs were read as data (`DeviceCommands.dll`, `DeviceControllers.dll`,
`ProtocolHelpers.dll`); their MSVC RTTI symbols under `cue::dev::cmd` name the whole command surface.
The per-device definition lives in downloadable **cuepkg** packages whose URLs are listed in the
installed `cuepkg.registry`; we fetched the official K70 MAX package
(`www3.corsair.com/.../dev-k70-max_5.41.1_win32-release-amd64.cuepkg`, SHA-256 in `DOWNLOADS.md`). It is
`cuepkg_10` header + a ZIP; inside, `meta/auxiliary.json` and the (zlib-compressed) manifest in
`k70_max.rcc` give the device facts below.

The **wire layer** is cross-checked against **OpenRGB** `CorsairPeripheralV2Controller`
(CalcProgrammer1/OpenRGB, GPL-2.0-or-later, read for the byte layout, not copied). SYNQ's code is
written fresh.

**EULA note.** The K70 MAX package references the "Corsair iCUE End-User License Agreement". We did not
decompile the DLLs for reuse — only read exported RTTI symbol names and open manifests, and implemented
the BRAGI transport independently from the GPL OpenRGB reference. Not legal advice.

---

## Transport (BRAGI / Corsair V2)

- **VID** `0x1B1C`. **Collection:** usage page `0xFF42`, usage `0x01`. *(src: OpenRGB detect.)*
- **Report id `0x00`**, 64 data bytes (65-byte write including the id). All settings and reads ride this
  one report. *(src: OpenRGB `CORSAIR_V2_WRITE_SIZE 65`.)*
- **Packet layout** (byte indices are into the 64-byte data, i.e. OpenRGB `buffer[n]` = data `[n-1]`):

  | data byte | meaning |
  |---|---|
  | `[0]` | **write id**: `0x08` wired, `0x09` wireless *(src: OpenRGB `WRITE_WIRED_ID/WIRELESS_ID`)* |
  | `[1]` | **command**: `0x01` SET, `0x02` GET, `0x05` STOP_TX, `0x06` BLK_W1, `0x07` BLK_WN, `0x0D` START_TX |
  | `[2]` | address / transaction opt1 |
  | `[3]+` | value / light-control register / block size |

- **Reads:** `GET 0x11` firmware+VID, `GET 0x12` PID, `GET 0x41` keyboard layout; `GET 0x01`/`0x22`
  probe the two lighting-control endpoints. *(src: OpenRGB `GetAddress`, `LightingControl`.)*
- **Render mode:** `SET 0x03`, byte `[4]` = mode (`0x12` software-direct, `0x7E` hardware). *(OpenRGB.)*
- **Lighting write:** `START_TX opt1=0x00 ctrl=0x01|0x22` → `BLK_W1` (size at `[3..4]` LE, payload from
  `[7]`) → `BLK_WN` (payload from `[3]`) → `STOP_TX 0x01 ctrl`. *(OpenRGB `SetLEDs`.)* A ~1 ms pace
  between packets avoids lock-ups (K70/K100).

Handshake: open `0xFF42` → `GET 0x11` (firmware/VID, also sets packet capability) → `GET 0x12` (PID) →
pin the lighting endpoint (K100 → `0x22`).

---

## iCUE command surface (what the device can do)

From `DeviceCommands.dll` RTTI (`cue::dev::cmd::…`). This is the **semantic** surface; the byte-level
BRAGI encoding of the analog/profile writes is abstracted in the DLL and shipped in the (compressed)
device manifest, so it is **not published** — SYNQ reads lighting/identity and leaves analog
**read-only** (tier `read-only`) rather than emitting unverified actuation writes.

- **Magnetic / analog (K70 MAX):** `GetAnalogSwitchSettings`, `SetKeyActuationSetting`,
  `SetRapidTriggerSetting` (`RapidTriggerSettingOption`, `ContinuousRapidTriggerReportingEnabled`),
  `GetGameModeActuationSettings`/`SetGameModeActuationSettings`, `SetGameModeActuationOverrideEnabled`,
  `CommitKeyActuationSettings`.
- **Lighting:** render mode + the LED transaction above; `SaveHwLightingEffect`,
  `SetKeySpecificBacklightFrame`, brightness.
- **Mouse/common:** `SetDpiData`/`CommitDpis`, `SetPollingRate`/`SetWirelessPollingRate`,
  `SetLiftHeightLevel`, `SetAngleSnapping`, `SetButtonDebounceTime`, `SetKeyMapping`/`CommitMappings`,
  `SetActiveHardwareProfileIndex`.

### K70 MAX facts (from `dev-k70-max` cuepkg)

- `usb-vid 0x1B1C`, `usb-pid 0x1BC0`; `DeviceType: Keyboard`; `HidProto: "Bragi_kbd"`;
  `DeviceEnumerator: "Bragi"`; `HasOnboardMemory: true`; min firmware `1.16.93`.
- `KeyActuationCapabilities: { minRecommendedDistance 0.4, maxRecommendedDistance 3.6 }` mm,
  `DefaultActuationDistance 20` (0.1 mm units → 2.0 mm). `SupportsActuation: true`.
- `MaxSupportedPollingRates.defaultDevice: PR_8000Hz`. `FlashTapCapabilities`, `KeyLock`,
  `BragiHwpCapabilities { assignmentMapFileVersion V2, maxFileSize 16368 }`.
- Firmware update: `tool: BragiFwUpdateTool`, operating mode `Bootloader`, `CRC32_MPEG2` — **blocked**.

---

## Dangerous commands — blocked (never sent)

The guard (`src/lib/brands/corsair-icue/guard.ts`) is a **strict allowlist**: only the BRAGI operations
confirmed safe from OpenRGB pass — identity/layout **reads**, the **render-mode** switch, and the
**lighting transaction** opened on a lighting endpoint (`START_TX opt1=0, ctrl ∈ {0x01,0x22}`). Because
everything else is refused, every dangerous iCUE command is unreachable *by construction*, including:

| iCUE command | why |
|---|---|
| `SetFirmwareUpdatingState`, firmware transfer (`BragiFwUpdateTool`, Bootloader mode) | firmware |
| `Reset`, `PowerReset` | factory-reset |
| `ResetHardwareStorage`, `ResetHardwareProfile`, `ClearHardwareProfile` | profile-wipe |
| `StartPairing`, `SetPairingId` | pairing |
| `StartCalibration`, `ApplyCalibration`, `InitJoystickCalibrationStep` | calibration |
| `SetKeyActuationSetting`, `SetRapidTriggerSetting` (exact BRAGI bytes unverified) | unknown |
| `CommitKeyActuationSettings`, `CommitHwSettings` (flash commit) | profile-wipe |
| `SetPollingRate`, `SetDpiData`, `SetKeyMapping` (unverified BRAGI bytes) | unknown |

Specifically refused at the wire level: any command byte other than `0x01/0x02/0x05/0x06/0x07/0x0D`; a
`GET` of any address other than `0x11/0x12/0x41/0x01/0x22`; a `SET` of anything but render mode (`0x03`);
a transaction opened on a non-lighting endpoint (`opt1 ≠ 0` or `ctrl ∉ {0x01,0x22}`) — which is how a
firmware transfer would start; a write id that isn't `0x08/0x09`; wrong report id or length.
`scripts/corsair-icue-codec.test.ts` proves all of this and that no SYNQ encoder emits a blocked frame;
`scripts/corsair-icue.sim.mjs` drives a full lighting transaction against a simulated K70 MAX and shows
five dangerous frames are refused before reaching the device.

---

## Devices covered (tier read-only)

| model | PID | kind | analog | source |
|---|---|---|---|---|
| **K70 MAX (MGX magnetic)** | **0x1BC0** | keyboard | **yes** | iCUE cuepkg `dev-k70-max` |
| K70 Core RGB / TKL | 0x1BFD / 0x2B01 | keyboard | no | OpenRGB |
| K70 RGB PRO / PRO V2 | 0x1BC4 / 0x1BB3 | keyboard | no | OpenRGB |
| K100 RGB Optical (v1/v2) / MX Red | 0x1B7C / 0x1BC5 / 0x1B7D | keyboard | no | OpenRGB |
| K95 RGB PLATINUM XT | 0x1B89 | keyboard | no | OpenRGB |
| K55 RGB PRO | 0x1BA4 | keyboard | no | OpenRGB |
| M75 / M75 Wireless | 0x1BF0 / 0x1BF1 | mouse | — | OpenRGB |
| M65 RGB Ultra (wired) | 0x1B9E | mouse | — | OpenRGB |
| Scimitar Elite RGB V2 | 0x1BE3 | mouse | — | OpenRGB |
| Katar Pro V2 | 0x1BBA | mouse | — | OpenRGB |
| M55 RGB PRO | 0x1B70 | mouse | — | OpenRGB |

**Overlap note (for Wave 3a):** some of these PIDs may also appear on Corsair's Web Hub. Where both
cover a device, the Web Hub (`src/lib/brands/corsair/`) is the richer path; this iCUE/BRAGI path exists
for the devices the Web Hub can't reach — the magnetic K70 MAX especially — and for lighting/identity on
the rest.

## What still needs a real device
- The exact BRAGI property bytes for **magnetic actuation** and **rapid trigger** on the K70 MAX
  (abstracted in the iCUE DLL; the device manifest that would hold them is compressed/binary). SYNQ
  documents the 0.4–3.6 mm range and command names but does not emit actuation writes.
- Per-key lighting payload geometry (LED order/zones) for each board.
- Confirmation of the OpenRGB PIDs against live hardware for the newer boards (K70 Core TKL, M75).
