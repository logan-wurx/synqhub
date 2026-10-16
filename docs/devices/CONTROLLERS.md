# SYNQ and game controllers: what exists, and how SYNQ could support it

Research snapshot: **2026-10-15**. This is research only. No controller was opened, no vendor app or downloaded code was run,
and iCUE was only read as files (it was never launched; no Corsair service was touched).
Sibling documents:
- [CONTROLLERS-ROADMAP.md](CONTROLLERS-ROADMAP.md): the order of work;
- [CAPABILITIES.md](CAPABILITIES.md): the driver/UI model that §7 extends;
- [BRANDS.md](BRANDS.md): mice, keyboards and audio;
- [corsair-bragi.md](corsair-bragi.md) and [desktop-only/corsair-icue.md](desktop-only/corsair-icue.md): the BRAGI transport that SCUF Envision reuses.

Working files (downloads, extracted strings, helper scripts) stayed outside the repository.

**How to read this file**

- **Hex IDs** are USB VID:PID without `0x`. Every ID has a source. Anything not confirmed is marked **UNVERIFIED**.
  The main ID sources are:
  - SDL (`src/joystick/usb_ids.h`, `controller_list.h`, `hidapi/*`, zlib);
  - Linux `xpad.c` (GPL-2.0-or-later; IDs used as facts only);
  - OpenRGB (GPL-2.0-or-later);
  - 8BitDo's own WebHID updater table;
  - the 2026 community tools named per brand.
- **License rule** is the same as BRANDS.md. SYNQ ships AGPL code, so it is AGPL-3.0 as a whole.
  - **Code can be reused** under MIT, BSD, zlib, Apache-2.0, GPL-3.0(-or-later), GPL-2.0-**or-later** and AGPL-3.0.
  - **Docs-only** (read to learn, write our own code): GPL-2.0-only, no-license repositories, vendor apps and bundles, and the Microsoft GIP partner documents.
- **Paths for SYNQ** (column "Path" in §1):
  - `HID`: the existing Rust bridge (hidapi), and also WebHID on the website;
  - `HID-desktop`: the bridge only;
  - `GIP-custom`: `Windows.Gaming.Input.Custom`, desktop Windows only (§3);
  - `iCUE-derived`: BRAGI facts read out of iCUE (§4);
  - `tester`: read-only through the universal tester (§6);
  - `detect`: name, image, vendor-tool link, on-device button guide;
  - `none`.
- **Risk** of writing: **hi** = in-band firmware, latching bootloader or a documented brick; **med** = calibration, NVS, flash-commit or pairing commands on the same channel; **lo** = settings only.
- **Pop.** is a rough guess (H/M/L) of PC use. **Effort**: **S** = reuse an open driver or a tiny protocol; **M** = port open RE or read vendor JS; **L** = desktop-only vendor app, no open code, captures needed.

---

## 0. Key findings

1. **Three different "worlds" on Windows.** Everything else follows from this.
   - **HID** (Sony, Nintendo, Valve, 8BitDo config mode, Flydigi and GameSir vendor collections, SCUF Envision, any Xbox pad on Bluetooth): SYNQ's Rust HID bridge already fits, and so does WebHID.
   - **XUSB** (`xusb22.sys`, "Xbox 360"-class; most third-party pads in "PC/XInput" mode): user mode only gets XInput state, rumble and a few driver IOCTLs. The vendor endpoints these pads use for configuration on Linux **cannot be opened without swapping the driver** (WinUSB).
   - **GIP** (`xboxgip.sys`; every Xbox One/Series pad and every Xbox-licensed third-party pad in Xbox mode, over USB or the Xbox Wireless Adapter): no raw USB access. There are **two user-mode doors**:
     - `Windows.Gaming.Input.Custom.GipGameControllerProvider` (`SendMessage` / `SendReceiveMessage`);
     - GameInput's `SendRawDeviceOutput` ("for Xbox One devices, this takes the form of a GIP message").
2. **The GIP door is real.** iCUE (a plain Win32 Qt app) ships `Corsair.GipDevices.dll`. It is a WRL WinRT class `Corsair.GipDevices.GipDevice` that implements `ICustomGameControllerFactory` + `IGipGameControllerInputSink` (RTTI, §4.2), and it is used for Corsair's "Xbox mode" headset. Microsoft's own docs say the namespace is meant for equipment makers' component libraries, not apps. That is a caution, not a block.
3. **The Xbox Elite Series 2 profile protocol is documented.** `lemonxah/xbelite2` (2026, **GPL-2.0-only**, so docs-only for us) gives it from USB captures of the Xbox Accessories app:
   - vendor message `0x4D` (SDL calls it `GIP_SL_ELITE_CONFIG`, standard-latency class);
   - pages `0x20–0x2B`, with a 56-byte mapping page and a 43-byte curve page;
   - unlock/commit, read back.

   This is exactly the payload a GIP-custom provider would carry.
4. **DualSense Edge onboard profiles are writable over USB HID.** The **MIT** WebHID app `steffalon/dualsense-edge-profile-web-application` documents it:
   - read: feature reports `0x70–0x7B`, three per slot;
   - write: `0x60–0x63`, with CRC32;
   - delete: `0x68`.

   Sony's own "PlayStation Accessories" Windows app (2024) does the same job and also updates firmware.
5. **SCUF Envision is a BRAGI gamepad.** Its iCUE packages declare `HidProto: Bragi_dongle`, depend on `bragi-proto`, and iCUE's `BragiProtocols.dll` names the gamepad properties (deadzones, max deadzones, curves, vibration, calibration, live stick/trigger position notifications). SYNQ already has a BRAGI transport and guard.
6. **Enthusiast brands got permissive open RE in 2026.** This is new since the keyboard research:
   - GameSir: `g7ctl` (protocol library **Apache-2.0**), `gamesir-linux-tools` (**MIT**), `gamesir-cyclone2-linux` (**MIT**);
   - 8BitDo: `ultimatecontroller-rs` (**MIT**);
   - Flydigi: `flydigi-space-station-mac` (**MIT**, Apex 4) and `flydigictl` (GPL-3.0);
   - SDL now has HIDAPI drivers for 8BitDo, Flydigi, GameSir, GIP, Steam "Triton", Switch 2 and SInput (all zlib).
7. **Polling rate needs raw reports.**
   - The browser Gamepad API is sampled at about 250 Hz (Chromium polls every 4 ms), so it cannot measure 1 kHz–8 kHz pads.
   - Exact numbers need hidapi read timestamps (HID pads) or GameInput reading timestamps (GIP pads).
   - XInput `dwPacketNumber` sampling is a fallback (§6).

---

## 1. Summary table

**Microsoft**

| Model | PC connection (IDs) | Configurator | On-device settings? | Open protocol work (license) | Path | Risk | Pop. | Effort |
|---|---|---|---|---|---|---|---|---|
| Xbox Wireless Controller (Series X\|S, One S) | GIP USB `045E:0B12` (One S `02EA`); Windows' HID shim `045E:02FF`; BLE `0B13` (One S `02E0`/`02FD`/`0B20`); Xbox Wireless Adapter | Xbox Accessories (Store app, Win + Xbox) | **No.** Remaps are host/console-side, per user | MS GIP spec (docs-only); SDL GIP + xboxone (zlib); xpad, xone (GPL-2.0+) | tester; later the remap API (§3.5) | lo | H | S |
| Xbox Elite Series 2 / Elite Core | GIP USB `045E:0B00`; BT `0B05`, BLE `0B22`; Adapter. Core = same hardware (Core IDs **UNVERIFIED**) | Xbox Accessories | **Yes:** 3 custom + 1 default profile on the controller | xbelite2 protocol.md (GPL-2.0-only, docs); SDL GIP (zlib); xpad (GPL-2.0+) | GIP-custom | med | H | L |
| Xbox Adaptive Controller | `045E:0B0A`, BT `0B0C`, BLE `0B21` | Xbox Accessories | Yes (3 profile slots) | SDL | detect, tester | lo | L | S |

**SCUF and Corsair**

| Model | PC connection (IDs) | Configurator | On-device settings? | Open protocol work (license) | Path | Risk | Pop. | Effort |
|---|---|---|---|---|---|---|---|---|
| SCUF Envision Pro (v1) | Slipstream dongle `2E95:434E` (+ `5046`); pad sub-devices `2E95:434C`/`434D`; wired IDs **UNVERIFIED** | iCUE (desktop) | **Yes:** 3 hardware-switch profiles | iCUE (EULA, facts only); SYNQ BRAGI code (own) | iCUE-derived (BRAGI) | med | M | M (read) / L (write) |
| SCUF Envision Pro V2 | dongle `1B1C:3A08`/`3A09`; pad `1B1C:3A05`/`3A06` | iCUE | Yes | same | iCUE-derived | med | M | M / L |
| SCUF Envision (wired), Envision V2 | iCUE packages `dev-envision`, `dev-envision-v2` (IDs **UNVERIFIED**, packages 404 now) | iCUE | Yes | same | iCUE-derived | med | M | M |
| SCUF Instinct / Instinct Pro | GIP (Xbox licensed). xpad lists `2E95:0504` "SCUF Gaming Controller" (model **UNVERIFIED**) | none (on-controller remap) | Yes (3 profiles, paddles) | none | detect, tester | lo | M | S |
| SCUF Reflex / Reflex Pro / Reflex FPS | DualSense-based, USB/BT HID; reports as DualSense `054C:0CE6` (**UNVERIFIED**) | none | Yes (3 colour profiles, paddles) | DualSense stack | tester + DualSense LEDs/rumble | lo | M | S |
| SCUF Valor Pro (wired / wireless) | GIP (Xbox licensed); 1000 Hz on PC wired | wired: on-controller only; wireless: SCUF "Companion App" (Xbox + PC, "coming soon" Oct 2025) | Yes (3 profiles) | none | detect, tester; GIP-custom after captures | lo | L–M | S / L |
| Corsair NOVABLADE PRO (leverless) | `1B1C:2B1F` wired, `2B2B` receiver (XInput per xpad); config channel **UNVERIFIED** | **UNVERIFIED** (likely iCUE) | Yes (5 profiles, MGX 0.1–4 mm, rapid trigger) | xpad IDs | detect | med | L | M |

**Sony**

| Model | PC connection (IDs) | Configurator | On-device settings? | Open protocol work (license) | Path | Risk | Pop. | Effort |
|---|---|---|---|---|---|---|---|---|
| DualSense | `054C:0CE6` USB/BT HID | Sony firmware updater (Win); PS5 | No profiles. Lightbar/LEDs/trigger effects are volatile | hid-playstation (GPL-2.0+); SDL ps5 (zlib); pydualsense (MIT); dualshock-tools (MIT); dualsensectl (GPL-2.0+); DS4Windows (GPL-3.0, archived); nondebug/dualsense (none); OpenMouse controller-protocol (none) | HID | med | H | S |
| DualSense Edge | `054C:0DF2` | **PlayStation Accessories** (Windows, 2024), PS5, DSX (closed) | **Yes:** 4 slots incl. default | steffalon Edge web app (**MIT**); hid-playstation | HID (writes USB only) | med | M | M |
| DualShock 4 | `054C:05C4` v1, `09CC` v2, `0BA0` adapter; BT | none | No | hid-playstation; DS4Windows; dualshock-tools (MIT) | HID | med | H | S |
| PS Access controller | `054C:0E5F` (**UNVERIFIED**) | PS5 only | Yes (profiles) | none | detect | lo | L | S |

**Nintendo**

| Model | PC connection (IDs) | Configurator | On-device settings? | Open protocol work (license) | Path | Risk | Pop. | Effort |
|---|---|---|---|---|---|---|---|---|
| Switch Pro Controller | `057E:2009` USB/BT HID | console only | No (stick calibration in SPI flash) | hid-nintendo (GPL-2.0+); SDL switch (zlib); dekuNukem notes (no license) | HID | med | M | S |
| Joy-Con L / R / grip | `057E:2006` / `2007` / `200E` | console only | No | same | HID | med | M | S |
| Switch 2 Pro / Joy-Con 2 / NSO GC | `057E:2069` / `2066`,`2067` / `2073` | console | No | SDL switch2 (zlib) | **none on Windows** (USB init needs WinUSB bulk; SDL has no BT yet) | – | M | – |

**Valve**

| Model | PC connection (IDs) | Configurator | On-device settings? | Open protocol work (license) | Path | Risk | Pop. | Effort |
|---|---|---|---|---|---|---|---|---|
| Steam Controller (2015) | `28DE:1102` wired, `1142` dongle, `1105`/`1106` BT | Steam Input | **No (host-side)** | hid-steam (GPL-2.0+); SDL steam (zlib) | tester | lo | L–M | S |
| Steam Controller (2026, "Triton") | `28DE:1302` wired, `1303` BLE, Puck `1304` ("Proteus"), `1305` ("Nereid") dongle | Steam Input | **No (host-side)** | SDL steam_triton (zlib) | tester | lo | M | S |
| Steam Deck controls | `28DE:1205` | Steam Input | No (host-side) | hid-steam; SDL steamdeck | tester (when SYNQ runs on a Deck) | lo | M | S |

**Razer**

| Model | PC connection (IDs) | Configurator | On-device settings? | Open protocol work (license) | Path | Risk | Pop. | Effort |
|---|---|---|---|---|---|---|---|---|
| Wolverine V2 / V2 Chroma | GIP `1532:0A29` / `0A2E` | Razer Controller Setup for Xbox (Store) | Onboard profile; app profiles revert when the app closes | xpad, SDL (IDs) | detect, tester; GIP-custom after captures | med | M | L |
| Wolverine V2 Pro (PS5/PC) | `1532:100B` wired, `100C` wireless (DualSense-type HID) | **UNVERIFIED** | **UNVERIFIED** | SDL (IDs) | tester (HID) | med | L–M | L |
| Wolverine V3 Pro (Xbox) / V3 Tournament Ed. | `1532:0A3F` (SDL "Wolverine V3 Pro"); TE **UNVERIFIED** | Razer Controller Setup for Xbox | Yes (**UNVERIFIED** count) | none | detect, tester | med | M | L |
| Wolverine V3 Pro 8K (PC) | `1532:0A57` wired, `0A59` 2.4 GHz (XInput, xpad); 8000 Hz | **Synapse 4** | Yes (4 profiles, per a review) | none | detect, tester; HID-desktop after captures | med | M | L |
| Kishi family | phone USB-C/Lightning; PC use **UNVERIFIED** | Razer Nexus (mobile) | – | – | detect | lo | L | S |
| Raiju (Tournament / Ultimate / V3 Pro) | `1532:1000`, `1004`/`1009`, `1007`/`100A`; V3 Pro `1024`/`1026` | Raiju mobile app | Yes (**UNVERIFIED**) | SDL (IDs) | tester (HID) | lo | L | S |

**8BitDo**

| Model | PC connection (IDs) | Configurator | On-device settings? | Open protocol work (license) | Path | Risk | Pop. | Effort |
|---|---|---|---|---|---|---|---|---|
| Ultimate (2.4G / BT) | XUSB `2DC8:3106`; 2.4G `3012`; PC `3011`; BT/idle `3109`; config mode `6007` (HID) | Ultimate Software V2 (Win, mobile); firmware: updater + web.8bitdo.com (WebHID) | **Yes:** 3 profiles | **ultimatecontroller-rs (MIT)**; SDL 8bitdo (zlib) | HID-desktop (config mode; XUSB switch spike) | med | H | M |
| Ultimate 2C | XUSB `310A`; BT `301A`; receiver `301C`; `301B` (SDL) | limited | Partly (**UNVERIFIED**) | SDL | tester | lo | H | S |
| Ultimate 2 Wireless (2.4G) / Ultimate 2 Bluetooth | 2 Wireless: XUSB `310B`, BT mode `6012` (SDL), receiver `6013`. 2 Bluetooth (separate model): `600F` (8BitDo updater table) | Ultimate Software V2 | Yes (3 profiles) | SDL; Ultimate 2 RE **UNVERIFIED** | HID-desktop | med | H | M |
| Ultimate 3-mode (Xbox) | GIP `2DC8:200F` | Ultimate Software (**UNVERIFIED**) | Yes | xpad (IDs) | detect, tester; GIP-custom later | med | M | L |
| Pro 2 / Pro 3 | `6003`/`6006` (Pro 2 BT/D), `3010` wired; Xbox-wired variants `2000`/`201E` (GIP); Pro 3 `6009`, adapter `600A` | Ultimate Software | Yes | SDL; ultimatecontroller-rs lists Pro 2 | HID | med | M | M |

**Flydigi**

| Model | PC connection (IDs) | Configurator | On-device settings? | Open protocol work (license) | Path | Risk | Pop. | Effort |
|---|---|---|---|---|---|---|---|---|
| Vader 3 / 3 Pro | dongle as XInput (`045E:028E` clone) or D-input `04B4:2412` ("V1" vendor); BT | Space Station (Win), mobile app | Yes | flydigictl (GPL-3.0, via the XInput interface); vader3 (GPL-3.0); SDL flydigi (zlib) | HID where a vendor collection exists; tester | med | M–H | M |
| Vader 4 Pro | `04B4:2412` (SDL V1 type table) | Space Station | Yes | SDL | HID | med | M–H | M |
| Vader 5 Pro | `37D7:2401` ("V2" vendor) | Space Station | Yes | openflydigi (partial, licence **NOASSERTION**); flydigi-vader5 (GPL-2.0); SDL | HID | med | M–H | M |
| Apex 4 | VID `04B4`, PID **UNVERIFIED** | Space Station 4 | Yes (4 slots) | **flydigi-space-station-mac (MIT)**; ApexSenseBridge (NOASSERTION) | HID | med | M | M |
| Apex 5 / Apex 6, CD2 dock | `37D7:2501` / `2502`, dock `37D7:6001` | Space Station | Yes (4 slots, explicit save) | openflydigi; SDL | HID | med | M | M |

**GameSir**

| Model | PC connection (IDs) | Configurator | On-device settings? | Open protocol work (license) | Path | Risk | Pop. | Effort |
|---|---|---|---|---|---|---|---|---|
| G7 SE | GIP `3537:1010` | GameSir Nexus (Store) | Yes (3 profiles, 250/500/1000 Hz) | gamesir-linux-tools (MIT, vendor-class USB) | tester; GIP-custom after captures | med | M–H | L |
| G7 Pro (tri-mode) | XUSB identities `3537:109B`/`109C`, `100A`, `1003`/`1004`, `10BA`/`10BB`, `10A7`; GIP identity `1022` | Nexus | Yes (4 profiles + Shift layer, report rate) | **g7ctl pyg7 (Apache-2.0)**; gamesir-linux-tools (MIT) | tester (config interface is XUSB-owned on Windows) | med–hi | M–H | L |
| G7 Pro 8K (PC) | `3537:10C7` wired / `10C8` dongle (Nioh ed.); `10B8` (SDL "G7 Pro 8K") | GameSir Connect | Yes (4 profiles, lighting, 8K) | gamesir-linux-tools (MIT, hidraw) | HID | med | M | M |
| Tarantula Pro (8K) | PC mode `3537:103D`; `103C` (SDL "Tarantula 8K") | Connect / Nexus | Yes (profiles, poll rate) | gamesir-linux-tools (MIT); SDL | HID | med | M | M |
| Cyclone 2 | `3537:1053` USB config; `101D` wired, `102A`/`100B` 2.4G | GameSir Connect | Yes (4 profiles, lighting, macros, curves, report rate) | **gamesir-cyclone2-linux (MIT)**; gamesir-linux-tools (MIT) | HID | med | M | S–M |
| T4 Kaleid / Kaleid Flux | `3537:1082` D, `1086` X, `1012` GIP (gamesir-linux-tools); xpad names `3537:1004` "T4 Kaleid" (conflict, **UNVERIFIED**) | Nexus | Lighting | gamesir-linux-tools (lighting only, MIT) | detect, tester | lo | M | M |
| Nova / Nova Lite / Nova 2 Lite | `3537:100F` wired, `1098` wireless (OpenRGB); Super Nova dongle `103E` (SDL) | GameSir app | RGB | OpenRGB (GPL-2.0+) | HID (lighting) | lo | M | S |
| X2 / X3 (mobile) | phone USB-C | GameSir app | – | – | detect | lo | L | S |

**Turtle Beach**

| Model | PC connection (IDs) | Configurator | On-device settings? | Open protocol work (license) | Path | Risk | Pop. | Effort |
|---|---|---|---|---|---|---|---|---|
| Stealth Ultra | GIP `10F5:7073` wired; dongle **UNVERIFIED** | Control Center 2 (Xbox, PC, mobile) | **Yes:** 10 onboard profiles | xpad (IDs) | detect, tester; GIP-custom after captures | med | M | L |
| Stealth Pivot | **UNVERIFIED** | Control Center 2 | **UNVERIFIED** | none | detect | med | L–M | L |
| Recon Controller | `10F5:7005`, `7008`, `7009` (GIP) | on-controller presets (Pro-Aim, etc.) | Yes | xpad, SDL | detect, tester | lo | M | S |
| REACT-R | `10F5:7013` | none | No | SDL | detect, tester | lo | L–M | S |

**PDP / Victrix**

| Model | PC connection (IDs) | Configurator | On-device settings? | Open protocol work (license) | Path | Risk | Pop. | Effort |
|---|---|---|---|---|---|---|---|---|
| Victrix Pro BFG (PS5/PS4/PC) | PS-mode IDs **UNVERIFIED**; PC mode = XInput | Victrix Control Hub (Windows) | Yes (3 profiles) | none | detect, tester; HID-desktop after captures | med | M | L |
| Victrix Pro BFG (Xbox/PC, "Reloaded") | GIP `0E6F:024C` wired | Control Hub (Xbox + PC) | Yes | xpad (IDs) | detect, tester; GIP-custom later | med | M | L |
| Victrix Gambit | GIP `0E6F:02D6` | Control Hub | **UNVERIFIED** | SDL, xpad | detect, tester | lo | L–M | L |

**PowerA**

| Model | PC connection (IDs) | Configurator | On-device settings? | Open protocol work (license) | Path | Risk | Pop. | Effort |
|---|---|---|---|---|---|---|---|---|
| Fusion Pro 3 | GIP, PID **UNVERIFIED** | PowerA Gamer HQ (**UNVERIFIED** for FP3) | Paddle mapping in memory | none | detect, tester | lo | M | L |
| Fusion Pro 4 | GIP `20D6:400B` | **PowerA Gamer HQ** (Xbox + Win 10/11) | Yes: 3 local profiles; paddle assignments kept | xpad (IDs) | detect, tester; GIP-custom later | lo–med | M | L |
| OPS v3 Pro | **UNVERIFIED** | PowerA app (beta per reviews) | Yes (3 profiles) | none | detect | lo | L–M | L |

**Nacon**

| Model | PC connection (IDs) | Configurator | On-device settings? | Open protocol work (license) | Path | Risk | Pop. | Effort |
|---|---|---|---|---|---|---|---|---|
| Revolution 5 Pro | PS4 mode `3285:0D16`/`0D17`, PS5 mode `0D18`/`0D19`, PC XInput `3285:0662` | Revolution 5 Pro app (PC) | Yes (4 profiles per platform) | SDL, xpad (IDs) | tester; HID-desktop after captures | med | M | L |
| Revolution X Pro (Xbox) | **UNVERIFIED** | Revolution X Pro app (Xbox/PC) | **UNVERIFIED** | none | detect | med | L–M | L |

**Thrustmaster**

| Model | PC connection (IDs) | Configurator | On-device settings? | Open protocol work (license) | Path | Risk | Pop. | Effort |
|---|---|---|---|---|---|---|---|---|
| eSwap X Pro / eSwap X 2 | GIP `044F:D012` / `D01E` | **ThrustmapperX** (Microsoft Store) | Yes (2 profiles) | SDL, xpad (IDs) | detect, tester; GIP-custom later | med | L–M | L |
| eSwap Pro (PS4/PC) | `044F:D00E` | Thrustmapper (desktop) | Yes (2 profiles) | SDL (IDs) | tester; HID-desktop after captures | med | L | L |

**HORI**

| Model | PC connection (IDs) | Configurator | On-device settings? | Open protocol work (license) | Path | Risk | Pop. | Effort |
|---|---|---|---|---|---|---|---|---|
| Fighting Commander OCTA | Xbox GIP `0F0D:0150`; PS `0162`/`0163`, XInput `0164` | HORI Device Manager | Up to 4 profiles (on-device **UNVERIFIED**) | SDL (IDs) | detect, tester | lo | M | L |
| HORIPAD Pro (Xbox) | **UNVERIFIED** | HORI Device Manager | **UNVERIFIED** | none | detect | lo | M | L |
| Wireless HORIPAD for Steam | `0F0D:01AB` / BT `0196` (Steam protocol) | Steam Input | No (host) | SDL steam_hori (zlib) | tester | lo | L | S |

**Other brands**

| Model | PC connection (IDs) | Configurator | On-device settings? | Open protocol work (license) | Path | Risk | Pop. | Effort |
|---|---|---|---|---|---|---|---|---|
| Machenike G5 Pro (V2) | XInput `2345:E00B` (xpad); dongle/BT | Machenike app (**UNVERIFIED**) | **UNVERIFIED** | none | detect, tester | ? | M | L |
| BIGBIG WON (Blitz 2, Rainbow 2 Pro/SE) | **UNVERIFIED** | BIGBIG WON app (**UNVERIFIED**) | **UNVERIFIED** | none | detect, tester | ? | L–M | L |
| Battle Beaver / modded pads | the base controller's IDs | none | mechanical mods | – | detect as the base model | – | L | S |
| Logitech F310 / F510 / F710 | XInput `046D:C21D` / `C21E` / `C21F`; F310 D-mode `C216` | none | No | SDL, xpad | detect, tester | – | M | S |

---

## 2. How Windows sees a controller

| What Windows sees | Driver | How SYNQ can talk to it | Website (WebHID)? | Examples |
|---|---|---|---|---|
| **HID** over USB, BT or dongle: a gamepad collection plus vendor collections | hidclass / hidusb / BthLEEnum. Gamepad collections are **shared**, not exclusive like keyboards and mice | hidapi in the Rust bridge: input, output and feature reports | **yes.** Chromium does not protect the Gamepad usage; vendor pages are fine (8BitDo's own updater and dualshock-tools are WebHID) | DualSense/DS4/Edge; Switch Pro; 8BitDo config mode `6007`; Flydigi `0xFFA0`; GameSir vendor pages; SCUF Envision (BRAGI); Xbox on BT |
| **XUSB** ("Xbox 360", interface FF/5D/01) | `xusb22.sys` | XInput (state, rumble, battery); xusb22 IOCTLs (LED: **UNVERIFIED**); `XusbGameControllerProvider` (`SetVibration` only). **Raw interrupt endpoints: no** | no | 8BitDo `3106`; GameSir G7 Pro `109B`; Flydigi `045E:028E` clones; Machenike `2345:E00B`; Razer V3 Pro 8K `0A57`/`0A59`; Nacon `0662` |
| **GIP** (interface FF/47/D0) over USB or the Xbox Wireless Adapter | `xboxgip.sys`, plus a HID shim for DirectInput (`045E:02FF`, "IG_" path; SDL ignores it) | XInput, Windows.Gaming.Input, **GameInput** (readings + raw GIP output), **WGI.Custom `GipGameControllerProvider`**. **Raw USB: no** | no | Xbox pads; Elite 2/Core; every Xbox-licensed pad in Xbox mode |
| **Xbox on Bluetooth** (classic or BLE HID) | HID + `xinputhid.sys` filter (MS "XInputHID" spec) | hidapi read (shared) and the rumble output report; profile index readable on the Elite 2 | likely (**UNVERIFIED**) | `045E:0B13`, `0B20`, `0B22`, `0B05`, `02E0`, `02FD` |
| **Switch-mode emulation** | HID | as a Switch Pro (`057E:2009`) | yes | 8BitDo, PowerA, HORI, Flydigi in Switch mode |
| **Vendor bulk endpoints** | none bound (needs WinUSB) | **impossible without a driver** | WebUSB would need WinUSB too | Switch 2 init; any "claim the XInput interface" Linux tool |

**Personalities.** Many pads change PID with mode or profile, so a PID is not a model. Examples:
- 8BitDo XUSB `3106` → config `6007`;
- GameSir G7 Pro `109B` ↔ `100A` (a 1000 Hz report rate or a keyboard/mouse bind adds a HID interface) ↔ `1022` (GIP);
- Kaleid `1082`/`1086`/`1012`.

The detection table must map every personality to one model, and must say which personality carries the config channel.

---

## 3. The Xbox / GIP path

### 3.1 The APIs that reach a GIP pad without a driver

| API | What it gives | Limits |
|---|---|---|
| XInput | state, rumble, coarse battery; `dwPacketNumber` | 4 controllers; no paddles; "global" focus (reads in the background) |
| Windows.Gaming.Input (`Gamepad`, `RawGameController`) | state incl. Elite paddles, timestamped readings, battery, trigger rumble | **the app window must have focus** ("A Windows application must have focus to receive input from a controller"; Unity closed the background bug as by design) |
| **WGI.Custom** (`GameControllerFactoryManager`, `GipGameControllerProvider`, `IGipGameControllerInputSink`) | Register a factory for a **GIP interface GUID** (or HID VID/PID, or XUSB type). Then: `SendMessage(GipMessageClass, byte id, byte[])` and `SendReceiveMessage(...)`. Every incoming message arrives with a timestamp through `OnMessageReceived(UInt64 timestamp, class, id, seq, byte[])`. It also exposes `FirmwareVersionInfo`, `HardwareVersionInfo`, VID/PID, and `UpdateFirmwareAsync` (**must never be called**) | Microsoft: the namespace "is not targeted at apps"; it is for equipment makers' WinRT components. Factories cannot be unregistered (process lifetime). `GipMessageClass`: Command 0, LowLatency 1, StandardLatency 2 |
| **WGI.Preview `LegacyGipGameControllerProvider`** | `Get/SetStandardControllerButtonRemapping(User, …)` (the Accessories app's remap for standard pads), `SetHomeLedIntensity`, battery, `IsFirmwareCorrupted`, `GetExtendedDeviceInfo`, `IsInterfaceSupported(Guid)`, copilot pairing, headset ops, `ExecuteCommand(Reset)` | "**requires declaring the `xboxAccessoryManagement` capability**". Windows Desktop Extension SDK 10.0.23665+. An unpackaged Win32 app has no capability manifest, so it would need package identity (sparse/MSIX package). **UNVERIFIED** whether it works unpackaged |
| **GameInput** (`Microsoft.GameInput` NuGet + `GameInputRedist.msi`) | One **reading per raw input packet** with a µs timestamp; 0.5 s of history (`GetNextReading`); raw reports; `CreateRawDeviceReport` + `SendRawDeviceOutput` ("for Xbox One devices, this takes the form of a GIP message"); "raw device reports … supported only for GIP devices" | Needs the GameInput runtime (shipped by many games and the Xbox app; MS licence for the redist). PC behaviour of raw output **UNVERIFIED** |

### 3.2 Who uses the custom path

- **iCUE: proven, read from its files (§4.2).** `Corsair.GipDevices.dll` (PDB `C:\projects\test_gip\CorsairGipController\…`) exports `DllGetActivationFactory`. Its RTTI shows these classes:
  - `GipDeviceFactory` : `ICustomGameControllerFactory`;
  - `GipDevice` : `CustomTypedGameControllerBase<IGipGameControllerProvider, IGipGameControllerInputSink, …>`;
  - `IGipDeviceStatics`, `GameControllerCollection<GipDevice>`.

  `modules\GipProtocols.dll` says "Provides support for Gip Protocol made by Microsoft for devices that supports Xbox mode" and "Turning off Xbox mode for device". The cuepkg registry ties `gip-service` / `gip-protocols` to `dev-virtuoso-max-wireless-for-xbox`. iCUE.exe is an unpackaged Win32 process, so **the custom factory works from a desktop app.**
- **Store companion apps (inference: they run on Xbox, where WGI.Custom is the only door):**
  - Xbox Accessories;
  - Razer Controller Setup for Xbox (Wolverine Ultimate/TE/V2/V2 Chroma/V3 Pro/V3 TE);
  - PowerA Gamer HQ;
  - Turtle Beach Control Center 2;
  - Victrix/PDP Control Hub;
  - HORI Device Manager;
  - ThrustmapperX;
  - GameSir Nexus;
  - Nacon Revolution X Pro app;
  - the SCUF Valor Pro companion app.

  None is confirmed from its binaries. Captures of their traffic are the way to learn each vendor's messages.

### 3.3 Using it from SYNQ (Rust/Tauri)

SYNQ already depends on `windows` 0.62.

1. Add the WinRT features `Gaming_Input`, `Gaming_Input_Custom`, `Foundation` and `Foundation_Collections`.
2. Implement the factory with `#[implement(ICustomGameControllerFactory)]`:
   - `CreateGameController(provider)` returns an object implementing `IGipGameControllerInputSink` + `IGameControllerInputSink`;
   - `OnGameControllerAdded/Removed` tracks devices.
3. Call `GameControllerFactoryManager::RegisterCustomFactoryForGipInterface(&factory, guid)` once per process.
4. Cast the provider to `GipGameControllerProvider` and use `SendMessage`/`SendReceiveMessage`.

No driver, no admin. **Spike questions (all UNVERIFIED):**
- Is the factory called for controllers that were already connected?
- Do vendor messages such as `0x4D` pass through `SendMessage`? Is `messageId` the 5-bit message number (so `0x4D` = StandardLatency + `0x0D`) or the full type byte?
- Do input messages reach the sink while SYNQ is unfocused?
- Does the Xbox Accessories app running at the same time interfere?

GIP interface GUIDs seen on the Elite 2 (from SDL's GIP driver comments):
- `IProgrammableGamepad` `31c1034d-b5b7-4551-9813-8769d4a0e4f9`;
- `IControllerProfileModeState` `f758dc66-022c-48b8-a4f6-457ba80e2a5b`;
- `IExtendedDeviceFlags` `34ad9b1e-36ad-4fb5-8ac7-17234c9f546f`;
- `IEliteButtons` `37d19ff7-b5c6-49d1-a75e-03b24bef8c89`;
- the standard `IGamepad` `082e402c-07df-45e1-a5ab-a3127af197b5`.

Registering for `IProgrammableGamepad` is the narrowest first try.

### 3.4 Elite Series 2 protocol (facts from xbelite2 `docs/protocol.md`, firmware 5.17; GPL-2.0-only, so docs-only)

- **Transport (USB):** GIP. The 4-byte header is `[type][flags][seq][len]`, with flag `0x20` = system and `0x10` = ACME/ack. SDL gives the same flag bits.
- **`0x4D` vendor command** (SDL: `GIP_SL_ELITE_CONFIG`). The sub-command is payload byte 0:
  - `0x03` UNLOCK, and also COMMIT (persists to flash after `0x07`);
  - `0x04` write name (UTF-16LE, 15 chars);
  - `0x05` read name;
  - `0x07` init extended reports (paddles + profile in the input; SDL sends `{7,0}` as "enable raw report");
  - `0x02` read profile page `[page, size]`;
  - `0x01` write profile page (needs UNLOCK).
- **Pages:**

  | Profile | Slot A mapping | Slot A curves | Slot B (shift) mapping | Slot B curves |
  |---|---|---|---|---|
  | 1 | `0x20` | `0x21` | `0x26` | `0x27` |
  | 2 | `0x22` | `0x23` | `0x28` | `0x29` |
  | 3 | `0x24` | `0x25` | `0x2A` | `0x2B` |

  The Accessories app always writes all four pages of a profile.
- **Mapping page (56 bytes):**
  - flags; paddle outputs [P1..P4]; face outputs [A,B,X,Y]; 8 extended slots (D-pad, LB, RB, LS, RS); keyboard remap bytes;
  - **rumble scale per motor** `[28..31]` (weak, strong, RT impulse, LT impulse; 0–100);
  - **max-output saturation per axis** `[32..43]` (LT, LS, RT, RS; `0xFF` = full range; the "trigger range 67 %" setting writes `0xAB`). **Zero-filled bytes produce binary triggers** on any active profile;
  - LED brightness `[44]`, colour flag + RGB `[45..48]`, vibration L/R `[49..50]`, keyboard-mode flag `[55]`.
- **Remap codes:** `0x04` A … `0x0F` RS. LT and RT are not remappable through profile data.
- **Curves page (43 bytes):** 3 control points × 2 bytes for LX, LY, RX, RY (default `2B 2B 7F 7F BF BF`), plus a stick-inversion bitmask `[27]`.
- **Inputs:**
  - `0x20` input (47-byte payload after init; paddles at `[14]`);
  - `0x0C` compact Elite report (paddles `[14]`, **hardware profile 0–3 `[15]`**);
  - `0x1E` system (version, profile-button notification, name, stick calibration read).

  The SDL comments add the paddle/profile offsets for firmware 4.x / 5.x / 5.17+.
- **Write sequence:** UNLOCK → write 4 pages → `0x07` re-init → COMMIT → power reload `05 20 seq 01 05` → read back.
- **Bluetooth:** report `0x01` (20 bytes) carries the profile in byte 17 bits 0–1 and paddles in byte 19. Config writes over BT are not documented; treat them as USB/Adapter only.

### 3.5 What SYNQ would do with it

| Feature | How | Persistence |
|---|---|---|
| Elite 2/Core: 3 profiles × (curves, saturation/"range", rumble scaling, remaps incl. paddles + shift layer, LED, inversion), name | GIP-custom `0x4D`, read-back, full-page backups | onboard (flash) |
| Elite / any Xbox pad: live inputs incl. paddles, profile index, exact report timing | GameInput readings, or the GIP-custom sink | – |
| Standard Xbox pad: button remap, home LED brightness | `LegacyGipGameControllerProvider` (needs the capability, §3.1) | **host (per user)** |
| Third-party Xbox-licensed pads | GIP-custom once their vendor messages are captured from the Store app (USBPcap) by an owner | onboard (per vendor) |

**Blocked on GIP, always:**
- `UpdateFirmwareAsync`;
- system messages other than the read-only queries we choose (`0x06` security, `0x0C` firmware, `0x1E` extended writes, `0x1F` debug);
- writing pages that are not a byte-exact copy of the read with only the edited fields changed;
- any write to a pad whose `IsFirmwareCorrupted` is true (send the user to Xbox Accessories).

---

## 4. iCUE (read-only) and SCUF

### 4.1 Files found in `C:\Program Files\Corsair\Corsair iCUE5 Software`

| File | What it is |
|---|---|
| `Corsair.GipDevices.dll` (106 KB, WRL WinRT) | GIP custom-controller factory (§3.2) |
| `modules\GipProtocols.dll` | "Gip Protocol" device module (C++/WinRT 2.0.250303.1, SDK 26100); "Xbox mode" handling; manifest keys `XboxModeCapabilities`, `GamepadSensitivityDefaults`, `SupportsGamepadCalibration`, `SupportsThumbsticks/Triggers/Vibration` |
| `modules\BragiProtocols.dll` | BRAGI gamepad support (below) |
| `DeviceCommands.dll` | `cue::dev::cmd` gamepad commands (below) |
| `cue_qml_plugins\GamepadCueQmlPlugin.dll` | UI: sensitivity presets, response-curve editor, min/max deadzone, stick/trigger calibration wizard (resting position, then full range) |
| `ScufControllerLibrary.dll` | exports `GetDeviceIndex`, `InjectStack`, `LockButtonActive`, `SetButtonState`; talks `DeviceIoControl` to a driver. It belongs to the downloadable `driver-scuf` package and points to host-side **input injection** for some Envision functions (**UNVERIFIED**). SYNQ must not copy this model (§9) |
| `drivers\vhid\CorsairVHidDriver.sys`, `CorsairVBusDriver.sys` | iCUE's virtual HID bus (input emulation) |
| `cuepkg.registry` | packages `dev-envision`, `-v2`, `-pro`, `-pro-v2`, `-pro-dongle`, `-pro-v2-dongle`, `driver-scuf`, `driver-scuf-audio`, `gamepad-predefined-data`, `gip-service`, `gip-protocols` |

### 4.2 Gamepad command surface

These are RTTI names under `cue::dev::cmd` and strings in `BragiProtocols.dll`. Names only: the property IDs are not in plain text.

- **Sensitivity:**
  - `Get/SetGamepadSensitivityCurve(LogicalPosition)`, `CommitGamepadSensitivityCurves`;
  - `Get/SetGamepadSensitivityDeadzone`, `Get/SetGamepadSensitivityValue`;
  - properties `Left/RightThumbstickDeadzone`, `Left/RightTriggerDeadzone`, `…MaximumDeadzone` (outer), `…Sensitivity`.
- **Vibration:** `IsVibrationMotorPresent`, `Get/SetVibrationMotorIntensity` (`Left/RightVibrationMotorIntensity`).
- **Live positions:**
  - `SetGamepadInputPositionsReportingEnabled` (`ThumbstickPositionsReportingEnabled`, `TriggerPositionsReportingEnabled`);
  - notifications `ThumbstickPositionsChanged` (11), `TriggerPositionsChanged` (10). The IDs match the Web Hub enum in corsair-bragi.md.
- **Calibration:**
  - `StartCalibration`, `StopCalibration`, `ApplyCalibration`, `GetCalibrationStatus`, `InitJoystickCalibrationStep`;
  - BRAGI `0x0A` targets 3 GamepadRest, 4 LT, 5 RT, 6 LS, 7 RS (corsair-bragi.md).

  **Blocked.**
- **Profiles:** `GamepadSensitivitySettingsLayout` and `GamepadButtonFunctionRemapActionLayout` live in the **hardware-profile files**, so they are onboard. The remap action file type 5 = gamepad (corsair-bragi.md).
- **Others:** `AccelerometerSensitivity`, `GyroscopeSensitivity`, tilt gestures. Which device uses these is **UNVERIFIED**.

### 4.3 Envision packages (official public cuepkgs; only the dongle packages are still downloadable)

- **`dev-envision-pro-dongle` 5.31.101** (SHA-256 `367ff298…d336`):
  - `"SCUF ENVISION PRO WIRELESS RECEIVER"`, VID `2E95` PIDs `434E` + `5046`;
  - `HidProto: Bragi_dongle`, `DeviceEnumerator: Bragi`;
  - `NativeSubDevices` `2E95:434C`, `434D` (the pad);
  - firmware `tool: BragiHeadsetFwUpdateTool` (**blocked**);
  - pairing `ConnectGamepadWithSwitcherExtendedRequirement`.
- **`dev-envision-pro-v2-dongle` 5.31.101:** VID `1B1C` PIDs `3A08` + `3A09`, sub-devices `1B1C:3A05`, `3A06`; same BRAGI, same firmware tool.
- The pad packages (`dev-envision*_5.37.1`, `gamepad-predefined-data_5.46.67`, `driver-scuf_*`) now return **404**. Re-check later; they would carry the gamepad manifest (curve presets, ranges).
- **Corsair Web Hub** (snapshot 2026-10-13) has the generic BRAGI gamepad enums but **no SCUF device entries**.
- **SCUF Instinct / Valor / Reflex are not in iCUE.**

### 4.4 Plan for SCUF

- **Read now (low risk):**
  - identity: BRAGI GET `0x11`/`0x12`, firmware `0x13`, battery `0x0F`, sub-device bitmap `0x36`;
  - input through XInput/HID for the tester.
- **Live positions and settings:** need the property IDs of the names above. Get them from a capture of iCUE with an Envision (an owner), or from the pad manifest if Corsair republishes it.
- Writes use SYNQ's existing BRAGI guard plus a gamepad allowlist.

### 4.5 SCUF Envision: what SYNQ reads now, and what writes would need (C2, 2026-10-15)

**Built (read only, `src/lib/controllers/scuf.ts`, guard `scuf` in guard.ts / pads.rs):** the receivers
(`2E95:434E`/`5046`, `1B1C:3A08`/`3A09`) and the pads on a cable (`2E95:434C`/`434D`, `1B1C:3A05`/`3A06`) open their
BRAGI request collection `0xFF42:0x0001` in full and their gamepad collection input only. The only frames sent are
BRAGI 1.0 GETs (`08|addr 02 prop`, 64 bytes, report 0) of battery level `0x0F`, battery status `0x10`, USB vid `0x11`
/ pid `0x12`, firmware `0x13` and the connected-pad bitmap `0x36`: the receiver's firmware, which address its pad is
on, then the pad's id, firmware and battery, shown on the controller's overview. Sent when the person opens the pad's
page, never from the device list. On the desktop the bridge tags each report with its collection, so answers are kept
out of the pad's input; the browser can't tell them apart, so there the reads stop at the first unanswered GET.
**UNVERIFIED** (owner check): that the Envision speaks BRAGI 1.0 (not 1.5 with a host session; a 1.5 device ignores
these frames and the overview just shows less), the 64-byte report length, and the battery units (tenths of a percent,
as Corsair's mice).

**What writes would need** (none are built; the guard refuses every SET, file and session command):
1. **The property ids** behind iCUE's names (§4.2): `Left/RightThumbstickDeadzone`, `…MaximumDeadzone`,
   `Left/RightTriggerDeadzone`, `…Sensitivity`, `Left/RightVibrationMotorIntensity`, and for a live view
   `ThumbstickPositionsReportingEnabled` / `TriggerPositionsReportingEnabled` (notifications 10 / 11). They aren't in
   plain text in iCUE; get them from an **iCUE capture with an Envision** (USBPcap: change each setting once, note the
   frames), or from the `dev-envision*` pad packages if Corsair publishes them again (their manifests carry ids and
   ranges; 404 today).
2. **The hardware-profile files**: the three onboard profiles keep `GamepadSensitivitySettingsLayout` (curves as
   `LogicalPosition` points, dead zones) and `GamepadButtonFunctionRemapActionLayout` (remap action file type 5). A
   write is BRAGI file I/O (open `0x0D`, write `0x06`/`0x07`, close `0x05`) of files whose ids and byte layouts only a
   capture shows; the backup is reading every one of them first.
3. **The framing and mode**: BRAGI 1.0 vs 1.5 (session `0x1B`), and whether live SETs need operating mode 2
   (host-controlled) and how iCUE gives the pad back (mode 1). Mode 3 / 5 (bootloader) stay refused, as in brands.rs.
4. **The guard**: the existing BRAGI guard (brands.rs `bragi`, src/lib/brands/corsair/guard.ts) with a gamepad family:
   SETs only to the captured property ids within their ranges, file writes only to the profile files the capture names
   (never identity files, firmware file 3, pairing, calibration `0x0A`, factory reset `0x0F`, create / delete
   `0x0B` / `0x0C`, apply firmware `0x10` / `0x16`), fixtures checked by Rust and TS like every pad guard, a read-back
   after each write.
5. **Never**: the calibration wizard (`0x0A`, targets 3-7), firmware (`BragiHeadsetFwUpdateTool`), pairing
   (`ConnectGamepadWithSwitcherExtendedRequirement`), or iCUE's SCUF driver path (input injection, §4.1).

---

## 5. Brands

### 5.1 Microsoft (Xbox Wireless, Elite Series 2, Elite Core, Adaptive)

**Connection modes**

| Model | USB / Adapter (GIP) | Bluetooth | Notes |
|---|---|---|---|
| Xbox Wireless Controller (Series) | `045E:0B12` | BLE `0B13` | share button; Windows shows `045E:02FF` on the xboxgip HID shim |
| Xbox One S | `02EA` | `02E0`, `02FD`, BLE `0B20` | |
| Elite Series 1 | `02E3` | – | paddles in byte 28 (SDL) |
| Elite Series 2 / Elite Core | `0B00` | `0B05` (classic), `0B22` (BLE) | Core = same pad sold without accessories (Core IDs **UNVERIFIED**) |
| Adaptive Controller | `0B0A` | `0B0C`, BLE `0B21` | 3 profile slots |

**Configurator:** Xbox Accessories (Store, Windows + Xbox). It also updates firmware.

**Settings (Elite 2):**
- stick curves (presets plus 3 control points per axis), stick and trigger range (saturation);
- vibration scaling per motor (4 motors incl. impulse triggers);
- remaps incl. paddles and a **shift** layer, keyboard keys;
- LED colour and brightness, axis inversion, name.
- Stick tension (3 settings) and trigger stops (3) are **mechanical**: N/A.

**Storage:**
- Elite 2: **3 custom + 1 default profile on the controller** (xbox.com), switched with the profile button.
- Standard pad: remaps are **host-side per user** (the LegacyGip API takes a `User`); nothing onboard.

**Open work:**
- Microsoft GIP partner docs (`aka.ms/gipdocs`, April 2025: GIP spec, metadata spec, XInputHID, XUSB, arcade/wheel/flight-stick specs) and the MS-GIPUSB open spec;
- SDL `SDL_hidapi_gip.c` + `SDL_hidapi_xboxone.c` (zlib; paddle/profile offsets per firmware);
- xpad (GPL-2.0-or-later); xone (GPL-2.0-or-later);
- xpadneo (licence NOASSERTION; BT);
- **xbelite2** (GPL-2.0-only; Elite profile protocol with pcaps).

**Path:**
- tester (GameInput > WGI > XInput);
- Elite profiles via GIP-custom (L);
- standard remap via LegacyGip if the capability works (M, **UNVERIFIED**).

**Safety:**
- firmware only through Xbox Accessories; never `UpdateFirmwareAsync`;
- a firmware-corrupted state exists (`IsFirmwareCorrupted`);
- Elite: zero-filled saturation bytes → binary triggers; COMMIT writes flash, so always back up and read back.

**Pop.** H (Wireless), H (Elite). **Effort** S (tester) / L (Elite).

### 5.2 SCUF (Corsair) and Corsair

| Model | Platform | How it shows up | Settings | Configurator |
|---|---|---|---|---|
| **Envision Pro (v1)** | PC | dongle `2E95:434E`; pad `2E95:434C`/`434D`; BRAGI | 3 hardware-switch profiles; G-keys (5) + 2 SAX side buttons + paddles (count **UNVERIFIED**); per-stick/trigger deadzone (min/max), response curves, sensitivity, vibration L/R, RGB, calibration | iCUE |
| **Envision Pro V2** | PC | dongle `1B1C:3A08`/`3A09`; pad `1B1C:3A05`/`3A06` | same | iCUE |
| **Envision (wired) / Envision V2** | PC | IDs **UNVERIFIED** | same minus wireless | iCUE |
| **Instinct / Instinct Pro** | Xbox / PC | GIP; possibly `2E95:0504` (xpad "SCUF Gaming Controller", **UNVERIFIED**) | 3 profiles, paddle remap on the controller | none |
| **Reflex / Reflex Pro / Reflex FPS** | PS5 / PC | DualSense-based; IDs probably DualSense (**UNVERIFIED**) | 3 colour profiles, paddle remap on the controller (hold profile + paddle + button); FPS: instant triggers, no rumble | none |
| **Valor Pro (wired, 2025)** | Xbox / PC | GIP; 1000 Hz PC | 3 onboard profiles, on-controller remap; not in iCUE (review) | none |
| **Valor Pro Wireless (Oct 2025)** | Xbox / PC | GIP (PC wired) | remap, deadzones, sensitivity, vibration, recalibration; 3 profiles | SCUF Companion app (Xbox + PC) |
| **Corsair NOVABLADE PRO** | PS5 / PC leverless | `1B1C:2B1F` / `2B2B` (xpad) | MGX 0.1–4 mm actuation, rapid trigger, 5 onboard profiles, 1000 Hz | **UNVERIFIED** (not on Web Hub) |

**Storage:**
- Envision: **onboard** (the hardware profiles hold the gamepad sensitivity layout).
- Instinct, Reflex, Valor: onboard, set on the device.

**Open work:** none public for SCUF; iCUE facts (§4); SYNQ's own BRAGI code.

**Path:**
- Envision: iCUE-derived BRAGI (M read / L write);
- the rest: detect + tester (and Reflex gets DualSense LEDs/rumble if it answers as a DualSense).

**Safety:**
- BRAGI blocks from corsair-icue.md: firmware (`BragiHeadsetFwUpdateTool`, operating mode 3/5, `APPLY_FIRMWARE`), calibration `0x0A`, pairing, factory reset `0x0F`, file deletes;
- iCUE's SCUF driver/injection path is out of scope.

**Pop.** M. **Effort** M/L.

### 5.3 Sony (DualSense, DualSense Edge, DualShock 4)

**Connection modes and reports** (from hid-playstation):

| Pad | Input | Output | Feature |
|---|---|---|---|
| DualSense / Edge | USB `0x01` (64 bytes), BT `0x31` (78) | USB `0x02` (63), BT `0x31` (78) | `0x05` calibration, `0x09` pairing info, `0x20` firmware info |
| DS4 | USB `0x01`, BT `0x11` | USB `0x05`, BT `0x11` | `0x02` calibration (USB), `0x05` (BT), `0xA3` firmware info |

**Configurators:**
- **PlayStation Accessories** (Windows): Edge profiles + firmware;
- Sony "Firmware updater for DualSense";
- DSX (closed; supports Edge profiles over USB).

**Edge settings (Sony page):**
- button assignments (incl. disable);
- 6 stick curves (Default, Quick, Precise, Steady, Digital, Dynamic) with adjustment, plus a deadzone;
- trigger deadzone range L2/R2;
- vibration and trigger-effect intensity;
- back buttons are physical swaps.

**4 profiles incl. default, stored on the controller.**

**Edge protocol** (steffalon app, **MIT**):

| Operation | Report | Notes |
|---|---|---|
| Read | feature `0x70–0x7B` | 3 reports per slot: Triangle `0x70`, Square `0x73`, Cross `0x76`, Circle `0x79` |
| Write | feature `0x60` (Square), `0x61` (Cross), `0x62` (Circle), `0x63` (Triangle = default: do not alter) | 3 buffers; each ends in a CRC32 seeded with `0xA3`; the profile CRC sits at `[2][56]`; label, curve id + 6 curve bytes per stick, trigger min/max, 16-byte button map |
| Delete | feature `0x68`, byte = slot + 1 | |

Writes are **USB only**. Where vibration and trigger-effect intensity live in the profile is **UNVERIFIED**.

**DualSense / DS4, non-Edge:** no onboard settings. Lightbar, player LEDs, mic LED, rumble and adaptive-trigger effects are **volatile**: they must be re-sent per session (the helper could re-apply them).

**Open work:**
- hid-playstation (GPL-2.0-or-later, Sony-authored);
- SDL ps4/ps5 (zlib); pydualsense (MIT); dualsensectl (GPL-2.0-or-later); dualshock-tools (MIT; calibration + NVS);
- edgemap (GPL-3.0; Linux UHID remapper);
- DS4Windows (schmaldeo fork GPL-3.0, archived 2026);
- DualSenseX repo (no licence); nondebug/dualsense (no licence);
- OpenMouse `controller-protocol` (only `src/sony/dualsense.ts`, **no licence**, so docs-only);
- OpenRGB `SonyGamepadController` (GPL-2.0-or-later; lightbar for DS4/DS5/Edge).

**Path:** HID (web OK).

**Safety:** allowlist. Allowed:
- outputs `0x02`/`0x31` (DS5) and `0x05`/`0x11` (DS4);
- feature **reads** `0x05`, `0x09`, `0x20` / `0x02`, `0x12`, `0x81`, `0xA3`;
- Edge `0x70–0x7B` reads;
- Edge `0x60–0x62` and `0x68` writes behind "Allow changes" + backup.

**Blocked:**
- DS5 `0x80/0x81` test/NVS (`[3,1]` lock, `[3,2,101,50,64,12]` unlock), `0x82/0x83` stick calibration, Edge stick-module unlock and write (dualshock-tools);
- DS4 `0xA0` NVS, `0x90` calibration (dualshock-tools), `0x13` pairing (community knowledge, **UNVERIFIED**);
- PS auth `0xF0–0xF2` (community knowledge, **UNVERIFIED**);
- any unknown feature SET. The allowlist refuses these anyway; the list is for the "What SYNQ never sends" panel.

**Pop.** H / M / H. **Effort** S / M / S.

### 5.4 Nintendo (Switch Pro, Joy-Con, Switch 2)

- **IDs:**
  - Pro `057E:2009`; Joy-Con L `2006`, R `2007`, grip `200E`, joycond pair `2008`;
  - NSO SNES/N64/Genesis `2017`/`2019`/`201E`;
  - Switch 2: Pro `2069`, Joy-Con 2 R `2066` / L `2067` / pair `2068`, GC `2073`;
  - third-party Switch-mode pads (PDP `0E6F:0186`/`018C`, PowerA `20D6:A711–A718`, HORI `0F0D:00F6`, Turtle Beach Switch 2 `0E6F:0193`, etc.).
- **Configurator:** console only. **No onboard user settings.**
- Factory and user stick calibration live in SPI flash. LEDs and HOME light are volatile.
- **Open work:** hid-nintendo (GPL-2.0+); SDL switch / switch2 (zlib); dekuNukem RE notes (no licence, docs).
- **Path:** HID (player LEDs `0x30`, HOME light `0x38`, IMU enable `0x40`, vibration enable `0x48`, rumble test) + tester.
  - **Switch 2 on Windows: none.** USB needs a libusb bulk init (WinUSB), and SDL has no BT support yet.
- **Safety:**
  - allow subcommands `0x02`, `0x03`, `0x10` (SPI read of the known calibration ranges only), `0x30`, `0x31`, `0x38`, `0x40`, `0x48`;
  - **block** `0x01` pairing, `0x06` HCI, `0x07` reset pairing, `0x08` shipment mode, **`0x11` SPI write, `0x12` SPI erase**, `0x20–0x2B` NFC/IR MCU (incl. MCU firmware states), `0x41–0x42` IMU register writes, `0x50–0x52` GPIO.
- **Pop.** M. **Effort** S.

### 5.5 Valve (Steam Controller 2015 and 2026, Steam Deck)

- **2015 SC:** `28DE:1102` wired, `1142` dongle, `1101` legacy, `1105`/`1106` BT; "V2/Headcrab" `1201`/`1202`.
- **Steam Controller (2026, "Triton"):**
  - IDs: `28DE:1302` wired, `1303` BLE, Puck `1304` ("Proteus"), `1305` ("Nereid");
  - launched 2026-05-04 at $99 (per Fullcleared): TMR sticks, dual haptic trackpads, 4 grip buttons, gyro, capacitive grip sense;
  - SDL: "Always 1kHz according to USB descriptor, but actually about 4 ms";
  - Puck: about 4 ms polling (Valve figures, via reviews).
- **Deck:** `28DE:1205`.
- **Settings:** all **host-side** in Steam Input. Valve's pads keep "lizard mode" defaults in firmware; Steam updates firmware.
- **Open work:** hid-steam (GPL-2.0+); SDL steam / steamdeck / steam_triton (zlib).
- **Path:** tester only (HID). Never send settings; Steam owns them. Note that Steam Input running can swallow or remap inputs.
- **Pop.** M. **Effort** S.

### 5.6 Razer (Wolverine, Kishi, Raiju)

- **IDs:**
  - Wolverine V2 `1532:0A29`, V2 Chroma `0A2E`;
  - V2 Pro PS5 `100B`/`100C`, V2 Pro Xbox `1010`/`1011`;
  - V3 Pro `0A3F` (SDL);
  - **V3 Pro 8K (PC) `0A57` wired, `0A59` 2.4 GHz** (xpad, XInput);
  - older Wolverine Ultimate `0A14`, TE `0A15`;
  - Raiju PS4 `1000`, Raiju 2 Ultimate `1004`/`1009`, Tournament `1007`/`100A`; Raiju V3 Pro `1024`/`1026`; Kitsune `1012`.
- **Configurators:**
  - Razer Controller Setup for Xbox (Store; Wolverine Ultimate/TE/V2/V2 Chroma/V3 Pro/V3 TE): remaps of multi-function buttons and paddles, profiles, Chroma (Breathing/Immersive/Reactive/Spectrum/Static/Wave). "The active profile will revert to the onboard profile when the app is closed": app profiles are host-session, plus one onboard profile;
  - Synapse 4 for V3 Pro 8K PC: sensitivity, remaps, **4 onboard profiles** (review), 8000 Hz wired and wireless;
  - Raiju: mobile app; Kishi: Razer Nexus.
- **Mechanical:** HyperTriggers (mouse-click mode vs analog) are a **switch**.
- **Open work:** IDs only (SDL, xpad). OpenRGB does not list Wolverine.
- **Path:** detect + tester now; V3 Pro 8K via Synapse captures (Razer's HID class protocol is likely but **UNVERIFIED**); Xbox models via GIP-custom after captures.
- **Pop.** M. **Effort** L.

### 5.7 8BitDo (Ultimate 2.4G/BT, Ultimate 2C, Ultimate 2, Ultimate 3-mode, Pro 2, Pro 3)

- **IDs** (VID `2DC8`). Sources: SDL, xpad, ultimatecontroller-rs, 8BitDo's WebHID updater table.

  | Model | Normal identities | BT / config / receiver |
  |---|---|---|
  | Ultimate (2.4G/BT) | XUSB `3106`, 2.4G adapter `3012` (recovery `3013`), PC `3011`, adapters `3100`/`3105` | idle/BT `3109`, **config mode `6007` (HID)** |
  | Ultimate 2C | XUSB `310A` | BT `301A`, receiver `301C` |
  | Ultimate 2 Wireless | XUSB `310B` | BT mode `6012`, receiver `6013` |
  | Ultimate 2 Bluetooth (separate model) | – | `600F` |
  | Ultimate 3-mode (Xbox) | GIP `200F` | – |
  | Pro 2 | `6003`/`6006`, wired `3010` | Xbox-wired `2000`/`201E` (GIP) |
  | Pro 3 | `6009` | adapter `600A` |

  The updater opens vendor collections `0xFFA0`, `0xFF7A`, `0xFF7B` and page `0x8C`.
- **Configurators:** Ultimate Software V2 (Windows, mobile); firmware through the 8BitDo Firmware Updater and **web.8bitdo.com** (a WebHID firmware updater; it has no settings).
- **Settings:** stick sensitivity, curves and ranges, trigger ranges, remaps, macros (4 per profile, 18 steps), vibration, profile names. **3 onboard profiles.** The mapping is one array per profile slot, shared across modes.
- **Protocol** (ultimatecontroller-rs **MIT**, from the Windows/Android apps):
  - the mode switch is sent on the XUSB OUT endpoint: LED `01 03 06` + a rumble pattern → re-enumerates as HID `6007`;
  - config = 64-byte report `0x81` with CRC-16;
  - calibration: direct command `0x36` start / `0x38` save (PC: `0x36`);
  - firmware is Jieli-encrypted and only goes through the official updater.
- **Windows caveat:** the XUSB endpoint is owned by xusb22. The switch is probably done with xusb22's LED/rumble IOCTLs (**UNVERIFIED**; spike). Over BT or when already in `6007`, plain HID works.
- **Open work:** ultimatecontroller-rs (MIT); SDL 8bitdo (zlib; reads feature `0x30`/`0x06`, notes 1000 Hz over the dongle).
- **Path:** HID-desktop (config mode) + tester.
- **Safety:**
  - never open the updater's **boot-mode identities** `2DC8:05C4`, `3208`, `5750`, `207B`, `2078`, nor the `…RR` recovery PIDs (`3013`, `2079`, `9023`);
  - block calibration `0x36/0x38` outside a guarded flow;
  - no firmware.
- **C3 notes (built 2026-10-15 from ultimatecontroller-rs, MIT; fixtures and sims only):** the Ultimate's config
  (1652 bytes, three profiles) on `3012`, `3011`, `6007`, written only when its stored CRC-16/KERMIT checks out;
  calibration, `0x0B`/`0x0C` (vibration parameters; they can disconnect the pad), `0x0D` reset and every direct command
  but the version read are refused. **The XInput → config switch is not built:** on Windows the `3106` endpoint belongs
  to xusb22, so the LED `01 03 06` + rumble sequence would go through xusb22's IOCTLs (unverified) and needs the developer
  present; until then the pad is configured once it is already in its HID config mode (8BitDo's app or Bluetooth).
  The Ultimate 2, Pro 2 and Pro 3 stay tester-only: the MIT source configures the Ultimate only.
- **Pop.** H. **Effort** M.

### 5.8 Flydigi (Vader 3/3 Pro/4 Pro/5 Pro, Apex 4/5/6)

- **IDs:**
  - "V1" vendor `04B4` (Cypress), PID `2412`;
  - "V2" vendor `37D7`: Vader 5 Pro `2401`, Apex 5 `2501`, Apex 6 `2502`, CD2 dock `6001`;
  - vendor usage page `0xFFA0`;
  - in XInput mode the pads clone `045E:028E`.
  - SDL identifies the model by a controller-type byte (Vader 2/3/3 Pro/4 Pro/5 Pro, Apex 2–6).
- **Configurator:** **Space Station** (Windows desktop; mobile app). It has a setting "Allow third-party apps to take over mappings", which SDL's acquire command `0x1C` needs.
- **Settings:** remaps, macros, stick curves and deadzones, trigger modes (Apex: force-feedback "ForceAdapt"; Vader 5: trigger motors), gyro / mouse mode, vibration, lighting, LCD (Apex 4), per-game profiles. **4 onboard profile slots.** Changes are working memory until an explicit **save to flash** (openflydigi).
- **Protocol:** SDL V2 framing is report `0x03`, magic `5A A5`. Commands:
  - `0x01` info, `0x07` check architecture, `0x10`/`0x11` get/set status, `0x12` haptics, `0x1C` acquire;
  - input `0xEF`.

  Vader 5 uses unnumbered reports.
- **Polling:** Vader 5 Pro 1000 Hz (Gamepadla median); SDL notes IMU 1000 Hz on the Vader 4 Pro dongle, 500 Hz wired.
- **Open work:**
  - SDL flydigi (zlib);
  - **flydigi-space-station-mac (MIT, Apex 4: lighting, LCD, 4 slots, macros, ForceAdapt)**;
  - flydigictl (GPL-3.0; Vader 3 Pro over the XInput interface; the daemon claims USB);
  - openflydigi (Apex 5, partial Vader 5/Apex 6; licence NOASSERTION, so docs-only until clarified);
  - flydigi-vader5 (GPL-2.0, "-only" vs "-or-later" not checked);
  - vader3 (GPL-3.0); ApexSenseBridge (NOASSERTION).
- **Path:** HID (vendor page on the dongle/dock); tester. The XInput-only route (flydigictl style) is impossible on Windows without a driver.
- **Safety:** commit only on Save; block firmware (Space Station updates it); respect the "allow third-party" toggle.
- **C3 notes (built 2026-10-15 from flydigi-space-station-mac, MIT; fixtures and sims only):** the Apex 4 is reached
  in its D-input mode only (its XInput mode is xusb22's on Windows). The device-info answer decides: the Apex 4 family
  is read, device id 84 is written, anything else on `04B4:2412` is the tester only. A write lasts only after
  save-to-flash, which SYNQ sends only from Save; `0xED` (switch to XInput) and `0x17` (update mode) are refused by
  the guard. The `37D7` pads (Vader 5 Pro, Apex 5 / 6) get nothing: SYNQ never acquires them, so the "allow
  third-party apps" switch stays Space Station's.
- **Pop.** M–H. **Effort** M.

### 5.9 GameSir (G7, G7 SE, G7 Pro, G7 Pro 8K, T4 Kaleid, Nova, Tarantula Pro, Cyclone 2, X2/X3)

- **IDs** (VID `3537`): see §1. Some IDs conflict between sources (xpad `1004` "T4 Kaleid" vs g7ctl `1004` = White Tri-mode G7 Pro dongle), so trust the device query, not the table.
- **Configurators:**
  - **GameSir Nexus** (Microsoft Store, Windows + Xbox): G7 / G7 SE / G7 Pro / Kaleid;
  - **GameSir Connect** (Windows): Cyclone 2, G7 Pro 8K PC, and the newer pads.
- **Settings:**
  - G7 Pro: 21 buttons incl. paddles and a **Shift layer**, sticks, triggers (curves with 5 handles), vibration, report rate (≤ 1000 Hz), D-pad, dock;
  - **4 onboard profiles** (3 on G7 SE). M + Y/B/A/X switches profiles;
  - Cyclone 2: lighting, macros, curves, report rate, sleep;
  - G7 Pro 8K and Tarantula Pro 8K: 8000 Hz;
  - gyro on G7 Pro, G7 Pro 8K, Cyclone 2, Tarantula.
- **Transport facts:**
  - **G7 Pro / G7 SE / Kaleid** configure over a **vendor-class USB interface** (endpoint `0x02`, report IDs `0x03`/`0x0F` out, `0x10`/`0x20` in), after a `"gamesirapp"` handshake. On Windows that interface belongs to xusb22 (XInput identities) or xboxgip (`1022`), so **not reachable without a driver** except possibly via GIP-custom in Xbox mode (**UNVERIFIED**).
  - **Cyclone 2, G7 Pro 8K PC, Tarantula Pro 8K** use a **hidraw vendor interface**, so HID works on Windows.
  - The Nova 2 Lite RGB is on page `0xFF7A` (OpenRGB).
- **Open work:**
  - **g7ctl** (pyg7 library **Apache-2.0**, app GPL-3.0-or-later): G7 Pro, 87 KB PROTOCOL.md;
  - **gamesir-linux-tools** (**MIT**): Cyclone 2, G7 Pro, G7 Pro 8K PC, G7 SE, Tarantula Pro 8K, Kaleid lighting;
  - **gamesir-cyclone2-linux** (**MIT**);
  - SDL gamesir (zlib; IMU 1000 Hz wired / 250 Hz wireless);
  - OpenRGB (GPL-2.0+).
- **Path:** HID for the hidraw models (M); tester for the rest; GIP-custom later.
- **Safety:**
  - g7ctl documents a `CMD_READ` "wedge" with at least three failure states;
  - "identity flip clears remaps";
  - a profile switch can **re-enumerate** the pad (1000 Hz or a keyboard/mouse bind adds a HID interface);
  - the author refuses untested variants because the failure mode "is a bricked controller".

  So: per-PID support only, read-back on every write, never touch an unlisted variant.
- **Pop.** M–H. **Effort** M (HID models) / L (others).
- **G7 SE over GIP (research item 6):** see [G7SE-GIP.md](G7SE-GIP.md). Nexus uses `Windows.Gaming.Input.Custom`.
  The settings ride GIP message `0x0F` (replies on `0x10`) with the family's register protocol. A spike that would
  read them is written behind the `gip-spike` feature and has not been run.
- **C2 notes (built 2026-10-15 from the MIT sources, fixtures and sims only; all UNVERIFIED until the developer checks a pad):**
  - the config channel answers only in the pad's PC / Xbox (XInput) mode and only while the host sends the heartbeat
    (`0F F2`): SYNQ sends it every 0.4 s while the pad's tester or Settings page is open and focused, never from the
    device list. A pad that is asleep streams zero 0x12 reports and answers nothing: the page says so and writes nothing;
  - the wired Cyclone exposes **two** vendor interfaces (one streams empty 0x12 reports and answers nothing,
    gamesir-linux-tools `gs_common.py`). On Linux both are one hidraw node each; on Windows the bridge sends report 0x0F
    to the first collection that takes it. If that is the dead one, nothing answers and nothing is written (safe), but
    the settings won't open: **owner check**;
  - Windows lists the pad's XInput interface too. When XInput reports the pad's own id, the device list shows it once
    (as the HID pad). If XInput reports Windows' generic `045E:02A1` instead, it shows twice: **owner check**;
  - `0x0575` is shared by a wired Cyclone ("GameSir-Cyclone 2") and an idle G7 Pro 8K dongle ("Gamepad"), and the two
    register maps differ: read only;
  - the Tarantula re-enumerates when its report rate changes (the 8K may too): the page says to reopen it and check the
    rate. Its motors aren't mapped in the sources: no rumble test or vibration setting;
  - the 0x12 battery byte (35) and charging byte (34) are read as the sources name them; their units are unconfirmed.

### 5.10 Turtle Beach (Stealth Ultra, Stealth Pivot, Recon, React-R)

- **IDs:** Stealth Ultra `10F5:7073` (wired); Recon `7005`/`7008`/`7009`; React-R `7013`; VID `10F5` is in xpad's GIP vendor list. Stealth Pivot and the Stealth Ultra dongle: **UNVERIFIED**.
- **Configurator:** Control Center 2 (Xbox, PC, iOS, Android): mapping, deadzones and axis response, vibration, audio, RGB, updates.
- **Settings:** **10 onboard profiles** (Stealth Ultra). Hair-trigger locks are physical. Pro-Aim focus mode can be bound to a back button.
- **Path:** detect + tester; GIP-custom after captures.
- **Safety:** firmware via CC2 (block). **Pop.** M. **Effort** L.

### 5.11 PDP / Victrix (Pro BFG, Gambit)

- **IDs:** Pro BFG for Xbox `0E6F:024C` (xpad); Gambit `0E6F:02D6`. PS5-mode IDs **UNVERIFIED**; Victrix Pro FS sticks `0E6F:0203`/`0207`/`0209`/`020A`.
- **Configurator:** **Victrix Control Hub** (Windows desktop for the PS5 model; Xbox + PC for the Xbox model): remap, recalibrate, deadzones, audio EQ, diagnostics, firmware.
- **Settings:** **3 onboard profiles**. Clutch triggers have 5 mechanical stops. The PS model has a mode switch (PS5 / PS4 / PC XInput).
- **Path:** detect + tester; HID-desktop (PS model) or GIP-custom (Xbox) after captures.
- **Safety:** Control Hub flashes the controller and dongle, so block that. **Pop.** M. **Effort** L.

### 5.12 PowerA (Fusion Pro 3/4, OPS v3 Pro)

- **IDs:** Fusion Pro 4 wired `20D6:400B`; Fusion Pro 2 `20D6:4001`; MOGA XP-Ultra `890B`; VIDs `20D6`/`24C6` are in xpad's lists. Fusion Pro 3 and OPS v3 Pro: **UNVERIFIED**.
- **Configurator:** **PowerA Gamer HQ** (Xbox + Windows 10/11): remap, trigger deadzones, audio, vibration. The OPS v3 Pro has its own app (beta per reviews).
- **Storage:**
  - Fusion Pro 4: "up to 3 profiles locally" (manual); paddle assignments stay in memory;
  - OPS v3 Pro: 3 profiles switched with an underside button.
- **Path:** detect + tester; GIP-custom later. **Pop.** M. **Effort** L.

### 5.13 Nacon (Revolution 5 Pro, Revolution X Pro)

- **IDs:** Revolution 5 Pro PS4-mode `3285:0D16` (dongle) / `0D17` (wired), PS5-mode `0D18` / `0D19`, PC XInput `3285:0662`; older Nacon VID `146B`. Revolution X Pro: **UNVERIFIED**.
- **Configurator:** Revolution 5 Pro app (PC): stick and trigger deadzones, vibration, curves, "Shooter Pro Mode". **4 profiles per platform** on the pad.
- **Path:** tester; HID-desktop after captures (PS modes are DS4/DS5-like HID). **Pop.** M. **Effort** L.

### 5.14 Thrustmaster (eSwap)

- **IDs:** eSwap X Pro `044F:D012` (GIP); eSwap X 2 Elden Ring `D01E`; eSwap Pro (PS4/PC) `D00E` (no gyro; the lightbar does not change).
- **Configurators:**
  - **ThrustmapperX** (Microsoft Store) for eSwap X Pro: remap, stick curves and deadzones, trigger deadzones, vibration, firmware/driver updates;
  - Thrustmapper (desktop) for the PS4 model.
- **Storage:** **2 onboard profiles**.
- **Path:** detect + tester; GIP-custom / HID-desktop after captures. **Pop.** L–M. **Effort** L.

### 5.15 HORI (pro pads)

- **IDs:**
  - Fighting Commander OCTA: Xbox `0F0D:0150`, PS `0162`/`0163`, XInput `0164`;
  - HORIPAD ONE `0067`; Wireless HORIPAD for Steam `01AB` / BT `0196` (Steam protocol, SDL steam_hori);
  - HORIPAD Pro (Xbox): **UNVERIFIED**.
- **Configurator:** **HORI Device Manager**: button layout, D-pad, up to 4 profiles. On-device storage is **UNVERIFIED**.
- **Path:** detect + tester; GIP-custom later. **Pop.** M. **Effort** L.

### 5.16 Machenike (G5 Pro)

- **IDs:** `2345:E00B` "Machenike G5 Pro Controller" (xpad, XInput). Hall sticks, tri-mode.
- **Polling:** Gamepadla measured 125–470 Hz depending on connection; a retailer lists 1000 Hz wired for the V2.
- **Configurator:** mobile/PC app. App, settings and storage are all **UNVERIFIED**.
- **Path:** detect + tester. **Pop.** M. **Effort** L.

### 5.17 BIGBIG WON (Blitz 2, Rainbow 2 Pro/SE)

- IDs, configurator, settings and storage: all **UNVERIFIED** (nothing reliable found).
- **Path:** detect + tester (identify from the device strings once an owner sends a diagnostics bundle). **Pop.** L–M. **Effort** L.

### 5.18 Battle Beaver and other modded pads

- They use the base controller's IDs (Xbox, DualSense). Their mods are mechanical: trigger stops, clicky buttons, paddles.
- SYNQ cannot tell them apart. Detect as the base model; optionally let the user label it. **Effort** S.

### 5.19 Logitech F-series (detect only)

- F310 `046D:C21D` XInput / `C216` D-mode; F510 `C21E`; F710 `C21F`; Chillstream `C242`/`CAD1`.
- No settings (the mode is a physical switch). Detect + tester. **Effort** S.

### 5.20 Others worth listing (detect + tester; specifics UNVERIFIED unless noted)

- **HyperX Clutch family:** Clutch `03F0:038D`/`048D`; Gladiate `0495`, v2 `08B6`, RGB `07A0`; Tanto `09B4` (xpad).
- **ASUS ROG Raikiri / Raikiri Pro:** configured in Armoury Crate. **Never touch Armoury Crate** (standing rule); detect only.
- **ByoWave Proteus** `366C:0005`; Hyperkin Duke/DuchesS (`2E24`); Snakebyte (`294B`); Mad Catz (`0738`/`1BAD`).
- **GuliKit, EasySMX, Mobapad, ZD:** nothing reliable on PC config. Detect via descriptor strings.
- **Open protocols (easy tester support):**
  - Handheld Legend **SInput** (`2E8A:10C6`, ProGCC `10DF`, GC Ultimate `10DD`; documented at docs.handheldlegend.com, SDL zlib);
  - GP2040-CE leverless boards (on-device web configurator).

---

## 6. Universal controller tester

### 6.1 What it shows

| Panel | Content |
|---|---|
| Sticks | live dot + trail; **drift** (rest offset vector and noise σ over 2 s); **circularity** (spin at full tilt; 72 bins of 5°, max radius per bin, mean abs error % plus a polar plot); **inner deadzone / jump** (slow push from centre: smallest non-zero output radius, and whether the output starts at 0 or jumps, i.e. anti-deadzone); **outer deadzone** (radius where the output saturates; % of the circle at max); resolution (distinct values seen); deadzone overlays for the device's own settings when a driver knows them |
| Triggers | rest and full values, bit depth (8 vs 10), travel graph; hair-trigger detection (only 0 / max seen) |
| Buttons | map incl. paddles, profile index where reported (Elite, Edge), chatter (repeat toggles < 5 ms) |
| Gyro / accel | rates, bias at rest (°/s), noise; where reported (DualSense, Switch, Steam, 8BitDo, Flydigi, GameSir) |
| Polling | Hz mean, median, p1/p99 interval, jitter; per path (§6.3) with an honest "measured via …" label |
| Battery | % or level, charging; per protocol |
| Output tests (opt-in) | rumble per motor, DualSense trigger effect, lightbar / player LEDs. All volatile and harmless; off until clicked |

### 6.2 Input paths compared

| Path | Where | Rate it can see | Timestamps | What it covers | Caveats |
|---|---|---|---|---|---|
| Browser / WebView2 **Gamepad API** | web + desktop | **≈ 250 Hz max** (Chromium polls every 4 ms; Finch can change it). Microsoft has proposed an event-driven API (chromestatus 5989275208253440), not shipped | the browser's change time | standard mapping; Xbox through XInput/WGI inside Chromium; DualSense through raw HID; no paddles on most pads | good for visuals only; never use it for Hz |
| **XInput** (Rust) | desktop | up to the sampling loop (4–16 kHz busy loop in a short test) | `dwPacketNumber` changes + QPC | XUSB and GIP pads (4 max), triggers 8-bit | counts **changes**, so sticks must move (Gamepadla method); background OK |
| **Windows.Gaming.Input** RawGameController | desktop | per reading | reading `Timestamp` | GIP, XUSB, HID gamepads; Elite paddles | **window must be focused** |
| **GameInput** | desktop (runtime installed) | **every packet** | µs per reading, 0.5 s history | GIP (incl. raw reports), HID, XUSB | optional dependency; best for Xbox pads |
| **Raw HID** (hidapi read thread) | desktop; WebHID on the web (`inputreport` events) | **every report** | QPC at read (desktop); `timeStamp` on the web | all HID pads | needs a parser per protocol (Sony, Nintendo, Xbox-BT, Steam, 8BitDo, Flydigi, GameSir, SInput) or a generic descriptor-driven parser (SDL has one, zlib) |
| GIP-custom sink | desktop | every GIP message | `OnMessageReceived` timestamp | Xbox-licensed pads | spike (§3.3) |
| Raw Input `WM_INPUT` on the xusb/xboxgip "IG_" HID shims | desktop | per report | QPC at receipt | XUSB/GIP pads | **UNVERIFIED**; triggers combined on one axis |

### 6.3 Polling-rate method

1. Prefer a source with **one event per report** (raw HID, GameInput, GIP sink). Collect 3–5 s while the user spins a stick. Many pads only send on change, and Xbox BT and some dongles coalesce reports.
2. Report the **median interval → Hz**, p1/p99 and jitter (σ). Drop the first 200 ms and any gap > 50 ms (sleep / idle).
3. With XInput only: sample in a dedicated high-priority thread (high-resolution waitable timer, or a short busy-spin for 8K pads) and count `dwPacketNumber` increments. Report "≥ N Hz (sample-limited)" when the change rate reaches half the sampling rate.
4. Always label the path. Known pitfalls:
   - the Steam Controller 2026 claims 1 kHz in its descriptor but runs at about 4 ms (SDL);
   - GameSir/Flydigi IMU rates differ from stick rates;
   - Bluetooth is usually 125–250 Hz.
5. Prior art: Gamepadla **Polling** (MIT; "latency between successive changes in the position of the analog stick") and chrizonix XInputTest.

### 6.4 Safety for the tester

- Read-only by default. Output tests send only the volatile rumble/LED/trigger-effect reports listed per brand.
- **Bridge policy change (required):** today `hid.rs` never opens Generic Desktop collections for OpenMouse devices. The tester needs a separate, explicit rule:
  - input reports only, Generic Desktop Gamepad `0x05` / Joystick `0x04` (and SInput / known vendor input pages);
  - only for VID/PIDs in the controller table;
  - never Keyboard `0x06`, Mouse `0x02`, Keyboard page `0x07`.
- Release devices when SYNQ loses focus (g7ctl does the same). Never hold an exclusive handle while a game runs.

---

## 7. Capability model for controllers (extends CAPABILITIES.md §3)

Proposal only. Units stay human: % of travel, ms, Hz, °/s.

```ts
// §3.1 additions
export type Unit = /* existing */ "cpi" | "hz" | "ms" | "s" | "min" | "mm" | "deg" | "%" | "db" | "q" | "level" | "none"
                 | "deg/s" | "g";

export interface CurvePoint { x: number; y: number }      // normalised 0..1
/** A response curve. Devices store either a preset id, control points, or both. */
export interface CurveSpec {
  kind: "curve";
  presets?: readonly { id: number | string; label: string; points?: readonly CurvePoint[] }[];
            // Edge: Default, Quick, Precise, Steady, Digital, Dynamic (id byte + adjust points)
            // iCUE: predefined sensitivity presets (gamepad-predefined-data)
  points?: { count: number; fixedEnds: boolean; monotonic: boolean; quantum: number }; // Elite 2: 3 per axis, byte steps (1/255)
  axes: "radial" | "perAxis";                              // Elite 2 stores X and Y curves separately
}
export type Spec = /* existing union */ | CurveSpec;

// §3.2: new groups
export type GroupId = /* existing */ "info" | "power" | "pointer" | "buttons" | "lighting" | "analog" | "keymap"
                    | "profiles" | "eq" | "headset" | "wireless"
                    | "sticks" | "triggers" | "haptics" | "motion" | "link";

// §3.3: InfoGroup.kind gains "controller"; connection.kind gains "gip" | "xusb" | "dongle"
export interface Capabilities {
  /* existing groups … */
  sticks?: SticksGroup;
  triggers?: TriggersGroup;
  haptics?: HapticsGroup;
  motion?: MotionGroup;
  link?: LinkGroup;
  live?: LiveInput;              // the tester stream; not a setting
}

export type StickId = "left" | "right";
export interface SticksGroup {
  sticks: readonly { id: StickId; label: string; sensor?: "potentiometer" | "hall" | "tmr" | "unknown" }[];
  curve?: Setting<MapSpec<CurveSpec>>;           // over sticks; scope "profile"
  deadzoneInner?: Setting<MapSpec<NumberSpec>>;  // % radius (Edge deadzone, BRAGI ThumbstickDeadzone)
  deadzoneOuter?: Setting<MapSpec<NumberSpec>>;  // % radius (Elite "saturation", BRAGI ThumbstickMaximumDeadzone)
  antiDeadzone?: Setting<MapSpec<NumberSpec>>;   // % (rare onboard; Nacon "Shooter Pro Mode" is a toggle)
  deadzoneShape?: Setting<MapSpec<ChoiceSpec>>;  // "radial" | "axial" | "square"
  sensitivity?: Setting<MapSpec<NumberSpec>>;    // BRAGI ThumbstickSensitivity
  invertY?: Setting<MapSpec<ToggleSpec>>;        // Elite curves page byte 27
  swap?: Setting<ToggleSpec>;                    // Elite: swap sticks
  calibration?: ActionDescriptor;                // ALWAYS risk "high" or "blocked" (DS5 0x82, BRAGI 0x0A, 8BitDo 0x36/0x38)
}

export type TriggerId = "lt" | "rt";
export interface TriggersGroup {
  triggers: readonly {
    id: TriggerId; label: string; bits: 8 | 10 | 12;
    mechanicalStop?: "none" | "switch" | "slider";  // Elite, Victrix, SCUF, Razer: physical, shown, never set
  }[];
  rangeStart?: Setting<MapSpec<NumberSpec>>;     // % (Edge trigger min; BRAGI TriggerDeadzone)
  rangeEnd?: Setting<MapSpec<NumberSpec>>;       // % (Edge trigger max; BRAGI TriggerMaximumDeadzone; Elite saturation)
  curve?: Setting<MapSpec<CurveSpec>>;           // GameSir 5-handle curves; iCUE trigger curves
  hairTrigger?: Setting<MapSpec<ToggleSpec>>;    // software hair trigger (G7: M+LT/RT on-device)
  adaptive?: {                                   // DualSense family
    effectTest: ActionDescriptor;                // volatile output test only
    intensity?: Setting<NumberSpec>;             // Edge per-profile "trigger effect intensity"
  };
}

export type MotorId = "leftGrip" | "rightGrip" | "leftImpulse" | "rightImpulse" | "voiceCoil";
export interface HapticsGroup {
  motors: readonly { id: MotorId; label: string }[];
  intensity?: Setting<MapSpec<NumberSpec>>;      // % per motor, scope "profile" (Elite page [28..31], [49..50]; BRAGI L/R; Edge)
  test?: ActionDescriptor;                       // risk "low": volatile rumble pulse
}

export interface MotionGroup {
  gyro: boolean; accel: boolean;
  enabled?: Setting<ToggleSpec>;
  sensitivity?: Setting<NumberSpec>;             // BRAGI GyroscopeSensitivity; Flydigi/GameSir gyro pages
  output?: Setting<ChoiceSpec>;                  // "off" | "rightStick" | "mouse": mouse output can change the USB identity (caution)
}

export interface LinkGroup {
  connection: Setting<ChoiceSpec>;               // ro: "usb" | "dongle" | "bluetooth" | "xboxWireless"
  personality?: Setting<ChoiceSpec>;             // ro mostly (hardware switch): "xinput" | "dinput" | "switch" | "gip"
                                                 // writable only where a command exists; caution: the PID changes
  pollingWired?: Setting<NumberSpec>;            // values ⊆ [125, 250, 500, 1000, 2000, 4000, 8000]
  pollingWireless?: Setting<NumberSpec>;         // `caution`: a GameSir 1000 Hz setting re-enumerates the pad
  sleepTimeout?: Setting<NumberSpec>;
}

/** The tester stream. Never a setting. `source` decides what the Hz number means (§6.2). */
export interface LiveInput {
  source: "hid" | "gameinput" | "gip" | "xinput" | "wgi" | "gamepad-api" | "bragi-notify";
  timestamps: "per-report" | "per-change" | "sampled";
  maxHz?: number;                                // known ceiling (Gamepad API ≈ 250)
  reports: { sticks: boolean; triggers: boolean; paddles: number; gyro: boolean; battery: boolean; profileIndex: boolean };
}

// Buttons: reuse ButtonsGroup. Gamepad button ids are fixed strings so feel/profile data can move between pads.
export type GamepadButtonId = "a" | "b" | "x" | "y" | "lb" | "rb" | "ls" | "rs" | "view" | "menu" | "guide" | "share"
  | "dUp" | "dDown" | "dLeft" | "dRight" | "p1" | "p2" | "p3" | "p4" | "g1" | "g2" | "g3" | "g4" | "g5" | "saxL" | "saxR"
  | "fn" | "profile" | "touchpad" | "mic";
// ActionKind gains "gamepad" and "turbo". Turbo, macros and keyboard/mouse outputs carry a `caution`
// ("may break game or tournament rules", §9) and are off by default.

// Profiles: reuse ProfilesGroup, plus:
export interface ControllerProfilesExtras {
  slotsIncludeDefault: boolean;                  // Edge: 4 incl. a protected default; Elite: 3 + default
  switchControl: string;                         // "Fn + face button", "profile button", "M + Y/B/A/X", "rear switch"
  protectedSlots?: readonly number[];            // Edge Triangle/default: never written
}

// Transports (§3.6 ChannelShape.transport) gain "gip" | "xusb" | "gameinput". Their web verdict is always "no".
// Persistence semantics reused: onboard (Edge, Elite, Envision, GameSir, Flydigi, 8BitDo); host (Steam Input,
// standard Xbox remap per user, Razer app session profiles); volatile (DualSense LEDs/effects, Switch LEDs).
// apply: "commit" for Elite (0x4D 03 after 0x07), Flydigi (explicit save), BRAGI (commit commands).
```

**Guards** follow CAPABILITIES §3.4:
- a GIP guard classifies `(messageClass, messageId, payload)` instead of `(reportType, reportId, data)`;
- the same table is compiled into Rust.

---

## 8. Safety summary

| Family | Firmware / DFU path | Must block | Bricking / damage evidence |
|---|---|---|---|
| Xbox / GIP | Xbox Accessories; `GipGameControllerProvider.UpdateFirmwareAsync`; GIP system `0x0C` | `UpdateFirmwareAsync`; system `0x06`, `0x0C`, `0x1E` writes, `0x1F`; Elite `0x4D` writes outside the guarded flow | `IsFirmwareCorrupted` / `GetDeviceFirmwareCorruptionState` exist; Elite zero-filled pages → binary triggers |
| Sony | Sony Firmware Updater; PlayStation Accessories | DS5 `0x80–0x83`, DS4 `0xA0`, `0x90`, `0x13`, auth `0xF0–0xF2`, Edge module writes, any unknown feature SET | stick calibration and NVS writes are permanent (dualshock-tools needs explicit unlock and lock) |
| Nintendo | console only | subcommands `0x01`, `0x06–0x08`, `0x11`, `0x12`, `0x20–0x2B`, `0x41–0x42`, `0x50–0x52` | SPI writes can erase factory calibration and pairing |
| 8BitDo | Firmware Updater, web.8bitdo.com (WebHID) | boot PIDs `2DC8:05C4`/`3208`/`5750`/`207B`/`2078`, `RR` PIDs; calibration `0x36`/`0x38` | recovery ("RR") identities exist for failed updates |
| Flydigi | Space Station | firmware; acquire without the user's toggle; saves outside Save | – |
| GameSir | Nexus / Connect | firmware; unknown variants; reads that wedge the pad (g7ctl) | g7ctl warns that wrong-variant support means "a bricked controller" |
| SCUF / Corsair BRAGI | `BragiHeadsetFwUpdateTool`, iCUE | everything outside the BRAGI allowlist (corsair-icue.md) + gamepad calibration `0x0A` | – |
| Valve | Steam | everything (tester is read-only) | – |
| Victrix, PowerA, Turtle Beach, Thrustmaster, HORI, Nacon, Razer | their apps | no writes until a capture-based allowlist exists | – |

---

## 9. Anti-cheat

**Fine:**
- writing **onboard** settings with the same messages the vendor app sends (curves, deadzones, remaps, LEDs). The game sees a normal controller;
- reading inputs for the tester with shared, non-exclusive handles;
- volatile LED and rumble tests.

**Risky (SYNQ should not ship these):**
- **virtual controllers.** ViGEmBus was retired in 2023 with a security warning about its updater, and HidHide-style hiding needs kernel drivers;
- input injection or host-side remapping layers (iCUE's SCUF driver library injects button state);
- turbo, macros, rapid-fire, "anti-recoil".

  Activision's Ricochet now flags "machine-driven" input patterns and named Cronus Zen / XIM as cheating tools on console and PC. Battlefield 6 announced similar work.

  Where a pad stores turbo or macros **onboard** (GameSir, 8BitDo, Flydigi), SYNQ may show them, behind a caution, off by default.

**Practical:**
- never hold a pad exclusively while a game runs. g7ctl's claim of the interface makes the pad vanish from games;
- warn when a vendor app (Xbox Accessories, iCUE, Synapse, Space Station, Nexus) is also running.

**Conflict warnings (process names, read only; src-tauri/src/conflicts.rs).** SYNQ warns, never closes anything:

| App | Process names | Status |
|---|---|---|
| GameSir Nexus (legacy Store app, GuangzhouChickenRunNetwor.GameSirNexusLegacy 1.5.3.0) | `HJC.XboxApp.GameSir.exe` | verified on the developer's PC |
| GameSir Connect | `GameSir Connect.exe`, `GameSirNexus.exe`, `GameSir Nexus.exe` | **UNVERIFIED** |
| Xbox Accessories (Microsoft.XboxDevices) | `XboxDevices.exe`, `XboxAccessories.exe`, `Xbox Accessories.exe` | **UNVERIFIED** (not installed where checked) |
| Corsair iCUE | `iCUE.exe` | known |
| Razer Synapse | `Razer Synapse 3.exe`, `Razer Synapse.exe`; Synapse 4 `RazerAppEngine.exe` | Synapse 4 name **UNVERIFIED** |
| DSX (DualSenseX) | `DSX.exe`, `DualSenseX.exe` | known |
| DS4Windows | `DS4Windows.exe` | known |
| Steam (Steam Input) | `steam.exe`, `steamwebhelper.exe`; Linux `steam` | known |

Never warned on: the Xbox Accessory Management Service (XboxGipSvc), a Windows system service that is always present.

---

## 10. What is impossible without a driver

1. **Raw XUSB endpoints** (the configuration route Linux tools use for GameSir G7 / G7 SE / G7 Pro / Kaleid, flydigictl, 8BitDo Xbox mode) need WinUSB (Zadig = driver swap). The only exceptions are xusb22's own IOCTLs (rumble, LED: **UNVERIFIED**) and vendor messages over GIP-custom when the pad is in Xbox mode.
2. **Raw GIP over USB / the Xbox Wireless Adapter** (xone-style) means replacing xboxgip. Message-level access is still possible through WGI.Custom and GameInput.
3. **Switch 2 controllers** on Windows: USB needs a bulk-endpoint init (libusb/WinUSB). BT is not implemented anywhere open.
4. **Polling "overclock"** of DualSense, DS4 or Xbox pads (bInterval changes à la hidusbf) needs a filter driver.
5. **Virtual controllers and device hiding** (ViGEm, vJoy, HidHide). They are kernel drivers, and out of scope by policy and for anti-cheat (§9).
6. **System-wide curves, deadzones or remaps for pads that store nothing onboard** (standard Xbox pad, DualSense, Switch Pro, Steam pads) need a virtual device or injection. Steam Input does this inside Steam. SYNQ can only offer per-user remap on Xbox via LegacyGip (§3.1).

---

## 11. License summary (controller projects)

| Project | License | Use in SYNQ |
|---|---|---|
| SDL (`usb_ids.h`, `controller_list.h`, HIDAPI drivers: ps4/ps5/switch/switch2/xboxone/gip/steam/steam_triton/8bitdo/flydigi/gamesir/sinput) | zlib | code reuse OK (keep the notice) |
| Linux hid-playstation, hid-nintendo, hid-steam, xpad | GPL-2.0-or-later / GPL-2.0+ | code reuse OK |
| xone (medusalix; dlundqvist fork) | GPL-2.0-or-later | code reuse OK |
| xpadneo | NOASSERTION (mixed) | docs-only until checked |
| xbelite2 (Elite 2 protocol) | **GPL-2.0-only** | **docs-only** |
| dualsensectl | GPL-2.0-or-later | code reuse OK |
| pydualsense; dualshock-tools; steffalon Edge web app | MIT | code reuse OK |
| DS4Windows (schmaldeo, archived) | GPL-3.0 | code reuse OK |
| edgemap | GPL-3.0 | code reuse OK |
| DualSenseX repo; nondebug/dualsense; dekuNukem Switch notes; **OpenMouse controller-protocol** | none | docs-only |
| OpenRGB (SonyGamepadController, GameSirController) | GPL-2.0-or-later | code reuse OK |
| ultimatecontroller-rs (8BitDo) | MIT | code reuse OK |
| g7ctl | pyg7 **Apache-2.0**; app GPL-3.0-or-later | code reuse OK |
| gamesir-linux-tools; gamesir-cyclone2-linux | MIT | code reuse OK |
| flydigi-space-station-mac | MIT | code reuse OK |
| flydigictl; vader3 | GPL-3.0 | code reuse OK |
| flydigi-vader5 | GPL-2.0 (only/or-later not checked) | docs-only until checked |
| openflydigi; ApexSenseBridge | NOASSERTION | docs-only until checked |
| Gamepadla Polling | MIT | code reuse OK |
| Microsoft GIP partner docs, MS-GIPUSB, GameInput redist | Microsoft terms | docs; GameInput only as an optional runtime |
| iCUE, Synapse, Space Station, Nexus, Control Hub, … | vendor EULAs | facts only, never code |

---

## 12. Sources

**Microsoft**
- GIP docs ZIP (Apr 2025: Original GIP Spec, Metadata spec, XInputHID, XUSB, arcade/wheel/flight-stick): <https://aka.ms/gipdocs> → <https://dlassets-ssl.xboxlive.com/public/content/GIP/GIPDocumentation.zip>
- MS-GIPUSB: <https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-gipusb/e7c90904-5e21-426e-b9ad-d82adeee0dbc>
- WGI.Custom: <https://learn.microsoft.com/en-us/uwp/api/windows.gaming.input.custom>, [GipGameControllerProvider](https://learn.microsoft.com/en-us/uwp/api/windows.gaming.input.custom.gipgamecontrollerprovider), [GameControllerFactoryManager](https://learn.microsoft.com/en-us/uwp/api/windows.gaming.input.custom.gamecontrollerfactorymanager), [GipMessageClass](https://learn.microsoft.com/en-us/uwp/api/windows.gaming.input.custom.gipmessageclass), [IGipGameControllerInputSink](https://learn.microsoft.com/en-us/uwp/api/windows.gaming.input.custom.igipgamecontrollerinputsink)
- LegacyGipGameControllerProvider: <https://learn.microsoft.com/en-us/uwp/api/windows.gaming.input.preview.legacygipgamecontrollerprovider>
- GameInput: [readings](https://learn.microsoft.com/en-us/gaming/gdk/docs/features/common/input/overviews/input-readings), [SendRawDeviceOutput](https://learn.microsoft.com/en-us/gaming/gdk/docs/reference/input/gameinput/interfaces/igameinputdevice/methods/igameinputdevice_sendrawdeviceoutput), [raw report info](https://devdocs.xbox.com/reference/input/gameinput/structs/gameinputrawdevicereportinfo), [NuGet/redist](https://devdocs.xbox.com/build/core-features/common/input/overviews/input-nuget)
- WGI focus: [Unity issue](https://issuetracker-mig.prd.it.unity3d.com/issues/inputsystem-does-not-register-controller-inputs-in-the-background-when-inputsettings-dot-backgroundbehavior-is-set-to-ignorefocus), [DirectXTK GamePad wiki](https://github.com/Microsoft/DirectXTK/wiki/GamePad)
- Xbox: [Elite Series 2 page](https://www.xbox.com/en-CA/accessories/controllers/elite-wireless-controller-series-2), [2015 remap post](https://news.xbox.com/en-us/2015/11/16/button-remapping-now-available-on-standard-xbox-wireless-controllers/)

**Open-source code and reverse engineering**
- SDL: <https://github.com/libsdl-org/SDL> (`src/joystick/usb_ids.h`, `controller_list.h`, `hidapi/`)
- Linux: [xpad.c](https://github.com/torvalds/linux/blob/master/drivers/input/joystick/xpad.c), [hid-playstation.c](https://github.com/torvalds/linux/blob/master/drivers/hid/hid-playstation.c), [hid-nintendo.c](https://github.com/torvalds/linux/blob/master/drivers/hid/hid-nintendo.c), [hid-steam.c](https://github.com/torvalds/linux/blob/master/drivers/hid/hid-steam.c)
- Xbox: <https://github.com/medusalix/xone>, <https://github.com/dlundqvist/xone>, <https://github.com/atar-axis/xpadneo>, **<https://github.com/lemonxah/xbelite2>** (`docs/protocol.md`)
- Sony:
  - <https://www.playstation.com/en-us/support/hardware/set-up-edge-pc/>
  - <https://www.pushsquare.com/news/2024/08/dualsense-edge-fully-customisable-on-pc-with-new-app>
  - <https://steamdb.info/patchnotes/13037393> (DSX)
  - <https://github.com/steffalon/dualsense-edge-profile-web-application>
  - <https://github.com/dualshock-tools/dualshock-tools.github.io>
  - <https://github.com/nondebug/dualsense>
  - <https://github.com/schmaldeo/DS4Windows>
  - <https://github.com/Paliverse/DualSenseX>
  - <https://github.com/nowrep/dualsensectl>
  - <https://github.com/flok/pydualsense>
  - <https://github.com/Kurobac/edgemap>
  - <https://github.com/OpenMouse-Project/controller-protocol>
- Nintendo: <https://github.com/dekuNukem/Nintendo_Switch_Reverse_Engineering>
- OpenRGB: <https://github.com/CalcProgrammer1/OpenRGB> (`Controllers/SonyGamepadController`, `Controllers/GameSirController`)
- Polling: <https://github.com/cakama3a/Polling>, <https://github.com/chrizonix/XInputTest>, <https://gamepadla.com>
- 8BitDo: <https://github.com/s8n/ultimatecontroller-rs>, <https://web.8bitdo.com/> (bundle read), <https://8bitdo.com/ultimate-2-wireless-controller>
- Flydigi:
  - <https://github.com/pipe01/flydigictl>
  - <https://github.com/mkaliaha/openflydigi>
  - <https://github.com/uiltonlopes/flydigi-space-station-mac>
  - <https://github.com/BANANASJIM/flydigi-vader5>
  - <https://github.com/ahungry/vader3>
  - <https://github.com/ReynArts/ApexSenseBridge>
  - <https://gamepadla.com/flydigi-vader-5-pro.html>
- GameSir:
  - <https://github.com/questionablesyntax/g7ctl> (`PROTOCOL.md`)
  - <https://github.com/broroeror/gamesir-linux-tools>
  - <https://github.com/MiguelSanzBr/gamesir-cyclone2-linux>
  - <https://gamesir.com/collections/pc-controllers/products/gamesir-g7-pro>
  - <https://gamesir.com/collections/pc-controllers/products/gamesir-g7-pro-8k-pc-champion-edition>
- SInput: <https://docs.handheldlegend.com/s/sinput>

**Vendors and reviews**
- Razer:
  - <https://mysupport.razer.com/app/answers/detail/a_id/3939>
  - <https://www.overclockers.co.uk/razer-wolverine-v3-pro-8k-wireless-pc-controller-8000hz-hyperpolling-anti-drift-black/PER-RZR-07439.html>
  - <https://www.profesionalreview.com/2025/08/15/razer-presenta-el-wolverine-v3-pro-8k-pc-gaming-competitivo/amp/>
- Turtle Beach: <https://www.pbtech.com/product/JOYTTB1004/Turtle-Beach-Stealth-Ultra-Ultra-Wireless-Controll>
- Victrix: <https://www.bestbuy.com/site/6571329.p>
- PowerA:
  - <https://powera.com/siteassets/user-manuals/fusion/xbgp0325-01_xbx_fusion_pro4_um_v1_en_1726615352.pdf>
  - <https://www.gfinityesports.com/article/powera-ops-v3-pro-wireless-controller-review>
  - <https://www.techradar.com/gaming/pc-gaming/powera-has-unveiled-the-ops-v1-and-ops-v3-pro-wireless-controllers-designed-for-pc-and-cloud-gamers>
- Nacon: <https://www.thumbculture.co.uk/nacon-revolution-5-pro-controller-review>
- Thrustmaster: <https://support.thrustmaster.com/?p=9198>
- SCUF:
  - <https://www.corsair.com/newsroom/press-release/scuf-gaming-introduces-valor-pro-wireless-controller-for-xbox-and-pc>
  - <https://antyweb.pl/recenzja-scuf-valor-pro-e-sportowy-kontroler-dla-ludu>
  - <https://help.corsair.com/hc/en-us/articles/20234992914957-Envision-Controller-iCUE-Overview>
  - <https://gamepadla.com/scuf-envision-pro.html>
  - <https://www.wepc.com/reviews/scuf-reflex-pro-controller>
- Corsair NOVABLADE: <https://www.corsair.com/newsroom/press-release/corsair-steps-into-the-ring-announces-novablade-pro-wireless-hall-effect-leverless-fight-controller>, <https://www.pcgamesn.com/corsair/novablade-pro-review>
- Steam Controller 2026: <https://boilingsteam.com/the-2026-steam-controller-what-reviewers-are-saying/>, <https://fullcleared.com/news/steam-controller-launches-may-4-for-99/>
- Machenike: <https://gamepadla.com/machenike-g5-pro.html>

**Chromium Gamepad API**
- <https://lists.w3.org/Archives/Public/public-webapps-github/2021Aug/0513.html>
- <https://lists.w3.org/Archives/Public/public-webapps-github/2024Sep/0225.html>
- <https://www.pcworld.com/article/2796377/microsoft-plans-to-fix-controller-input-lag-in-chrome-and-edge.html>

**Anti-cheat**
- <https://windowscentral.com/gaming/xbox/activision-takes-a-stand-against-xim-cheating-in-call-of-duty-with-new-ricochet-countermeasures>
- <https://www.purexbox.com/news/2025/09/battlefield-6-team-partners-with-xbox-and-playstation-to-combat-cronus-zen-cheaters>
- <https://docs.nefarius.at/projects/ViGEm/End-of-Life/>

**iCUE (local, read-only) and Corsair CDN**
- `C:\Program Files\Corsair\Corsair iCUE5 Software\{Corsair.GipDevices.dll, ScufControllerLibrary.dll, DeviceCommands.dll, modules\GipProtocols.dll, modules\BragiProtocols.dll, cue_qml_plugins\GamepadCueQmlPlugin.dll, cuepkg.registry}`
- `https://www3.corsair.com/software/CUE_V5/public/modules/windows/packages/dev-envision-pro-dongle_5.31.101_win32-release-amd64.cuepkg` and `…dev-envision-pro-v2-dongle_5.31.101…`. The pad packages are 404 as of 2026-10-15.
