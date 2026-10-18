# SYNQ device brands: what exists, and how SYNQ could support it

Research snapshot: **2026-10-13**. This is research only: no device was opened, and no downloaded code was run.
Raw notes with every citation and helper script were kept in a research workspace that isn't published (`brands-research\notes\*.md`). This
file condenses them. Sibling documents: [ROADMAP.md](ROADMAP.md) (order of work) and [CAPABILITIES.md](CAPABILITIES.md) (driver/UI model).

**How to read this file**

- **Hex IDs** are USB VID/PID without `0x`. Every ID has a cited source; anything not confirmed is marked **UNVERIFIED**.
- **"OM"** is `@openmouse/protocol` 0.36.0 (npm, **AGPL-3.0-or-later**, <https://github.com/OpenMouse-Project>). It is already in SYNQ's `node_modules`, and paths like `OM razer/codec.js` are relative to its `dist/`.
- **"FCC"** is shybruh/FightingControlCenter-FCC (**GPL-3.0**, <https://github.com/shybruh/FightingControlCenter-FCC>). Its `docs/` documents the Sonix, RongYuan, MCHOSE and RK keyboard protocols.
- **License rule** (SYNQ ships AGPL code, so it is AGPL-3.0 as a whole):
  - **Code can be reused** under MIT, BSD, 0BSD, ISC, Apache-2.0, MPL-2.0 (file-level), WTFPL, EUPL-1.2 (lists AGPL as compatible), GPL-3.0(-or-later), GPL-2.0-**or-later** and AGPL-3.0.
  - **Docs-only** (read to learn, do not copy): GPL-2.0-only, no-license repos, and every vendor configurator bundle.
  - Several projects assumed to be GPL-2.0-only turned out to be **GPL-2.0-or-later** in their SPDX headers: openrazer (including the kernel driver), OpenRGB, Linux `hid-roccat`, roccat-tools, vial-gui, QMK, Keychron firmware, Solaar.
- **WebHID-OK** means the configuration channel is reachable from Chrome/Edge. The rules are in §6. In short: vendor pages and Consumer are fine; Generic Desktop mouse/keyboard collections allow **feature reports only**; System Control and the Keyboard page are blocked; on **Windows Chrome ≥ 153** a mouse collection whose feature report is undeclared vanishes (Razer).
- **Effort**:
  - **S**: reuse an existing open driver, or a tiny protocol;
  - **M**: read a vendor web bundle or port GPL code, plus a model catalogue;
  - **L**: desktop-only vendor app, no open code, hardware captures needed.

## 1. Summary table

Popularity is a rough guess (H/M/L).

**Risk** means what can go wrong when writing:
- **hi**: in-band firmware flashing, a latching bootloader, or a documented brick/wipe;
- **med**: factory-reset, calibration or pairing commands on the same channel;
- **lo**: settings only.

### 1.1 Mice

| Brand | Configurator | Open-source protocol (license) | AGPL reuse | WebHID-OK | Settings coverage | Risk | Pop. | Effort |
|---|---|---|---|---|---|---|---|---|
| Logitech (done) | desktop (G HUB) | yes: OM (AGPL), libratbag (MIT), Solaar (GPL-2.0+) | code | yes | full: stages, 8K, LOD, profiles, buttons, RGB, battery | med (flash sectors, DFU features) | H | S |
| Razer | **web** (Synapse Web β) + desktop | yes: openrazer (GPL-2.0+), OM (AGPL), OpenRGB (GPL-2.0+) | code | **no on Windows Chrome ≥153** (needs bridge); yes elsewhere | full | med (device-mode cmds) | H | S–M |
| SteelSeries | **web** (Engine for Chromebook, 4 mice) + GG | yes: rivalcfg (WTFPL), OM | code | yes | partial; **write-only** | lo | M-H | S–M |
| Corsair | **web** (Web Hub, `2Bxx`) + iCUE | partial: OM (read-only), OpenLinkHub (GPL-3.0), ckb-next (GPL-2.0-only) | code (OM/OLH), docs (ckb-next) | yes | full on Web Hub models | hi (web FW updater) | M | M |
| ASUS ROG/TUF | **web** (Gear Link) + Armoury Crate | yes: OM, libratbag (MIT), G-Helper (GPL-3.0) | code | yes | full | **hi** (in-browser OTA) | H | S–M |
| HyperX | desktop (NGENUITY) | partial: OM (Haste 1), open-pulsefire-haste (GPL-3.0) | code | yes (gen 1) | partial | lo | M-H | S (gen 1) / L |
| Turtle Beach/ROCCAT | desktop (Swarm II) | partial: roccat-tools (GPL-2.0+, pre-2018), libratbag | code | mixed (Burst Pro Air needs bridge) | partial | med | M | M / L |
| Cooler Master | desktop (MasterPlus+) | partial: OM (MM711) | code | yes | partial | lo | L-M | S / M / L |
| Zowie | none (driverless) | no | none | n/a | none (detect-only) | none | H | S |
| Glorious | desktop (CORE) | yes: OM, glorious-ctl/mxw (MIT), gloriousctl (EUPL) | code | yes | partial; **write-only** | lo | H | S |
| Endgame Gear | desktop executables | yes: OM, Janlhin web configurator (GPL-3.0), MIT tools | code | yes | full | **hi** (latching bootloader, zero-blob wipe) | M-H | S |
| Pulsar | **web** (bbb.pulsar.gg) | yes: OM, pulsar-mouse-linux (MIT) | code | yes | full | hi (WebDRV streams FW) | H | S–M |
| Lamzu | **web** (lamzu.net) | yes: OM, lamzu-cfg (MIT/Apache) | code | yes | full + magnetic | hi (web DFU) | M-H | S–M |
| Finalmouse | **web only** (Xpanel) | yes: OM | code | yes | full + TMR analog | med (Web Serial bootloader) | M | S |
| Ninjutso | **web** (NinjaForce) | yes: OM, ninjutso-rs (GPL-3.0) | code | yes | full | lo | M | S |
| ATK/VXE/MAD/VGN (ATK done) | **web** (hub.atk.pro, hub.vgnlab.com) | yes: OM, SYNQ | code | yes | full | med | H | S–M |
| WLMouse | **web** (gm.wlmouse.gg) | yes: OM | code | yes | full | hi (page 0xB0 flashing) | M-H | S |
| VAXEE | **web** (URL UNVERIFIED) | yes: OM | code | yes | full (small set) | lo | M | S |
| G-Wolves | **web** (mouse.xyz / mouse.fit) | yes: OM | code | yes | full + magnetic | hi (page 0xB0) | M | S–M |
| Darmoshark | **web** (darmoshark.cc, a Keychron Launcher clone) | partial: OM Keychron/Orbital | code | yes | full | hi (report 0xB2 FW) | M | M |
| Attack Shark | desktop (Core) + qmk.top | yes: OM, several MIT repos | code | **`1D57` needs bridge on Windows**; rest yes | partial–full | med | H | L overall (S per sub-family) |

### 1.2 Keyboards

| Brand / family | Configurator | Open-source protocol (license) | AGPL reuse | WebHID-OK | Settings coverage | Risk | Pop. | Effort |
|---|---|---|---|---|---|---|---|---|
| ASUS HE / Azoth (HFX done) | **web** (Gear Link) + AC | SYNQ's own captures | own | yes | full HE | **hi** (web OTA, calibration) | M-H | S–M |
| illumipc / Witmod family (X68 done) | **web** (illumipc.com) | own; OpenRGB Witmod/Winbond (GPL-2.0+) for lighting | code | yes | full HE | med | H (Redragon) | S |
| Wooting | **web** (wootility.io) + desktop | yes: SDKs (MPL-2.0), d0da (GPL-3.0), OM-kb (AGPL, read-mostly) | code | yes | full HE | med (KEYS_OFF lockout, bootloader) | H | S–M |
| Razer analog/HE | **web** (Synapse Web, new models) + Synapse | partial: openrazer (RGB), universal-analog-plugin (MIT, read) | code (partial) | yes (page 0x0C) | full HE (from JS) | med | H | M |
| SteelSeries Apex Pro | desktop (GG) | no (RGB only in OpenRGB) | RGB code only | plausible | none yet | unknown | H | **L** |
| Corsair HE/MGX | **web** (Web Hub, `2Bxx`) + iCUE | partial (OM Bragi framing) | code (partial) | yes | full HE (from JS) | hi (FW in Web Hub) | M-H | M / L |
| Logitech G PRO X TKL RAPID | desktop (G HUB) | partial (HID++ transport) | code | yes | needs a feature dump | lo | M | M |
| QMK / VIA / Vial (generic) | **web** (usevia.app, vial.rocks) | yes: QMK (GPL-2.0+), VIA app/defs (GPL-3.0), Vial (GPL-2.0+) | code | yes | keymap, macros, lighting, Vial extras | lo (0x0B bootloader jump) | H | S–M |
| Keychron (+Lemokey) | **web** (Launcher) | yes: Keychron QMK fork (GPL-2.0+) | code | yes | full HE | med (0xAA/0xAB, calibrate) | H | S–M |
| NuPhy | **web** (nuphy.io) | partial: V2 is VIA; V3/HE use FCC's MCHOSE framing | code (partial) | yes | full | hi (web FW, XOR session) | H | S / M–L |
| Akko/MonsGeek (RongYuan RY5088) | **web** (app.monsgeek.com) | yes: sharkfin (GPL-3.0, 1389 boards), FCC | code | yes | full HE | med (0x7F/0xAC) | H | M |
| DrunkDeer | **web** (Antler) | yes: MIT / Apache / AGPL tools | code | yes | full HE | hi (0xF9 FW) | M-H | M |
| MCHOSE | **web** (MCHOSE HUB) | yes: FCC | code | yes | partial (no DKS/SOCD yet) | med | M | S–M |
| Madlions | **web** (URL UNVERIFIED) | partial (MIT analog read) | docs | yes | unknown | lo | M | M |
| Ducky / Varmilo (kbhub) | **web** (duckyhub.io, varmilo.kbhub.org) | no | docs | yes | unknown | hi (One X OTA) | M-H | L / M–L |
| Royal Kludge | **web** (drive.rkgaming.com, multi-OEM) | yes: FCC, KludgeKnight, Rangoli (GPL-3.0) | code | legacy System Control channel: **no**; vendor `FF00` channel: yes | partial; **write-only** | med | H | S–M |
| AULA / Ajazz / Sonix family | **web** (VTER/driveall, magnet.aulastar.com) | yes: FCC; OpenRGB (GPL-2.0+) lighting | code | yes | full HE | med | H | S–M |
| Epomaker | **web** (hub.epomaker.com, multi-family) | via families | code | yes | via family | med | M | S (catalogue) |
| Wuque / "i-game" family | **web** (drives-hid) | yes: OM-kb (AGPL; BABAO60 HE validated) | code | yes | full HE | med (group 8 FW) | M | S–M |
| SparkLink family (RK M75 HE, AULA HE, Kochi) | **web** | yes: vendor SDK (MIT), AureTrix (MIT) | code | yes | full HE | med | M | S–M |
| HHKB (Pro HYBRID / Type-S) | desktop (Keymap Tool) | yes: happy-hacking-gnu (**Unlicense**) | code | likely (UNVERIFIED) | keymap | med (that tool can flash) | M | M |
| Realforce (R3/R3S/GX1) | desktop (REALFORCE CONNECT) | yes: RealforceControl (**MIT**, GX1 only) | code | likely (`FF00:1`) | APC actuation + remap | med (flash save/restore) | M | M |
| Kinesis Advantage360 (ZMK) | web (ZMK Studio) + GitHub builds | yes: ZMK / ZMK Studio (MIT / Apache-2.0) | code | **no** (USB serial + BLE GATT, not HID) | keymap / layers | lo | L-M | M (+ serial transport) |
| Lofree Flow Lite / Edge | **web** (lofree.tech "Control HUB WEB") + desktop | no (Flow 2 is VIA) | docs | yes | remap / macros | med (OTA path) | M | M–L |
| Glorious GMMK 3 / HE (CORE firmware) | desktop (CORE) | no (GMMK Pro/2/Numpad on QMK are VIA) | none | unknown | full HE in CORE | unknown | H | L |
| Lighting-only keyboard cluster (HyperX Alloy, Cooler Master, TB Vulcan, Cherry, SteelSeries Apex, Corsair legacy, Logitech G, Alienware, Legion, Das Keyboard, A4Tech, MSI Vigor) | desktop apps | yes: OpenRGB (GPL-2.0+), alienfx-tools (MIT), Das Q API docs (Apache-2.0) | code | mostly yes (vendor pages) | lighting only | lo | H | M (Lighting tab) |

### 1.3 Audio

| Brand / family | Configurator | Open-source protocol (license) | AGPL reuse | WebHID-OK | EQ coverage | Risk | Pop. | Effort |
|---|---|---|---|---|---|---|---|---|
| AutoEq (presets) | web (autoeq.app) | yes: **MIT** code; measurement-data terms UNVERIFIED | code (fetch data, don't bundle) | n/a | about 6000 headphone presets | none | H | S |
| WalkPlay dongles (~367 products) | **web** (peq.szwalkplay.com) | yes: devicePEQ (**0BSD**) | code | yes | 5–10 band PEQ, 1 slot | med (flash every push; 0xFF upgrade) | H | M |
| Moondrop | **web** + Android | yes: devicePEQ | code | yes | 5–9 bands | med | H | M |
| FiiO | **web** (fiiocontrol.fiio.com) | yes: devicePEQ | code | yes | 5–31 bands, 10 user slots | med (reset cmds) | H | M |
| Qudelix 5K | Chrome extension | partial: devicePEQ protocol notes (0BSD) | code/docs | yes (USB) | 10/20 bands, 10 presets | **hi** (DFU in the same session) | M-H | M |
| KT Micro (Tanchjim, Kiwi Ears, Moondrop CDSP) | phone app | yes: devicePEQ | code | yes | 5 bands | med | M | S–M |
| JDS Labs Element IV | web (core.jdslabs.com) | yes: devicePEQ | code | **no** (Web Serial, not HID) | 12 bands, 10 profiles | lo | M | S + a serial transport |
| SteelSeries Arctis Nova | desktop (GG) | yes: HeadsetControl (**GPL-3.0+**) | code | likely (`FFC0`) | 6/10-band graphic; 10-band PEQ on Nova 3P/5 | lo | H | S–M |
| Logitech G PRO X 2 / ASTRO A50 Gen 4 | desktop (G HUB) | yes: HeadsetControl | code | likely | 5-band | lo | M | M |
| HyperX headsets | desktop (NGENUITY) | partial: HeadsetControl (no EQ) | code (non-EQ) | likely | sidetone/battery only; use EAPO for EQ | lo | H | L for EQ |
| Razer headsets | desktop (Synapse) | no | none | unknown | — | — | H | L |
| Jabra | Jabra apps | — | — | **no**: Chromium blocklists `0B0E` page `FF00` output report 5 | — | — | M | n/a |

Model-number details, IDs and sources are in §3–§5. Shared OEM firmware families are in §2. The 50-brand keyboard list (A/B/C classification) is in §4.20.

## 2. Shared OEM firmware families (read one, support many)

Brands buy firmware from a handful of ODMs. **The protocol follows the firmware family, not the logo.** VIDs are often the ODM's or the chip vendor's, and **the PID often does not identify the model**. SYNQ should build one driver per family with a per-family catalogue.

### 2.1 Mouse families

| Family | Framing | VIDs / brands | Model identity | Open code | Web tool(s) |
|---|---|---|---|---|---|
| **Compx "report-8" EEPROM** | report 0x08, 16 bytes `[cmd][status][addr16][len][data×10][chk]`; bytes + report id sum to 0x55; read 0x08 / write 0x07 | ATK + VXE + MAD `373B`, `3554`; VGN `vgn-y2`/`vgn-f1-pm` (`3554`, `391D`); G-Wolves XVI-0 (`33E4`, receiver `3854`); Pulsar main (`3710`, receiver `3554:F40A`); Lamzu Atlantis; GravaStar Mercury; Teevolution; Endgame Gear WE series | CID/MID (0x10; Pulsar uses the 0x01 challenge), receiver handshake | SYNQ `atk-protocol.ts`; OM `atk/`, `vgn/`, `pulsar/`, `gwolves/` | hub.atk.pro, hub.vgnlab.com, bbb.pulsar.gg, controlhub.top/gravastar, mouse.fit |
| **Compx 64-byte page-command ("DriverCore")** | feature report 0, 64 bytes `[status A0/A1/A2/A3][..][target][len][page][cmd]`; read = cmd\|0x80; **bootloader page 0xB0** | WLMouse `36A7`; G-Wolves XVI-1 `33E4`; Lamzu `373E`/`37B0`; CRDRAKO, LunaFury, Vancer/Arbiter, Attack Shark R-series, RAWM on `373E`; very likely Glorious core2 (inferred from the identical envelope) | PID; receiver query (WLMouse 0x8B) | OM `compx/codec.js`, `wlmouse/`, `lamzu/`, `gwolves/` | gm.wlmouse.gg, mouse.xyz, lamzu.net (title "DriverCore"; device table `Config/env-models.json`, which also lists **bootloader PIDs**) |
| **Keychron Launcher mice** | "8k" `FFC1` (reports B3/B5); "1k" `0x8C` (feature 0x51/0x52); "4k" Nordic DMS `FF0A` | Keychron `3434`, **Darmoshark** (white-label; its API is `launcher.keychron.com`), Orbital | PID (server config) | OM `keychron/`, `orbital/` | launcher.keychron.com, darmoshark.cc |
| **GearHub (MicLink/mlzn, qmk.top)** | GearHub-V5 | `3151` (Attack Shark R2/R3, Lingbao); Areson `25A7` "MU class" (Attack Shark X3/X8, Pulsar X2 gen 1) | device id | OM `gearhub/`, `attackshark/` | qmk.top |

### 2.2 Keyboard families

**Brands per family:**

1. **QMK/VIA raw HID:** Keychron/Lemokey, NuPhy V2, Wuque VIA boards, Womier SK75, Epomaker QMK line, RK R65/R75, Pulsar `/nKey` and ZywOo, about 2000 VIA IDs.
2. **RongYuan RY5088 (+ YiChip YC3121):** MonsGeek, Akko, Attack Shark, EWEADN, Ajazz, Hator, XinMeng, VKMS, FL·Esports, MageGee, Epomaker "Vendor A", Gamakay, Skyloong, VGN, **YUNZII (35 boards, mechanical too)**, Cherry, Keydous, ikbc, NOPPOO, MEETION, Kreo, Royalaxe, **Womier**, **MSI STRIKE 700 HE**, RK A72 HE.
3. **Sonix "VTER / driveall.cn":** AULA (F65/F65M), Ajazz (AK820 MAX, AK680 MAX, AK980), EWEADN, LEOBOG, CIDOO, Looting, Epomaker HE80/TH line, Fighting68 (about 135 boards).
4. **"`19F5`" OEM (RK calls it "Gcome"; MCHOSE "glw" firmware):** **NuPhy V3/HE**, **MCHOSE gen 1**, **newer DrunkDeer**, **RK K99 / R87Pro V2 / R98Pro GT / T87 / T98**.
5. **illumipc / Witmod (Nuvoton/Winbond):** MAGIC-REFINER X68 HE, **Redragon (44 entries)**, Epomaker HE60 Lite, Womier M68HE PRO, VL68, ATOM HE68.
6. **"i-game" / drives-hid:** **Wuque Studio** (BABAO, ZOOM HE), **Ducky OK-HE**, unnamed white-label boards.
7. **SparkLink / PlayJoy:** **RK M75 HE** and C-series, **AULA HE** (WIN60 HE PRO/MAX, magnet.aulastar.com), Kochi Hummingbird 68, AureTrix-compatible boards.
8. **SinoWealth "BeiYing" (BYK):** **Royal Kludge** non-HE majority (RK61/68/84/M75/R65…, 314 RK entries), AULA F75/F87 Pro/F99, LEOBOG Hi75C Pro, Redragon K686 Eisa Pro.
9. **EVision (rebranded Sonix):** classic Redragon K55x/K6xx RGB, some Glorious, Ajazz, Tecware.
10. **kbhub.org:** Ducky One X / Cushion / Strata, Varmilo.
11. **0x55 Gcome sibling labels in RK's bundle** (HangSheng `342D`, JuPeng `0603` Novatek, QiWang `0F62` Acrox, Bytech `372E`): a handful of RK models each.

Single-brand protocols: Wooting `31E3`, Razer `1532`, Corsair Bragi `1B1C`, ASUS Gear Link `0B05`, DrunkDeer `352D`, Logitech HID++, SteelSeries `1038`.

**Protocol details per family:**

| # | Family | Channel | Framing | VIDs | Model identity | Open code (license) | Web tool |
|---|---|---|---|---|---|---|---|
| 1 | QMK/VIA raw HID | `FF60:61`, 32 B in/out | VIA ids 0x01–0x15; vendor extensions (Keychron 0xA0–0xAB, Madlions custom values); Vial `FE` prefix | any (Keychron `3434`, Lemokey `362D`, Madlions `373B`, RK `342D`…) | VID:PID + VIA JSON; Vial: layout JSON (xz) in firmware | QMK GPL-2.0+, VIA GPL-3.0, Vial GPL-2.0+, Keychron fw GPL-2.0+, libhmk GPL-3.0 | usevia.app, vial.rocks, Launcher |
| 2 | RongYuan RY5088 + YiChip YC3121 | `FFFF:02`, 64 B **feature** | `[cmd, p1–6, chk = 255 − sum, data]` | `3151` (most), `38EE`, `374A`, `379A`, `39AB`, `046A` | **0x8F model id + fw; 0xE6 precision** (PID shared) | **sharkfin GPL-3.0**, **FCC GPL-3.0** (TS), ry5088-flasher MIT | app.monsgeek.com, qmk.top, vendor hubs |
| 3 | Sonix VTER / driveall.cn | `FF68:61`, 64 B out/in | `[0xAA, cmd, len, off16, 0×3, 56 B]` | `0C45` (Sonix/Microdia), borrowed `05AC:024F` dongles | **USB product string** (PIDs shared) | FCC GPL-3.0 | VTER / driveall.cn, magnet.aulastar.com, hub.epomaker.com |
| 4 | "`19F5`" OEM | Generic Desktop `0001:0000`, 64 B; upgrader PIDs on `FF00:01` | `[0x55, cmd, 0, chk, len, off16, 0, data]`, reply 0xAA; **newer fw XOR-masks with a session key** | `19F5`, `41E4`, `3837` | per-model PID | FCC MCHOSE driver GPL-3.0 | nuphy.io, MCHOSE HUB, drunkdeer.keybord.net.cn, drive.rkgaming.com |
| 5 | illumipc / Witmod | `FF1B:91`, 63 B id 1 (SYNQ docs) | SYNQ `x68he-protocol.ts` | `2E3C` (~260 boards on `C365`), `0416` (Winbond/Nuvoton), `17EF`, `117F`, `34D3` | product code (cmd 0x0D) | **SYNQ's own**; OpenRGB Witmod + Winbond controllers (GPL-2.0+) | illumipc.com ("Redragon Web Driver") |
| 6 | "i-game" / drives-hid | `FFB0:01` (alt `FF80`), 64 B `[group, sub]` | groups 1–18; group 8 = firmware | `1CA6` (247 PIDs), `36B5`, `38A6`, `1A86`, `391D`, `371C`, `3806` | VID:PID | **OM-kb AGPL** (Wuque codec) | drives-hid.wuquestudio.cn, ok-he.i-game… |
| 7 | SparkLink / PlayJoy | `FFA0:01` | vendor SDK | `1CA2`, `1CA3`, `1CA5` | SDK | **@sparklinkplayjoy/sdk-keyboard MIT**, AureTrix MIT | magnet.aulastar.com, RK, AureTrix |
| 8 | SinoWealth "BeiYing" (BYK) | wired `FF00:01` (RK web driver); legacy tools use **System Control `0001:0080` feature 0x0A** | write-only | `258A` (+ `3554` dongles) | PID | FCC, KludgeKnight, Rangoli (GPL-3.0); OpenRGB 010C (GPL-2.0+) | drive.rkgaming.com |
| 9 | EVision (rebranded Sonix) | `FF1C` | 0x01/0x02/0x06/0x10/0x11 | `0C45`, `320F` | PID | OpenRGB EVision (GPL-2.0+), lighting + polling | desktop apps |
| 10 | kbhub.org | `0x008C` | UNVERIFIED | Ducky `3233`, Varmilo `3783` | UNVERIFIED | none | duckyhub.io, varmilo.kbhub.org |

**Family 8 web note:** the legacy System Control channel is blocked in Chrome. RK's own web driver uses `FF00`, which is reachable.

**Takeaways:**

- With **sharkfin + FCC** (both GPL-3.0, both runnable in the browser), families 2–4 are mostly porting work, not reverse engineering.
- Brand web hubs are often **multi-family routers**. RK's bundle tags every board with `protocolType` (BeiYing / SparkLink / Gcome / RongYuan / QMK / Bytech / HangSheng / JuPeng / QiWang), and Epomaker's hub with `vendor`. These tags are the cheapest way to build catalogues.
- **A retail name is not a device.** "Womier M68 HE" exists on RY5088, illumipc *and* Sonix. SYNQ must identify by VID/PID plus a firmware query, never by name.

## 3. Mice

### 3.1 Logitech (already supported)

- **Identity:** VID `046D`. HID++ on vendor page `FF00` (Bluetooth: `FF43`). Model = receiver PID + device index, then HID++ 2.0 feature discovery, device name (0x0005) and firmware info (0x0003). OM handles Unifying, Lightspeed and Bolt.
- **Configurator:** G HUB and the Onboard Memory Manager (desktop). No web configurator found.
- **Open source:**
  - OM `logitech/` (AGPL-3.0-or-later), already in SYNQ;
  - libratbag (MIT, <https://github.com/libratbag/libratbag>);
  - Solaar (GPL-2.0-or-later headers, <https://github.com/pwr-Solaar/Solaar>).
- **Settings:**
  - DPI 0x2201/0x2202 and report rate 0x8060/0x8061, up to 8K;
  - onboard profiles 0x8100: stages, buttons, lighting, rate, per-stage LOD;
  - RGB 0x8071, hi-res wheel 0x2121, battery 0x1000/0x1004;
  - analog buttons 0x1B0C on the PRO X2 SUPERSTRIKE (OM implements it).
- **WebHID:** good (`FF00` is a vendor page). OM already runs it in Chrome.
- **Safety:**
  - Block HID++ features 0x00C0–0x00C3 (DFU control), 0x00D0 DFU, 0x010A, 0x1800 test, 0x1802 reset, 0x1805 OOB state, 0x1806 config props, 0x1E00 hidden features, 0x1F20 ADC.
  - Put receiver pairing registers (0xB2) behind an explicit action.
  - Onboard-profile writes are full flash sectors with CRC. Back up the sector first (SYNQ already does).
  - DFU wire protocol unknown; OM says flashing wrong bricks.
- **Popularity / effort:** High / **S**. Next steps are the allowlist, a fuller onboard-profile editor, and the G PRO X TKL RAPID keyboard (§4.5).
- **Sources:** OM `drivers/vendors.js`, `logitech/`, `drivers/logitech/dfu.js`; Solaar `hidpp20_constants.py`; <https://support.logi.com/hc/en-ca/articles/360057433714>.

### 3.2 Razer

- **Identity:** VID `1532`. The model is identified **only by PID**; the protocol is not self-describing, so a per-PID table is needed (OM `razer/devices.js`, about 107 products). Wired and wireless have separate PIDs (Viper V3 Pro `00C0/00C1`, DeathAdder V4 Pro `00BE/00BF`, Viper V4 Pro `00E5/00E6`).
- **Transaction id per PID:** `FF`, `3F` or `1F`. It does not follow family or age, and a wrong id gets silence. Button writes on the Viper V3 Pro need `10`.
- **Report:**
  - classic: 90-byte feature report, id 0: status, transaction id, remaining, protocol, size, class, id, args[80], XOR CRC of bytes 2..87 at byte 88;
  - newer modules: a 64-byte framing (rolling id, 24-bit length). UNVERIFIED which mice use it.
- **Configurator:** Synapse 4 (desktop) and **Synapse Web Beta, <https://synapse.razer.com/dashboard>**.
  - WebHID confirmed: `requestDevice({filters:[{vendorId:0x1532, productId, usagePage}]})`, no `usage`. The usage page comes from a server device config (0x01 and 0x0C for mice; 0x0C for keyboards).
  - Synapse Web device list (2026-10-13):
    - mice: Viper V4 Pro, DeathAdder V4 Pro (+ Carbon Fiber), DeathAdder V4 HyperSpeed, Viper V4 HyperSpeed (decimal PIDs 45061/45063 = `B005/B007`, a new range);
    - keyboards: Huntsman V3 Pro family, Blade laptops.
  - Firmware is not flashed in the browser: the page links out to a desktop CFU updater.
- **Open source:**
  - openrazer: kernel driver and daemon are **GPL-2.0-or-later** (SPDX headers; `MODULE_LICENSE("GPL v2")` is the kernel's own string). It is the best PID / transaction-id / command reference. <https://github.com/openrazer/openrazer>
  - OpenRGB Razer (GPL-2.0-or-later, lighting only).
  - OM `razer/` (AGPL): codec, V4 framing, Cobra/Viper/Viper Mini/V4 Pro drivers. Status: 14 supported, 68 likely.
- **Reuse:** code (OM, openrazer, OpenRGB). Synapse Web JS is docs-only.
- **Settings:**
  - DPI up to 5 stages with X/Y;
  - polling with the legacy ÷1000 or extended ÷8000 command, plus HyperPolling 8K dongle pairing;
  - wireless polling;
  - LOD with asymmetric lift/land, smart tracking and surface calibration, dynamic sensitivity, sensor rotation;
  - debounce;
  - scroll mode, auto-sleep / low power, tournament mode;
  - buttons, HyperShift, macros, Chroma, battery;
  - factory reset.
  - Motion sync: not found (UNVERIFIED).
- **WebHID: platform-dependent.**
  - The control channel is feature report 0 on the **Generic Desktop Mouse collection (0x01/0x02)** for most models.
  - Chromium protects only input/output reports there, but **Chrome 153 on Windows** fixed an `IsAlwaysProtected` bypass (crbug 536063911, between 152.0.7977.83 and 153.0.8010.37). Since then every Razer mouse gets `Access is denied` on Windows Chrome, so SYNQ reaches Razer through its desktop bridge (SYNQ Helper).
  - Works on macOS, Linux and ChromeOS, and on the desktop app via hidapi.
  - Razer keyboards on page 0x0C are not affected.
- **Safety:**
  - Set Device Mode (class 0x00 id 0x04): allow only 0x00 normal and 0x03 driver. Block 1 bootloader, 2 test, 4 download, 8 RF test, 9 retail.
  - Block Set Device Reset 0x00/0x0B, Set Serial 0x00/0x02, profile reset/delete (class 0x05), all calibration writes, factory reset.
  - Put HyperPolling pairing behind an explicit action.
  - Default-deny unknown classes.
- **Popularity / effort:** High / **S** for the classic 90-byte family (port OM), **M** for V4 / 64-byte framing and the Windows bridge path.
- **Sources:** <https://synapse.razer.com/dashboard> (AvailableDevices.json, per-product `main.js`); OM `razer/*`, `drivers/vendors.js`; openrazer `driver_razercommon.h`; <https://issues.chromium.org/issues/536063911>.
- **UNVERIFIED:** VID of the `B00x` PIDs, motion sync, factory-reset and bootloader bytes, which mice use the 64-byte framing.

### 3.3 SteelSeries (mice)

- **Identity:**
  - VID `1038`, models identified by PID only. Wired and 2.4 GHz modes have separate PIDs (Aerox 3 Wireless `183A`/`1838`).
  - **A firmware update can change the PID** (Rival 3 `1824` becomes `184C` after fw 0.37).
  - The only identity query is a 2-byte firmware version.
- **Configurator:** GG/Engine (desktop) and **SteelSeries Engine for Chromebook, <https://engineforchromebook.steelseries.com/>**.
  - WebHID confirmed, whole-device `{vendorId, productId}` filters.
  - Covers Rival 3 (`1824`/`184C`), Rival 3 Wireless `1830`, Aerox 3 `1836`, and Aerox 3 Wireless (`1838`/`183A`, plus VID `0111` = Bluetooth? UNVERIFIED).
- **Open source:**
  - **rivalcfg (WTFPL)**, about 40 mice, <https://github.com/flozz/rivalcfg>;
  - OM `steelseries/` (AGPL, transcribed from rivalcfg; 10 supported);
  - OpenRGB (lighting).
- **Reuse:** code (WTFPL, AGPL). The Chromebook PWA is docs-only.
- **Settings:**
  - CPI 1–5 stages (up to 18K on TrueMove Air), polling 125–1000 Hz on the covered mice;
  - buttons, RGB zones, sleep/dim, LOD on some, battery.
  - GG-only (newer gen-2): angle snap, accel/decel, 2K–8K (UNVERIFIED).
  - **Most settings are write-only** (no read-back). A save command is needed (`09 00` Rival 3, `11 00` Aerox).
  - Pace commands 50 ms apart (a mouse crashed when driven faster).
- **WebHID:** good. Output reports on vendor page `FFC0`, interface 3.
- **Safety:** no firmware opcodes in open code. Allowlist only the rivalcfg bytes per family and enforce the 50 ms pacing.
- **Popularity / effort:** Med-High / **S–M** (S for rivalcfg models, L for 2025+ models, which need GG captures).
- **Sources:** OM `steelseries/*`; rivalcfg LICENSE/README; <https://steelseries.com/blog/how-to-use-steelseries-mice-with-chromebook-1045>.

### 3.4 Corsair (mice)

- **Identity:** VID `1B1C`. Three generations:
  1. **NXP legacy:** 64-byte feature reports on `FFC2`:4.
  2. **Bragi:** 64-byte output reports on `FF42`. Request `[0x08|slot][cmd][prop]…`; cmd 01 set / 02 get / 05–0D handles. Properties include 0x01 poll, 0x07 angle snap, 0x0F/0x10 battery, 0x1E/0x1F DPI index/mask, 0x21/0x22 DPI X/Y. SLIPSTREAM receivers relay slots 1–7.
  3. **Bragi 1.5 with host session control:** a random 4-byte header becomes a session id in byte 2 of every report.
- **Model identity:** PID, or Bragi property 0x12 through the receiver.
- **Configurator:** iCUE (desktop) and **CORSAIR Web Hub, <https://www.corsair.com/web-hub/index.html>** (WebHID confirmed).
  - It covers the new `2Bxx` PID range:
    - mice: Sabre v2 Pro family (`2B25/2B28/2B29`, dongles `2B2A/2B34/2B35`), Sabre v3 Pro family (`2B3F–2B45`), Scimitar Elite Wireless SE `2B22`, Nightsword V2 Wireless `2B1C`, Harpoon V2 `2B2E/2B33`;
    - receivers: SLIPSTREAM `2B00/2B1B/2B3C/2B42`.
  - Older `1Bxx` devices are iCUE-only.
  - Users must close iCUE first.
  - **CORSAIR Web FW Updater** (<https://www.corsair.com/firmware-updater/index.html>) flashes over WebHID.
- **Open source:**
  - OM `corsair/` + `bragi` (AGPL; Ironclaw read-only, 1 supported);
  - **OpenLinkHub (GPL-3.0, Go, very active)**, <https://github.com/jurkovic-nikola/OpenLinkHub>;
  - OpenRGB Corsair V2 (GPL-2.0-or-later);
  - **ckb-next (GPL-2.0, no "or later" seen, so docs-only)**, <https://github.com/ckb-next/ckb-next>.
- **Settings:** DPI stages (step 20 on some), polling index 0–6 up to 8K wired, sleep, angle snap, LOD, surface / OmniSense calibration, key assignment and macros, lighting, 5 onboard profiles, game mode.
- **WebHID:** good (vendor pages `FFC2/FF42/FF01/FF02`).
  - Never leave a Bragi device in software mode (property 0x03 = 2). It stops applying onboard settings.
  - Windows delivers input reports to every handle, so iCUE can steal replies.
- **Safety:**
  - NXP: block `FIELD_RESET 0x02` (esp. `0xAA` bootloader), `FW_START 0x0C`, `FW_DATA 0x0D`.
  - Bragi: allow write-data only to known resources. Never touch resources 0x05 PAIRINGID / 0x06 ENCRYPTIONKEY. Default-deny unknown properties.
  - Never call the Web FW Updater flow. Put calibration behind explicit UI.
- **Popularity / effort:** Med / **M** for Web Hub `2Bxx` mice, **M–L** for older iCUE-only mice (OpenLinkHub code helps).
- **Sources:** Web Hub `assets/BDiHBs-c.js`; FW updater `fwupd-config.js`; ckb-next `bragi_proto.h`/`nxp_proto.h`; OM `corsair/*`.

### 3.5 ASUS ROG / TUF (mice)

- **Identity:**
  - VID `0B05`. Models by PID.
  - Gear Link manifest per PID: `https://gearlink.asus.com/view/<decimalPID>/manifest.json`, with `deviceType`, `productNumber`, `connectionType`, `hidPattern`, `firmwareUpdateMethod`.
  - `hid-whitelist.json` lists 99 PIDs.
  - Receivers list their paired devices: Omni `1ACE`, SpeedNova 8K `1AD0`.
- **Gear Link mice:** Harpe Ace Aim Lab `1A92/1A94`, Keris II Ace `1B16/1B18`, Harpe Ace Mini/Extreme, Keris II Origin, Harpe II Ace (+Mini), Gladius III Core, Gladius IV Ace (+Max), Spatha X 65K, ProArt MD301.
- **Configurator:**
  - Armoury Crate: **never touch it** (user rule after a BSOD).
  - **ASUS Gear Link, <https://gearlink.asus.com>**: WebHID, VID+PID filters, control pages `FF00/FF01/FF02` usage 1, events `FFC0–FFC2`.
  - Framing `[cmd, sub, idxLo, idxHi, payload]`. Mouse block `51 31 <idx>`: stages, polling 4, debounce 5, angle snap 6, motion sync 18, sensor mode/FPS 19. `51 35`: calibration / asymmetric LOD / glass. Profiles `50 02/03`, save `50 55`.
  - **The same transport as SYNQ's Falchion driver.**
- **Open source:**
  - OM `asus/` (AGPL; Gladius II verified, Omni receiver);
  - libratbag (MIT; device files for Chakram, Keris Wireless, Spatha X, TUF M4…);
  - G-Helper (GPL-3.0);
  - OpenRGB (GPL-2.0-or-later, lighting).
- **Settings:** 4–5 stages, step 50 (1 on some models), X/Y; polling to 8K; debounce; angle snap and tuning; motion sync; sensor mode; LOD with asymmetric option, calibration and glass; buttons/macros; lighting; 5 profiles; battery/idle/power saving.
- **WebHID:** good (vendor pages). Add `usagePage`/`usage:1` to filters; Gear Link uses VID+PID only.
- **Safety:** **Gear Link flashes firmware in the browser** (`ota/main.js`).
  - Block the app→boot jump `7B AA 41 53 55 53 AA`, `ENTER_BOOT 7F 55 AA 55 AA`, and the bootloader opcodes (INIT with `ASUSHIDFWU`, SET_ADDR, SET_LEN, LEAVE, CHECKSUM).
  - Block `B0 00` reset, `50 40` reset all profiles, `52 02`, `51 35 00` and `80 27` calibration, and demo mode `12 12`/`51 41-42`.
  - Put `A2 01` unpair behind a confirmation.
  - Never open bootloader PIDs (`1948, 194A, 1AAF, 1ACF, 1AD1, 1C11, 1C6A, 1C7E, 1CAD, 1D4D, 1D69, 1D6D`) or `hidPattern 3` entries.
- **Popularity / effort:** High / **S–M** (one ASUS driver could cover about 99 PIDs across mice, keyboards, headsets and receivers).
- **Sources:** Gear Link `devices.js`, `hid-whitelist.json`, manifests, `view/7600` bundle, `ota/main.js`; OM `asus/*`; libratbag `data/devices`; <https://github.com/seerge/g-helper>.

### 3.6 HyperX

- **Identity:** two VIDs: `0951` (Kingston, pre-HP) and `03F0` (HP).
  - Haste gen 1: `0951:1727`, HP `03F0:0F8F/048E/028E`.
  - Older Pulsefire PIDs come from OpenRGB.
  - **Haste 2 / Saga / Fuse PIDs: UNVERIFIED.**
- **Configurator:** NGENUITY (Microsoft Store). No web configurator found.
- **Open source:**
  - OM `hyperx/` (AGPL): Haste gen 1 only, 64-byte reports on `FF00`:1. Reads 0x46/0x50–0x54; writes 0xD0 polling, 0xD3 DPI/LOD, 0xD2 LED, 0xD4 button, 0xDE save.
  - open-pulsefire-haste (GPL-3.0).
  - OpenRGB (GPL-2.0-or-later).
  - santeri3700 Dart RE (no license, docs-only).
- **Settings:** 5 DPI presets, polling (gen 1 up to 1K; Haste 2 8K), LOD 2 steps, buttons/macros, RGB, onboard memory, battery.
- **WebHID:** gen 1 good. Haste 2 protocol unknown.
- **Safety:** allowlist only the documented opcodes and block everything else.
- **Popularity / effort:** Med-High / **S** for gen 1, **L** for the Haste 2 generation (needs NGENUITY captures).

### 3.7 Turtle Beach / ROCCAT

- **Identity:** ROCCAT VID `1E7D` (Kone Pro `2C88`, Kone Pro Air `2C8E`/`2C92`, Kone XP `2C8B`, Burst Pro `2DE1`, Burst Pro Air `2CA6`, Kone AIMO `2E27`…). Turtle Beach VID `10F5`. **Burst II Air / Kone II Air PIDs: UNVERIFIED.**
- **Configurator:** Swarm II (desktop). No web configurator found.
- **Open source:**
  - roccat-tools (Stefan Achatz, headers **GPL-2.0-or-later**, pre-2018 mice only);
  - Linux `hid-roccat*` (GPL-2.0-or-later);
  - libratbag (MIT; Kone EMP/Pure/XTD);
  - OpenRGB (GPL-2.0-or-later, lighting).
  - OM: none ("driver needed"; the Kone Pro Air has 89 requests).
- **Settings:** 5 profiles, DPI to 26K, polling (8K on Burst II Air, UNVERIFIED), debounce, motion sync, DCU/LOD calibration, Easy-Shift[+] layer, macros, AIMO RGB, battery.
- **WebHID:** mixed. Kone Pro/XP and Burst Pro use `FF01` (OK). **Burst Pro Air uses Generic Desktop 0x01/0x02, so it needs the bridge.** Kone AIMO/Kova are on page `0x0B` (UNVERIFIED).
- **Popularity / effort:** Med / **M** for legacy models (roccat-tools), **L** for current Turtle Beach mice.

### 3.8 Cooler Master

- **Identity:** VID `2516`.
  - MM530 `0065`, MM711 `0101`, MM720 `0141`, MM730 `0165` (interface 1, `FF00`:1);
  - MM712 `0169` (`FF0A`:2, a different protocol);
  - MM731 and others: UNVERIFIED.
- **Configurator:** MasterPlus+ (desktop). MasterHUB is a macro-pad app, not for mice. No web configurator found.
- **Open source:** OM `coolermaster/` (AGPL; MM711 verified: handshake `41 80`, read `52`, write `51`, subcommands 40/9B/F0/10/28/2B/A8); OpenRGB (lighting).
- **Settings:** 7 stages 100–16000 step 100, polling ≤1K, debounce, buttons/macros, RGB, profiles, battery (MM712/731).
- **WebHID:** vendor pages, OK.
- **Safety:** firmware only through MasterPlus+ (a reviewer reports a hung MM712 update). Allowlist only the OM opcodes.
- **Filter collision:** OM's global filter `{2516, FF00, 1}` has no PID, so it also matches **Cooler Master keyboards** (OpenRGB registers every CM keyboard on `FF00:1`). The MM711 handshake must be gated by PID `0101`.
- **Popularity / effort:** Low-Med / **S** (MM711), **M** (MM720/730), **L** (MM712/731).

### 3.9 Zowie (BenQ)

- **Identity:** VID `04A5`, PID `8001` "BenQ ZOWIE Gaming Mouse" (usb.ids). Probably shared by many models, so the model can't be told from the PID (UNVERIFIED). Wireless models (EC-CW, ZA13-DW): UNVERIFIED.
- **Configurator:** none. Driverless by design: bottom DPI/LOD switches and a plug-in button combo for polling.
- **Open source:** none.
- **SYNQ:** **detect-only.** Show the model card and a per-model button-combo guide. **Never send anything to VID `04A5`** (shared with other BenQ/Acer products).
- **Popularity / effort:** High (CS esports) / **S**.

### 3.10 Glorious

- **Identity:** four generations on several VIDs:
  - Pixart Model O 2 / I 2 / D 2 on `093A` (`821B–832A`; shared with Ninjutso and Incott);
  - classic SinoWealth wireless on `258A` (Model O Wireless `2011` cable / `2022` receiver; three sources agree; glorious-ctl is the outlier), plus `22D4`, `320F`, `3794`;
  - core2 4K/8K PRO on `258A` (`201B/2035`, `201C/2036`);
  - V1 wired (libratbag `258A:0036/0033`).
- **Configurator:** Glorious CORE 2 (Electron desktop) and a Pairing Utility. No web configurator found.
- **Open source:**
  - OM `glorious*` (AGPL; all three wireless generations);
  - glorious-ctl (MIT), korkje/mxw (MIT), GloriousAutoPollingRate (MIT), GloriousBatteryMonitor (GPL-3.0);
  - enkore/gloriousctl (EUPL-1.2, which lists GPL/AGPL as compatible);
  - libratbag sinowealth (MIT);
  - OpenRGB Sinowealth (GPL-2.0-or-later).
- **Settings:**
  - Pixart line: DPI 100–26000 step 50, 6 stages, polling ≤1K, LOD 1/2 mm, debounce 0–16 ms even, RGB.
  - core2: polling to 8K wired / 4K wireless, debounce 4–16 ms step 2, motion sync, 3 profiles. The LOD mapping is unknown.
  - **The Pixart and classic lines are write-only**: settings go out as a 256-byte blob and cannot be read back.
- **WebHID:** OK (vendor pages `FF00/FF01/FFFF`).
  - Refuse writes to `320F` units that declare a 263-byte report (writes ACK but do nothing).
- **Safety:** CORE firmware/OTA, calibration V2 and pairing opcodes are not decoded, so allowlist only the known registers.
- **Popularity / effort:** High / **S** via OM. **M** for Series 2 PRO high polling, the O3, and read-back.

### 3.11 Endgame Gear

- **Identity:** VID `3367`.
  - 8K wired: OP1 8K `1964`, XM2 8K `1966`, v2 `1978/1980`.
  - 4K wireless: `1972/1968/1984/1982`, shared dongle `1970`.
  - WE series: `1960–1962`.
  - "Fourth family" (OP1 / OP1 RGB / XM1r): `1903/1905/1906`.
  - XM1 on `22D4:1803`.
  - **Bootloader `1977`** (OP1 8K v2).
- **Configurator:** per-model Windows executables. No web configurator.
- **2025 incident (verified):** the OP1w 4K v2 tool on the product page was trojanized with the XRed backdoor from 2025-06-26 to 2025-07-09 (<https://www.bleepingcomputer.com/news/security/endgame-gear-mouse-config-tool-infected-users-with-malware/>). This is a strong argument for WebHID tools and never shipping vendor executables.
- **Open source:**
  - OM `endgame-gear/` (AGPL; supported for 8K, 4K and WE);
  - **Janlhin/Endgame_Gear_Web_Configurator (GPL-3.0, WebHID, four families)**;
  - egctl (AGPL), vole / xm2ctl / xm2we-linux (MIT), egg-mouse (Apache-2.0, includes a flasher).
- **Settings:**
  - CPI 50–26000 step 50 (PAW3950 v2: 10–30000);
  - polling to 8K wired, 1K/2K/4K wireless plus a 125 Hz office mode;
  - LOD 0.7/1/2 or 0.7–1.7 mm in 0.1 steps; Glass Mode;
  - angle snap, ripple, motion sync, angle tune, max FPS, CPI downshift, filters;
  - SPDT switch modes, profiles, sleep.
- **WebHID:** OK:
  - 4K/8K family: `FF01`, feature 0xA0 (1024-byte blob) and 0xA1 (command);
  - WE family: `FF02` report 8, the same 0x55 framing as ATK;
  - fourth family: `FFA1` with a 32-byte passphrase.
- **Safety:**
  - Block `A1 3A` bootloader entry. **It latches**: the mouse stays in the bootloader across replugs until a full flash.
  - Block any write to PID `1977`, put `0x13` factory reset behind a confirmation, and block WE `0x07` writes outside decoded offsets.
  - **A known incident: an all-zero 0xA0 blob wiped an XM1's DPI**, so always read-modify-write.
- **Popularity / effort:** Med-High / **S** (OM + Janlhin), **M** for the fourth family.

### 3.12 Pulsar

- **Identity:**
  - Own VID `3710`. The 4K receiver is on `3554:F40A`; the first-gen X2 on Areson `25A7:FA7B/FA7C`.
  - **Model = CID/MID.** Command 0x01 is a random challenge; CID 0x57 plus about 150 MIDs map to sensor, max DPI and firmware.
  - XS-1 family: `5402/3404/5403`. Pro/ZywOo dongle: `5405`.
- **Configurator:** **"Bibimbap" WebDRV, <https://bbb.pulsar.gg/>** (WebHID confirmed). It routes to `/cMouse`, `/vMouse` (`FF05`), `/zywoo` (VIA-style `FF60:61`), `/sKey` and `/nKey` (QMK/VIA). Pulsar Fusion (desktop) is still listed.
- **Open source:** OM `pulsar/*` (AGPL; four families), pulsar-mouse-linux (MIT, active), Pulsar-X3-Web-Config (MIT), ardor-mouse (MIT).
- **Settings:** polling 125–8000; DPI 10–32000 (42000 on 3955), step 10/50/100; LOD; debounce; motion sync; angle snap; ripple; angle tune; performance state; sleep; long range; buttons/macros; DPI LED; dongle RGB/key; Pro adds wheel accel, turbo and profiles.
- **WebHID:** OK:
  - main family: output/input report 8, 16 bytes, checksum `0x55 − sum` (the Compx report-8 family, §2);
  - Pro: Generic Desktop page 1 usage **0**, which is not a protected usage.
- **Safety:** the WebDRV **streams firmware `.bin` over WebHID.**
  - Block 0x05 pair (explicit only), 0x09 ClearSetting (confirm), 0x0B SetDeviceVidPid, 0x0C SetDescriptorString, 0x0D EnterUsbUpdateMode, 0x11 EnterMTKMode, 0xF0 WriteKBCIdMID, and 0xB0/0xB1 download.
  - Allow 0x07 writes only at known flash offsets.
  - ZywOo VIA route: block 0x0B BOOTLOADER_JUMP and 0x0A EEPROM_RESET, and never open `2E3C:AF01` (assumed bootloader).
- **Popularity / effort:** High / **S–M**.

### 3.13 Lamzu

- **Identity:** three VIDs:
  - `373E` (the shared Compx ODM VID: Maya X `001C/1D/1E`; also CRDRAKO, LunaFury, Vancer, Attack Shark, RAWM);
  - `37B0` (Lamzu's own: Tachi, Inca, Maya, Paro, Thorn, Thorn V2, newer 54H20/LM20 models `002C–0056`);
  - `3554` (Atlantis `F50F/F50D/F510/F517`).
  - The vendor's `env-models.json` is the PID table, including **bootloader PIDs**. Receivers are shared, so the model is identified through the receiver.
- **Configurator:** **"LAMZU Aurora", <https://www.lamzu.net/>** (keyboards at `/kb/`). Page title "DriverCore"; WebHID confirmed.
- **Open source:** OM `compx/`, `lamzu/*` (AGPL; Maya X and Inca supported), LeadSun/lamzu-cfg (MIT OR Apache-2.0).
- **Settings:** DPI to 30000 (50000 on LM20), polling 125–1K wired and to 8K on the dongle, LOD 0.7/1/2, X/Y, 5 stages with colors, sleep 10 s–30 min, HyperMode, angle tune, motion sync, key binding, bhop, **magnetic switches** (switch type, travel, RT, calibration).
- **WebHID:** OK. 64-byte feature report 0 on `FFFF`:0 (page-command family, §2); Atlantis uses `FF02`:2 report 8.
- **Safety:** **the vendor app flashes `.hex` over WebHID.**
  - Never open bootloader identities: `373E:B01C/B01D/B01E`, `37B0:0002/0004/0006/0008/000A/0012/0018/0033/0041`.
  - Block page `0xB0`.
  - Gate magnetic calibration (page 0x03 cmd 0x07).
- **Popularity / effort:** High (niche) / **S–M**.

### 3.14 Finalmouse

- **Identity:** VID `361D`.
  - ULX: dongle `0100`, mouse `0102`. Starlight X: `0300/0301`, `0310/0311`.
  - Keyboard (Centerpiece? UNVERIFIED): `0200/0202`.
  - Bootloaders: `361D:0111` (**Web Serial**), `361D:0201`, `1FC9:0021/0022`.
- **Configurator:** **Xpanel, <https://xpanel.finalmouse.com/>**. Web only; WebHID plus Web Serial.
- **Open source:** OM `finalmouse/` (AGPL; ULX supported), small MIT tools (battery trays, polling switcher, centerpiece-companion).
- **Settings:** DPI, polling to 8K, motion sync, LOD (SLX 0.7–2.0), LED, tournament scroll, 5 named profiles, battery. **SLX TMR analog switches**: mechanical/analog mode, actuation 0.01–0.40 mm, RT 150–250 µm, calibration, live TMR.
- **WebHID:** OK (`FF00`). Firmware recovery needs Web Serial; leave that to Xpanel.
- **Safety:** never open the bootloader identities above. Block TMR calibration (cmd 27/28) except through an explicit flow.
- **Popularity / effort:** Med / **S** (ULX), **S–M** (SLX; report ids unverified), **M** (Centerpiece).

### 3.15 Ninjutso

- **Identity:** chip-vendor VIDs.
  - Legacy Sora V2: Nordic `1915:AE11–AE16`, receivers `AE1C/AE8C/AE8A`.
  - Current Sora V3 and TEN: **Pixart `093A`** (`E010`, `E020/EA01`, receivers `EB01/EB02`; NinjaForce also lists `E021/EB03`).
  - Also match on product name.
- **Configurator:** **NinjaForce, <https://www.ninjaforce.co/>** (WebHID confirmed; "Chrome and Edge only"). Firmware goes through a separate desktop Updater.
- **Open source:**
  - OM `ninjutso/` (AGPL; all `verified:false`);
  - ninjutso-rs (GPL-3.0), Sora_tray (GPL-3.0);
  - **ClickSync (GPL-2.0, no "or later" seen, so docs-only)**: a multi-brand WebHID driver, 397 stars.
- **Settings:** DPI 50–30000 step 50 (or 1–45000), stages, polling 1K–8K only, LOD, angle tune, motion sync, Hyper Click, Slam Click, optical engine mode, sleep, lighting, battery, profiles.
- **WebHID:** OK. Pin PIDs: `093A` is shared with Glorious and Incott.
- **Safety:** allowlist only the `NINJUTSO_COMMAND` ids. The pairing opcode is UNVERIFIED.
- **Popularity / effort:** Med / **S**.

### 3.16 ATK / VXE / MAD / VGN (Compx report-8; ATK already supported)

- **Identity:** ATK `373B` and Compx ODM `3554`.
  - OM's generated catalog (built from ATK HUB 3.2.27) has **199 models**: ATK 151, VXE 37, MAD 5 (MAD R / R+ / R MAJOR / MAJOR+), Dragonfly 5, Flow 1.
  - Model = VID:PID, then **CID/MID** (command 0x10). 36 CID/MID pairs and 4 VID:PIDs are shared, so both are needed.
  - VGN also uses VID `391D` (Dragonfly 3, F2 Turbo…).
- **Configurators:**
  - **ATK HUB <https://hub.atk.pro>** covers ATK, VXE and MAD.
  - **VGN HUB <https://hub.vgnlab.com/>** is a multi-ODM app: 8 mouse controllers, only `vgn-y2` and `vgn-f1-pm` are Compx report-8. It also runs 7 keyboard controllers including RongYuan, plus a SparkLink API.
  - Both are WebHID.
  - GravaStar Mercury mice: Compx "Control Hub" (controlhub.top/gravastar, the same build as bbb.pulsar.gg).
- **Open source:** OM `atk/`, `vgn/`, `gravastar/`, BITMOUSE (VXE ZERO on `FF05`), all AGPL. sing2293/gravastar has no license (docs-only).
- **Settings:** ≤8 stages (PAW3955 to 40–50K), X/Y, polling to 8K (needs the 8K dongle; NearLink A9 Plus max 1K), LOD 0.7–1.7 mm, motion sync, angle snap, ripple, debounce set, sensor mode (Basic/Competitive/MAX), sleep, long range, 6 buttons, 12 macros, 4 profiles, DPI RGB, dongle LED, battery.
- **WebHID:** OK. ATK HUB declares `FF04/FF05`, but **hardware answers on `FF02`:2**, so probe by report shape.
- **Safety:** see SYNQ `FORBIDDEN_COMMANDS`.
  - Block 0x01 DownLoadData, 0x02, 0x05/0x06 pair, 0x09 factory, 0x0B/0x0C/0x11 reserved, 0x0D USB upgrade, 0x0F profile switch (gate it), 0x13 unpair, 0x5A/0x5B.
  - VGN HUB also has a 0xB2 upgrade module.
- **Popularity / effort:** High / **S–M** to widen SYNQ to the whole catalog (tables plus per-sensor DPI codecs); **M** per extra VGN ODM controller.

### 3.17 WLMouse

- **Identity:** VID `36A7`. Pairs `A860–A886` (Beast G, Huan, Miao, Mini Pro, X Pro, Strider, Ying, Sword X, Max, Beast X, Beast Mini).
  - Shared 1K receiver `A882`: identify the paired model with page 0 cmd 0x8B.
  - Beast X 4K `A887` uses its own report-4 protocol with CRC-16/MODBUS.
- **Configurator:** **<https://gm.wlmouse.gg>** ("DriverCore", WebHID). Beast X 4K is desktop-only.
- **Open source:** OM `wlmouse/`, `compx/codec.js` (AGPL; 5 models supported).
- **Settings:** DPI 50–30000 step 50, 5 stages, X/Y, polling to 8K, LOD L/M/H, debounce 0–15, motion sync, angle snap, angle tune ±30°, ripple, hyper / turbo modes, sleep, buttons and combos, receiver key binding, profiles, battery.
- **WebHID:** OK. 64-byte feature report 0 (the page-command family, §2).
- **Safety:** the web hub flashes firmware. **Block page `0xB0` entirely**, put page 0 cmd 0x00 (factory) and 0x0D (reset profile) behind a confirmation, and block pairing.
- **Popularity / effort:** Med-High / **S** (Beast X 4K: **M**).

### 3.18 VAXEE

- **Identity:** VID `3057`. Wireless mice `1003–1015` (XE, NP-01S, AX, NP-01, XE-S, E1, V2/V3, Ergo). Receivers `0005/1001/1002/2001/2002`. Command 0x0A reads the PID of the mouse behind the receiver. Older wired models are driverless.
- **Configurator:** "VAXEE Control Center" web driver. The **URL is UNVERIFIED** (vaxee.co sits behind a Cloudflare challenge).
- **Open source:** OM `vaxee/` (AGPL; all 13 wireless models supported).
- **Protocol:** `FF05`:1, feature report 0x0E, 63 bytes, `[A5, cmd, 1 read / 2 write, len, data]`, 100 ms gap.
- **Settings:** DPI 100–26000 (42000 on 8K models), 4 stages, polling 500–8K, LOD Low/High, click response 0/2/4 ms, tracking, trajectory, 3 profiles, battery. No lighting.
- **Safety:** allowlist exactly the 13 known command ids.
- **Popularity / effort:** Med / **S**.

### 3.19 G-Wolves

- **Identity:** VID `33E4`. The vendor table `https://mouse.xyz/Config/env-models.json` lists 34 models in two generations:
  - **XVI-1** (64-byte page-command): HTX, HSK, HTS, Fenrir, VUK, HT-S2…;
  - **XVI-0** (Compx report-8): all share 8K receiver `3854`. The model id comes from handshake 0x01 (length 8 plus 4 random bytes).
- **Configurators:** **<https://mouse.xyz>** and **<https://mouse.fit>** ("DriverCore", WebHID).
- **Open source:** OM `gwolves/` (AGPL).
- **Settings:** DPI to 26K–40K, 7 stages, X/Y, polling to 8K, LOD 0.7–2, LOD debounce, button debounce ≤50, wheel debounce, competitive / long-distance / hyper modes, combos, macros, sleep, lighting. **Magnetic main buttons with RT and calibration** (HTS Plus Pro).
- **Safety:**
  - Block page `0xB0` (XVI-1).
  - On XVI-0, **0x01 is a handshake here but "DownLoadData" on ATK**. Allow it only in the exact G-Wolves shape and only on VID `33E4`.
  - Calibrate 0x2E: explicit action only, wired only.
- **Popularity / effort:** Med / **S–M**.

### 3.20 Darmoshark

- **Identity:** no VID of its own. It uses chip-vendor VIDs: Nordic `1915` (`0722–0749`, `0801–0812`), Realtek `0BDA`, `248A`, `362D`. **Never use VID-only matching.** The PID→model map is served by a server-side config.
- **Configurator:** **<https://www.darmoshark.cc/>** (WebHID). **It is a white-label of Keychron Launcher**: its API constant is `https://launcher.keychron.com/vapi/`.
- **Protocols:** the same as OM's Keychron Launcher mouse drivers:
  - "8k" on `FFC1` (reports B3/B5);
  - "1k" on `0x8C` (feature 0x51/0x52);
  - "4k" / Nordic DMS on `FF0A` (the same as OM's Orbital driver).
- **Open source:** OM `keychron/`, `orbital/` (AGPL). No Darmoshark-specific project found.
- **Settings:** DPI 50–30000, stages, polling to 8K, LOD 0.7/1/2, debounce 0–20, sleep, buttons/macros, lighting, battery.
- **Safety:** **block report 0xB2** (firmware; the same module is in VGN HUB). Put B5 0x0F factory/recovery behind a confirmation. Never use WebUSB DFU.
- **Popularity / effort:** Med / **M**.

### 3.21 Attack Shark

- **Identity:** four OEM platforms under one brand, and PIDs drift with firmware:
  1. **`1D57` (Xenta)** X11/R1/X3/X6. Feature reports 0x04 (DPI) and 0x06 (polling). Model byte in input report 0x03.
  2. **`25A7` (Areson)** X3/X6/X8/X11 "direct": GearHub "MU class" (from the qmk.top web driver).
  3. **`373E` (Compx)** R5 Ultra / R6 / R8: page-command, the Lamzu OEM.
  4. **`3151` (MicLink GearHub-V5)** R2/R3: shared `402D/4026`, told apart by device id.
- **Configurator:** Attack Shark Core (desktop, DriverCore lineage) and qmk.top GearHub for the `25A7/3151` models.
- **Open source:** OM `attackshark`, `gearhub`, `lamzu`, `compx/x11-dpi` (AGPL); attack-shark-x11-driver (MIT), x11-community-driver (MIT), Attack-Shark-X3 (MIT), ATKsoft (MIT), X11 GUI (GPL-3.0). Unlicensed R1 repos are docs-only.
- **WebHID:**
  - **`1D57` X11/R1: not possible on Windows Chrome.** The config channel is an interface-2 sub-collection that Windows doesn't expose to WebHID. hidapi reaches it (`&col04`), so the desktop app can.
  - OM marks 13 models "needs Bridge", including `25A7`.
  - `373E` and `3151`: OK.
- **Safety:** `373E` uses the page-0xB0 rule and bootloader PIDs. `1D57`: allow only feature reports 0x04 and 0x06 (+0xA0 read). `25A7`: only the known MU commands.
- **Popularity / effort:** High (budget) / **L overall**. Per platform: R-series **S**, R2/R3 **S**, `1D57` **M** (desktop only on Windows), `25A7` **M**.

## 4. Keyboards

### 4.1 Wooting

- **Identity:** VID `31E3` (legacy Atmel `03EB`). Base PIDs:
  - One v2 `1100`, Two v2 `1200`, Two Lekker `1210`, Two HE `1220/1230`;
  - 60HE `1300/1310`, 60HE+ `1320`, 60HE v2 `1340`;
  - 80HE `1400`, 80HE+ `1410`;
  - UwU `1500/1510`.
- **Every board also has gamepad-mode alternate PIDs `base|0..2`.** Match `pid & ~3`. OM lists only `1322`, which is alt PID 2 of the 60HE+.
- **Identity reads:** `get_device_config` 0x13 (layout), 0x01 firmware, 0x03 serial.
- **Configurator:** **Wootility Web, <https://wootility.io>**. WebHID confirmed, heavily obfuscated (javascript-obfuscator). Config pages `0x1337` (v2) or `FF55` (v3); analog stream `FF53/FF54`.
- **Wire format:** 8-byte feature report `[idx, D0|D1, DA, cmd, p3..p0]`. Replies `D0|D1 DA cmd 0x88 len <protobuf>`.
- **Open source:**
  - **wooting-rgb-sdk and wooting-analog-sdk (MPL-2.0)**;
  - **d0da (GPL-3.0, full command table 0x00–0x3B plus `.proto`)**, <https://pypi.org/project/d0da/>;
  - OM `wooting` (AGPL, read-only);
  - **@openmouse/keyboard-protocol 1.1.0 (AGPL)**: decoders for its keyboards' settings, and encoders for profile switch, save and RGB (60HE+);
  - HallJoy (AGPL-3.0, analog to gamepad).
- **Settings:** per-key actuation (and secondary), RT with separate press/release, strict vs continuous RT, SOCD (Rappy Snappy / Snappy Tappy), DKS, Mod-Tap, Tachyon mode, gamepad mapping (XInput/DInput), analog curves, RGB layers, 4 profiles plus a digital profile.
- **WebHID:** good (vendor pages).
- **Safety:**
  - Block `RESET_TO_BOOTLOADER 0x02`, `RESET_FLASH 0x2B`, `KEYS_OFF 0x15` (it locks the user out until `KEYS_ON`), `DO_SOFT_RESET 0x19`, `SET_RAW_SCANNING 0x2C`, `WOOT_DEV_*` 0x1E–0x21, `XINPUT_DETECTION` 0x2D/0x2E, and every unmodelled save.
  - Wootility can enter its bootloader from the browser.
- **Popularity / effort:** High / **S–M**. Writes need the profile protobuf schema from Wootility Web.

### 4.2 Razer analog / HE

- **Identity:** VID `1532`.
  - openrazer PIDs: Huntsman V2 Analog `0266`, Mini Analog `0282`, V3 Pro `02A6`, TKL `02A7`, Mini `02B0`, V3 Pro 8KHz `02CF`.
  - Synapse Web adds `02D0/02D1/02D8/02E4` (V3 HE Magnetic Mini 65%) and `02E6/02EA` (V3 HE Magnetic TKL 8KHz).
- **Configurator:** Synapse 4 and **Synapse Web** (WebHID). Keyboards default to **usage page 0x0C (Consumer), feature reports**. The older analog boards are not in Synapse Web.
- **Commands (class 0x02, get = set|0x80):**
  - actuation 0x19, RT 0x1A, mod-tap 0x1B, ADC data 0x9C, continuous RT 0x20, bottom dead zone 0x28;
  - Snap Tap 0x27 / single-key 0x2C, dual keypress priority 0x31;
  - keymaps 0x33–0x37, analog joystick mode 0x39;
  - class 0x00: polling 0x05, 8K 0x40, game mode 0x08.
  - Pairing is partly heuristic (UNVERIFIED lines).
- **Open source:**
  - openrazer (GPL-2.0-or-later; RGB/basic modes, no analog);
  - **universal-analog-plugin (MIT)**: analog read for V2 Analog, Mini Analog and the V3 Pro family;
  - FCC (GPL-3.0): experimental lighting and polling for 19 Razer keyboards, desktop only.
  - **No open project writes Razer actuation, RT or Snap Tap.**
- **WebHID:** good for Synapse Web boards (page 0x0C). Older analog boards may sit on the keyboard collection, so they likely need the bridge (UNVERIFIED).
- **Safety:**
  - Set Device Mode: allow only 0 and 3; block bootloader 1, test 2, download 4, RF test 8, retail 9.
  - Block device reset 0x00/0x0B, set serial 0x00/0x02, profile reset/delete (class 0x05), "Set Analog Input Calibration Data All".
- **Popularity / effort:** High / **M** (per-product Synapse Web bundles are about 3 MB each, minified but readable).

### 4.3 SteelSeries Apex Pro

- **Identity:** VID `1038`. Apex Pro `1610`, TKL `1614`, TKL 2023 `1628` (+ wireless `1630/1632`), Gen 3 `1640`, TKL Gen 3 `1642` (+ `1644/1646`). These come from OpenRGB, and regional PIDs differ. Mini PIDs: UNVERIFIED.
- **Interfaces:** wired = interface 1; wireless = interface 3, `FFC0`:1.
- **Configurator:** GG (desktop) only, plus on-device **GG QuickSet** (OLED). No web configurator.
- **Open source:** OpenRGB (GPL-2.0-or-later, RGB only), apex-tux (Unlicense, OLED), apexctl (Apache-2.0, old Apex). **Nothing implements OmniPoint actuation, RT, Rapid Tap or Protection Mode.**
- **Settings:** per-key actuation 0.1–4.0 mm (Gen 3), 2-in-1 action keys, RT (OmniPoint 2.0+), Rapid Tap (SOCD), Protection Mode, macros, per-key RGB, OLED, profiles.
- **WebHID:** plausible (`FFC0`), unproven.
- **Popularity / effort:** High / **L** (GG captures on real hardware are required).

### 4.4 Corsair HE / MGX

- **Identity:** VID `1B1C`.
  - **Web Hub keyboards:**
    - HE / magnetic: Vanguard Pro 96 `2B0E`, Vanguard 96 Wireless `2B0F`, Vanguard Pro 60 Wireless `2B30` (not yet offered), Clipper Pro Mini 60 `2B31`;
    - others: MAKR 75 `2B04`, Galleon 100 SD `2B0C`, Vanguard 96 `2B0D`, MAKR PRO 75 `2B1A`, Vanguard Air 99 `2B21`, Skiff 100 `2B3D/2B3E`.
  - K70 MAX (`1BC0`? user-submitted, UNVERIFIED) and K70 PRO TKL are iCUE-only.
- **Configurator:** iCUE; **CORSAIR Web Hub** (WebHID; Bragi `FF42` usage 1 request / usage 2 notify). Web Hub checks `app.corsair.com/api/firmware/latest`.
- **Settings:**
  - per-model `actuationDistanceRange` (0.1–3.5, 0.2–3.8 or 0–4 mm);
  - per-key press/reset distance; RT press/release plus deadzone;
  - **FlashTap** (SOCD), SmartTap, TapLock, multi-action;
  - 5 profiles, polling to 8K, RGB.
- **Open source:** OM Bragi (AGPL), OpenRGB (GPL-2.0-or-later), OpenLinkHub (GPL-3.0). **No open MGX/HE implementation.**
- **WebHID:** good for `2Bxx`.
- **Safety:** firmware properties (not yet extracted), factory reset, calibration. Allow only known Bragi properties.
- **Popularity / effort:** Med-High / **M** for Web Hub boards, **L** for K70 MAX / K70 PRO TKL.

### 4.5 Logitech G PRO X TKL RAPID / G515 RAPID

- **Identity:** VID `046D`. **PIDs not found in any public source (UNVERIFIED).** The model comes from HID++ name and model id as usual.
- **Configurator:** G HUB (desktop), plus on-board FN combos.
- **Open source:** none for analog keys.
  - HID++ feature 0x1B0C "analog buttons" exists (used by the PRO X2 SUPERSTRIKE mouse; OM implements it). Whether the RAPID keyboards use it or a per-key feature: UNVERIFIED.
  - The Keyboard Priority (SOCD) feature id is unknown.
- **WebHID:** good (HID++ on `FF00`, already working in SYNQ).
- **Popularity / effort:** Med / **M**. One feature-table dump from a real board (root 0x0000 / feature set 0x0001) reveals the ids; no guessing needed.

### 4.6 ASUS ROG / TUF keyboards (Falchion Ace HFX already supported)

- **Gear Link keyboards (manifest data):**

  | Model | PIDs (app / boot) | Unit | Actuation | RT |
  |---|---|---|---|---|
  | Falchion Ace HFX m605 | `1B7E` / `1B7F` | 0.1 mm | 0.1–4.0 | 0.1–2.5 |
  | Falchion Ace HFX ZywOo m606 | `1D1D` | 0.1 mm | | |
  | **Azoth 96 HE m901** | `1C10/1C12` / `1C11` | **0.01 mm** | 0.1–3.5 | 0.01–2.5 |
  | **Falcata m703** | `1C2F/1C31` | 0.01 mm | 0.1–3.5 | |
  | **Falchion Ace 75 HE m705** | `1C7D` | 0.01 mm | 0.1–3.5 | |
  | **TX75 Analog r701** | `1D68/1D6A` | 0.01 mm | 0.1–3.4 | 0.01–2.0 |
  | **TX75 Core r702** | `1DF3/1DF4` | 0.01 mm | 0.1–3.3 | |
  | **TUF K4 Magnetic r704** | `1DF5/1DF6` | 0.01 mm | 0.1–3.3 | |

  - Mechanical boards: Azoth `1A83/1A85`, Azoth Extreme `1B3F/1B42`, Azoth X, Strix Scope II, Morph 96.
  - **Falchion RX Low Profile is not in Gear Link** (Armoury Crate only).
- **Protocol:** the same `[cmd, sub, arg16, payload]` on `FF00`:1 as SYNQ's HFX driver. **SYNQ's encoder must be parameterised by the manifest's `magKeyUnit`** (0.1 vs 0.01 mm, probably 16-bit fields there; UNVERIFIED until the `view/7184` bundle is read).
- **Safety:** as in §3.5: block the OTA jump/ENTER_BOOT/bootloader opcodes, `B0 00`, `50 40`, `52 02`, `80 27` (analog calibration mode). Azoth 96 HE has `firmwareUpdateMethod: "WEB"`.
- **Popularity / effort:** Med-High / **S–M** per model (the transport is done).

### 4.7 Generic QMK / VIA / Vial

- **Channel:** raw HID **`FF60:61`**, 32-byte input/output reports, no report id. Model = VID:PID plus a VIA definition JSON. VIA's `supported_kbs.json` lists 1484 v2 + 577 v3 IDs; the top VID is Keychron `3434`.
- **Vial:** the serial contains `vial:f64c2b3c`, but **WebHID cannot read serials**, so probe `FE 00` instead.
- **VIA protocol (v0x000D):**
  - 0x01 version, 0x02/0x03 keyboard value, 0x04/0x05 keycode, 0x06 keymap reset;
  - 0x07–0x09 custom channels (backlight, rgblight, rgb_matrix, audio, led_matrix);
  - 0x0A eeprom reset, **0x0B bootloader jump**;
  - 0x0C–0x10 macros, 0x11 layer count, 0x12/0x13 keymap buffer, 0x14/0x15 encoders.
- **Vial additions:** `FE` prefix. In-firmware xz layout JSON (get definition 0x02), unlock 0x05–0x08, QMK settings 0x09–0x0C, dynamic entries 0x0D (tap dance, combos, key overrides).
- **Licenses (all code-reusable):** QMK GPL-2.0-or-later (SPDX), **the-via/app GPL-3.0**, **the-via/keyboards GPL-3.0**, **vial-gui GPL-2.0-or-later** (SPDX headers; COPYING is GPL-2.0 text), vial-qmk GPL-2.0-or-later.
- **Settings:** layers, keymap, encoders, macros, layout options, lighting channels, custom vendor menus. Vial adds tap dance, combos, overrides, tapping term, etc.
- **Configurators:** <https://usevia.app>, <https://vial.rocks> (both WebHID).
- **Safety:**
  - **Block 0x0B** (mainline QMK removed it, but VIA still sends it and old/vendor firmware honours it).
  - Put 0x0A, 0x06, 0x10 and Vial 0x0C resets behind a confirmation. Start Vial unlock only on request.
  - Warn before mapping `QK_BOOT`.
- **Notes:** many vendor boards (NuPhy, Ducky, Varmilo, Epomaker, Madlions) are **not in the-via/keyboards**, so SYNQ needs a "load VIA JSON" path.
- **Popularity / effort:** High / **S–M**.

### 4.8 Keychron (+ Lemokey)

- **Identity:** VID `3434`.
  - Keychron commands sit beside VIA on `FF60`: 0xA0 protocol, 0xA1 firmware, **0xA2 feature bitmask** (analog matrix, Snap Click, 2.4G, debounce…).
  - 0xA7 misc: debounce, Snap Click, wireless LPM, **report rate**, NKRO, 0x11 factory reset.
  - 0xA8 Keychron RGB.
  - **0xA9 analog matrix:** profiles, travel, advance mode, SOCD, curves, gamepad, realtime travel, 0x40 calibrate.
  - **0xAA wireless DFU, 0xAB factory test.**
- **Configurator:** **Keychron Launcher <https://launcher.keychron.com>** (WebHID; filters `FF60:61`, `8C:1`, `FFC1:1`, `FF0A:1`). It flashes over **WebUSB**, has telemetry and an AI chat endpoint, and is also white-labelled by Darmoshark. VIA also works.
- **Open source:** **Keychron/qmk_firmware (GPL-2.0-or-later headers)**, branches `2025q3` and `hall_effect_playground`. HE boards: K2/K4/K6/K8/K10 HE, Q0–Q6/Q12 HE, Lemokey L1/P1/P2/P3 HE.
- **HE model:**
  - actuation/deactuation in **0.1 mm** units (full travel 40);
  - modes: regular, rapid (6-bit sensitivity), DKS, gamepad (curves), toggle;
  - SOCD priority: none, deeper, deeper-single, last, key1, key2, neutral;
  - named profiles.
- **Safety:** block VIA 0x0B, 0xAA, 0xAB (includes jump-to-bootloader and RF carrier test). Put 0xA7/0x11, 0xA9/0x1E and 0xA9/0x40 calibrate behind a confirmation.
- **Popularity / effort:** High / **S** (VIA level) + **M** (HE extensions; the GPL source is in hand).
- **SYNQ (2026-10-14, `src/lib/kb/via/keychron/`):** the HE extension is a capability layer on the existing VIA driver, not a second channel.
  - **Boards:** the 35 wired HE variants of Keychron's `2025q3` firmware (commit `c5d99844`): K2/K4/K6/K8/K10 HE, Q0/Q1/Q2/Q3/Q4/Q5/Q6/Q12 HE and Lemokey L1/P1/P2/P3 HE, with ids and matrix from the firmware's `keyboard.json` files (`scripts/gen-keychron-he-catalog.mjs`). HE boards are not in VIA's keyboard list, so the layout comes from that catalogue (source "driver").
  - **Sent:** 0xA0/0xA1/0xA2 and 0xA7 0x01 reads; 0xA9 0x01, 0x10, 0x12 (raw profile read, 26 bytes at a time); 0xA9 0x14 (set travel: mode, actuation, press and release sensitivity, in 0.1 mm, at most 3.9 mm, to the profile's own configuration or to keys by row mask); 0xA9 0x1F (save the profile, always sent after a set).
  - **Blocked:** 0xAA, 0xAB, 0xA7 0x11, 0xA9 0x1E, 0xA9 0x40 and its reads, and (not offered yet) advanced keys, SOCD, profile names, curves, gamepad mode and profile selection. VIA's own 0x0B bootloader jump and 0x0A EEPROM reset stay refused by the VIA guard. The extension is a second guard tier (`checkKeychronFrame`), per id, mirrored in `src-tauri/src/hid.rs` (`keychron_he_frame_allowed`) and the web guard.
  - **Feel:** live depth stays with AnalogSense (`src/lib/kb/analogsense/`); the layer's actuation and rapid trigger feed "Keep your feel" through `KbView.analog`.
  - **Report rate, Snap Click and debounce (0xA7)** are not wired. A profile whose release distance is 0 follows its press distance, so a press-only change to the profile pins the release at its old value.
  - **UNVERIFIED on hardware:** every byte layout is read from the firmware source, nothing was sent to a keyboard. Details: [KEYCHRON-HE.md](KEYCHRON-HE.md).

### 4.9 NuPhy

- **V2 boards** (Air60/65/75/96 V2, Halo V2, Gem80, Field75): QMK/VIA, covered by §4.7.
- **V3 and HE boards: NuPhyIO, <https://nuphy.io>** (WebHID). VID **`19F5`**, Generic Desktop page 1 **usage 0** (not protected), 64-byte output reports.
  - 38 boards. App PIDs include Air75 HE `6120`, Field75 HE `FE70`/V2 `6132`, Halo65 HE `6112`, Air75 V3 `1028`, Node75 `1030`.
  - Separate **upgrader PIDs** (e.g. `0722`, `6F10`, `6F03`, `FF02`, `FF20`).
  - Framing `[0x55, cmd, 0, chk, len, off16, 0, data]`. **This is the same as MCHOSE gen 1** (FCC PROTOCOL-MC.md).
  - **Newer firmware XOR-masks traffic with a per-session key** (from `crypto.getRandomValues`), so captures alone can't be read.
- **Open source:** none specific. universal-analog-plugin (MIT) reads analog. FCC's MCHOSE code (GPL-3.0) covers the framing.
- **Safety:** NuPhyIO **flashes over WebHID** (`loadFirmwareToDevice`, `forcedUpgrade`). Never open upgrader PIDs, hide the `KC_FN_BOOT/RESET` targets, and allowlist only.
- **Popularity / effort:** High / **S** (V2) and **M–L** (V3/HE).
- **SYNQ (2026-10-14, `src/lib/brands/fw19f5/`):** the 38 app ids and 37 upgrader ids above are in the driver's table (36 explicit upgrader ids join the bootloader tables; `AF0F` rides the `AFxx` range). NuPhy boards are **read-only**: SYNQ reads the firmware version (area 3) and the base area (4) and nothing else. FCC documents the framing for MCHOSE only; NuPhy's area numbers are unverified, and the per-session XOR key exchange is documented nowhere SYNQ may use, so the XOR variant is not implemented. A board that doesn't answer the plain request is listed as "didn't answer".

### 4.10 Akko / MonsGeek (RongYuan RY5088 + YiChip YC3121)

- **Identity:** VID `3151` for most boards (FCC: 254 entries, PIDs mostly `5030/5029/502D/502F`); others: `38EE`, `374A`, `379A`, `39AB`, `046A`.
  - **The PID is shared by many models.** Command `0x8F` returns the model id plus firmware.
  - Command `0xE6` returns the travel precision (0.1 / 0.01 / 0.005 / 0.001 mm).
- **Configurator:** **<https://app.monsgeek.com>**. Note: it talks gRPC-Web to a local helper `iot_driver.exe` (127.0.0.1:3814) on at least some setups. Akko Cloud (desktop) is for older boards.
- **Protocol:** `FFFF:02`, 64-byte **feature** reports, `[cmd, p1–6, chk = 255 − sum, data]`, about 10 ms pacing.
  - Commands: 0x83 polling, 0x84 profile, 0x86 debounce, 0x87 lighting, 0x89 options, 0x8A keymap, 0x8B macros, 0x8C per-key colours, 0x91 sleep, 0xE5/0x65 HE tables, 0x01 factory reset.
- **Open source:**
  - **dniminenn/sharkfin (GPL-3.0; Rust + Tauri + WebHID at app.getsharkfin.com; 1389 ROYUAN boards; never flashes)**;
  - **FCC (GPL-3.0, TypeScript, ~285 boards)**;
  - dot-agi/ry5088-flasher (MIT: RY5088 = Artery AT32F405 + Panchip PAN1080);
  - monsgeek-rgb (MIT);
  - monsgeek-akko-linux (no license, so docs-only).
- **Brands on this platform** (FCC + sharkfin): MonsGeek, Akko, Attack Shark, EWEADN, Ajazz, Hator, XinMeng, VKMS, FL·Esports, MageGee, Epomaker, Gamakay, Skyloong, VGN, YUNZII, Cherry, Keydous, ikbc, NOPPOO, MEETION, Kreo, Royalaxe, Womier.
- **Safety:**
  - Block `0x7F` bootloader, `0xAC` flash erase, `0x50` SKU, screen/firmware commands. Put 0x01 factory reset behind a confirmation.
  - **Never trust the PID**: always query 0x8F and the precision first. A wrong unit sets absurd actuation values.
  - Rate-limit lighting writes, which go to flash.
- **Popularity / effort:** High / **M** (port FCC TS + sharkfin's catalogue logic).

### 4.11 DrunkDeer

- **Two platforms:**
  - **Own platform, VID `352D`:** `FF00:00`, report id 4, 63 bytes. PIDs `2382` (G65), `2383` (A75 family), `2384` (G60), `2386–23B6`. The model comes from the 0xA0 type code. The filter also includes borrowed `05AC:024F` and `1A81:2094`.
  - **Newer boards on `19F5`**: redirected to <https://drunkdeer.keybord.net.cn>, the same OEM family as NuPhy V3 and MCHOSE.
- **Configurator:** **Antler, <https://drunkdeer-antler.com>** (WebHID).
- **Commands:** 0xA0 identity, 0xB5 settings, 0xB6 action point, 0xFD down/upstroke, 0xFC last-win, 0xAE/0xC2 LED, **0xAA reset**, **0xF9 firmware upgrade**.
- **Open source:**
  - svumo/DrunkDeer-Control (MIT, C#), 2xxn/cli-drunkdeer (Apache-2.0), **PashOK7/HallJoy (AGPL-3.0)**, DrunkDeer-AnalogAdapter (GPL-3.0), universal-analog-plugin (MIT read);
  - mojobojo/drunkdeer-daemon (no license; best protocol table).
- **Settings:** per-key actuation (wire scale `mm × 100`, firmware "dialects"; older firmware capped at 2 mm), RT, Turbo, Last Win (SOCD), Rapid Double Tap, keystroke tracking, remap, profiles, RGB.
- **Safety:** block 0xF9 entirely. Never open `19F5:AFxx`. Put 0xAA behind a confirmation. **Check the firmware dialect first** (a 10× scale bug is documented in svumo v2.2.0).
- **Popularity / effort:** Med-High / **M**.
- **SYNQ (2026-10-14):** the seven `19F5` ids are driven by the 0x19F5 family driver (`fw19f5`), not by `drunkdeer/`; svumo's USB capture (docs/gen2-wire-format-confirmed.md) confirms the `0x55` framing, area 160 reads, area 161 writes with the last chunk flagged, only for the A75 Pro relabel `19F5:FB5C`. That id may be written (behind "Allow changes"); the other six are read-only. The replies may arrive on a collection Windows won't let apps read (svumo's investigation), so a real board may not answer: it is then only listed.

### 4.12 MCHOSE (keyboards)

- **Identity:** VIDs `41E4`, `3837`, `19F5` (FCC: 28 boards: Ace 60 / Ace 68 Turbo / Ace 75, Jet 75, Zero 75X, Mix 87…).
- **Configurator:** MCHOSE HUB web driver (www.mchose.com.cn per FCC; URL not fetched).
- **Protocol (gen 1):** `0001:0000` 64-byte, the 0x55 framing above.
  - Areas: 3 info, 4 profiles, 5/6 function, 8/9 keymap, 10/11 per-key RGB, 12/13 macros, 160/161 triggers, 164/165 mod-tap, 166/167 toggle, **238 factory reset**.
  - **Newer boards (G98 V3…) use a different protocol.**
- **Open source:** FCC `app/src/hid/mc.ts` (GPL-3.0; no DKS/SOCD/live travel yet).
- **Popularity / effort:** Med / **S–M** (gen 1), **L** (new gen).
- **SYNQ (2026-10-14):** FCC's 28 boards (31 USB ids; `3837:3033` is shared by four models, so it is read-only with no layout) drive per-key actuation / rapid trigger, Win / Alt-Tab / Alt-F4 locks, bottom RT, debounce, sleep and lighting (effect, brightness, speed, colour). Every board starts read-only behind "Allow changes" (FCC lists all 28 as untested). Writes are read back (area 160 / 5). The key map, colours, macros, mod-tap, toggle slots and the area-238 factory reset are never sent.

### 4.13 Madlions

- **Identity:** VID `373B` (the same as ATK), **`FF60:61`**. MAD60HE `1053–1056/105D`, MAD68HE `1058–105A/105C`, MAD68R `10A7` (from Soup / universal-analog-plugin, MIT).
- **Configurator:** a Madlions web driver exists (retail copy), but its **URL is UNVERIFIED**.
- **Protocol:** VIA-style with custom value ids (0x02/0x96…).
- **Settings:** actuation down to 0.04 mm (one listing), 0.02 mm precision, RT, DKS/MT/TGL, 8K (V2), remap, macros, RGB.
- **Popularity / effort:** Med / **M**. Try generic VIA first.

### 4.14 Ducky and Varmilo (kbhub)

- **Ducky:** `DUCKY_VID = 3233`. **DuckyHub, <https://duckyhub.io>** routes by PID:
  - One X `0016` / Mini `001B` → <https://one-x.duckyhub.io>;
  - Cushion `2501/2509`;
  - Strata `2502/2503`;
  - **OK-HE `2601–2606`** → `ok-he.i-game.tech.xsyd.top`, the "i-game" family in §2.
  - WebHID filter `{vendorId:0x3233, usagePage:0x008C}`.
  - The One X app **flashes firmware in the browser** (`LED61_OTA.bin`, `MCU_APP_Dfu.bin`).
  - One 2/3 and Mecha: on-board shortcuts only.
- **Varmilo:** VID `3783`. **<https://varmilo.kbhub.org>**, same `0x8C` filter style, with cross-redirects to Ducky. It has a firmware download API. Arcade sticks on `FF00`.
- **Open source:** none (QMK port for the One 2 SF only).
- **Popularity / effort:** Med-High (Ducky) / **L** (no open source; minified Vue). Varmilo is **M–L** and shares the driver.

### 4.15 Royal Kludge

- **The RK web driver is itself a multi-OEM router.** <https://drive.rkgaming.com> (WebHID, a 20 MB bundle) tags each device with a `protocolType`:

  | protocolType | Entries | VID | Config collection | Models | Family (§2) |
  |---|---|---|---|---|---|
  | **BeiYing** | 314 | `258A` (SinoWealth); dongles `258A`/`3554` | **`FF00:01`** wired, `FF02:02` dongle | RK61/68/84, M65–M87, R65/R87/R98PRO, S70–S104, L75/L98, N80/N99… | family 8 |
  | **SparkLink** | 42 | `1CA2` | `FFA0:01` | **M75 HE**, C61–C98, X87 | family 7 |
  | **Gcome** | 28 | `19F5` | `0001:0000`; upgrader PIDs on `FF00:01` | K99, R87Pro V2, R98Pro GT, R99, T87, T98 | family 4 |
  | **RongYuan** | 6 | `3151` | `FFFF:02` | **A72 HE** | family 2 |
  | **QMK** | 3 | `342D` | `FF60:61` | R65, R75 Pro | family 1 |
  | **Bytech** | 2 | `372E` | — | **RK68 HE** | unknown |

  Plus HangSheng (`342D`), JuPeng (`0603` Novatek) and QiWang (`0F62` Acrox), a few models each.
- **Legacy tools (FCC, KludgeKnight, Rangoli)** use **System Control `0001:0080`, feature report 0x0A, 64 bytes, write-only**.
  - **Chromium blocks System Control collections for all report types** (§6). So that channel is **desktop-only**: needsBridge on the web.
  - RK's own web driver reaches the same boards on the vendor collection `FF00:01`. Whether the 0x0A protocol also works there is UNVERIFIED.
- **Some RK boards are on `0C45`** (Sonix), with an obfuscated protocol (Rangoli issue #13).
- **Open source:** **FCC (GPL-3.0; RK M75 family), vinc3m1/kludgeknight (GPL-3.0, WebHID, write-only, tested F68/S79), rnayabed/rangoli (GPL-3.0, 471★, stale since 2024-07, `258A` only).** OpenRGB has no RK controller.
- **Safety:** the bundle lists 33 firmware JSON URLs and dedicated "Upgrader", "boot" and "DFU" device entries. Refuse every one of them.
- **SYNQ (2026-10-14, `src/lib/brands/rk-beiying/`):** the legacy System Control channel (feature report `0x0A`, 64 bytes, write-only) is built for 168 boards: RK's own software list (195 PIDs) minus Rangoli's unsupported boards (`0059`, `00A9`, `0102`), the 18 boards with a screen (`ShowScreen` / `DataUnitSize 512`: a newer data format) and the 6 with no lighting table. Layouts, default codes and lighting-mode flags are facts read from RK's per-board data via KludgeKnight, cross-checked against FCC's M75 catalogue (all four M75 layouts equal FCC's, key for key) and Rangoli's keycode table; 139 boards get remaps, 29 lighting only. Nothing can be read back, so every write is "unconfirmed" and the panel shows what SYNQ last sent. The 9 Gcome boards (`19F5`) are read-only on the 0x19F5 driver. The `FF00` vendor collection of RK's web driver is not used.
- **SYNQ, SparkLink HE boards (2026-10-14, `src/lib/brands/sparklink/`):** the 21 `1CA2` ids RK's web driver tags "SparkLink" (`1604`..`161B`, M75 HE `1619` among them) are claimed by the SparkLink driver; see §4.19 and [SPARKLINK.md](SPARKLINK.md). Bootloader (`Boot` in the sync reply) boards are refused.
- **Popularity / effort:**
  - High overall.
  - BeiYing (legacy, non-HE) **M**: FCC/KludgeKnight code plus the `FF00` protocol from the RK bundle.
  - HE boards come with their family drivers (SparkLink S, RY M, `19F5` M).
  - HangSheng, JuPeng, QiWang and Bytech **L**.

### 4.16 AULA / Ajazz and the Sonix HE family

- **Identity:** VID **`0C45`** (Sonix/Microdia), **`FF68:61`**, 64-byte output/input.
  - Framing `[0xAA, cmd, len, off16, 0,0,0, 56 data]`.
  - Regions: 0x11/0x21 settings (polling 1K/4K/8K, deadzones, sleep), 0x12/0x22 keymap, 0x13/0x23 LED, 0x14/0x24 per-key RGB, 0x15/0x25 macros, 0x17/0x27 RT (0.01 mm), 0x18/0x28 DKS; **0x0F factory reset, 0x64/0x65 calibration**.
  - **PIDs are shared** (`0C45:8030` = Fighting68 / Ato87 / ES75T), so models are told apart by the USB product string.
  - Dongles (`0C45:FEFC–FEFE`, borrowed `05AC:024F`) use a different page and 32-byte reports.
- **Official web driver:** VTER / driveall.cn.
- **Brands:** AULA, Ajazz (AK820 MAX / AK680 MAX / AK980), EWEADN, LEOBOG, CIDOO, Looting, Epomaker HE80, Fighting68 (FCC: about 135 wired boards).
- **AULA and Ajazz span other families too:**
  - AULA's best-seller **F75** (also F87 Pro, F99) is **SinoWealth `258A:010C`** (`FF00:01`, feature report 0x06). OpenRGB has lighting for it.
  - AULA HE boards use the **SparkLink page `FFA0`** (<https://magnet.aulastar.com>, VIDs `1CA5/1CA2/1CA3`).
  - Ajazz also ships RY5088 boards, plus budget boards on CR Semi `1A2C` (AK820, identity-only in OM).
- **Open source:** **FCC (GPL-3.0; Fighting68 verified)**. AULA F2067 lighting: progzone122/aegis-2067usb-custom-software (GPL-3.0, Rust, stale since 2024-12).
- **SYNQ, AULA SparkLink HE boards (2026-10-14, `src/lib/brands/sparklink/`):** the 34 ids in magnet.aulastar.com's request filter (`1C4F:EE88`, 17 on `1CA5`, 11 on `1CA2:1901`..`190B`, 5 on `1CA3`) are claimed by the SparkLink driver; see §4.19 and [SPARKLINK.md](SPARKLINK.md). The Sonix `0C45` boards stay with the AnalogSense / omkb drivers.
- **Popularity / effort:** High / **S–M**.

### 4.17 Wuque Studio and the "i-game" OEM family

- **Wuque:** VIDs `1CA6`, `36B5`; **`FFB0:1`** (alt `FF80`); 64-byte `[group, sub, …]`.
  - Groups: 1 device, 2 global (1 = factory reset), 3 keys, 4 performance, 5 lighting, 6 advanced, 7 macro, **8 firmware upgrade**, 12 display…
  - Source: **@openmouse/keyboard-protocol 1.1.0 (AGPL)**, reverse-engineered from <https://drives-hid.wuquestudio.cn/>. **Verified on a BABAO60 HE** (`1CA6:1B10`, fw 1.2.1.0) for actuation, polling, RT and deadzones.
- **The same pages appear in the Ducky OK-HE configurator's list:** 247 PIDs on `1CA6`, plus `38A6`, `1A86`, `391D`, `371C`, `3806`. So "i-game" is a white-label platform.
- **Popularity / effort:** Med / **S–M** (the codec exists; a catalogue is needed).

### 4.18 illumipc / Witmod family beyond the X68 (Redragon, Epomaker, Womier)

- illumipc's `device.json` has **44 Redragon entries** (company `fengrun_redragon`):
  - 30 on `2E3C:C365` (K552 SP, K556, K580-M, K617, K618, K673, K686, K707, K721, M82…);
  - 14 on **`0416:7372`** (M61, M68, M82, RS82 RT, K701).
- Redragon's own K556 HE download page links its **"Redragon Web Driver" to illumipc.com**.
- Other boards on the same driver: Epomaker HE60 Lite (`hongfeng_epomaker`), Womier "M68HE PRO" (`KF068USHEARGB`).
- **OpenRGB `WitmodKeyboardController` (`0416:C345`, command 0x0D product code) and `WinbondGamingKeyboardController` (`0416:B23C`, `FF1B:91`; Pulsar PCMK TKL / KT108 / KT87) are the same family.** Both are GPL-2.0-or-later, so lighting code can be reused.
- Other Redragon families: EVision (classic K55x/K6xx RGB, §2 family 9), SinoWealth 010C (K686 Eisa Pro), one VIA board (K667), one RY board.
- **Effort:** **S**. Widen SYNQ's existing driver from `AK1680*` product codes to these codes; layouts come from illumipc `/config/keys/<product>.json`.
- **Check first:** whether `0416:7372` boards behave exactly like `2E3C:C365` (UNVERIFIED).
- **SYNQ (2026-10-14):** built as a catalogue on the existing driver (`src/lib/illumipc/`, `src/lib/x68he*.ts`, `X68Panel.tsx`; protocol in [../keyboard-x68he/PROTOCOL.md](../keyboard-x68he/PROTOCOL.md) section 16).
  - **Catalogue** (`scripts/gen-illumipc-catalog.mjs` over illumipc's public `device.json` and `keys/<product>.json`): 50 boards, one row per product code: 44 Redragon (30 on `2E3C:C365`, 14 on `0416:7372`), 2 Epomaker (HE60 Lite, HE30), 1 Womier (M68HE PRO `KF068USHEARGB`) and the 3 MAGIC-REFINER X68 HE codes, with 19 distinct layouts (ANSI and ISO variants, from a 29-key pad to 104-key boards). One board (`K1USliteBYHEARGB`) has no layout file at illumipc and gets the same fallback layout illumipc itself uses (`SI2828HEARGB`); the panel says so.
  - **Ids opened:** `2E3C:C365`, the gamepad personalities `C366`, `C367`, `C368` (same firmware, same collection) and `0416:7372`. Exactly one driver claims each. The product code, not the id, names the board; the shared id never selects a photo.
  - **Behaviour:** the X68 HE paths are unchanged (same three codes, same `AK1680`/`AK1681` prefix rule, same programmatic layouts, same allowlist). Fn, rotary knob and custom G keys are drawn and locked. A catalogue board starts read-only like any other and needs "Allow changes", with an extra caution line because only the X68 HE's behaviour was read in full. A product code in neither table opens read-only.
  - **Not done:** the other ~190 illumipc entries (other companies on the same ids) and the OpenRGB `0416` ids (`B23C`, `C345`), which are not opened. Whether `0416:7372` behaves exactly like `2E3C:C365` is still UNVERIFIED.

### 4.19 Other single-family or small brands

- **GravaStar K98 Pro:** sing2293/gravastar (no license, docs-only); keyboard VID/PID UNVERIFIED. Effort M.
- **Epomaker (+ KiiBOOM):** **Epomaker Hub <https://hub.epomaker.com>** (WebHID) is a multi-family router:
  - "Vendor A" = RY5088 (37 entries: HE/RT/TH lines);
  - "Epomaker" = Sonix VTER (HE80, TH65–TH108);
  - one illumipc board (HE60 Lite);
  - a QMK/VIA line (Galaxy, Luma, QK, Split).
  - No Epomaker-specific protocol, so this is catalogue work only (**S**).
  - OpenRGB has TH80 Pro `3151:4010/4011` lighting.
  - RT100 screen: epomaker-controller (no license, docs-only).
- **Kochi Hummingbird 68** (`1CA2:0901`): the Win/Mac mode switch through @openmouse/keyboard-protocol. SparkLink SDK family.
- **SparkLink / PlayJoy:** **@sparklinkplayjoy/sdk-keyboard (MIT, npm 1.0.24, docs <https://sparklinkplayjoy.github.io/keyboard-docs/>)**, used by AureTrix_driver (MIT). This is a published vendor SDK, rare and valuable. Also embedded in VGN HUB.
- **SYNQ, SparkLink (2026-10-14, `src/lib/brands/sparklink/`, [SPARKLINK.md](SPARKLINK.md)):** our own driver written from the SDK, its docs and AureTrix (nothing copied or run).
  - **Ids (56):** Royal Kludge 21 (`1CA2:1604`..`161B`, incl. M75 HE `1619`), AULA 34 (`1C4F:EE88`; 17 on `1CA5`; 11 on `1CA2:1901`..`190B`; 5 on `1CA3`) and Kochi `1CA2:0901`. All start "experimental" (read-only until "Allow changes"). Kochi was claimed by omkb before; omkb now yields it, so exactly one driver owns it.
  - **Features:** per-key and global actuation, rapid-trigger press and release and top and bottom dead zones (micrometres), a key given its own values switches to its own mode, Windows or Mac mode (the one setting a third party has exercised on a Kochi), and read-only protocol version, name, report rate and travel range. Dead zones are read from the keys in global mode: the global message's dead zones are unreliable (AureTrix). Keys in an advanced mode are shown and skipped.
  - **Blocked:** the bootloader (classes 8 to 14) and screen-picture commands (48, 49), factory restore (order 0x11), calibration (0x04, 0x0C, 0x0D), macros, key-map (Fn layer) writes, the switch-type layout, advanced keys (DKS, mod-tap, toggle, SOCD, rapid-switch, multi-point) and lighting.
  - **Persistence is unknown:** the SDK has no explicit save command; the panel reads each write back and says what the board reports.
  - **UNVERIFIED on hardware:** nothing was sent to a SparkLink board.
- **libhmk + hmkconf (GPL-3.0):** open HE firmware with a web configurator. A natural "reference board" for testing SYNQ's analog model.

### 4.20 The 50 keyboard brands, classified

**Classes:**
- **A**: covered by a running or finished wave (ROADMAP K1–K3b, plus the done Falchion and illumipc X68 work);
- **B**: gaming/enthusiast with real settings still to plan;
- **C**: office/standard, nothing worth configuring (exceptions noted).

Many brands are **split**: their boards sit on several OEM families (§2.2), so the class column lists every part.

**Tiers:**
- **full**: remap / actuation / profiles;
- **lighting-only**: OpenRGB-derived USB HID, which goes into the Lighting tab (ROADMAP L2);
- **detectOnly**: device card plus vendor-tool link.

| # | Brand | Class | Covered by / plan | OEM family (evidence) | Tier |
|---|---|---|---|---|---|
| 1 | Logitech G | B | RAPID analog = K5 (one HID++ feature dump); G915/G815/G512 lighting = L2 | HID++ (existing SYNQ transport); OpenRGB Logitech, g810-led (GPL-3.0) | full (RAPID) / lighting-only |
| 2 | Razer | A + B | Analog/HE = **K3b**; non-analog BlackWidow/Huntsman lighting uses the same 90-byte family (S) | Razer `1532`, Synapse Web page 0x0C | full / lighting-only |
| 3 | Corsair | A + B | `2Bxx` Web Hub boards = **K3a**; legacy iCUE boards = lighting (OpenRGB Peripheral V1/V2); K70 MAX / K70 PRO TKL = L | Bragi `FF42` | full / lighting-only |
| 4 | HP | C | OMEN Sequencer EOL 2023; HP-era HyperX boards use HP's VID `03F0` (see HyperX) | — | detectOnly |
| 5 | Dell / Alienware | C (exception) | **AW510K `04F2:1830`, AW410K `04F2:1968`**: lighting-only, `FF00:1` (OpenRGB; alienfx-tools MIT). Laptops out of scope | Chicony `04F2` | lighting-only / detectOnly |
| 6 | Lenovo | C (exception) | **Legion K500 `17EF:60D5`, K510 Mini Pro `17EF:619A`** (`FF1C:92`, EVision-like): lighting-only. Laptops out of scope | EVision page `FF1C`? (UNVERIFIED) | lighting-only / detectOnly |
| 7 | Apple | C | nothing to configure (OS remap only) | — | detectOnly |
| 8 | Microsoft / Surface | C | limited hotkeys in Mouse and Keyboard Center; OM covers MS mice only | — | detectOnly |
| 9 | ASUS ROG | A | Gear Link keyboards = **K3a**; HFX done; Falchion RX Low Profile is Armoury Crate only | Gear Link `0B05` | full |
| 10 | SteelSeries | B | Apex Pro analog = K5 (**L**, GG captures); Apex 3/5/7/9 lighting = L2 (OpenRGB PIDs `161A/1622/161C/1612/1618/1634/1620`) | `1038`, `FFC0` | lighting-only (full later) |
| 11 | HyperX | B | Alloy Elite/FPS/Origins/Core/60/65 lighting = L2 (8 OpenRGB controllers, Kingston `0951` + HP `03F0`); macros stay in NGENUITY | own | lighting-only |
| 12 | Keychron | A | VIA = **K1**; HE analog matrix = K4d | QMK/VIA `3434` + Keychron extensions | full |
| 13 | Rapoo | B (low) | own VID `24AE`, no open/web protocol; the mouse side needs the bridge (GET_REPORT input) | own | detectOnly (L) |
| 14 | A4Tech / Bloody | B (low) | Bloody B820R `09DA:FA10` lighting (OpenRGB, `FF52`); macros in Bloody7 | own | lighting-only / detectOnly |
| 15 | Redragon | A + B | HE boards = **illumipc (done driver; K4b catalogue widening, 44 entries)**; classic K55x/K6xx RGB = EVision lighting (L2); K686 Eisa Pro = SinoWealth 010C lighting; K667 = VIA (K1) | illumipc/Witmod, EVision, SinoWealth | full / lighting-only |
| 16 | MSI | A + B | **STRIKE 700 HE = RY5088 (K3b)**; Vigor GK30 `0DB0:0B30` lighting (S); Forge/Strike/Vigor others L | RY5088; own `0DB0`/`1462` | full / lighting-only |
| 17 | Cherry | A + B | Cherry-branded RY5088 boards (`046A` in the FCC RY list) = **K3b**; MX Board 3.0S / 1.0 / 2.0S / 8.0 / 10.0 / G80 lighting = L2 (OpenRGB `046A`, page `FF1C`); macros in CHERRY Utility (L) | RY5088; EVision-like `FF1C` | full / lighting-only |
| 18 | Ducky | A + B | **OK-HE** uses the i-game family (Wuque codec, **K1**); One X / Cushion / Strata on kbhub = K5 (**L**); One 2/3 nothing | i-game; kbhub | full (OK-HE) / detectOnly |
| 19 | Royal Kludge | A + B | A72 HE = RY (**K3b**); M75 HE = SparkLink (K4c); K99/R87Pro V2/T98 = `19F5` (K4a); **BeiYing majority (314 entries) = K4e** (write-only); R65/R75 Pro = VIA (K1) | 9 OEM protocols (§4.15) | full / write-only |
| 20 | Akko | A | **K3b** (RY5088 + YC3121) | RY5088 `3151` | full |
| 21 | Epomaker | A | Catalogue only: Sonix (**K2**), RY (**K3b**), illumipc (done), VIA (**K1**) via hub.epomaker.com tags | 4 families | full |
| 22 | AULA | A + B | F65/F65M = Sonix (**K2**); HE WIN60/68 = SparkLink (K4c); **F75/F87 Pro/F99 = SinoWealth 258A:010C** (lighting L2; remap needs captures) | Sonix, SparkLink, SinoWealth | full / lighting-only |
| 23 | Wooting | A | **K1** (OM keyboard-protocol, read-mostly); writes follow | own `31E3` | full |
| 24 | Cooler Master | B | MasterKeys/SK/CK/MK lighting = L2 (OpenRGB V1/V2, about 20 PIDs, `FF00:1`); macros in MasterPlus+ (L). **Gate OM's MM711 filter by PID `0101`**: its `{2516, FF00, 1}` filter also matches CM keyboards | own `2516` | lighting-only |
| 25 | NuPhy | A + B | V2 = VIA (**K1**); V3/HE = `19F5` family (K4a, incl. the XOR session variant) | VIA; `19F5` | full |
| 26 | Glorious | A + B | GMMK Pro `320F:5044`, GMMK 2 `5045`, Numpad `5088` on QMK = **K1**; GMMK 3 / 3 Pro HE / CORE firmware = **L** (closed) | VIA; CORE (closed, `320F`) | full / detectOnly |
| 27 | Ajazz | A | Sonix (**K2**) + RY (**K3b**); CR Semi `1A2C` budget boards L | Sonix, RY, `1A2C` | full |
| 28 | Trust | C | GXT RGB; OpenRGB `145F:026D/0248` look like mice (UNVERIFIED) | — | detectOnly |
| 29 | Kensington | C | KensingtonWorks covers trackballs, not keyboards | — | detectOnly |
| 30 | Genius | C | SmartGenius / per-model tools, no protocol | — | detectOnly |
| 31 | Acer / Predator | C | QuarterMaster barely supports Aethon keyboards; Nitro laptop EC out of scope | — | detectOnly |
| 32 | Turtle Beach | B | Vulcan / Vulcan II lighting = L2 (OpenRGB; `1E7D`, `10F5:501B/5023/5001`); **Vulcan II TKL Pro is analog HE** (page 0x0001, L) | ROCCAT/TB own | lighting-only |
| 33 | Varmilo | B | kbhub family with Ducky (K5, **M–L**) | kbhub `3783` | detectOnly → full |
| 34 | Leopold | C | DIP switches / Fn combos (UNVERIFIED) | — | detectOnly |
| 35 | Filco | C | DIP switches; Xacro macros via FILCO Assist (protocol UNVERIFIED) | — | detectOnly |
| 36 | HHKB | C (**exception**) | **Keymap** on Professional HYBRID / Type-S: happy-hacking-gnu (**Unlicense**, VID `04FE`); block its firmware update, gate reset; HHKB Studio detect-only. Plan: **K5, M** | PFU own | full (keymap) |
| 37 | Realforce | C (**exception**) | **APC actuation + remap** (REALFORCE CONNECT): **RealforceControl (MIT, GX1 `0853:0317`, `FF00:1`)**; R3/R3S PIDs and layout need confirming. Plan: **K5, M** | Topre own | full |
| 38 | Drop | A | QMK/VIA (**K1**): CTRL `359B:0009`, ALT `0006`, SHIFT `000C`, CSTM65 `0010`, SENSE75 `0001` | VIA | full |
| 39 | Lofree | A + B | Flow 2 = VIA (**K1**); Flow Lite / Edge "Control HUB WEB" Key Mapper (<https://www.lofree.tech/home/>, WebHID, has an OTA path) = K5 (**M–L**); Hyzen separate app | VIA; Lofree OEM | full |
| 40 | Yunzii | A | RY5088 (**K3b**): sharkfin lists 35 boards, including non-magnetic ones | RY5088 | full |
| 41 | Durgod | A + C | QMK-flashed K310/K320/Hades (`D60D:*`) = **K1**; stock firmware (`2F68:0082`? UNVERIFIED) detectOnly | VIA; stock closed | full / detectOnly |
| 42 | Das Keyboard | B | Q-series per-key RGB "signals": **local Q REST API `localhost:27301`** (docs Apache-2.0) or OpenRGB HID (`24F0:2037/2020/209A`) = L2 | own `24F0` | lighting-only |
| 43 | Kinesis | B (**exception**) | **Advantage360 Pro = ZMK**: ZMK Studio (MIT/Apache-2.0) over **USB serial + BLE GATT, not HID**, so it needs the serial transport (with JDS, ROADMAP A5); SmartSet boards detectOnly | ZMK | detectOnly → full with serial |
| 44 | Thermaltake | C-ish | Poseidon Z RGB `264A:3006` lighting only (OpenRGB); iTAKE lines closed; line largely discontinued | own `264A` | detectOnly |
| 45 | Cougar | C-ish | 700K EVO `060B:7010` lighting possible (OpenRGB); UIX closed | ODM `060B` | detectOnly |
| 46 | MCHOSE | A + B | Sonix MCHOSE boards (FCC **K2** list); gen 1 (`41E4/3837/19F5`, 28 boards) = K4a; newer gen (G98 V3…) = **L** | Sonix; `19F5` | full |
| 47 | MonsGeek | A | **K3b** (RY5088) | RY5088 | full |
| 48 | Womier | A | SK75 VIA (**K1**), RY boards (**K3b**), M68HE PRO on illumipc (done) | 3 families | full |
| 49 | iKBC | C | hardware-only; its RY boards (sharkfin's brand list) ride K3b | (RY for some) | detectOnly |
| 50 | Vortex | C | Holtek "CYKB" boards; pok3rtool (GPL-3.0) is a **flasher that warns of bricks**, so never ship it | Holtek CYKB | detectOnly |

**Totals (primary class; 10 + 13 + 10 + 17 = 50):**
- **A (10):** ASUS, Keychron, Akko, MonsGeek, Epomaker, Wooting, Ajazz, Drop, Yunzii, Womier.
- **A + B split (13):** Razer, Corsair, Redragon, MSI, Cherry, Ducky, Royal Kludge, AULA, NuPhy, Glorious, Lofree, MCHOSE, and Durgod (A + C).
- **B (10):** Logitech G, SteelSeries, HyperX, Cooler Master, Turtle Beach, Varmilo, Das Keyboard, Kinesis, plus low-value Rapoo and A4Tech.
- **C (17):** HP, Dell/Alienware, Lenovo, Apple, Microsoft, Trust, Kensington, Genius, Acer, Leopold, Filco, HHKB, Realforce, Thermaltake, Cougar, iKBC, Vortex.
  - Lighting-only exceptions: Dell/Alienware (AW510K/AW410K) and Lenovo (Legion K500/K510).
  - **Full-tier exceptions worth a driver: HHKB (keymap) and Realforce (APC + remap).**

**Family-level conclusions:**
1. **Lighting-only keyboards cluster into OpenRGB-derived USB HID controllers:** HyperX, Cooler Master, Turtle Beach, Cherry, SteelSeries Apex, Corsair legacy, Logitech G, Alienware, Legion, Das Keyboard, A4Tech, MSI Vigor, EVision Redragon, SinoWealth 010C. **Plan them as ROADMAP L2 (Lighting tab), not as keyboard waves.** Page **`FF1C` keeps reappearing** (EVision, Cherry, Legion K510, Glorious stock): one driver may cover several (UNVERIFIED).
2. **No new HE web families surfaced** in the second half of the list. The only closed HE boards are Glorious GMMK 3 HE, Turtle Beach Vulcan II TKL Pro and SteelSeries Apex Pro.
3. **New transport needed only for Kinesis/ZMK** (Web Serial / BLE GATT). Share it with JDS Labs.

## 5. Audio

### 5.1 AutoEq (preset source)

- **What:** <https://github.com/jaakkopasanen/AutoEq> (about 16k★; last push 2025-07). Web app: <https://autoeq.app>, which has no device I/O.
- **License:** **MIT** for the code. The `measurements/` come from third parties (oratory1990, crinacle, Rtings…) and their redistribution terms are **UNVERIFIED**. So **fetch on demand, do not bundle the database.** `results_README.md` is the index (about 486 KB, about 6000 headphones).
- **Formats:**
  - `ParametricEQ.txt` is Equalizer APO syntax (`Preamp:` plus `Filter N: ON PK|LSC|HSC Fc Gain Q`, not sorted by frequency). SYNQ's EAPO engine already parses it.
  - `FixedBandEQ.txt` has 10 PK bands at 31–16k, Q 1.41.
  - `GraphicEQ.txt` has 127 nodes.
- **Device fitting:** `autoeq/constants.py` `PEQ_CONFIGS` already describes constrained targets: `MOONDROP_FREE_DSP` (9 PK, fc 40–10k, Q 0.5–6, gain −12…+3), `QUDELIX_5K` (LSC + HSC + 8 PK, ±12), 10/31-band graphic, miniDSP, Poweramp, and others. The `peq.yaml` schema is per-slot.
- **Effort:** **S** to import a preset (works with EAPO today). **M** to port the optimizer (`peq.py`, SciPy-based) to TS/WASM for refitting to a device.

### 5.2 devicePEQ (hardware PEQ reference)

- **What:** <https://github.com/jeromeof/devicePEQ> (Pragmatic Audio). **License 0BSD**, so the handlers, `peqConstraintsConfig.json` and `compensation.js` can be reused.
- **Do not copy the vendor captures it contains:** `fiio-js-capture/`, `walkplayJS/`, `walkplayPreprocessor/walkplay.json` (third-party API data) and `Q5K/` are vendor bundles. Treat them as docs-only.
- **Transports:** WebHID (FiiO, WalkPlay, Moondrop ×3 generations, Conexant FreeDSP, KT Micro, Fosi), Web Serial / SPP (JDS Labs, FiiO DSP cable, Tanchjim Rita, Moondrop Edge), BLE (Audeze Maxwell), and HTTP (WiiM, Luxsin).
- **Matching is VID + USB product string (+ PID scheme groups).** PID alone is not enough. Many VIDs are reused chip or OEM IDs: `0A12` CSR, `152A` Thesycon, `1A86` QinHeng, and WalkPlay OEMs on `3302`, `0D8C` (C-Media), `0909` (Audio-Technica)…
- **Key finding: hardware does not realise ideal biquads.** For example, WalkPlay scheme 11 lands 2.2–2.5 % low in frequency with lower Q; old KT Micro lands at 2× frequency; FiiO has gain-dependent Q. A faithful AutoEq→device writer therefore needs per-scheme compensation.

### 5.3 Hardware PEQ families

| Family | IDs | Web tool | Protocol (from devicePEQ handlers) | EQ capability | Block |
|---|---|---|---|---|---|
| **WalkPlay** (about 367 products, 11 "SchemeNo"; brands include Moondrop, TRN, Simgot, DUNU, **WLMOUSE**, **ATK GEAR**) | many VIDs: `3302`, `0762`, `35D8`, `2FC6`, `0104`, `B44D`, `0661`, `0666`… | <https://peq.szwalkplay.com> (WebHID) | report 0x4B, READ 0x80 / WRITE 0x01; per-filter host-computed biquad plus freq/Q×256/gain×256/type; commit `[1,5,0]`, `[1,0x17,0]`, temp write, flash | 5–10 bands, ±10 dB, Q 0.1–10. **Scheme 11 (41 %) has no high shelf**. 1 slot (id 101) | `0xFF` upgrade; send 0x05/0x17 only inside the commit sequence |
| **Moondrop** (WalkPlay, Conexant and KT Micro platforms) | by product name | Moondrop web tool (URL UNVERIFIED) + Android | 0x4B WalkPlay-like; "Old Fashioned" register R/W/S; FreeDSP gen 1 = host-computed coefficients, no read-back | 5–9 bands; ceilings +3 / +6 dB on some | `0xFF` upgrade, 0x17, 0x05 |
| **FiiO** | `2972` (+ `0A12` BT receivers) | <https://fiiocontrol.fiio.com> | `AA 0A … EE` / `BB 0B`, report 7 (sometimes 1 or 2); filter 0x15 (gain×10, Q×100), global gain 0x17, save 0x19 / 0x21 | 10 bands typical (−24…+12), **31 on K17/K19**, 5 on dongles; 10 user slots (ids 160–169), bypass 240 | `0x1B` reset device, `0x1C` reset all |
| **Qudelix 5K / 5K Plus** | `0A12`, `1FC9` | Chrome extension (WebHID) | reports 8/9/1; `0x07xx` EQ commands, Q×1024 | 10 PEQ (20 on Plus), 10 presets, GEQ mode | **the extension also does DFU**: allowlist strictly |
| **KT Micro** (Tanchjim One/Bunny/Fission DSP, Kiwi Ears, Moondrop CDSP/Chu2 DSP, JCally) | `31B2` | phone apps only | 0x4B; R 0x52 / W 0x57 / commit S 0x53 / clear C 0x43 | 5 bands ±10 dB, Q 0.1–5, device-side pregain | 0x43 outside the push sequence |
| **JDS Labs Element IV** | `152A:88FA` (CDC serial) | <https://core.jdslabs.com> | JSON over serial, `Describe` / `Update` | 12 bands (2 LS + 8 PK + 2 HS), 10 profiles (fw 1.4.1) | anything other than Describe/Update |

- **Web:** all HID families are vendor collections on DAC dongles, so they are **web-OK**. JDS needs **Web Serial** and a native serial port (not HID).
- **Safety:** every push writes flash. Confirm the model and slot before the first write (devicePEQ's own rule) and commit only on an explicit Save.

### 5.4 Gaming headsets with onboard EQ

- **HeadsetControl** (<https://github.com/Sapd/HeadsetControl>): **GPL-3.0-or-later** (file headers), C++20 on HIDAPI, very current (2026-10-02).
  - Its `lib/device.hpp` defines `EqualizerInfo` (graphic) and `ParametricEqualizerInfo` (bands, gain base/step/min/max, Q min/max, freq min/max, filter-type bitmask). This is a good schema reference.
  - **No firmware or reset code**.

| Headset | VID:PID (HeadsetControl) | Channel | EQ |
|---|---|---|---|
| SteelSeries Arctis Nova 3 | `1038:12EC` | `FFC0` | graphic 6 bands, ±6 dB, step 0.5; 4 presets |
| Arctis Nova 3P/3X Wireless | `1038:2269/226D` | `FFC0` | **parametric 10 bands**, ±12 dB step 0.1, Q 0.2–10, LS/LP/PK/HP/HS/Notch |
| Arctis Nova 5/5X | `1038:2232/2253` | `FFC0` | **parametric 10 bands**, ±10 dB step 0.5, Q 0.2–10; `saveState` persists |
| Arctis Nova 7 family (12 PIDs), Nova 7P, Nova Pro Wireless, Arctis 7+ | `1038:2202, 22A1, 227E…`; Pro `12E0/12E5` | `FFC0` | graphic 10 bands, ±10 (±12 on 7+), step 0.5; 4 presets |
| Logitech G PRO X 2 LIGHTSPEED | `046D:0AF7` | Centurion `FFA0` | 5 presets; peaking bands, with count and gain range read from the device |
| Logitech ASTRO A50 Gen 4 | `9886:002C` | `FF32:74` | 5 bands ±7 dB step 1, 80–15k Hz, LS/PK/HS |
| Audeze Maxwell | `3329:4B19/4B18` | `FF13` | presets only |

- **HyperX** (Cloud Alpha Wireless, Cloud III…): HeadsetControl has sidetone, battery and auto-off but **no EQ**. NGENUITY's EQ is software-side, so SYNQ's EAPO already covers it.
- **Razer** headsets: not in HeadsetControl; no open EQ work (**L**).
- **Jabra:** the Chromium blocklist strips output report 5 on `0B0E` page `FF00`, so it is **not configurable from the web**.
- **Web:** headset channels are vendor pages on non-keyboard devices, so web is likely OK (UNVERIFIED in a browser). WebHID sees only the HID interfaces of the composite device.

### 5.5 What an EQ capability must describe (feeds CAPABILITIES.md)

**Four topologies:**
1. **flat parametric:** any type per band;
2. **typed / positional:** a slot has a fixed type (JDS 2 LS + 8 PK + 2 HS, Qudelix 2 shelves + 8 PK);
3. **graphic:** fixed frequencies, gain only (Nova 7/Pro, Nova 3);
4. **preset-only** (Audeze).

**Fields every real device needed:**
- per-slot kinds;
- fixed or ranged freq and Q;
- gain range, step and **ceiling** (+3 / +6);
- preamp mode (host register / device-side / none);
- wire quantisation (Q×100 / ×256 / ×1000 / ×1024 / bandwidth = 4096/Q; gain ×10 / ×256 / 0.5 dB);
- disabled-band encoding (Nova freq 20001);
- preset and user-slot ids;
- read-back yes/no;
- an explicit commit;
- transport (hid / serial / spp / ble / http);
- a realisation-compensation model.

## 6. Platform rules: WebHID vs desktop bridge

From Chromium source at tags 152.0.7977.83 and 153.0.8010.37 plus main, hidapi 0.16.0. Full detail is in the `webhid-platform` notes.

**Three Chromium layers:**
1. **Blocklist:** `hid_blocklist.cc`. Covers FIDO `F1D0`, security-key VID/PIDs, and **Jabra `0B0E` `FF00` output report 5**. Rules can be **pushed by Finch without a Chrome release**. No gaming mouse or keyboard VID is on it today.
2. **Always-protected usages:** `IsAlwaysProtected`, unchanged from 152 to 153 to main.
3. **Pruning:** collections left with no reports are pruned, and a device with nothing left is dropped from `requestDevice` / `getDevices`.

**Layer 2, by collection:**

| Top-level collection | Input | Output | Feature |
|---|---|---|---|
| Keyboard page `0x07` | blocked | blocked | blocked |
| Generic Desktop Pointer/Mouse/Keyboard/Keypad | blocked | blocked | **allowed** |
| Generic Desktop **System Control `0x80–0x8F`**, System Dock `0xA0–0xB7` | blocked | blocked | **blocked** |
| Consumer `0x0C`, vendor `FF00–FFFF`, Generic Desktop usage 0, Gamepad, LED, Lighting `0x59` | allowed | allowed | allowed |

**Chrome 153 (Windows only):**
- `hid_service_win.cc` now sets `collection_type = Application` on the collections Windows synthesizes. This closes a bypass (<https://issues.chromium.org/issues/536063911>). Windows now behaves like macOS/Linux.
- A mouse collection that declares only its input report (**Razer**, whose 90-byte feature report 0 is undeclared) is stripped and pruned, so the device disappears.
- Also in 153: **`requestDevice()` consumes the user activation**, so SYNQ needs one chooser per click with all filters.

**Windows native (hidapi / SYNQ bridge):**
- The OS owns mouse and keyboard collections. hidapi falls back to a **zero-access handle**, on which **feature reports work and input/output do not**.
- Pad feature buffers to `FeatureReportByteLength`. For undeclared reports (Razer), try each `&colNN` path.
- No admin rights are needed. Warn (never kill) when vendor suites hold the device: Synapse, G HUB, iCUE, GG, NGENUITY.

**Other platform facts:**
- **Permission persistence:** a WebHID grant survives a re-plug only if the device has **both a serial number and a product name**. Many mice don't, so expect re-prompts on the website.
- **WebView2** has no documented WebHID support. Irrelevant: SYNQ replaces `navigator.hid` with its bridge on desktop.
- **WebUSB** cannot claim HID or Audio interfaces (protected classes), so it is no workaround. It is how some vendors flash DFU; **SYNQ must never request WebUSB**.
- **Bridge design:** a loopback server on 127.0.0.1 with an origin allowlist exposes native HID as a `navigator.hid` replacement to the website. SYNQ's desktop app could offer the same so the website can reach bridge-only devices. Chrome's Local Network Access prompt applies.

**Verdicts used in this file:**
- **Web-OK:** every vendor-page / Consumer / usage-0 channel. That covers almost every brand here.
- **Needs bridge:** Razer mice (Windows Chrome ≥ 153), Attack Shark `1D57` X11/R1 (Windows: sub-collection not surfaced), ROCCAT Burst Pro Air (mouse collection), legacy RK System Control channel (all browsers), Rapoo mice (answer via GET_REPORT(Input)).
- **Never:** Jabra report 5; anything that needs input/output on an OS-owned mouse or keyboard collection (not even the Windows desktop app can do that).

## 7. Safety: what every driver must enforce

These rules come from what the vendor tools themselves do.

1. **Allowlist, never blocklist.** Most vendor web tools **flash firmware over the same WebHID channel** as settings:
   - ASUS Gear Link OTA, Corsair Web FW Updater, Pulsar WebDRV `.bin` streaming;
   - Lamzu / WLMouse / G-Wolves DriverCore page 0xB0, Darmoshark / VGN report 0xB2;
   - NuPhyIO, DrunkDeer 0xF9, Wuque group 8, RY5088 0x7F/0xAC;
   - Ducky One X OTA, Wootility bootloader, Keychron 0xAA/0xAB + WebUSB DFU, Qudelix extension DFU, Finalmouse Web Serial.
2. **Never open bootloader or upgrader identities.** Examples:
   - ASUS `1948, 194A, 1AAF, 1ACF, 1AD1, 1C11, 1C6A, 1C7E, 1CAD, 1D4D, 1D69, 1D6D` and `hidPattern 3` entries;
   - Endgame Gear `3367:1977`;
   - Lamzu `373E:B01C/B01D/B01E`, `37B0:0002/0004/0006/0008/000A/0012/0018/0033/0041`;
   - Finalmouse `361D:0111/0201`, `1FC9:0021/0022`;
   - NuPhy upgrader PIDs, `19F5:AFxx`;
   - Pulsar `2E3C:AF01` (assumed);
   - generic `0483:DF11`, `03EB:2FF0–2FF9`.
   - Show "device is in bootloader mode, use the vendor tool" instead.
3. **Commands that must never be reachable from generated UI:**
   - Razer Set Device Mode except 0 and 3;
   - Pulsar 0x0B SetDeviceVidPid / 0x0C SetDescriptorString / 0x0D EnterUsbUpdateMode / 0x11 EnterMTKMode / 0xF0;
   - Compx 0x01 DownLoadData (except G-Wolves' handshake shape), 0x0D, 0x5A/0x5B;
   - Endgame Gear `A1 3A` (the bootloader latches across replugs);
   - Wooting KEYS_OFF 0x15 (locks the keyboard), 0x02, 0x2B;
   - VIA 0x0B; Logitech HID++ 0x00C0–0x00D0, 0x1802, 0x1805, 0x1806, 0x1E00;
   - Corsair Bragi resources 0x05/0x06 (pairing id / encryption key);
   - ASUS `7B AA 41 53 55 53 AA`, `7F 55 AA 55 AA`.
4. **Confirm-gated actions** (typed confirmation, backup first): factory resets (ATK 0x09, Pulsar 0x09, Endgame 0x13, RY 0x01, Sonix 0x0F, MCHOSE area 238, Keychron 0xA7/0x11, DrunkDeer 0xAA), receiver pairing/unpairing, profile wipes.
5. **Calibration is high-risk** and gets an explicit flow with a warning, wired only. Examples: magnetic switches on G-Wolves 0x2E, Lamzu page 3 / cmd 7, Finalmouse TMR 27/28, Keychron 0xA9/0x40, ASUS `80 27`, Razer analog calibration, Sonix 0x64/0x65.
6. **Identity before writes.** Query firmware model ids (RY 0x8F, CID/MID, product code, type code) and **unit precision** (RY 0xE6, ASUS `magKeyUnit`, DrunkDeer firmware dialect) before any write. Wrong units have caused 10× actuation errors (DrunkDeer-Control v2.2.0).
7. **Read-modify-write only.** Endgame Gear's documented zero-blob wipe. Never leave Corsair in Bragi software mode. Pace SteelSeries commands at ≥ 50 ms. Rate-limit flash-backed lighting writes.
8. **Supply chain:** never download or run vendor executables. The Endgame Gear tool was trojanized (XRed) from 2025-06-26 to 2025-07-09.

## 8. License summary

| Source | License | Use in SYNQ |
|---|---|---|
| @openmouse/protocol, @openmouse/keyboard-protocol | AGPL-3.0-or-later | code (already a dependency) |
| sharkfin, FCC, Janlhin EG configurator, OpenLinkHub, G-Helper, d0da, ninjutso-rs, open-pulsefire-haste, KludgeKnight, Rangoli, libhmk/hmkconf, the-via/app + keyboards | GPL-3.0(-or-later) | code |
| HeadsetControl | GPL-3.0-or-later | code |
| openrazer, OpenRGB, QMK, Vial, Keychron QMK, roccat-tools, Linux hid-roccat, Solaar | GPL-2.0-**or-later** per file SPDX headers (several repos ship only a GPL-2.0 COPYING file, so re-check the header of every file you port) | code (under GPL-3.0) |
| ckb-next, Nuitfanee/ClickSync | GPL-2.0 (no "or later" seen) | **docs-only** |
| libratbag, AutoEq code, universal-analog-plugin, SparkLink SDK, AureTrix, glorious-ctl, mxw, attack-shark-x11 drivers, DrunkDeer-Control, pulsar-mouse-linux, ry5088-flasher | MIT | code |
| devicePEQ (excluding its vendor captures) | 0BSD | code |
| Wooting RGB / Analog SDKs | MPL-2.0 | code (keep file headers) |
| rivalcfg | WTFPL | code |
| gloriousctl | EUPL-1.2 | code (EUPL lists AGPL as compatible) |
| cli-drunkdeer, egg-mouse | Apache-2.0 | code |
| HallJoy, egctl | AGPL-3.0 | code |
| monsgeek-akko-linux, mojobojo/drunkdeer-daemon, sing2293/gravastar, epomaker-controller, santeri3700 Dart RE, unlicensed Attack Shark repos | none | **docs-only** |
| Every vendor web configurator (Synapse Web, Gear Link, Web Hub, Wootility, Launcher, NuPhyIO, Antler, Bibimbap, Xpanel…) | proprietary | **docs-only** (read for interoperability, no copying) |
| AutoEq measurement data, walkplay.json | third-party, terms UNVERIFIED | fetch on demand, don't bundle |

## 9. Main sources

Every per-claim URL is inline above and in the research notes.

**Vendor configurators:**
- Mice and multi-device:
  - <https://synapse.razer.com/dashboard> · <https://www.corsair.com/web-hub/index.html> · <https://www.corsair.com/firmware-updater/index.html> · <https://gearlink.asus.com>
  - <https://engineforchromebook.steelseries.com/> · <https://bbb.pulsar.gg/> · <https://www.lamzu.net/> · <https://xpanel.finalmouse.com/> · <https://www.ninjaforce.co/>
  - <https://hub.atk.pro> · <https://hub.vgnlab.com/> · <https://gm.wlmouse.gg> · <https://mouse.xyz> · <https://www.darmoshark.cc/>
- Keyboards:
  - <https://wootility.io> · <https://launcher.keychron.com> · <https://nuphy.io> · <https://app.monsgeek.com> · <https://drunkdeer-antler.com>
  - <https://duckyhub.io> · <https://varmilo.kbhub.org> · <https://drive.rkgaming.com> · <https://hub.epomaker.com> · <https://magnet.aulastar.com>
  - <https://drives-hid.wuquestudio.cn> · <https://www.illumipc.com/> · <https://usevia.app> · <https://vial.rocks>
- Audio: <https://peq.szwalkplay.com> · <https://fiiocontrol.fiio.com> · <https://core.jdslabs.com> · <https://autoeq.app>

**Open source:**
- OpenMouse and its protocol packages:
  - <https://github.com/OpenMouse-Project> · <https://openmouse.app/supported.html>
- Brand-specific protocol projects:
  - <https://github.com/openrazer/openrazer> · <https://github.com/flozz/rivalcfg> · <https://github.com/libratbag/libratbag> · <https://github.com/pwr-Solaar/Solaar>
  - <https://github.com/jurkovic-nikola/OpenLinkHub> · <https://github.com/ckb-next/ckb-next> · <https://gitlab.com/CalcProgrammer1/OpenRGB> · <https://github.com/seerge/g-helper>
  - <https://github.com/Janlhin/Endgame_Gear_Web_Configurator>
- Keyboard projects:
  - <https://github.com/shybruh/FightingControlCenter-FCC> · <https://github.com/dniminenn/sharkfin> · <https://github.com/Keychron/qmk_firmware>
  - <https://github.com/the-via/app> · <https://github.com/vial-kb/vial-gui> · <https://github.com/qmk/qmk_firmware> · <https://github.com/WootingKb/wooting-rgb-sdk>
  - <https://pypi.org/project/d0da/> · <https://github.com/AnalogSense/universal-analog-plugin> · <https://github.com/peppapighs/libhmk>
- Audio projects:
  - <https://github.com/jaakkopasanen/AutoEq> · <https://github.com/jeromeof/devicePEQ> · <https://github.com/Sapd/HeadsetControl>

**Platform:**
- <https://chromium.googlesource.com/chromium/src/+/refs/tags/153.0.8010.37/services/device/hid/hid_service_win.cc>
- <https://source.chromium.org/chromium/chromium/src/+/main:services/device/public/cpp/hid/hid_blocklist.cc>
- <https://issues.chromium.org/issues/536063911>
- <https://github.com/libusb/hidapi>

**Incident:** <https://www.bleepingcomputer.com/news/security/endgame-gear-mouse-config-tool-infected-users-with-malware/>.

**Main UNVERIFIED items:**
- VAXEE and Madlions web-driver URLs; Razer `B00x` PIDs.
- Logitech RAPID PIDs and analog feature ids; HyperX Haste 2 and Turtle Beach Burst/Kone II PIDs; SteelSeries Apex Pro analog protocol.
- Whether `0416:7372` illumipc boards equal `C365`; whether RK BeiYing boards accept the 0x0A protocol on `FF00`.
- The kbhub (Ducky/Varmilo) command set; NuPhy area numbers vs MCHOSE.
- Moondrop FreeDSP free-vs-fixed bands; AutoEq data terms; WebView2 `navigator.hid`; Edge 153 parity.
