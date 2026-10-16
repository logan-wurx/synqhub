# Logitech G keyboards (desktop-only: G HUB)

How SYNQ talks to Logitech G keyboards — the analog **RAPID** boards (PRO X TKL RAPID, G515 RAPID)
and the mechanical/RGB boards (G915, G815, G713/G715, PRO X 60, G213…). All of them speak **HID++ 2.0**.

**Source method (nothing was run; everything read as data).** G HUB is not installed on this PC. The
official bootstrapper `lghub_installer.exe` (logitechg.com → download01.logi.com, SHA-256 in
`wave4-src/DOWNLOADS.md`) is a thin downloader: it reads its own update route from embedded strings and
fetches "depots" from Logitech's CDN. Following the same route (read out of the installer's strings) we
fetched, over plain HTTP range reads, the update manifest and the `core` depot's data files only —
never executing anything:

- `GET https://updates.ghub.logitechg.com/pipeline/v2/update/ghub13/win/public/update.json`
  → build 876190, G HUB **2026.6.981214**.
- `…/details.json` → 780 depots, each `{name,size,url,mac(sha256)}`. Plain depots use magic
  `10 01 17 20` + u32 json-header `{"files":[{name,mode}]}` + per-file `u32 len`+bytes (no compression,
  no encryption). The per-**device** definition depots (UUID names) use magic `06 05 21 20` and are
  **signed + encrypted** (header `{"header-sha","key-id"}`, payload entropy ≈ 7.98), so the RAPID
  boards' runtime PIDs and exact actuation tables are **not** readable from the depots.
- From the `core` depot (range reads of single entries): `LGHUB/lghub_agent.exe` (the engine; MSVC RTTI
  + log strings name every HID++ feature class and the analog functions) and
  `LGHUB/resources/app.asar` (the Electron UI; `app.min.js` holds the capability model).

Cross-checked against **Solaar** (`pwr-Solaar/Solaar`, GPL-2.0-or-later, read only, not copied) for the
exact sub-function bytes, and **@openmouse/protocol** `drivers/logitech/hidpp.js` for the report framing
and the mouse analog feature 0x1B0C. SYNQ's code is written fresh.

**EULA note.** G HUB's bundled licenses are third-party (Qt, fonts, Sentry/Crashpad, Chromium). The
Logitech EULA (`logitech.com/legal/eula.html`, referenced from the installer) was not fetched; typical
Logitech terms restrict reverse-engineering. We did not decompile for reuse — only read strings and
open/public manifests, and implemented the protocol independently. Not legal advice.

---

## Transport

- **Vendor id** `0x046D`.
- **Collection:** HID++ vendor page **usage page `0xFF00`**, usage `0x0001` (short) and `0x0002` (long).
  Lighting/profile bulk transfers use a very-long report. *(src: @openmouse hidpp.js; agent symbols.)*
- **Report ids / sizes (data bytes after the id):**
  | report | id | data len |
  |---|---|---|
  | short | `0x10` | 6 |
  | long | `0x11` | 19 |
  | very-long | `0x12` | 63 |
- **Request layout:** `[deviceIndex, featureIndex, (function<<4)|softwareId, …params]`.
  - `deviceIndex`: `0xFF` for a cabled keyboard, `0x01…0x06` for a receiver slot. SYNQ's software id
    is `0x0B` (keeps replies apart from G HUB's `0x05`).
  - **featureIndex is not fixed.** The host first calls **IRoot** (always index `0x00`) function `0`
    `GetFeature(featureId)` to learn a feature's per-device index, then addresses that index. SYNQ
    resolves indices during `load()`; the guard is built from that map (`src/lib/brands/logitech-kb/guard.ts`).
- **Reply:** same report id, echoes bytes 0–2. **Error report:** `[index, 0xFF, feature, fn|sw, code]`.
  *(src: `logitech-ping.ts`, Solaar `base.py`.)*

Handshake: open the `0xFF00` collection → `IRoot.ping` (fn 1, `GetProtocolVersion`) → for each feature
SYNQ needs, `IRoot.GetFeature(id)` → build the index map → read state.

---

## Feature map (what each board exposes)

Feature ids present on G keyboards, from `lghub_agent.exe` RTTI/log strings (e.g.
`devio::Feature1B08AnalogKeys`, `Feature8102ProfileManagement`, `feature_8040_brightness_control`):

| id | name | SYNQ use |
|---|---|---|
| `0x0000` | IRoot | resolve indices, ping (read) |
| `0x0001` | FeatureSet | enumerate (read) |
| `0x0003` | FirmwareInfo | firmware version (read) |
| `0x0005` | DeviceName | model name (read) |
| `0x8060` | ReportRate | polling, 1–8 ms (read + write) |
| `0x8061` | ExtendedAdjustableReportRate | polling, 8ms…125µs (read + write) |
| `0x8040` | Brightness | brightness (read + write) |
| `0x8070`/`0x8071` | ColorLED/RGB effects | lighting (present; not yet written) |
| `0x8080`/`0x8081` | PerKeyLighting | per-key RGB (present; not yet written) |
| `0x8100` | OnboardProfiles | mode + current profile (read; **set mode only**) |
| **`0x1B08`** | **AnalogKeys** | **actuation / rapid trigger / key priority** on the RAPID boards |
| `0x1B0C` | AnalogButtons | mouse analog buttons (not keyboards; handled by OpenMouse) |

### Settings commands (byte encoding)

Function below is the **function index** (0–15); the wire byte is `(index<<4)|0x0B`. "fnid" is Solaar's
pre-shifted name. All multi-byte values big-endian. Confidence: **[C]** confirmed by Solaar/OpenMouse
code, **[I]** inferred from the agent's symbol pairing, **[D]** needs a device to confirm reply layout.

| setting | feature | read | write | encoding | conf |
|---|---|---|---|---|---|
| firmware | `0x0003` | fn0 GetInfo → count; fn1 GetFwInfo(entity)→name+ver | — | reply `[type, c0,c1,c2, hex, maj, min, build16]` | C |
| report rate | `0x8060` | fn0 list (bitmask of 1–8ms), fn1 current | fn2 `SetReportRate(msCode 1..8)` | `[code]` | C |
| report rate (ext) | `0x8061` | fn1 list (bits: 125,250,500,1k,2k,4k,8k Hz), fn2 current | fn3 `SetReportRate(code 0..6)` | `[code]` | C |
| brightness | `0x8040` | fn0 GetInfo→`[max16,stepsFlags,caps,min16]`, fn1 current | fn2 `SetBrightness(v16)`; fn4 on/off | `[hi,lo]`, scaled to device max | C |
| onboard mode | `0x8100` | fn0 info, fn2 GetMode, fn4 GetCurrentProfile | fn1 `SetMode(1=onboard, 2=host/SW)` | `[mode]` | C |
| **rapid trigger** | `0x1B08` | fn3 GetRapidTriggerState | fn4 SetRapidTriggerState(on) | `[0\|1]` | I/D |
| key travel events | `0x1B08` | — | fn2 SetKeyTravelEventsState(on) (arms notifications) | `[0\|1]` | I/D |
| key priority (SOCD) | `0x1B08` | fn5 GetKeyPriorityState | fn6 SetKeyPriorityState(on) | `[0\|1]` | I/D |

**Analog ranges (from the G HUB UI, `app.min.js`):** `analogSupport.supportedAnalogFeatures` =
`["ACTUATION_POINT","RAPID_TRIGGER","MULTI_ACTION",…]`; `keyTravelConfig.actuationPoint` carries
`{minimum, maximum, step, decimalLength}` with **0.1 mm** steps (`decimalLength:1`). Product pages give
PRO X TKL RAPID **0.1–4.0 mm** and G515 RAPID **0.1–2.5 mm**. Per-key actuation values and the exact
`0x1B08` reply layout are **[D] needs-device** — they come from the encrypted device package, so SYNQ
declares the ranges but reads values back only on real hardware.

> Read-back: report rate, brightness, onboard mode and the rapid-trigger toggle read back cleanly. The
> fine analog values (per-key actuation in mm) can't be confirmed without a device.

### Read-back and persistence

Report rate, brightness and onboard profiles persist on the keyboard (onboard memory). Setting onboard
mode to **host/SW** (`0x8100` fn1 `0x02`) makes live lighting/settings volatile until mode returns to
onboard — this is why Solaar warns that report rate "may need Onboard Profiles set to Disable".

---

## Dangerous commands — blocked (never sent)

The guard refuses these **feature ids** outright, on every function: even if the device reports an index
for one, that index is never placed in the guard's safe map, so no frame can reach it. Tests
(`scripts/logitech-kb-codec.test.ts`) prove every one is unreachable for every function 0–15, and that no
SYNQ encoder can emit one for any input.

| feature | what | why |
|---|---|---|
| `0x00C0`–`0x00C3` | DFU control (legacy/unsigned/signed) | bootloader |
| `0x00D0`, `0x00D1` | DFU / Resumable DFU (firmware transfer) | firmware |
| `0x010A` | Generic DFU | firmware |
| `0x1800` | Manufacturing / generic test | calibration/test |
| `0x1802` | Device reset | factory-reset |
| `0x1805` | Out-of-box (OOB) state | factory-reset |
| `0x1806` | Configurable device properties | identity |
| `0x1500`, `0x1816`, `0x1894`, `0x1895`, `0x1DF0` | force / BLE / LIGHTSPEED pairing | pairing |
| `0x1814`, `0x1815` | Change host / host switch | device-mode |
| `0x1E00` | Enable hidden (manufacturing) features | device-mode |
| `0x1B30` | Device mode (gaming/multimedia) | device-mode |
| `0x1B20` | Switch swapability | device-mode |
| `0x1B05` | Full key customization (remap/keystrokes) | identity/keystrokes |
| `0x8101`, `0x8102` | Profile management (onboard memory + macros) | profile-wipe |
| `0x4521`, `0x4522` | Disable keyboard keys | identity |

Also refused: any report id that isn't `0x10/0x11/0x12`, wrong length, device index outside `0xFF`/`1–6`,
a non-query IRoot function, a function on a safe feature that SYNQ doesn't use, and — importantly —
`0x8100` functions **5/6/7/8** (bulk profile-memory read/write/commit), which are *not* in the safe set and
therefore fall through to "blocked (profile memory)".

**Bootloader/DFU USB ids seen in `details.json`** (the keyboard re-enumerates as these during a firmware
update; SYNQ never opens them — see `src/lib/bootloader-ids.ts`): G915 `046d_aae3`, G915 TKL
`046d_aafb`, G713 `046d_ab16`, G715 `046d_ab15`, PRO X 60 `046d_ab29`. The G515/PRO X TKL RAPID DFU depots
are encrypted, so their bootloader ids still need a device.

---

## Models

| model | app PID | connection | analog | source |
|---|---|---|---|---|
| PRO X TKL RAPID | needs-device (encrypted pkg) | USB | **yes (0x1B08)** | agent model id `pro_x_tkl_rapid` |
| G515 RAPID TKL | needs-device | USB | **yes** | agent `g515_tkl_rapid`; 0.1–2.5 mm |
| G515 LIGHTSPEED TKL (analog) | needs-device | receiver | yes | agent `g515_ls_tkl` |
| G915 TKL LIGHTSPEED | `0xC343` | receiver | no | Solaar; dfu `046d_c343` |
| G915 LIGHTSPEED | `0xC33E` | receiver | no | dfu.json |
| G715 (AURORA) | `0xC347` | receiver | no | dfu.json |
| G713 (AURORA) | `0xC348` | USB | no | dfu.json |
| PRO X 60 | `0xC351` | USB | no (FKC remap) | dfu.json |
| G815 LIGHTSYNC | `0xC33F` | USB | no | Solaar |
| G512 RGB | `0xC33C` | USB | no | Solaar |
| G213 Prodigy | `0xC336` | USB | no | Solaar |
| K845 / PRO (mech) | `0xC341` / `0xC339` | USB | no | Solaar |

All are tier **read-only** in SYNQ: shown, with the handful of reversible settings above writable only
after the person turns on "Allow changes". Nothing SYNQ knows has been tried on real hardware yet.

---

## What still needs a real device
- The runtime USB PIDs of the RAPID analog boards (their definitions are in encrypted G HUB packages).
- The exact `0x1B08` reply byte layout: per-key actuation (mm), rapid-trigger press/release depths, and
  the key-priority/SOCD payload. SYNQ declares the UI ranges but reads them back only on hardware.
- Confirmation of the inferred `0x1B08` function indices (set actuation, set rapid trigger press/release).
- Lighting (0x8071/0x8081) frame encodings — present and documented as a capability, not yet built.
