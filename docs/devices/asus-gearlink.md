<!-- Evidence for src/lib/brands/asus (Wave 3a, 2026-10-13). Copied from the research notes; the paths below were temporary downloads (a research workspace, not published) of the public Gear Link files (https://gearlink.asus.com/view/<pid>/...), read as text, never executed. -->

# ASUS Gear Link HID protocol notes (wave 3)

Written 2026-10-13 from Gear Link's public WebHID JavaScript (gearlink.asus.com), fetched with curl and read as
text only. Nothing was executed and no device was touched. Vendor JS is proprietary, so treat these notes as
documentation only and quote only short snippets.

Confidence tags: **SOURCE** = read in Gear Link code. **INFERRED** = reasoned from code or naming, not stated.
**UNKNOWN** = not established. **CAPTURED** = already proven on hardware in SYNQ `docs\keyboard\PROTOCOL.md` (HFX).

## 0. Files and abbreviations

All paths are under `wave3-src\asus\` unless noted.

| Abbrev | File | What |
|---|---|---|
| SDK | `view\7184\chunk-1.00.36-7184-1784799807-12aa25-BJ-_oHSK.js` | Shared device SDK. Every keyboard bundle ships the same library, and a signature check over 7215/7293/7528/7667/7669/7038/7453 matched it (`wave3-tools\sigs.py`). Keyboard base class `j` (offset ~723768), legacy subclass `Wn` (~769209), transport `Ns` (~696499), model switch `initASUSDevices` (~783399). A second, newer "controller" layer for mice and keyboards (classes `ia`, `aa`, `oa`, `ha`) sits at ~330k-625k. |
| UI96 | `view\7184\chunk-...-dDfc5LWq.js` | Azoth 96 HE page logic (hooks `refreshAPDZ`, `refreshRapidTrigger`, `setDevicePollingRate`, the AP/DZ sliders). |
| UI-FAL / UI-FA75 | `view\7215\main-1.00.50-...e3c903.js`, `view\7293\main-1.00.21-...6263b5.js` | Falcata and Falchion Ace 75 HE pages. |
| UI-TX75 / UI-CORE / UI-K4 | `view\7528\main-1.00.14-...917ebd.js`, `view\7667\main-1.00.08-...bf6d1a.js`, `view\7669\main-1.00.03-...c6c2f7.js` | TX75 Analog, TX75 Core and K4 Magnetic pages. |
| UI-HFX | `view\7038\main-1.00.28-...06d08f.js`, `view\7453\...` | HFX and HFX ZywOo pages. |
| MSDK | `..\brands-research\dl-mice-big2\gearlink\views\7600\chunk-C9DkXjFJ.js` | Mouse controller classes (Gladius IV Ace 1.00.10). 6934 and 7273 now also have chunks in `view\6934`, `view\7273` (SDK chunks `...CEOYheup.js`, `...DEK-kehd.js`), and they carry the same mouse command set. |
| MUI | `..\brands-research\dl-mice-big2\gearlink\views\7600\main-1.00.10-...34b199.js` | Mouse page and per-model capability table. |
| OTA | `..\brands-research\dl-mice-big2\gearlink\ota\main.js` | Firmware updater with embedded per-model "DCM" JSON. |
| DEV | `..\brands-research\dl-mice-big2\gearlink\devices.js` | Device picker and collection matcher. |

Folded, readable text copies are in `wave3-src\asus\pretty\`. Helper scripts are in `wave3-tools\`:
`cmds.py` lists makeCommand call sites, `ctx.py` and `show.py` print context, `fwkeys.py` dumps the key table,
`devtable.py` extracts the device table, and `sigs.py` diffs SDK signatures. The FW key table is dumped to
`wave3-tools\fwkeys-7184.json`.

---

## A. Keyboards

### A0. Transport and model classes (SOURCE)

- **Frame:** the keyboard SDK's `Ns.makeCommand(cmd, sub, arg16, payload)` writes `[cmd, sub, arg lo, arg hi, payload...]`.
  A second form, `(cmd, sub, b2, b3, payload)`, writes bytes 2 and 3 directly. Reports are zero-padded to **64 bytes**,
  or **63 bytes** when the control report id is 1 (Omni receiver). Snippet: `const r=this.controlReportId===1?63:64,o=new Uint8Array(r)`.
- **Report ids** (`zs.initialize`):
  - USB: `new Ns(t,…,0)`, so control report id 0.
  - Wireless without Omni: `new Ns(t,…,2)`, so report id 2.
  - Omni receiver: report id 1 for the dongle. Each paired device uses its own `reportId` and `notifyReportId` from `A0 00` (see A8).
  - Events (`registerEventCallback`): input report **3** on USB, **4** for wireless, Omni or the dongle itself.
- **Reply matching** (`Ns.executeCommand`): replies are keyed on report id plus the first 2 bytes. Timeout is 500 ms
  with up to 3 retries. A reply starting `FF AA` means retry or failure. On timeout Gear Link synthesises `FF AA 00 03 03 03`.
  Bluetooth writes are cut to 20 bytes.
- **Model classes** (`initASUSDevices`): M603 Yr, **M605 Xr (extends Wn)**, **M606 Wn**, M701 Zr, M702 Jr, **M703 Qr**,
  M704 qr, **M705 jr**, M706 zr, M709 eo, **M901 so**, X903 io, X904 ao, X906 ro, **R701 en**, **R702 to**, **R704 no**.
  Every class except Wn and Xr inherits the base `j` encoders unchanged; the subclasses only override `customLeverIndex`
  and `getLeverState`. So **all 0.01 mm boards use the `j` encoders, and only the HFX pair uses the legacy `Wn` overrides.**
- **LegacyModel list** (SDK ~706770): `z=[6975,6978,7038,7453,7204,7205,7493,7495,7586,7588].includes(pid)`.
  That covers Azoth Extreme, HFX, HFX ZywOo, Azoth X, KD300 and Azoth Extreme Ed.20.
  Two more lists sit next to it:
  - `$n` = Mac and PID in [7215,7217,7293]. Labelled "MacUseCopilot".
  - `Br` = [7528,7530,7667,7669], which forces KeepCopilot=true. The 7667 bundle's copy also includes 7671 (unknown PID).

### A1. Units and field widths for the magKeyUnit 0.01 boards

**Conversion (SOURCE).** The manifest function `Mo` converts each mm value to device units:
`Mo=e=>{const t=e.magKeyUnit??1;return{DefaultAPValue:(e.defaultAP??0)/t, …MaxRTValue:(e.maxRT??0)/t…}}` (SDK ~315256).
The UI then rounds when it converts back from mm (UI96 ~218291):
- AP: `te=Math.round(te*100)/100*100`, which gives 0.01 mm steps.
- Dead zones: `Math.round(te*10)/10*100`, which gives 0.1 mm steps in the UI, still sent in 0.01 mm units.
- RT: `const P=Math.round(S*100)`, where 0 is bumped to 1 (UI96 ~261035).

**Device value = round(mm / 0.01)** on these boards. On the HFX the same fields carry 0.1 mm units.

| Frame | Field layout (bytes after `cmd sub argLo argHi`) | Widths | Same as HFX? | Cite |
|---|---|---|---|---|
| `51 50 00 00` global actuation | `AA AA` | u16 LE | yes (CAPTURED) | SDK `j.setActuation`: `i=80 … a.push(F(r),E(r))` |
| `51 4F 00 00` per-key actuation | `KK KK AA AA` | key u16, act u16 | yes | same, `i=79` |
| `51 58 00 00` global dead zones | `BB TT` (**bottom first**) | u8, u8 | yes | `j.setDeadZone`: `a.push(s.bottom,s.top)` |
| `51 59 00 00` per-key dead zones | `KK KK BB TT` | key u16, u8, u8 | yes | same, `i=89`. A Gear Link bug turns Escape (enum 0) into a global write, because it tests `if(s.key)`. |
| `51 54 MM 00` per-key RT, **non-legacy** | `KK KK CC EE S1 S1 [S2 S2]` | key u16, continuous u8, enable u8, then **u16** values | **NO** | `j.setRapidTriggerPerKeySettings`: `a.push(F(r),E(r)),a.push(n\|\|i.continuous?1:0),a.push(i.enable?1:0), independent? press16,release16 : sensitivity16` and `makeCommand(81,84,o,a)` with `o=independent?1:0` |
| `51 54 MM 00` per-key RT, **legacy HFX (Wn)** | `KK KK SS CC EE` | u8 sensitivity. MM 0 = combined, 1 = press, 2 = release, sent as separate frames | CAPTURED | `Wn`: `let a=[F(i),E(i),n.sensitivity,s?1:0,n.enable?1:0]` |
| `51 5A MM 00` RT global settings (non-legacy) | `NP CNTlo CNThi CC GE S1 S1 [S2 S2]` | NP = ceil(keys/8), key count u16, continuous, global enable, u16 values. MM 0 = combined, 1 = independent | no (HFX never sends it) | `j.setRapidTriggerGlobalSettings` |
| `51 5B NN 00` RT global key list | `K1 K1 … K8 K8` | ≤8 keys u16. **arg lo = number of keys in this packet**. No packet index is sent. | no | `j.setRapidTriggerGlobalKey`: `const r=0\|i.length … makeCommand(81,91,r,o)` |
| `51 5C 00 00` RT enable (mode on/off) | `EE` | u8 | no (HFX uses a hardware switch) | `j.setRapidTriggerEnable` |
| `51 53 MM 00` RT global, legacy only | `SS CC EE 00` | u8 | legacy | `Wn.setRapidTriggerGlobalSettings` |
| `51 52 TT 00` reset analog trigger | type 0: `AP16 RT16 LY`; 1: `AP16 LY`; 2: `RT16 LY`; 3: `AP16 RT16 BOT LY TOP`; 4: `BOT LY TOP`; 5 (polling), 6 (speed tap): no payload | u16 / u8. LY = layer: 0 Main, 1 FNAndKey, 2 All | same encoder | `j.resetAnalogTrigger`. Azoth 96 UI sends `{type:Actuation, actuation:DefaultAPValue, layer:All}` = `51 52 01 00 64 00 02` and `{type:RapidTrigger, rapidTrigger:20, layer:All}` = `51 52 02 00 14 00 02`. |

**What else changes for the 0.01 boards (SOURCE unless noted).**
- **Key-trigger actuation is u16 on these boards, u8 on the HFX** (A3).
- **DKS end point:** u16 350 (3.50 mm) here, u8 36 (3.6 mm) on legacy.
- **Copilot key code:** 211 normally. On legacy boards, and on a Mac without KeepCopilot, it is 64 (see A9).
- **Key index table:** the same table on all boards (A9). **There is no extra layer byte** in any of these frames.
  Fn-layer keys are addressed as key `0x9F00+code` (A9).

**Which RT commands each UI sends (SOURCE: grep of `setDeviceRT*` in each UI).**
- Azoth 96 HE: `51 5A`+`51 5B`, `51 54`, and `51 5C`.
- Falcata and Falchion Ace 75 HE: `51 5A`+`51 5B` and `51 54`. They never send `51 5C`.
- TX75, TX75 Core and K4: `51 54` per key only (`t.setRapidTriggerPerKeySettings(C)` with no global-continuous argument).
- HFX: `51 54` only (legacy u8 layout).

**Worked examples** (0.01 mm boards; key codes come from A9: W=0x12, A=0x1F, S=0x20, D=0x21):

| Action | Bytes |
|---|---|
| Azoth 96 HE global actuation 1.00 mm | `51 50 00 00 64 00` |
| TX75 default AP 2.0 mm (manifest `defaultAP:2`) | `51 50 00 00 C8 00` |
| Per-key W 0.35 mm | `51 4F 00 00 12 00 23 00` |
| Global dead zones bottom 0.2, top 0.3 | `51 58 00 00 14 1E` |
| Per-key W dead zones bottom 0.2, top 0.3 | `51 59 00 00 12 00 14 1E` |
| RT W combined 0.15 mm, continuous off, enabled | `51 54 00 00 12 00 00 01 0F 00` |
| RT W press 0.10, release 0.25, continuous on | `51 54 01 00 12 00 01 01 0A 00 19 00` |
| RT W disabled (remove from group) | `51 54 00 00 12 00 00 00 <sens16>`. The layout is SOURCE; Gear Link's UI sends nothing for removed keys (HFX CAPTURED). |
| RT global combined 0.20 for W/A/S/D, global on | `51 5A 00 00 01 04 00 00 01 14 00`, then `51 5B 04 00 12 00 1F 00 20 00 21 00` |
| RT mode on (Azoth 96 HE) | `51 5C 00 00 01` |
| Same 1.00 mm on the HFX, for contrast | `51 50 00 00 0A 00` |

Ranges come from the manifests (mm): AP 0.1-3.5 (TX75 0.1-3.4; TX75 Core and K4 0.1-3.3), DZ 0-0.5 (TX75 0-1.0),
RT 0.01-2.5 (TX75 0.01-2.0). Defaults: AP 1.0 (TX75 2.0), DZ 0.2/0.2, RT 0.2. The UI shows a confirm warning
when a dead zone is below 0.2 mm (`te<20?V("TDZ")`). Firmware limits were not probed (UNKNOWN).

### A2. Speed Tap / SOCD (SOURCE)

| Frame | Meaning |
|---|---|
| `51 55 00 00 K1 K1 K2 K2 EE` | Set or clear one pair. EE 1 adds the pair, 0 removes it (`j.setSpeedTap`). |
| `51 56 00 00` | Reset all pairs (`resetSpeedTap`). |
| `51 57 00 00 EE` | Global Speed Tap on/off (`switchSpeedTap`). |
| `51 57 01 00 EE` | "Random delay time mode" on/off. This is `switchSpeedTapDelayMode`, which exists only in the controller layer (SDK ~435237). **No keyboard UI calls it.** |
| `25 01` read | `[4]` = enabled; `[5]` = delay mode (controller `getSpeedTapDelayMode`). |
| `25 08 00 00` / `25 08 01 00` read | Pair table. Page 0 holds 3 pairs at `[4..15]`, page 1 holds 2 pairs at `[4..11]`, each pair `K1 u16, K2 u16`. 0 or 0xFFFF means an empty slot. **At most 5 pairs.** |

- **There is no mode byte** for last-win, neutral or priority. Gear Link exposes only on/off, pairs, and the
  optional random-delay flag. The firmware's resolution behaviour is UNKNOWN.
- UI order on sync: `51 57 01`, then `51 55 <default pair> 00`, then each pair with `01`, then `51 57 <enable>`, then `50 55` (UI96 ~156299).
- Event `78 xx xx EE` (0x78) reports that the Speed Tap state changed.

### A3. Key remap, Fn layer, Toggle, DKS, Mod-Tap (SOURCE, `j.setKeyTrigger`, SDK ~757051)

Source key `SRC` sits in **bytes 2-3** (argLo/argHi). Trigger types: Normal 0, Toggle 1, DKS 2, ModTap 3. Mod-tap kinds: Hold 0, Tap 1.

| Frame | Payload | Notes |
|---|---|---|
| `51 21 SRC SRC` Normal remap | `TGT16 ACT16` | 0.01 boards. Default act is 100. "Back to default" = target equals source. Legacy HFX payload is `TGT16 ACT8` (CAPTURED `51 21 4b 00 7d 00 0a`). |
| `51 22 SRC SRC` Toggle | `TGT16 ACT16 DUR16` | Legacy: `TGT16 ACT8 DUR16`. |
| `51 23 SRC SRC` DKS, one frame per stage 1..4 | `START16 END16(=350) TGT16 POS IDX` | POS = `p0<<6\|p1<<4\|p2<<2\|p3` (four 2-bit fields). IDX = 1..4. The meaning of the 2-bit values is UNKNOWN. Legacy: `START8 36 TGT16 POS IDX`. |
| `51 24 SRC SRC` Mod-Tap, two frames | `KIND TGT16 DUR16` | KIND 0 hold, 1 tap. TGT 0xFFFF = none. DUR defaults to 200 (ms, INFERRED). |
| `51 20 SRC SRC` simple binding | `TGT16` | `j.setKeyBinding`. **Not called by the 0.01-board UIs**; they remap through `51 21`. |
| `71 01 00 00` lever / knob key | `LVR SRC16 TGT16` | LVR = `customLeverIndex()`: M901 9, M703 5, M705 3, R701/R702/R704 5, M605/M606 4. |
| `75 01 00 00` touch panel key | `03 SRC16 TGT16` | |

- **Fn layer:** keys named `Fn_*` map to `0x9F00 + base code` (`[l.Fn_Escape]:40814` = 0x9F6E = 0x9F00+110). Fn-layer
  remaps use the same `51 21..24` frames with SRC = 0x9Fxx. There is no separate layer byte.
- `j.getKeyCode`: on legacy boards 211 maps back to Copilot and 64 maps back to ControlRight.
- Reset frames: `50 60` resets key bindings, `50 61` resets lighting.

### A4. Polling rate (SOURCE)

Keyboard index enum (every bundle): `Hz1000=0, Hz2000=1, Hz4000=2, Hz8000=3`.

| Model | Write | Read | UI choices |
|---|---|---|---|
| Falchion Ace 75 HE, TX75, TX75 Core, K4, HFX | `51 31 00 00 II` (`j.setPollingRate`) | `12 15` → `[4]` index (`getPollingRateIndex`) | 1000 / 8000 (`u=[{value:…Hz1000,label:"1000Hz"},{value:…Hz8000,label:"8000Hz"}]`). On TX75 and K4 the event `GameModeChanged` (0x82) makes Gear Link write 8000 when game mode is on and 1000 when off. |
| **Azoth 96 HE, Falcata** | **mode system** `80 xx` (`j.setPollingRateSetting`, then `savePollingRateSettings`) | `25 24` → `[4]` mode; per key `25 25 KK KK` → `[4]` mode, `[5]==1` means 8K, else SPS | NormalMode / ZoneMode / PowerSavingMode, with per-key sub-mode SPS or 8K |

Mode-system frames:
- Modes: Normal 0, Zone 1, PowerSaving 2. Sub-modes: None 0, SPS 1, Hz8000 2.
- Opcode r = `0x20` Normal, `0x22` Zone, `0x24` PowerSaving.
- Sub-mode None: send `80 r 00 00`.
- Otherwise: `80 r SS 00 NP CNTlo CNThi`, then key packets `80 (r+1) NN 00 K16×≤8`.
- Then always `80 25 00 00` (savePollingRateSettings), then `50 55`.
- The UI sends the SPS key list and the 8K key list as two separate calls.
- What "SPS" means is UNKNOWN. Gear Link turns lighting off in Zone and PowerSaving modes (`will apply none light effect`).

### A5. Debounce and other global keyboard settings (SOURCE unless tagged)

| Frame | Meaning | Used by these UIs? |
|---|---|---|
| `6C 00 00 00 NN` | setDebounceTime. **Units UNKNOWN.** | No keyboard UI calls it. |
| `51 62 00 00 EE` | Fn key mode | Falchion Ace 75 HE; read `25 28`. |
| `51 63 00 00 EE` | "WT mode" (meaning UNKNOWN) | Falchion Ace 75 HE; read `25 3A`. |
| `80 28 00 00 EE` | Left-half Fn key | Falcata; read `25 26`. |
| `51 0A 00 00 MM` | RGB indicator mode (0 Normal, 1 Power) | |
| `51 38/39/3A 00 00 VV` | Idle time / power saving / low-power level (`j.setPower`: IdleMode 56, PowerSaving 57, LowPower 58) | Wireless boards. |
| `74 00 00 00 EE` | SW mode; read `27 00` | |
| `73 00 00 00 EE` | WDL (Windows Dynamic Lighting); read `12 16` | |
| `51 51 00 00 [K16]` / `51 61 00 00 [K16]` | DKS notify / key-travel notify. Starts event streams 0x73 and 0x7E (live key-travel view). | |
| `51 25 KK KK`, `51 26`, `51 27 KK KK SW` | Plugin key binding / combination key / select key switch type | Controller layer only. **Switch type affects analog calibration, so block it** (INFERRED). |

### A6. Profiles and save (SOURCE)

- **Select:** `51 00 00 00 PP` (`j.changeProfile`).
- **Save current profile:** `50 55 00 00` (`setProfile(SetCurrentProfile)`). Gear Link sends it after every change.
- **Resets:** `50 40 00 00 00` resets the current profile, `50 40 00 00 01` resets **all** profiles.
- **Profile numbering:** `12 00` reply `[8]` = profile count N, `[10]` = current profile.
  The UI list (`initProfileOptions`) is "Default Profile" with value **N** (6 on six-profile boards), then
  "Profile 1".."Profile N-1" with values 1..N-1. Index 0 is never used. This resolves the HFX open question:
  **"Default Profile" is 6.**

### A7. Lighting (SOURCE)

- `51 2C TT NN …`: the `j.setLightingEffect` encoder is shared by all keyboards, so it is **identical to the HFX layout (CAPTURED)**.
- Effects: 0 Static, 1 Breathing, 2 ColorCycle, 3 Reactive, 4 Rainbow, 5 Ripple, 6 StarryNight, 7 Quicksand, 8 Current, 9 RainDrop.
- Side light `51 2E` (TX75, TX75 Core, K4 have `hasSideLight`). Effects: Wave 0, Marquee 1, Static 2, Breathing 3, Rainbow 4. The Rainbow arg = `(pktsLeft<<8)|4`.
- Analog effect `51 2D LL 00 TT EE`. Reads: `25 0E TT NN` lighting, `25 1E TT NN` side light, `25 03 LL 00 TT` analog effect (`[4]==1`).
- `80 14 NN 00` = resetLightEffect.

### A8. Read commands and reply layouts (SOURCE)

**Which boards read settings back:**
- **Azoth 96 HE, Falcata and Falchion Ace 75 HE read everything back with the v1 getters.** `refreshProfileSettings` runs:
  power `12 01`, then polling, then key triggers `25 02` for **every key plus every Fn_ key**, then AP/DZ
  (`25 05`, `25 0A`, then `25 04`/`25 09` per key), then RT (`25 22`, `25 23` pages, `25 00`, `25 06` per key), then OLED.
- **TX75, TX75 Core and K4 read back with the V2 getters:** `25 A4`, `25 A9`, `25 A2`, `25 A6` per key, plus `25 00`,
  `12 15`, `25 01`, `25 08`. They compare against the manifest defaults instead of a global read.
- **HFX and ZywOo run "Legacy Mode":** their UI reads only `25 00`, `25 01`, the analog effect and polling, and stores
  everything else in the Companion (CAPTURED).

| Read | Reply layout |
|---|---|
| `12 00` BasicInfo | USB: fw = `[7][6]`.`[5]`.`[4]` (hex). Wireless: fw at `[14][13]`.`[12]`.`[11]`. `[8]` profile count, `[9]` current effect, `[10]` current profile, `[15]` current side-light effect. |
| `12 01` CurrentPower | `[5]` battery %, `[6]` idle (255 = off), `[7]` power saving, `[8]` charging, `[9]` low-power level, `[10]` secondary battery |
| `12 03` ConnectionType | `[4]`: 0 USB, 1 wireless, 2 BT, 255 unavailable |
| `12 12` Layout/Nation | `[4]` layout (1=104, 2=105, 3=107), `[5]` nation |
| `12 14 00` / `12 14 01` / `12 14 02` | FWInfo `[4]` = demo-mode flag / ISN / SSN (ASCII `[4..15]`) |
| `12 15` | Polling index `[4]` |
| `12 16` | WDL `[4]` |
| `25 00` | RT mode `[4]` |
| `25 01` | Speed Tap `[4]` enabled, `[5]` delay mode |
| `25 02 00 00 KK KK` key trigger | type u16 `[2..3]`. Normal/Toggle: `[4..5]` target, `[6..7]` act. DKS: `[4..5]` start, `[6..7]` end, then 4×(tgt u16 + pos byte) at `[8..19]`. ModTap: `[4..5]` duration, `[6..7]` hold, `[8..9]` tap. |
| `25 A2 00 00 KK KK` (V2) | Same but `[4..5]` echoes the source and every field shifts +2. Toggle adds duration at `[10..11]`. DKS stage targets come from `25 29 KK KK` at `[6..17]`. |
| `25 04 00 00 KK KK` / `25 05` | Per-key / global actuation u16 at `[4..5]` |
| `25 A4 KK KK` / `25 A5` (V2) | Actuation u16 at `[6..7]`, key at `[4..5]` |
| `25 06 00 00 KK KK` | RT per key: `[2..3]==1` means independent, `[4..5]` sens or press, `[6..7]` release, `[9]` enable |
| `25 A6` (V2) | `[6..7]` sens/press, `[8..9]` release, `[10]` continuous, `[11]` enable |
| `25 09 00 00 KK KK` / `25 0A` | Per-key / global dead zone: `[4]` bottom, `[5]` top |
| `25 A9` / `25 AA` (V2) | `[4..5]` key, `[6]` bottom, `[7]` top |
| `25 0D 00 00 KK KK` | Binding target u16 `[4..5]` |
| `25 22` RT global | `[2..3]==1` independent, `[4]` packet count, `[5..6]` key count, `[7..8]` sens/press, `[9..10]` release, `[11]` continuous, `[12]` global enable |
| `25 23 00 PP` | Global key list page PP (packet index in **byte 3**): keys u16 from `[4]` |
| `25 24` / `25 25 KK KK` | Polling mode / per-key sub-mode (A4) |
| `25 0B`, `25 0C`, `22 01` | Lever state / lever key / current lever |
| `25 10`, `25 11`, `25 12` | Touch panel |
| `21 00`, `23 xx`, `24 xx` | OLED animation / info |
| `7D 20 02` | Booster connected `[4]` |

**Events** (input report 3 or 4; `j.setupServiceEventHandler`):

| Event | Meaning |
|---|---|
| `70` | Hotkeys (HW reset 0x101, profile 0x201..) |
| `73` | DKS |
| `74` | Mod-tap |
| `75`/`77` | Actuation changed: key `[1..2]`, value `[3..4]` |
| `76` | RT mode |
| `78` | Speed Tap state |
| `7C`/`7D` | RT changed: press `[3..4]`, release `[5..6]` |
| `7E` | Key travel |
| `7F` | Polling mode |
| `81` | Power, connection, autonomous mode |
| `82` | Game mode |
| `91` | Lever mode |
| `92` | Brightness |
| `93`-`97` | OLED, touch panel |
| `50` | WDL |
| `51` | SW mode |
| `72` | Plugged |

### A9. Key index table (SOURCE: `Me.NORMAL`, SDK ~706900, dumped to `wave3-tools\fwkeys-7184.json`)

- **It is the same IBM-style table as the HFX `FW_KEY`.** All 120 SYNQ entries match except three that Gear Link
  makes conditional:
  - `[l.MetaLeft]:Ee?60:59` (Mac 60, else 59)
  - `[l.MetaRight]:Ee?62:65535`
  - `AltLeft` swaps the same way on Mac (INFERRED)
- `IntlRo` = 56, which SYNQ names `Brazilian`.
- **Additions:**

| Key(s) | Code(s) |
|---|---|
| Copilot (`ms?211:64`) | 211 when KeepCopilot, else 64. Legacy boards: 64 in the table, but 211 when assigned as a target. |
| SpaceRight | 212 |
| LeverUp / Mid / Down | 164 / 165 / 166 |
| TP_* touch panel | 193-198 |
| MacroKey | 240 |
| CombinationKey | 4081 (0xFF1) |
| WS_* Windows shortcuts | 768-778 |
| MS_* mouse functions | ~484-496 |
| AV_* media keys | e.g. VolDown 188 |
| DefaultKey / Disabled / Undefined | 255 / 0 / 65535 |
| Fn layer | 0x9F00 + code |

- A UK table (`NORMAL_UK`) is selected when `12 12 [5]` reports the UK nation.
- Azoth 96 HE numpad codes come from the same table (Numpad0 99, NumpadEnter 108, Numpad7 91, Numpad8 96, Numpad9 101, NumpadAdd 106). Its knob/lever uses lever index 9.

---

## B. Mice (controller layer, MSDK; same command set in 6934 / 7273 / 7600)

**B0. Frame and transport (SOURCE).**
- Frame: `makeCommand(cmd,sub,arg16,payload)` writes `[cmd, sub, argLo, argHi, payload]`.
- Sent on `controlDeviceReportID` (0 on USB). Frames are padded to at least 20 bytes: `s.length<20?…new Uint8Array(20)`.
- Report length comes from the output report in the HID descriptor (`getControlReportLength`). The fallback is
  `connectionType===USB?64:20`.
- The OTA DCM notes say the P729 uses report id 0 with a **63-byte** report on 0xFF01, so take the length from the descriptor.

### B1. `51 31 <index> 00` performance block (SOURCE)

| index (arg) | Payload | Encoding |
|---|---|---|
| 0..3 | `RAW16 [R G B]` | DPI stage n uses arg n-1. RAW = `Math.floor(dpi/base)-1`. **base = 1** for p724, p725, p726, p728, p729, p730 (`sa=["p724",…,"p730"],de=sa.includes(z)?1:50`); **50** for every other model. |
| 4 | `II 00` | Polling: **0=125, 1=250, 2=500, 3=1000, 4=2000, 5=4000, 6=8000** (`va` enum). The UI switches motion sync off when it selects 8000. |
| 5 | `II 00` | Button response (debounce): ms = **(II+1)×4** (log: `（${(k+1)*4}ms）`). Supported on md301, p724-p726, p729, p730. OpenMouse offers 12-32 ms (II 2..7). |
| 6 | `EE` | Angle snapping 0/1 |
| 9 | `SS 00` | Switch active DPI stage 1..4 |
| 10 | `NN` | DPI stage count 1..4 |
| 11 | `LO HI` | Angle tuning, int16 LE (read as signed: `s&32768?s\|0xFFFF0000:s`) |
| 12..15 | `X16 Y16 [R G B]` | Split X/Y DPI for stage n (arg 12+n-1), same RAW encoding |
| 18 | `EE` | Motion sync |
| 19 | `MODE FPS` | Sensor mode: 0 Dynamic, 1 Office, 2 LowPower, 3 HighPerformance, 4 Corded. FPS: 0 = 13K, 1 = 20K. |

**Per-model capabilities** (MUI `nC`):

| Group | Models | Max DPI | Stages | Extras |
|---|---|---|---|---|
| 1 | p523 (Gladius III Core), p524 (Harpe Mini Core) | 12000 | 4 | snapping, DPI colours. p523 also: static polling 125-1000. |
| 2 | md301 | 8000 | 3 | button response |
| 3 | p713, p714, p716, p718, p722, p727 | 42000 | 4 | split DPI, angle tuning, snapping |
| 4 | p723, p731 (Harpe II Ace, PBZ) | 42000 | 4 | group 3 + motion sync |
| 5 | p724, p725, p726, p729, p730 | 65000 | 4 | group 4 + button response, DPI step 1 |
| 6 | p728 (Spatha X 65K) | 65000 | 4 | group 5 + static polling 125-1000; no Corded sensor mode |

Worked example: Gladius IV Ace (p729, base 1), stage 1 = 1600 dpi → `51 31 00 00 3F 06`. Harpe II Ace (p723, base 50), 1600 dpi → `51 31 00 00 1F 00`.

### B2. LOD, surface, power, zones (SOURCE)

| Frame | Meaning |
|---|---|
| `51 35 00 00 MODE MAT K0 K1 K2` | `setCalibration2`. MODE: 0 PresetSurface, 255 LOD. MAT = surface enum: 0 ROG Whetstone, 1 Sheath, 2 cloth, 3 plastic, 4 glass, 5 metal, … |
| `51 35 TT 00 MAT HEIGHT 00 K0 K1 K2` | `setCalibration`. TT: 0 preset, **1 manual**, 255 disabled. Manual calibration waits up to 30 s; reply `[6]` = 0x01 ok, 0xFA fail. |
| `51 35 01 00 MODE NLOD LIFT DROP 00 MLOD` | LOD. MODE: 0 Normal, 1 AsymmetricInterrupt, 2 ManualCalibration. NLOD: 0 Low, 1 Mid, 2 High. |
| `51 35 02 00 EE` | Track on glass. Gear Link waits for an echo with `[4]==EE` (5 s). |
| `51 37 00 00 SLEEP 00 LOW% 00 FULLFX WAKE CHGLIGHT` | Power config. SLEEP: 0=1, 1=2, 2=3, 3=5, 4=10 min, 255 = never. |
| `51 43 00 00 LOW% POLLIDX` | Smart battery |
| `51 44 00 00 EN POLLIDX DPI16` | Zone mode, basic |
| `51 44 01 00 EN POLLIDX DPIX16 DPIY16 TXPWR` | Zone mode, advanced. POLLIDX: 0=4000, 1=8000. TXPWR: 0 FullPower, 1 EnvironmentAdaptive. |
| `51 38 00 00 NORM BACK` | Dock indicator (0 Polling, 1 DPI, 2 Profile, 3 Power, 4 WirelessEnv, 255 Off) |
| `51 32 00 00 L R` | Dongle LED indicators |
| `51 39 00 00 EN LOGO SCROLL SIDE` | Smart light. **Meaning differs from keyboards (PowerSaving), so encoders must be per family.** |
| `51 42 00 00 EE` | **Mouse = WDL state; keyboard = demo mode.** |
| `51 41 00 00 EE` | **Mouse = demo mode**; keyboard controller = BLE host LED |
| `51 30 00 00 EE` | SW mode |
| `51 22 00 00 L16 R16 M16` | Rapid fire. **The same opcode is Toggle on keyboards.** |
| `51 21 00 00 BTN16 FUNC16` / `51 23 …` | Button map / shift-layer map |
| `51 21 01 00 BTN16 {key, act(2 kb press, 1 kb release, 18 ms press, 17 ms release), delay16}… FF` | Combo key (`51 23 01 00` for the shift layer) |
| `51 28 AREA 00 EFFECT BRIGHT R G B DIR RAND SPEED` | Lighting. AREA: 0 logo, 1 scroll, 2 base, 3 all, 4 dongle. Effects: 0 static, 1 breathing, 2 cycle, 3 rainbow, 4 reactive, 5 comet, 6 power, 240 off. |

### B3. Mouse reads (SOURCE)

| Read | Reply |
|---|---|
| `12 00 00 00` device info | `[4..7]` u32 version (`>>16`.`>>8`.`&FF`, hex); this is the dongle fw when wireless. `[8]` profiles, `[9]` effects, `[10]` current profile (0-based, so +1), `[11]` DPI index, `[12..13]` current DPI, `[14..17]` u32 mouse fw when wireless, `[18]` DPI level count. |
| `12 00 02` | Alive `[4]` |
| `12 00 0E` | Wireless signal `[4]` (0 poor … 3 excellent) |
| `12 00 08`, `12 00 09`, `12 00 0B`, `12 00 0C`, `12 00 0F` | Autonomous / WDL / smart battery info / SW mode / smart light |
| **`12 04 00` performance** | `[4..11]` DPI 1-4 RAW u16 (dpi = (RAW+1)×base). `[12..13]` polling u16 packed: bits 0-3 USB/RF index, bits 4-7 booster index, bits 12-15 BLE index. `[14..15]` button response, `[16]` snapping, `[18..19]` angle tuning int16. |
| `12 04 01` / `02` / `03` / `04` / `05` | Accel/decel u16×2 / split DPI 4×(X,Y) / DPI RGB 4×3 / motion sync `[4]` / sensor mode `[4]`, FPS `[5]` |
| `12 05 00`, `01`, `02`, `07`, `08` | Button maps (u16 each from `[4]`) |
| `12 05 09` / `12 05 0A` + `BTN16` | Combo keys |
| `12 03 AREA` | Lighting: `[4]` effect, `[5]` brightness, `[6..8]` RGB, `[10]` direction, `[11]` random, `[12]` speed |
| `12 06 00` / `12 06 01` / `12 06 02` | Calibration / LOD (`[4]` mode, `[5]` NLOD, `[6]` lift, `[7]` drop, `[8]` sensor-triggered, `[9]` MLOD) / track on glass `[4]` |
| **`12 07 00` battery** | `[4]` %, `[5]` sleep, `[6]` low %, `[7..8]` mV u16, `[9]` charging, `[10]` type, `[11]` full-charge fx, `[12]` wake on motion, `[13]` charge lighting |
| `12 11` | Rapid fire (3× u16) |
| `12 12 00` / `12 12 01` / `12 12 02` | Demo-mode flag / ISN / SSN |
| `12 14 00` / `12 14 01` | Zone mode |
| `12 15` | Smart battery `[4]` en, `[5]` polling index |
| `12 17`, `12 18` | Dock / dongle indicators |
| `12 19` | SKU colour (0 black, 1 white, 2 pink, 3 red, 4 blue, 240 SE) |
| `7D 20 01` / `7D 20 02` / `7D 20 03` | Booster fw/VID/PID, connected, device |

**Receiver (Omni dongle class `Tn`)** (SOURCE):
- `A1 00` → serial ASCII `[4..15]`.
- `A1 01` → fw u32 `[4..7]`.
- `A0 00` → count u16 `[2..3]`, then per device `PID16 reportId notifyReportId` from `[4]`.

**Mouse events** (event report): `12 08 xx`:

| xx | Event |
|---|---|
| 00 | DPI channel |
| 01 | Profile |
| 02 | Alive |
| 05 | DPI change |
| 06 | Polling |
| 07 | LOD |
| **08** | **All profiles were reset** |
| 09 | Autonomous |
| 0A | Zone |
| 0B | Smart battery |
| 0C | SW mode |
| 0D | Signal |
| 0E | Charging |

`7D 20 04` reports a booster state change.

### B4. Save and profile (SOURCE)

- **Profile select:** `50 02 (P-1) 00`, P = 1..11.
- **Save:** `50 03 00 00`. Gear Link waits for the reply and auto-saves 1500 ms after the last change, retrying up to 3 times (`Fm=1500 … e.saveCurrentProfile()`).
- **Mice do not use `50 55`.**
- `52 00`-`52 03` (setProfile / doSaveNow / resetAllProfiles / resetCurrentProfile) belong to the **gamepad** class `tt`, not to mice.
- **No mouse reset-all-profiles command was found in Gear Link**, only the `12 08 08` event.

### B5. Legacy `12 04` read on newer mice (SOURCE)

Yes. The Gladius IV Ace UI calls `getPerformanceInfo` (`12 04 00`) and gets the same layout as OpenMouse `asus/index.js`
for 4-stage mice:
- rate field = dpiStages+0 = 4, debounce = 5, snapping = 6
- reply offsets rate 12, debounce 14, snapping 16
- same debounce formula: `raw*4+4`

Gear Link additionally uses:
- `12 04 01`..`05`
- `51 31` indices 9-19
- base-1 DPI on p724+
- a 4-bit booster field and a BLE field in the polling word. OpenMouse's ASUS driver reads the low three bits (`&0x07`) and the booster nibble.

---

## C. Dangerous commands: block by default (SOURCE unless tagged)

**C1. Never open or write to these PIDs.** They are bootloaders.
- **OTA `bootloader_pid` fields:** 0x1948, 0x194A (P510), **0x1AAF** (X901), **0x1ACF** (Omni), **0x1AD1** (SpeedNova 8K / M901 dongle),
  **0x1C11** (Azoth 96 HE), **0x1C6A** (Harpe II Ace), **0x1C7E** (Falchion Ace 75 HE), **0x1CAD** (Cetra Open dongle),
  **0x1D4D** (Keris II Origin KJP), **0x1D69** (TX75 Analog, wired), **0x1D6D** (TX75 Analog, RF).
- **Manifest `hidPattern:"3"`** ("NOT_DEFINED" collection layout; the bundle shows "device is in bootloader mode"):
  0x1B40, 0x1B7F, 0x1C11, 0x1CE9, 0x1CF0, 0x1D46, 0x1D7B, 0x1DA3, 0x1DDF, 0x1DE1, 0x1DF4, 0x1DF6, 0x1E0B, 0x1E4D,
  0x1E5C, 0x1AAF, 0x1AB6, 0x1ACF, 0x1AD1. **Treat all of them as bootloader/recovery (INFERRED, but confirmed for
  0x1C11, 0x1AAF, 0x1ACF, 0x1AD1).**
- Airoha mice (P724, P726, P729, P730) have **no bootloader PID**. They flash in place over RACE (see C3).

**C2. App to bootloader entry (on the normal control collection, report 0):**

| Bytes | Family | Source |
|---|---|---|
| `7B AA 41 53 55 53 AA` ("{ ASUS") | `asus_hid_fwu` jump_to_boot (M901, X901, Omni, M705, P723, P727, P510) | OTA DCM `jump_to_boot_magic` |
| `7F 55 AA 55 AA 00 00 82` | ry5088 ENTER_BOOT, **TX75 Analog**, sent on FF00 / usage 1 / id 0. Byte 7 is a checksum. | OTA `enterBootloader` + DCM `_cmd_note` |
| `43 55 AA 55 AA` | TX75 Analog: put the 2.4 GHz radio into ISP | DCM |

**C3. Bootloader and flash opcodes (block everywhere, even in app mode).** Several overlap app opcodes, so block them by
**PID class**, not opcode alone.
- **asus_hid_fwu:**

| Op | Bytes |
|---|---|
| INIT | `10 'ASUSHIDFWU'` |
| LEAVE | `11 FF` |
| get_app_ver | `12` |
| get_boot_ver | `82` |
| status | `8F` |
| SET_ADDR | `20 a0 a1 a2 a3` |
| ERASE | `1F 01` |
| SET_LEN | `21 lo hi` |
| SET_DATA | `22 len off_lo off_hi …` |
| PROGRAM | `1F 51` |
| CHECKSUM | `8E` (pass `[1]==FA`) |

  Transports: M901 app and boot both on FF00 report 0, 64 B. The Omni dongle uses app FF02 report 1 (63 B) and boot FF00 or FF01 report 0.
- **ry5088 (TX75 Analog bootloader, Feature report 0 on FF01):**

| Op | Bytes |
|---|---|
| init | `BA C0 seq16 len32` |
| verify | `BA C2 count16 sum32 size32` |
| RF radio, after `43 55 AA 55 AA` | `C3`, `44`, `C4` |

- **Airoha RACE** (P724, P726, P729, P730 and dongles; also GC701, O701, B701): HID **Feature 0x14 on usage page 0xFF13**,
  61-byte payloads. Also leave alone the FF14 collection (OUT 0x2E / IN 0x2F) and the FF15 collection (Feature 0x17).
  **Never open FF13, FF14 or FF15.**
- TX75 Core (0x1DF3) uses a different "MFC / 0x7D" FOTA stack (DCM text). **Allow only the `7D 20 01`/`7D 20 02`/`7D 20 03` reads and block every other `7D xx`** (INFERRED).
- The per-device view bundles contain **no** boot-entry bytes. A grep for `123,170,65`, `127,85,170` and `ASUSHIDFWU` over all bundles found nothing. Only `ota\main.js` has them.

**C4. Destructive and state commands in app mode:**

| Bytes | What | Where |
|---|---|---|
| `B0 00 00 00 72 65 73 65 74` ("reset") | deviceReset (keyboard) / resetDongle (Omni) | SDK `oa.deviceReset`, `Tn.resetDongle` |
| `50 40 00 00 01` | Reset **all** profiles (keyboard) | `j.setProfile(ResetAllProfiles)` |
| `50 40 00 00 00` | Reset current profile (keyboard). Allow only with confirm, as HFX Sync uses it. | same |
| `50 60`, `50 61` | Reset key bindings / lighting (keyboard) | same |
| `52 02`, `52 03` | Gamepad reset all / current | `tt` |
| `51 52 TT …` | Reset analog trigger | `j.resetAnalogTrigger` (allow with confirm) |
| `51 56` | Reset Speed Tap | |
| `80 26 00 00 KK KK` | **Keyboard analog key calibration** (30 s, reply `[6]==1`) | `j.setCalibration` |
| `80 27 00 00 KK KK EE` / `80 27 01 00 KK KK EE SW` | **Calibration mode** (V2 adds switch type; TX75, Core, K4) | `setCalibrationMode(V2)` |
| `51 27 KK KK SW` | Select key switch type (calibration-related) | controller `selectKeySwitchType` |
| `51 35 TT …` with TT=1 (manual), `51 35 00 …` K-values | Mouse sensor calibration | `setCalibration`, `setCalibration2` |
| `51 35 01 …` LOD with MODE 2 (manual calibration) | Mouse | `setCalibrationLOD` |
| `51 42 00 00 01` (keyboard) / `51 41 00 00 01` (mouse) | Demo mode | `j.setDemoMode` / mouse `setDemoMode` |
| `A2 00 00 00 EE` | Receiver pairing mode | `Tn.setPairingMode` |
| `A2 01 00 00 05 0B PID16 SN[12 ASCII]` | **Unpair** device | `Tn.unpairDevice` |
| `80 00`/`80 01`/`80 02`, gamepad `SET_GAMEPAD_CALIBRATION` stick/trigger raw writes | Gamepad mode / calibration | gamepad classes |
| `61 xx`, `62 xx`, `67 xx`, `6B 01-03` | OLED image streaming (large multi-packet writes; not dangerous, but heavy) | `setOledCustomImage*` |

- **Serial, MAC or encryption writes:** none found. Only `12 14 xx`, `12 12 xx` and `A1 00` reads exist.
- **"factory", "mfg" or "test" commands:** none found by method-name search.

**C5. Collections the OTA uses:** app FF00/FF01/FF02 report 0 (dongle report 1), boot FF00 or FF01 (TX75 boot = Feature id 0
on FF01), RACE FF13 Feature 0x14, TX75 RF path FF00 usage 0xFF.

---

## D. Collections (SOURCE)

| Device class | Control usage page | Event usage page | Usage | Notes |
|---|---|---|---|---|
| Keyboard | 0xFF00 | 0xFFC0 | 1 | KD300 wireless uses usage 2. Azoth X over BT (M704) uses usage page 0x000C. |
| Mouse | 0xFF01 | 0xFFC1 | 1 | |
| Omni / SpeedNova / Asus dongle | 0xFF02 | 0xFFC2 | 1 | 63-byte reports, report 1 |
| Gamepad | 0xFF03 | 0xFFC3 | | |
| Dock / charger | 0xFF04 | 0xFFC4 | | |

- **Matching** (SDK `SUPPORT_DEVICES`, DEV `z`): `DEV.O` picks a collection with `usage===1` and a usagePage from the
  control list; `_e` does the same for the event list. For mouse, keyboard, headset and dongle the control list is
  [FF00, FF01, FF02] and the event list is [FFC0, FFC1, FFC2]. DEV accepts any of the three pages for any type.
- **hidPattern:** `ab={COMMON:"1",CONTROL_ONLY:"2",NOT_DEFINED:"3"}`.
  - 1 pairs each control collection with an event collection.
  - 2 uses control only.
  - 3 takes the first control match, or the first collection.
- **Gear Link filters `requestDevice` by VID+PID only.** SYNQ should add `usagePage` plus `usage:1` filters and keep a
  blocklist for FF13/FF14/FF15 and for usage 0xFF.
- **Report ids:**
  - Keyboard control: USB 0, wireless 2, Omni = per-device reportId (dongle 1). Keyboard events: 3 on USB, 4 on wireless/Omni.
  - Mouse control: `controlDeviceReportID` (0 on USB).

## E. Things that contradict or extend the prior notes

1. **hidPattern 3 is a collection-layout flag** ("NOT_DEFINED"), not a bootloader flag. The manifests use it for
   bootloader-mode PIDs, and those pages show a "device in bootloader mode" message.
2. **`52 02` is a gamepad command, not a mouse reset.** Mice save with `50 03` only. **`50 55` is keyboard-only.**
3. **Opcodes `51 41` and `51 42` change meaning by family.** Mouse: 41 = demo, 42 = WDL. Keyboard SDK: 42 = demo, 41 = BLE host LED.
   `51 38`, `51 39`, `51 21` and `51 22` also differ between mice and keyboards, so allowlists must be per family.
4. **0.01 boards:**
   - Actuation and dead-zone widths are unchanged: u16 and u8.
   - **RT per key uses a different frame**: u16 values, continuous and enable before the values, one frame per key.
   - Global RT uses `51 5A/5B/5C`. Key-trigger actuation is u16 and the DKS end is 350.
5. **Azoth 96 HE and Falcata do not use `51 31` for polling.** They use the `80 20..25` mode system.
6. **Profile "Default" = N** (6 on six-profile boards). Profile 0 is unused.
7. Airoha mice (Gladius IV Ace, Harpe II Ace Mini, Demon1, Gladius IV Ace Max) flash over RACE on FF13 with no bootloader PID.
   The TX75 Analog enters its bootloader with `7F 55 AA 55 AA 00 00 82` on the **same** FF00/report-0 collection as settings.

## F. UNKNOWN

- Debounce `6C` units.
- The DKS 2-bit position values.
- Speed Tap resolution mode.
- What "SPS" and "WT mode" mean.
- Firmware range limits.
- Whether `51 31` still works on the Azoth 96 HE.
- PID 7671.
- The real report length per mouse (read it from the descriptor).
- Whether every `hidPattern 3` PID is a bootloader (only 4 are confirmed).
