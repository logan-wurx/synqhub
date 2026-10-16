# SYNQ controller roadmap

Snapshot 2026-10-15. Facts, IDs and sources are in [CONTROLLERS.md](CONTROLLERS.md). The driver/UI model is
[CAPABILITIES.md](CAPABILITIES.md) plus the controller groups in CONTROLLERS.md §7. This follows the keyboard
[ROADMAP.md](ROADMAP.md) style.

## How the order was chosen

**Score = popularity × access ÷ effort.**

| Access | When |
|---|---|
| Highest | the pad is **HID** on Windows **and** permissive open code exists (MIT, zlib, Apache, GPL-2.0-or-later or GPL-3.0) |
| Middle | HID, but only docs-only references or a mode switch to work out |
| Low | **GIP** or **XUSB**: needs the new GIP-custom transport (one spike, then many pads) or captures |
| Lowest | desktop-only vendor apps with no open work |

**Rules for every wave:**
1. **Read-only first.** Each model starts `experimental`, with writes behind the per-device "Allow changes" switch, a backup first, and read-back after (CAPABILITIES §3.5). Promote to `community` with an developer's diagnostics bundle, and to `verified` on maintainer hardware.
2. **Identify by device query, not PID.** Many pads change PID by mode or profile (8BitDo `3106`↔`6007`, GameSir G7 Pro `109B`/`100A`/`1022`). One model, many personalities.
3. **Allowlist per family, mirrored in Rust.** Bootloader and recovery identities go in `neverOpen`. Never flash firmware, never run calibration outside a separate guarded flow, never call `UpdateFirmwareAsync`.
4. **Say where a value lives:**
   - `onboard`: Edge, Elite, Envision, GameSir, Flydigi, 8BitDo;
   - `volatile`: DualSense LEDs and trigger effects, Switch LEDs;
   - `host`: Steam Input, the standard Xbox remap per user.

   SYNQ does not fake system-wide settings for pads that store nothing.
5. **Anti-cheat hygiene.** No virtual controllers, no input injection, no exclusive handles while a game runs (release on blur). Turbo and macros appear only where the pad stores them, behind a caution, off by default.
6. **Web vs desktop.** HID pads work on the website (WebHID). XInput, WGI, GameInput and GIP-custom are desktop-only (Windows).

## Prerequisites (C0)

| Item | What | Effort |
|---|---|---|
| **P1 Controller ID table** | Generated from SDL `usb_ids.h` + `controller_list.h` (zlib), the xpad table (facts), and the brand tools. Per entry: model, personality, transport (HID / XUSB / GIP), the config-channel collection, and bootloader/recovery PIDs (8BitDo `05C4`/`3208`/`5750`/`207B`/`2078`, `RR` PIDs, BRAGI firmware modes). Emits TS + Rust, like `brand_ids.rs` | S |
| **P2 Bridge input policy** | `hid.rs` today refuses Generic Desktop collections for OpenMouse devices. Add a **separate** read-only rule: input reports on Generic Desktop Gamepad `0x05` / Joystick `0x04` (and listed vendor input pages) for P1 entries only. Never Mouse `0x02`, Keyboard `0x06`, page `0x07`. Release handles on blur | S |
| **P3 Capability groups + cards** | `sticks`, `triggers`, `haptics`, `motion`, `link`, `live` (CONTROLLERS §7); curve editor, deadzone rings, trigger range bars, paddle map | M |
| **P4 Diagnostics bundle** | descriptor dump, 3 s of input reports, allowlisted feature reads, connection and personality, firmware; "Save diagnostics" like the X68 panel | S |
| **P5 Conflict warnings** | warn (never kill) when Xbox Accessories, iCUE, Synapse, Space Station, Nexus/Connect, DSX, DS4Windows or Steam (Input) is running | S |

## Wave C1: universal tester and the easiest high-value pads (start here)

| Item | Scope | Sources | Path | Effort |
|---|---|---|---|---|
| **Universal tester** | Sticks (drift, circularity, inner/outer deadzone, jump, resolution), triggers (range, bit depth, hair-trigger detect), buttons + paddles + profile index, gyro, **polling (median Hz, p1/p99, jitter)**, battery; opt-in rumble/LED tests | CONTROLLERS §6; Gamepadla Polling method (MIT) | web: Gamepad API visuals + WebHID raw for HID pads. Desktop: hidapi raw (exact), XInput `dwPacketNumber` sampler, WGI readings (focused), GameInput if installed (exact for Xbox) | M |
| **DualSense / DS4 / DualSense Edge (basic)** | Identity, firmware (`0x20` / `0xA3`), battery, calibration **read**. Volatile outputs: lightbar, player LEDs, mic LED, rumble, adaptive-trigger test. The helper can re-apply the lightbar later | hid-playstation (GPL-2.0+), SDL ps4/ps5 (zlib), pydualsense (MIT) | HID (web + desktop) | S |
| **Switch Pro / Joy-Con** | Player LEDs `0x30`, HOME light `0x38`, IMU + rumble test, SPI **read** of calibration (for the tester) | hid-nintendo (GPL-2.0+), SDL (zlib) | HID | S |
| **Xbox (all, incl. Elite, every licensed pad)** | Tester only: XInput / WGI / GameInput; on Bluetooth the HID report (exact Hz, Elite profile index, paddles) | SDL xboxone/gip (zlib) | desktop (BT also web, **UNVERIFIED**) | S |
| **Valve (SC 2015, SC 2026 "Triton", Deck), HORIPAD for Steam** | Tester only; settings stay in Steam Input | hid-steam (GPL-2.0+), SDL (zlib) | HID | S |
| **Everyone else** | Detect: name, image, vendor-tool link, on-device guide (e.g. "Reflex: hold profile + paddle + button") + tester | P1 table | – | S |

**Owner verification:** one DualSense, one DS4, a Switch Pro, one Xbox pad (USB + BT), and one 1 kHz+ pad to check the Hz method against Gamepadla numbers.

## Status of C0 and C1 (2026-10-15)

| Item | Status | Notes |
|---|---|---|
| P1 Controller ID table | **done** | `scripts/gen-controller-ids.ts` → `src/lib/controllers/ids.generated.ts` + `src-tauri/src/controller_ids.rs` (760 ids from SDL 6defbc0 + xpad facts + models.ts). Boot / recovery ids in `PAD_BOOT` (hid.rs `bootloader_id`, bootloader-ids.ts) |
| P2 Bridge input policy | **done** | `src-tauri/src/pads.rs`; hid.rs (`allowed`, `collection_access`, every send path), hid_plan.rs (Linux per-report-id), web policy.ts / guard.ts, the helper (same modules). Pads release on blur (page) with a 3 s bridge backstop that stops rumble and closes them; XInput sampling stops at once. udev rule covers the HID pads |
| P3 Capability groups + cards | **done** (display) | Controllers on the Devices home (photos from main, drawn gamepad / arcade silhouettes otherwise), receivers without a pad greyed and last; the controller page (Overview, Test, Polling, Lights & rumble) |
| P4 Diagnostics bundle | **done** | "Save diagnostics" on the controller page (desktop: `controllers/<name>-diag-<time>.json`; website: a download) |
| P5 Conflict warnings | **done** | `conflicts.rs`; Xbox Accessories and GameSir Connect process names **UNVERIFIED** (GameSir Nexus legacy = `HJC.XboxApp.GameSir.exe`, seen on the developer's PC) |
| C1 Universal tester | **done** | HID raw (exact per-report times), XInput sampler (desktop), Gamepad API (web, any browser: "Open the controller tester" on the unsupported-browser page). WGI / GameInput skipped as briefed |
| C1 DualSense / DS4 / Edge basics | **done, experimental** | firmware 0x20 / 0xA3, calibration GET (switches Bluetooth pads to the full report, on opening the tester only), battery; lightbar, player LEDs, mic LED, rumble (auto-stop ≤ 0.7 s), trigger test; USB and Bluetooth (CRC32) |
| C1 Switch Pro / Joy-Con | **done, experimental** | USB 0x80 0x01–0x05, device info (firmware + type; MAC dropped), input mode 0x30 (0x3F restored on close when it was 0x3F), IMU on, SPI read of the stick calibration, player lights, HOME light, rumble (two frames) |
| C1 Xbox (incl. the developer's G7 SE), Valve, HORIPAD for Steam | **done** (tester only) | Xbox and Xbox-licensed pads through XInput; Valve pads through their vendor input collection, nothing sent |
| C1 Everyone else | **done** | detect (name, photo or silhouette, configurator, on-device guide) + tester |

Still needs an owner (unchanged from "What needs an owner" below): every C1 pad on real hardware, especially the
Sony and Switch output frames over Bluetooth, and a 1 kHz+ pad to compare the Hz method with Gamepadla.

## Status of C2 (2026-10-15, fixtures and sims only; no hardware writes)

| Item | Status | Notes |
|---|---|---|
| DualSense Edge profiles | **built, experimental** | `src/lib/controllers/edge.ts`, `edge-session.ts`, the Profiles tab. Reads 0x70-0x7B; edits name, stick curve preset + adjustment (0-10), L2/R2 ranges, the 16-input button map; writes 0x60-0x62 (three parts, part CRC32 seeded 0xA3 over the 64-byte part with its CRC at zero, profile CRC at [2][56] as in the reference app), deletes 0x68 (slots 2-4). 0x63 never. USB only. Built from the slot's own bytes, so unknown bytes (vibration / trigger-effect intensity) are kept. Backup of all 12 reports before the first change, read-back after each write, "Put the backup back". Guard `edge` in guard.ts / pads.rs, 1080 fixture lines. **UNVERIFIED** on a real Edge: the part CRC's exact input (the reference computes it over all 64 bytes with a zeroed tail), part 1's used flag, and a stick deadzone field (not in the reference's model) |
| GameSir HID family (Cyclone 2, G7 Pro 8K PC, Tarantula Pro 8K) | **built, experimental** | `src/lib/controllers/gamesir.ts` (register maps, write allowlist, frames), `gamesir-session.ts`, the Settings tab. Vendor collection 0xFFF0 only (output 0x0F, answers 0x10, state 0x12), per PID: Cyclone `1053` `101D` `102A` `100B`; 8K `10C7` `10C8` `10C5` `10C6` `1032` `1033` `10B7` `10B9`; Tarantula `103D`. Read only: `0575` (a wired Cyclone and an idle 8K dongle share it), `103C` (its channel answers nothing), `10B8`. Writes only into the fields of the map, each with its allowed values: vibration (0-100), report rate (Cyclone 250-1000, 8K / Tarantula to 8000), stick and trigger dead zones (8-bit percent; 16-bit per mille on the 8K engine), stick shape (circle / raw), the Cyclone's three curve presets (whole blocks), button remaps to gamepad buttons (never keyboard, mouse, macro or turbo codes), lighting effect 1-4 (Cyclone) / mode + brightness (8K). Commands: heartbeat, firmware, active profile, profile switch 1-4, reads inside banks 1-4 / 0x20, writes, the rumble test (not on the Tarantula). Never the firmware loader `0F 17 55 88`, macros, LED playback, bank 5 (Shift layer). Writes reach the active profile only: a save to another profile switches to it, writes, reads back, switches back; ~20 ms between commands, busy answers sent again; the report rate goes last. Backup of banks 1-4 + lighting before the first change; restore puts back every field SYNQ writes; fields GameSir's app set to keyboard keys, macros or drawn curves are shown and kept. Guards `gamesir-*` in guard.ts / pads.rs (map generated into controller_ids.rs), 1167 fixture lines. **UNVERIFIED** on real pads: everything (see CONTROLLERS.md §5.9 "C2 notes") |
| SCUF Envision Pro / Pro V2 | **built, read only** | `src/lib/controllers/scuf.ts`. BRAGI 1.0 GETs on `0xFF42:0x0001` only: the receiver's firmware and connected-pad bitmap, the pad's vid / pid, firmware, battery level and status, shown on the overview. Guard `scuf` in guard.ts / pads.rs, 368 fixture lines. What writes would need (property ids from an iCUE capture, the hardware-profile files, framing / operating mode, the guard): CONTROLLERS.md §4.5. **UNVERIFIED**: BRAGI 1.0 vs 1.5, report length, battery units |

## Wave C2: onboard profiles over HID with permissive references

| Item | Scope | Sources | Path | Effort |
|---|---|---|---|---|
| **DualSense Edge profiles** | Read all 4 slots (feature `0x70–0x7B`). Edit: label, 6 curve presets + adjust points, deadzone, trigger min/max, button map. Write the 3 custom slots (`0x60–0x62`, CRC32 seeded `0xA3`); the default/Triangle `0x63` is protected. Delete via `0x68`. **USB only** | steffalon Edge web app (**MIT**); Sony's page for semantics | HID | M |
| **GameSir HID family** | Cyclone 2, G7 Pro 8K PC, Tarantula Pro 8K: profiles (4), remaps, curves, vibration, report rate (incl. 8K), lighting. **Per-PID only**; read-back every write; never unlisted variants (g7ctl's brick warning) | gamesir-linux-tools (**MIT**), gamesir-cyclone2-linux (**MIT**), g7ctl pyg7 (**Apache-2.0**) for shared framing | HID | M |
| **SCUF Envision Pro (v1, V2) read** | BRAGI identity (`0x11`/`0x12`), firmware `0x13`, battery `0x0F`, sub-device `0x36`; standard input for the tester. Settings writes wait for the gamepad property IDs (capture, or the Envision cuepkg manifest if Corsair republishes it) | SYNQ BRAGI transport + guard; iCUE names (§4) | HID (web too: BRAGI is a vendor page, **UNVERIFIED** for the Envision descriptor) | M |

**Owner verification:** an Edge, one of each GameSir HID model, and an Envision Pro.

## Wave C3: enthusiast HID pads with mode switches

| Item | Scope | Sources | Path | Effort |
|---|---|---|---|---|
| **8BitDo Ultimate / Ultimate 2 / Pro 2 / Pro 3** | HID config mode `6007`: 3 profiles, remaps, stick/trigger tuning, vibration, macros (caution). **Spike:** do the XUSB → config switch on Windows (LED `01 03 06` + rumble pattern through xusb22 IOCTLs, **UNVERIFIED**). Fallback: the BT / already-HID path. Block calibration `0x36`/`0x38` and every boot/RR PID | ultimatecontroller-rs (**MIT**), SDL 8bitdo (zlib), 8BitDo updater PID table | HID-desktop (web only once in HID mode) | M |
| **Flydigi Apex 4 / Apex 5 / Vader 5 Pro** | Vendor page `0xFFA0`: profiles (4), remaps, curves, vibration, lighting/LCD (Apex 4), ForceAdapt test. Respect Space Station's "Allow third-party apps" toggle (SDL acquire `0x1C`); flash only on Save | flydigi-space-station-mac (**MIT**), SDL flydigi (zlib), flydigictl (GPL-3.0), openflydigi (docs until the licence is clear) | HID | M |
| **GameSir / Nova lighting** | Nova 2 Lite RGB (page `0xFF7A`), Kaleid lighting | OpenRGB (GPL-2.0+), gamesir-linux-tools (MIT) | HID | S |

**Owner verification:** an 8BitDo Ultimate (2.4G) and an Ultimate 2; a Flydigi Apex 4 or 5 and a Vader 5 Pro.

## Research item 6 and the C4 spike (2026-10-15)

The GameSir G7 SE's settings over GIP, written up in [G7SE-GIP.md](G7SE-GIP.md):
- GameSir Nexus was read (files only). Its GIP component sends `SendMessage(Command, id, body)`.
- The settings ride message `0x0F`, and the replies come back on `0x10`. The body is GameSir's register protocol.
- Fields: the report rate at `0x0036` (banks 1–4) and the L4 / R4 records at `0x00AB` / `0x00C7` (profiles 1–3).
- The spike is `src-tauri/src/gip_spike.rs` + `gip_g7se.rs`, behind the cargo feature `gip-spike` (off by default). Its bodies and guard are unit-tested against the published Nexus captures.
- It has **not been run**: that needs the developer present with no game running. The doc lists every message it would send and the questions the session answers.

## Status of C3 (2026-10-15, fixtures and sims only; no hardware writes)

| Item | Status | Notes |
|---|---|---|
| 8BitDo Ultimate (2.4G adapter `3012`, PC `3011`, config mode `6007`) | **built, experimental** | `src/lib/controllers/eightbitdo.ts`, `eightbitdo-session.ts`, the Settings tab. Report `0x81` on the gamepad collection (answers on input `0x02`): report state, version, the 1652-byte config in 37 chunk reads, writes of the whole config built from the pad's own bytes with one profile edited (name, rumble L/R, stick and trigger ranges, the invert / swap / dead-zone / 4-way options, the 20-input button map to single buttons), save (`6`/`0x15`), the vibration test (≤ 1 s, stops by itself). Writes only when the stored CRC-16/KERMIT at `0x0C` checks out; backup of the whole config first; the whole config read back after each save; restore. Each chunk is checked field by field where a field lies inside it (mode, slot, names, rumble 0-1, ranges in order, known feature / button bits, macro counts). Never calibration (`0x36`/`0x38`), the vibration-parameter writes that disconnect the pad (`0x0B`/`0x0C`), reset (`0x0D`), boot or firmware. Guard `8bitdo` in guard.ts / pads.rs, 768 fixture lines. **Read only:** the adapters `3100`/`3105`, the Ultimate 2 (`6012`/`6013`), Pro 2, Pro 3 (the MIT source configures the Ultimate only; their config layout is unconfirmed). **Not built:** the XInput `3106` → config-mode switch (xusb22 owns the endpoint on Windows; needs the developer). **UNVERIFIED:** which collection carries report `0x81` (the gamepad collection is assumed) and that answers arrive as input report `0x02` |
| Flydigi Apex 4 in D-input (`04B4:2412`) | **built, experimental** | `src/lib/controllers/flydigi.ts`, `flydigi-session.ts`, the Settings tab. Vendor collection `0xFFA0` (output 5, input 4): device info first, and the pad is identified by its answer: settings are **read** for the Apex 4 family (device ids 84, 86, 87, 92, 93, 102-104) and **written for device id 84 only** (the one the MIT source verified); `04B4:2412` is shared by older Flydigi pads. Four slots of 790 bytes (79 parcels); edits: title, stick curve preset + dead zone, vibration on/off, the gamepad key map (macros, turbo, keyboard mappings and drawn curves kept); a slot is written whole from the pad's own bytes, **saved to flash only by Save** (random id + 1), read back and compared but for the two version bytes the save rewrites. Backup of all four slots first; restore. Motor test with auto-stop. Never the XInput switch (`0xED`), update mode (`0x17`), LED / screen writes, ForceAdapt, mapping enable. Guard `flydigi` in guard.ts / pads.rs, 762 fixture lines. **Apex 5, Vader 5 Pro, Apex 6 (`37D7`)**: tester only, nothing sent; their newer protocol (SDL's `5A A5` framing) has no open-source config reference with a clear licence, and Space Station's "allow third-party apps" switch is never overridden (SYNQ never sends the acquire `0x1C`). **UNVERIFIED:** the device-info and save answer layouts on Windows, the read-queue drain (a late parcel of one slot landing in the next read: SYNQ waits 120 ms between reads) |


## Wave C4: GIP-custom transport and Xbox Elite

| Item | Scope | Sources | Effort |
|---|---|---|---|
| **GIP spike (no writes)** | Rust (`windows` 0.62 + `Gaming_Input_Custom`) `ICustomGameControllerFactory` registered for `IProgrammableGamepad` `31c1034d-…`. Log `OnGameControllerAdded` and `OnMessageReceived`. Prove one **read**: Elite `0x4D` sub `0x02` (read page) through `SendReceiveMessage`. **Stop** if the factory never fires, if vendor messages are refused, or if it disturbs normal input | CONTROLLERS §3; iCUE's `Corsair.GipDevices.dll` shows the pattern works from Win32 | M |
| **Elite Series 2 / Core profiles** | Read 3 profiles × 4 pages. Editor: curves (3 points per axis), stick/trigger range (saturation), rumble scaling per motor, remaps incl. paddles + shift layer, LED colour/brightness, inversion, name. Guarded write: UNLOCK → 4 pages (byte-diff from the read, **never zero-filled**) → `0x07` → COMMIT → reload → read back; full backups | xbelite2 `docs/protocol.md` (GPL-2.0-only: our own code from the docs); SDL (zlib) for offsets | L |
| **Standard Xbox remap and home LED** | `LegacyGipGameControllerProvider` (`Set/GetStandardControllerButtonRemapping`, `SetHomeLedIntensity`). Needs the `xboxAccessoryManagement` capability. Test unpackaged first; if refused, a sparse MSIX package is the only route (user decision: signing, installer) | MS docs | M |
| **GameInput (optional)** | Exact per-packet timing for GIP pads in the tester. Use only if the runtime is already installed; never bundle it silently | GDK docs | S |

**Owner verification:** an Elite 2 or Core on a USB-C cable, and an Xbox Wireless Controller. Run with Xbox Accessories closed.

## Wave C5: Xbox-licensed third-party pads (GIP-custom, one capture set each)

Each needs the vendor's GIP messages. Ways in, in order (the 2026-10-13 desktop-brand rule):
1. read the unpacked vendor app;
2. public captures;
3. an developer's USBPcap capture of the Store app changing one setting at a time;
4. a Pi Pico impersonation as a last resort, and only with the user's OK.

| Order | Pads | App |
|---|---|---|
| 1 | Razer Wolverine V3 Pro (Xbox) / V2 / V2 Chroma | Razer Controller Setup for Xbox |
| 2 | GameSir G7 SE, G7 Pro (GIP identity `1022`), Kaleid | GameSir Nexus |
| 3 | Turtle Beach Stealth Ultra (10 onboard profiles) | Control Center 2 |
| 4 | Victrix Pro BFG for Xbox (`0E6F:024C`) | Control Hub |
| 5 | PowerA Fusion Pro 4 (`20D6:400B`) | Gamer HQ |
| 6 | HORI Fighting Commander OCTA / HORIPAD Pro | HORI Device Manager |
| 7 | Thrustmaster eSwap X Pro (`044F:D012`) | ThrustmapperX |
| 8 | 8BitDo Ultimate 3-mode (`2DC8:200F`) | Ultimate Software |
| 9 | SCUF Valor Pro Wireless | SCUF Companion App, once it ships |

Effort: **L** each. A shared GIP guard and editor make each one after the first cheaper.

## Wave C6: desktop-only HID vendor apps (captures)

| Pad | App | Note |
|---|---|---|
| Razer Wolverine V3 Pro 8K (PC, `1532:0A57`/`0A59`) | Synapse 4 | likely Razer's HID class protocol (**UNVERIFIED**); 4 onboard profiles, 8 kHz |
| Victrix Pro BFG (PS5/PC) | Victrix Control Hub | PS-mode IDs unknown |
| Nacon Revolution 5 Pro (PS modes `3285:0D16–0D19`) | Revolution 5 Pro app | 4 profiles per platform |
| Thrustmaster eSwap Pro (PS4, `044F:D00E`) | Thrustmapper | 2 profiles |
| Machenike G5 Pro, BIGBIG WON | their apps | IDs/apps **UNVERIFIED** |
| Corsair NOVABLADE PRO | **UNVERIFIED** (likely iCUE) | MGX actuation/RT; reuse the K70 MAX BRAGI work |

Effort: **L** each.

## Detect-only (no protocol work planned)

- Battle Beaver and other modded pads (shown as the base model).
- Logitech F310/F510/F710.
- SCUF Instinct Pro and Valor Pro wired (on-device remap guide only).
- SCUF Reflex (DualSense outputs only, if it answers as a DualSense).
- Razer Kishi, GameSir X2/X3 (phone pads).
- Switch 2 Pro / Joy-Con 2 / NSO GC: no driver-free Windows path.
- ASUS ROG Raikiri: Armoury Crate stays untouched.

## Never

- virtual controllers (ViGEm-style), device hiding (HidHide), input injection;
- polling "overclock" drivers;
- firmware flashing on any brand;
- calibration writes outside a separately approved guarded flow;
- `UpdateFirmwareAsync`.

## Top 10 to support first

| # | Controller | Why | Wave |
|---|---|---|---|
| 1 | **DualSense** | H popularity; plain HID on web + desktop; GPL-2.0+ / zlib / MIT code; LEDs, rumble and the trigger test are safe volatile outputs | C1 |
| 2 | **Xbox Wireless Controller** | the most common PC pad; tester (Hz, drift, circularity) is valuable on its own; remap later via LegacyGip | C1 → C4 |
| 3 | **DualSense Edge** | real onboard profiles; MIT reference; Sony's own app proves the feature set | C1 → C2 |
| 4 | **Xbox Elite Series 2 / Core** | H popularity, 3 onboard profiles, full protocol documented (xbelite2); needs the GIP-custom spike | C4 |
| 5 | **8BitDo Ultimate / Ultimate 2** | H enthusiast popularity; MIT RE with the whole config struct; 3 onboard profiles | C3 |
| 6 | **GameSir G7 Pro 8K PC / Tarantula Pro 8K / Cyclone 2** | 8 kHz pads; MIT/Apache code; HID on Windows | C2 |
| 7 | **Flydigi Apex 4/5, Vader 5 Pro** | M–H enthusiast popularity; HID vendor page; MIT (Apex 4) + SDL | C3 |
| 8 | **SCUF Envision Pro (v1/V2)** | reuses SYNQ's BRAGI transport; iCUE gives the setting names; onboard profiles | C2 (read) → captures (write) |
| 9 | **DualShock 4** | still H on PC; same HID stack as DualSense; tester + LEDs | C1 |
| 10 | **Switch Pro Controller** | M popularity; HID; LEDs, HD rumble test, gyro for the tester | C1 |

Next after these: Razer Wolverine V3 Pro 8K (C6) and the Xbox-licensed pads (C5), once captures exist.

## What needs an owner

| Device | Verify | Wave |
|---|---|---|
| DualSense, DS4 | report parsing, LED/rumble/trigger outputs, battery, Hz over USB and BT | C1 |
| Xbox Wireless (USB + BT) | tester paths agree; BT report on this PC through hidapi | C1 |
| DualSense Edge | slot read, write to one custom slot, read back, restore backup; where vibration/trigger intensity live | C2 |
| GameSir Cyclone 2 / G7 Pro 8K PC / Tarantula Pro 8K | handshake, profile read, one write + read-back, report-rate change and re-enumeration | C2 |
| SCUF Envision Pro (v1 or V2) | BRAGI identity on the pad sub-device; an iCUE capture for the gamepad property IDs | C2 |
| 8BitDo Ultimate / Ultimate 2 | Windows mode switch, config read, one write | C3 |
| Flydigi Apex 4/5, Vader 5 Pro | acquire toggle, profile read, save | C3 |
| Elite Series 2 / Core | GIP spike, page reads, one guarded write + read-back | C4 |
| Each C5/C6 pad | captures, then one write + read-back | C5, C6 |

Which controllers the user owns is not recorded anywhere. Ask before C1 hardware checks.

## Later ideas (not scheduled)

- **"Keep your feel" for pads:** move curves, deadzones and trigger ranges between Edge, Elite, Envision and GameSir with the same nearest-legal-value rule as mice.
- **Helper:** controller battery toasts (DualSense, Xbox via WGI/GameInput, BRAGI), and per-game DualSense lightbar re-apply.
- **Lighting tab:** DualSense lightbar, Wolverine Chroma (after captures), GameSir RGB.
