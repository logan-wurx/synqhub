# SYNQ device roadmap

Snapshot 2026-10-13. Built from [BRANDS.md](BRANDS.md) (facts, IDs, sources) and [CAPABILITIES.md](CAPABILITIES.md) (the driver/UI model every wave uses).

## How the order was chosen

**Score = popularity × access ÷ effort.**
- **Access** is high when either:
  - an official **web configurator** exists whose JS shows the protocol; or
  - **permissive or AGPL-compatible open code** exists.
- It is highest when both exist.
- Desktop-only vendor tools with no open code score lowest: they need hardware captures.

**Rules that shape every wave:**
1. **One driver per firmware family, not per brand** (BRANDS §2). RY5088, Sonix, `19F5`, illumipc, SparkLink and Compx each cover dozens to hundreds of products across many logos.
2. **Ship read-only first.** Every new model starts `experimental`, with writes behind "Allow changes" (CAPABILITIES §3.5). It is promoted to `community` by an developer's diagnostics bundle, and to `verified` by a maintainer's hardware test.
3. **Allowlist per family, refuse bootloader identities, never flash** (BRANDS §7). Mirror the allowlist in the Rust bridge.
4. **Identify by firmware query, never by PID or retail name**, where the family shares PIDs (RY 0x8F, Sonix product string, illumipc 0x0D, Compx CID/MID).
5. **Web availability is derived per channel and platform** (CAPABILITIES §3.6). Razer mice are web-OK on macOS/Linux but need the bridge on Windows Chrome ≥ 153.

## Wave 0: done

| Item | Status |
|---|---|
| Logitech HID++ mice (OpenMouse) | verified on PRO X 2 DEX (onboard-profile writes) |
| ATK / Compx report-8 mice | verified on X1 V2 Air+ (DPI, 2K/4K, LOD, angle snap, sensor mode, debounce) |
| ROG Falchion Ace HFX (Gear Link protocol) | captured from Gear Link; some writes verified |
| illumipc X68 HE family (`2E3C:C365`, `AK1680*`) | code only, experimental, awaiting the friend's diagnostics |
| Equalizer APO EQ engine | verified |

## Prerequisites for every wave

- **P1. Shared core split** (`core/` drivers + capability model, `ui/`, `web/`, `desktop/`), with pages generated from capabilities (CAPABILITIES §4).
- **P2. Channel-based web verdicts** (CAPABILITIES §3.6), so the website hides bridge-only devices instead of showing a broken chooser.
  - One `requestDevice` per click (Chrome 153 consumes the activation).
  - Detect missing WebHID or policy blocks and route the user to the desktop app.
- **P3. Catalogue importers.** Turn vendor tables into SYNQ model tables (facts only, never the vendor file):
  - Compx/DriverCore `Config/env-models.json` (Lamzu, G-Wolves, Arbiter), which also lists **bootloader PIDs**;
  - illumipc `device.json`, Gear Link manifests (`magKeyUnit`, ranges);
  - RK `protocolType` tags, Epomaker hub `vendor` tags;
  - the OM ATK catalogue;
  - FCC `DEVICES.md`, sharkfin board files.
- **P4. Diagnostics bundle + support records** (tier promotion path). Every wave's "community" step depends on it.

## Keyboard waves (running now)

| Wave | Scope | Main sources | Notes |
|---|---|---|---|
| **K1** | **VIA / Vial** generic driver (+ Vial in-firmware xz layouts, "load VIA JSON" for vendor boards not in the-via/keyboards). **@openmouse/keyboard-protocol**: Wooting (read-mostly), Wuque Studio (BABAO60 HE validated), Kochi HB68 | QMK/VIA/Vial (GPL), OM-kb (AGPL) | Block VIA 0x0B. Wooting writes need the profile protobuf from Wootility Web (follow-up). |
| **K2** | **FCC Sonix HE family** (~135 boards: AULA F65, Ajazz AK820 MAX/AK680 MAX, EWEADN, LEOBOG, CIDOO, Looting, Epomaker HE80/TH line, Fighting68) + **AnalogSense** live key travel (Razer analog, NuPhy, DrunkDeer, Keychron HE, Lemokey, Madlions) | FCC (GPL-3.0), universal-analog-plugin (MIT) | Identify by product string (PIDs shared). Block 0x0F reset and 0x64/0x65 calibration outside an explicit flow. |
| **K3a** | **ASUS** Gear Link keyboards (Azoth 96 HE, Falcata, Falchion Ace 75 HE, TX75, K4 Magnetic; parameterise by `magKeyUnit` 0.1 vs 0.01 mm) and **Corsair** Web Hub `2Bxx` boards (Vanguard Pro 96, Clipper Pro 60 HE, MAKR) | Gear Link manifests/bundles, Web Hub bundle (docs-only), OM Bragi | Block the Gear Link OTA family and the Bragi firmware properties. Never open `hidPattern 3` PIDs. |
| **K3b** | **Razer** analog (Synapse Web models, page 0x0C), **MonsGeek/Akko RY5088** (+ the ~30 other RY brands via the same catalogue), **DrunkDeer** `352D` | Synapse Web JS (docs-only), FCC + sharkfin (GPL-3.0), DrunkDeer-Control (MIT), cli-drunkdeer (Apache-2.0) | RY: query 0x8F model + 0xE6 precision before any write. DrunkDeer: firmware dialect check (10× scale bug). Block RY 0x7F/0xAC/0x50 and DrunkDeer 0xF9. |

## Keyboard waves (next)

| Wave | Scope | Why now | Effort |
|---|---|---|---|
| **K4a** | **`19F5` OEM family**: MCHOSE gen 1 (28 boards), NuPhy V3/HE (38 boards, incl. the XOR-session variant), RK "Gcome" boards, newer DrunkDeer | One framing documented by FCC (GPL-3.0); covers four brands | M. **Built 2026-10-14** (`src/lib/brands/fw19f5/`): MCHOSE actuation / RT / locks / lighting and DrunkDeer A75 Pro OEM actuation, all behind "Allow changes"; NuPhy and RK Gcome read-only (firmware version only: the XOR key exchange is documented nowhere); see [BRANDS §4.9](BRANDS.md#49-nuphy) |
| **K4b** | **illumipc / Witmod widening**: Redragon (44 entries, Redragon's own "web driver" is illumipc), Epomaker HE60 Lite, Womier M68HE PRO, `0416` Winbond boards | SYNQ already has the driver; mostly catalogue + layout files | S. **Built 2026-10-14** (`src/lib/illumipc/`, `src/lib/x68he*.ts`): 50 boards by product code (44 Redragon, Epomaker HE60 Lite and HE30, Womier M68HE PRO, 3 X68 HE), 19 layouts, ids `2E3C:C365/C366/C367/C368` and `0416:7372`; X68 HE behaviour unchanged; the other illumipc entries and the OpenRGB `0416` ids are not opened; see [BRANDS §4.18](BRANDS.md#418-illumipc--witmod-family-beyond-the-x68-redragon-epomaker-womier) |
| **K4c** | **SparkLink family**: RK M75 HE + C-series, AULA HE (magnet.aulastar.com), Kochi | Vendor SDK is **MIT** on npm, with docs | S–M. **Built 2026-10-14** (`src/lib/brands/sparklink/`, [SPARKLINK.md](SPARKLINK.md)): 56 ids (21 RK, 34 AULA, Kochi), per-key and global actuation, rapid trigger and dead zones, Windows / Mac mode; all "experimental" (read-only until "Allow changes"); bootloader, factory reset, calibration, macros and lighting never sent; see [BRANDS §4.19](BRANDS.md#419-other-single-family-or-small-brands) |
| **K4d** | **Keychron HE extensions** (0xA7 misc incl. report rate, 0xA9 analog matrix, Snap Click) on top of K1 | Keychron publishes GPL-2.0+ firmware source | M. **Built 2026-10-14** (`src/lib/kb/via/keychron/`, [KEYCHRON-HE.md](KEYCHRON-HE.md)) for the 0xA9 analog matrix only: 35 HE boards (K2/K4/K6/K8/K10, Q0 to Q6 and Q12, Lemokey L1/P1/P2/P3), per-key and profile actuation and rapid trigger on VIA's own channel behind a second guard tier; 0xA7 (report rate, Snap Click, debounce), advanced keys, SOCD, curves and profile names not offered yet; see [BRANDS §4.8](BRANDS.md#48-keychron--lemokey) |
| **K4e** | **RK BeiYing** (SinoWealth `258A`, 314 RK entries, write-only) on the `FF00` vendor collection, plus the legacy System Control channel as **desktop-only** | Huge budget install base; FCC/KludgeKnight code | M. **Built 2026-10-14** (`src/lib/brands/rk-beiying/`) for the legacy System Control channel only (168 boards, 139 with a key map): lighting and base-layer remaps, every write "unconfirmed", desktop bridge only. The `FF00` vendor-collection protocol of RK's web driver is still unread; see [BRANDS §4.15](BRANDS.md#415-royal-kludge) |
| **K5** | Long tail:<br>• **HHKB keymap** (happy-hacking-gnu, Unlicense) and **Realforce APC + remap** (RealforceControl, MIT): the two office brands worth a real driver<br>• Logitech G PRO X TKL RAPID (one HID++ feature dump)<br>• Madlions (find the web driver; try VIA first)<br>• Lofree Key Mapper<br>• Ducky/Varmilo kbhub (L)<br>• Corsair K70 MAX / iCUE-only HE (L)<br>• SteelSeries Apex Pro (L, GG captures)<br>• Glorious GMMK 3 HE (L)<br><br>Lighting-only keyboards move to **L2** | Low access or low value | M–L |

## Wave 5: "Keep your feel" (top priority after the keyboard waves)

Headline feature: **move your setup between mice of different brands and keep the same aim feel, then convert it into each game's sensitivity.**

**Setup transfer:**
1. **Read** a source mouse's effective settings through the capability model (CAPABILITIES §3.7 `FeelProfile`): CPI per stage, polling, LOD, angle snap, motion sync, ripple, debounce, sensor mode, button map.
2. **Map** onto the target mouse's capabilities: nearest legal value, mm-based LOD vs level LOD, unsupported features listed. Show a **diff with "can't match" notes** before writing. Keep a "measured CPI" correction per mouse, since real CPI differs from nominal; this is user-calibrated.
3. **Write** as any other plan (tier rules apply).

**Sens calculator:**
- `cm/360 = 360 / (sens × yaw × CPI) × 2.54`, with a table of per-game yaw constants.
- Convert between games, between CPIs, and from a feel profile to a game.
- The desktop app can read Windows pointer speed and "Enhance pointer precision" and warn when they're on.
- The yaw table must come from sources with clear terms: **UNVERIFIED**, not researched in this pass. Only facts should be stored.

**Why it lands here:** its value grows with the number of mouse brands, so **M1 below ships in the same wave**. M1 is mostly OpenMouse drop-ins at S effort.

## Mouse waves

| Wave | Scope | Main sources | Effort |
|---|---|---|---|
| **M1** (with Wave 5) | **OpenMouse drop-ins, web-OK, permissive/AGPL code:** Glorious (3 generations; write-only), Endgame Gear (8K/4K/WE; Janlhin GPL-3.0 as second source), Pulsar main family, Lamzu (Maya X/Inca/Atlantis), WLMouse, VAXEE, Ninjutso, Finalmouse ULX, G-Wolves, SteelSeries (rivalcfg models; write-only; 50 ms pacing), HyperX Haste gen 1, Cooler Master MM711, ASUS legacy family + Omni receiver, **Razer classic 90-byte family** (needs bridge on Windows Chrome ≥ 153), Zowie detect-only + button-combo guide | OM (AGPL), rivalcfg (WTFPL), libratbag (MIT) | S each |
| **M2** | **Compx report-8 catalogue widening** (SYNQ already speaks it): the 199-model ATK/VXE/MAD catalogue, VGN `vgn-y2`/`vgn-f1-pm` (`3554`/`391D`), G-Wolves XVI-0 (8K receiver `3854`), GravaStar Mercury; per-sensor DPI codecs | OM catalogue + SYNQ `atk-protocol.ts` | S–M |
| **M3** | **Vendor-web new generations:** Razer V4 / Synapse Web models (+ 64-byte framing), Corsair Web Hub `2Bxx` mice (Bragi 1.5 session), ASUS Gear Link modern mice (`51 31` index map), Pulsar vMouse/ZywOo, Darmoshark + Keychron mice (Launcher protocols), Lamzu 37B0/LM20 models, Finalmouse SLX | vendor bundles (docs-only), OM | M |
| **M4** | **Bridge-only and long tail:** Attack Shark `1D57` (desktop-only on Windows; MIT code) and `25A7`, ROCCAT legacy (roccat-tools), Endgame Gear fourth family, Glorious Series 2 PRO high polling and O3; then **L**: HyperX Haste 2 / Saga, Turtle Beach Burst II / Kone II Air, Cooler Master MM712/731, SteelSeries gen-2 Aerox/Prime (GG captures) | mixed | M–L |

## Wave 6: Audio

| Step | Scope | Sources | Effort |
|---|---|---|---|
| **A1** | **AutoEq import**: paste or fetch `ParametricEQ.txt` by headphone name (fetch from GitHub on demand; never bundle the measurement DB) into the existing EAPO engine | AutoEq (MIT code) | S |
| **A2** | **devicePEQ dongles over WebHID** (web + desktop), in order: WalkPlay (~367 products, 11 schemes), FiiO, KT Micro (Tanchjim, Kiwi Ears, Moondrop CDSP), Moondrop, Fosi; Qudelix later (DFU in the same session; strict allowlist) | devicePEQ (0BSD); never its vendor captures | M |
| **A3** | **HeadsetControl headsets:** Arctis Nova 3P/5 (10-band PEQ), Nova 7/Pro/7+ (10-band graphic), Nova 3, Logitech G PRO X 2 (Centurion), ASTRO A50 Gen 4; also sidetone, battery, auto-off | HeadsetControl (GPL-3.0+) | S–M |
| **A4** | **Constrained fitting:** port AutoEq's optimizer (bounded least squares in TS/WASM), per-scheme realisation compensation (devicePEQ `compensation.js`), quantise-then-score, report what was dropped | AutoEq (MIT), devicePEQ (0BSD) | M |
| **A5** | Non-HID transports: JDS Labs Element IV over Web Serial / native serial (JSON); SPP/BLE devices only on demand | devicePEQ | S + transport |

## Wave 7: Lighting tab

Not deeply researched in this pass: the links below are the official entry points to verify when the wave starts.

| Step | Scope | Notes |
|---|---|---|
| **L1** | **Windows Dynamic Lighting / HID LampArray** (HID usage page `0x59`; Windows `Windows.Devices.Lights` LampArray API, <https://learn.microsoft.com/windows-hardware/design/component-guidelines/dynamic-lighting-devices>) | One standard driver for every LampArray device. Page 0x59 is not in Chromium's protected list (BRANDS §6), so web access is plausible. Interplay with Windows' own "ambient lighting" control: UNVERIFIED. |
| **L2** | **OpenRGB-derived USB HID controllers** (GPL-2.0-or-later code), reusing family drivers where they exist. This is also where the **lighting-only keyboards** from the 50-brand list land:<br>• SinoWealth 010C (AULA F75, Redragon K686), EVision (page `FF1C`, likely shared by Cherry and Legion K510), Witmod/Winbond<br>• HyperX Alloy (8 controllers), Cooler Master MasterKeys/SK/CK/MK, Turtle Beach/ROCCAT Vulcan<br>• SteelSeries Apex, Corsair Peripheral V1/V2, Logitech G<br>• Alienware AW510K/410K, A4Tech B820R, MSI Vigor GK30<br>• Das Keyboard Q (OpenRGB HID, or its documented local REST API at `localhost:27301`), ASUS Aura USB… | **Exclude RAM and GPU SMBus lighting**: it needs a kernel driver (WinRing0/inpout-style port I/O), which conflicts with SYNQ's no-driver, no-admin stance and with the user's Armoury Crate/BSOD history. |
| **L3** | **Govee**: LAN API (local UDP), cloud API (developer key), BLE | Official LAN/cloud docs from developer.govee.com (UNVERIFIED in this pass); BLE is community reverse-engineered (license check needed). |
| **L4** | **Philips Hue** (local bridge REST API v2 + Entertainment streaming; developers.meethue.com) and **Nanoleaf** (local OpenAPI with a button-press token) | Local network only; keep tokens in OS secure storage (desktop). Web build would need the desktop bridge (mixed content / Local Network Access). |

## Hardware to own or borrow for verification

"Verified" needs a maintainer with the device. Grouped so that one device verifies a whole family.

| Wave | Device(s) | Verifies |
|---|---|---|
| K1 | any Vial board; one VIA board (e.g. Keychron Q/V series); Wooting 60HE+ or 80HE; Wuque BABAO60 HE (already validated by OM) | VIA/Vial driver; Wooting reads |
| K2 | **AULA F65 or Ajazz AK820 MAX** (Sonix `0C45`); Fighting68 HE (FCC's verified board) | Sonix family; product-string identification |
| K3a | ASUS **Azoth 96 HE** or Falchion Ace 75 HE (0.01 mm units); Corsair Vanguard Pro 96 or Clipper Pro 60 HE | `magKeyUnit` handling; Bragi 1.5 keyboard path |
| K3b | **MonsGeek FUN60 or M1 V5 HE** (RY5088); Razer Huntsman V3 Pro (8KHz or HE Magnetic); DrunkDeer A75 Pro | RY family, Razer analog commands, DrunkDeer dialects |
| K4 | **MCHOSE Ace 68** + NuPhy Air75 HE / Field75 HE; any Redragon K-series HE (illumipc); RK M75 HE (SparkLink); Keychron Q1 HE / K2 HE; an RK61/RK84 (BeiYing) | `19F5` family incl. XOR variant; illumipc widening; SparkLink SDK; Keychron analog matrix; RK write-only path |
| M1 | Razer DeathAdder V3 Pro or Viper V3 Pro (Windows bridge path); Glorious Model O 2 Wireless; Endgame Gear OP1 8K; Pulsar X2 V3; Lamzu Maya X; WLMouse Beast X; VAXEE XE-S; SteelSeries Aerox 3 Wireless | OM drop-ins on SYNQ's bridge; write-only cache UI |
| M2 | a VXE R1 Pro Max or VGN F2 Master; G-Wolves HTX 8K | Compx catalogue + per-sensor DPI codecs |
| M3 | Razer Viper V4 Pro; Corsair Sabre v2/v3 Pro; ASUS Harpe II Ace or Gladius IV Ace | vendor-web new generations |
| A2–A3 | a WalkPlay scheme-11 dongle (e.g. Moondrop Dawn Pro 2 / TRN), FiiO KA17, a KT Micro DSP cable (Tanchjim One DSP), SteelSeries Arctis Nova 5 or 7 | PEQ families, compensation, headset EQ |
| L1 | any LampArray-capable keyboard or mouse | Dynamic Lighting path |

Already owned (2026-10-13): Logitech PRO X 2 DEX, ATK X1 V2 Air+, ROG Falchion Ace HFX ZywOo, a Corsair device `1B1C:0C57` (not a mouse/keyboard; UNVERIFIED role). A friend has the MAGIC-REFINER X68 HE (illumipc).

## The 50 keyboard brands, classified

See [BRANDS.md §4.20](BRANDS.md#420-the-50-keyboard-brands-classified) for evidence and IDs. Brands are split when their boards sit on several OEM families.

**(A) Covered by a running or finished wave (10 fully, 13 partly):**

| Wave | Brands it covers |
|---|---|
| **K1** (VIA/Vial + OM keyboard) | Keychron, Wooting, Drop, Womier SK75, Glorious GMMK Pro/2/Numpad, Lofree Flow 2, Durgod (QMK-flashed), NuPhy V2, RK R65/R75 Pro, Redragon K667, Epomaker QMK line, Ducky OK-HE (i-game family via the Wuque codec) |
| **K2** (FCC Sonix + AnalogSense) | AULA F65/F65M, Ajazz MAX boards, Epomaker HE80/TH line, MCHOSE Sonix boards, LEOBOG, EWEADN, CIDOO, Looting |
| **K3a** | ASUS ROG/TUF (Gear Link), Corsair `2Bxx` (Web Hub) |
| **K3b** | Razer analog, **Akko, MonsGeek, Yunzii (35 boards), Epomaker "Vendor A", Ajazz RY boards, Womier RY boards, MSI STRIKE 700 HE, Cherry RY boards, RK A72 HE, iKBC RY boards** (all RY5088), DrunkDeer |
| **Done** | ASUS Falchion Ace HFX; illumipc X68 family, which also covers Redragon HE (44 entries), Epomaker HE60 Lite and HE30 and Womier M68HE PRO through the K4b catalogue (built 2026-10-14) |

**(B) Still to plan:**

| Brand | Next step | Family / chipset | Wave |
|---|---|---|---|
| Royal Kludge (majority) | BeiYing write-only driver: **built** for System Control (desktop-only); `FF00` (web) still open | SinoWealth `258A` "BeiYing" | **K4e** (M) |
| RK M75 HE, AULA HE | SparkLink SDK (MIT): **built** (experimental until verified on a board) | SparkLink `1CA2/1CA3/1CA5` | **K4c** (S–M) |
| NuPhy V3/HE, MCHOSE gen 1, RK Gcome, new DrunkDeer | FCC MCHOSE framing (**built**; NuPhy / RK read-only, the XOR variant is undocumented) | `19F5` OEM | **K4a** (M) |
| Logitech G | RAPID: HID++ feature dump; others: lighting | HID++ | K5 (M) / L2 |
| HHKB (Pro HYBRID/Type-S) | keymap via happy-hacking-gnu (Unlicense); block its firmware update | PFU `04FE` | **K5** (M) |
| Realforce | APC + remap via RealforceControl (MIT, GX1); confirm R3/R3S | Topre `0853` | **K5** (M) |
| Lofree Flow Lite/Edge | trace the "Control HUB WEB" Key Mapper | Lofree OEM | K5 (M–L) |
| Ducky One X / Cushion / Strata, Varmilo | read the kbhub bundles (no open code) | kbhub `3233`/`3783` | K5 (L / M–L) |
| Kinesis Advantage360 | ZMK Studio over Web Serial / BLE (MIT); shares the serial transport with JDS | ZMK | after A5 (M) |
| SteelSeries Apex Pro, Corsair K70 MAX, Glorious GMMK 3 HE, Turtle Beach Vulcan II TKL Pro, MCHOSE new gen | closed HE; hardware captures | own | K5 (L) |
| HyperX Alloy, Cooler Master, Turtle Beach Vulcan, Cherry, SteelSeries Apex, Corsair legacy, Das Keyboard (local Q API), A4Tech, MSI Vigor, Redragon classic (EVision), AULA F75 (SinoWealth 010C), Alienware AW510K/410K, Legion K500/K510 | **lighting-only from OpenRGB code** (GPL-2.0+) | per brand; `FF1C` family likely shared | **L2** (Lighting tab) |
| Rapoo | probably bridge-only; no protocol | own `24AE` | backlog (detectOnly) |

**(C) Office/standard, detect-only:** HP, Apple, Microsoft/Surface, Trust, Kensington, Genius, Acer/Predator, Leopold, Filco, iKBC, Vortex, Thermaltake, Cougar, Dell (office), Lenovo (office). Exceptions are in the B table above: Alienware and Legion lighting, HHKB keymap, Realforce APC, Das Keyboard Q API, Kinesis ZMK. Laptop-internal keyboards (Alienware, Legion, Predator, OMEN) are out of scope for a peripheral app.

**Housekeeping found during classification:** OM's global filter `{2516, FF00, 1}` matches **Cooler Master keyboards** as well as the MM711 mouse. Gate the MM711 driver (and SYNQ's bridge allowlist) by PID `0101` before shipping M1.
