# MAGIC-REFINER X68 HE: configuration protocol

USB `2E3C:C365`, Chrome's HID chooser shows **"X68HE"**. Its official configurator is the WebHID app
at **https://www.illumipc.com/** ("iLLumiPC"). Everything below was read from that site's public
JavaScript on **2026-10-12**. No keyboard was attached, nothing was ever sent to one, and nothing here
has been confirmed on hardware yet.

This replaces the earlier guess (RongYuan RY5088 "GearHub" protocol from qmk.top: feature reports on
`FFFF:0002`, report id 0, checksum byte). **That guess was wrong for this keyboard.** qmk.top never
listed `2E3C:C365`; illumipc does, and speaks a different protocol (below).

Code: `src/lib/x68he-protocol.ts` (codec + allowlist), `src/lib/x68he-layout.ts` (matrix and
layouts), `src/lib/x68he.ts` (session), `src/components/keyboard/X68Panel.tsx` (UI),
`src-tauri/src/hid.rs` (`x68_frame_allowed`, collection filter).
Tests: `node --test scripts/x68he-codec.test.ts` (codec vs illumipc's byte logic) and
`node scripts/x68he-session.sim.mjs` (whole session against a simulated keyboard), both headless;
`cargo test --lib x68` checks the Rust allowlist gives the same verdict as the TypeScript one on the
frames in `src-tauri/src/x68-frames.txt` (regenerate with `node scripts/x68he-allowlist-fixture.ts`).

Labels: **[v2]** current site, **[v1]** old site ("Use Old Version"), **[both]** identical in both,
**[inferred]** follows from how illumipc uses the bytes but nothing proves it, **[unverified]** needs
the real keyboard.

---

## 0. Sources

| What | Where | Notes |
|---|---|---|
| Loader | `https://www.illumipc.com/` | Picks `v2.html` (default) or `v1.html` ("Use Old Version", `#/old`). Build stamp `1791785253956`. |
| v2 app | `/v2.html` -> `/app.js?v=1791785253956` (1.78 MB, Vite, minified only) | SDK class names `SA` (device manager), `zQ` (scheduler), `_Q` (input parser), `WA` device, `XA` trigger, `NA` poll, `LA` SOCD, `Nl` keymap, `KA` macro, `YA` advanced keys, `PA` switches, `IA` lighting, `Zc` facade. `sdkVersion {sdk: "1.1.9", build: "20261008"}`. |
| v1 app | `/v1.html` -> `/js/agreement.min.js`, `wmIndex.min.js`, `deviceConfig.min.js` ... (`?v=1791785072616`) | javascript-obfuscator (string array + base64). Decoded statically (no code run). Same commands and byte layouts as v2. |
| Device list | `/config/device.json` (439 entries; also embedded in app.js) | 264 entries share `2E3C:C365`; the product code tells them apart. |
| Layouts | `/config/keys/<product>.json` | Matrix index, HID code and drawing position per key. |
| Fixed key table | `/config/keys.json` | Action codes for media/mouse/shortcut/lighting keys (hex strings). |
| i18n | XOR+base64 blobs in app.js, key `"witmod-i18n-0x7f"` | English labels used for modes and options. |

Local copies (a research workspace, not published): `illumipc-src\` (current/, old/, pretty/, v1-deob/, i18n/, config/keys/).

## 1. Identification

* WebHID filter **[both]**: `{vendorId: 11836 (0x2E3C), productId: 50021 (0xC365), usagePage: 65307 (0xFF1B), usage: 145 (0x91)}`.
  The v2 filter list (`gA`), all on FF1B:0091: `0416:7472/7402/7372/C345/C375/7000/7474/7500/7501/7410/7502/7600`,
  `17EF:61D4/61D6`, `2E3C:C365/C366/C367/C368/C369/C370/C371/7500/7501/7502/7503/7505`, `117F:4006/4007`, `34D3:5301`
  (`0416:7502` with usage 1; v1's `deviceConfig.min.js` has the same family plus `2E3C:7504/7508`).
  `2E3C:C366` and `:C367` are the same keyboards in gamepad mode (illumipc `getGamePadMode`: pid 50022 = mode 1, 50023 = mode 2).
* `2E3C:C365` is shared by ~260 boards (VL68, WIN 68 HE, Redragon K-series, ATOM HE68, ...). illumipc
  reads the **product code** (command `0x0D`, field 4) and requires it to be in `device.json`.
* X68 HE entries in `device.json` (company `sanpin`):
  `AK1680UKX68ZAXHEARGB` "X68HE", `AK1680BRX68ZAXHEARGB` "X68 HE", `AK1680GUKX68XYXCPHEARGB` "".
  The chooser name "X68HE" matches the first one's `name`, but the USB product string may be the same on
  every variant. **[unverified]** which code the friend's board reports.
* All 58 `AK1680*` / `AK1681*` layouts on `2E3C:C365` share one matrix; only Backslash moves
  (index 58 on ANSI boards, 79 on ISO). SYNQ therefore supports the X68 family by product code
  prefix `AK1680`/`AK1681` (ANSI unless the code says UK/BR), and stays **read-only** for any other code.

## 2. Transport [both]

* Collection **FF1B:0091**, **output** reports via `device.sendReport(1, data)` and **input** reports
  with `reportId === 1`. `data` is always **63 bytes** (`new Uint8Array(63)`), so 64 bytes on the
  wire with the report id. **No checksum, no feature reports.**
* Frame shape: `[cmd, sub, page_hi, page_lo, len, payload...]` for most commands; trigger commands
  (`0x21`) put their sub-command in byte 5.
* Replies come back as input reports on the same collection; illumipc matches them by byte 0 (plus
  per-command rules, `replyRule()` in the codec). Multi-page reads end on a known last page or after
  300 ms of silence.
* Scheduler (`zQ`): one request at a time, default timeout 300 ms, 2 retries for reads, 5 ms pause after
  each fire-and-forget write. Keymap pages wait up to 100 ms for an ack `[0x18, 0|layer]`.
* After keymap writes illumipc polls status (`0x01`) until the "storing" flag (status byte 22 bit 1)
  clears (60 ms steps, 2 s max).
* Optional heartbeat: `0x01` every `heartbeatMs` (not used by SYNQ).
* The page also runs inside a Qt desktop wrapper (`window.qt.hidBridge`, `qwebchannel.js`); same bytes.

## 3. Connect sequence (illumipc v2 `initializeDevice`)

1. Open the device, `0x0D` product (3 tries). Reject if the product isn't in `device.json` (or not in the
   site's brand list; illumipc.com itself has no brand filter).
2. `0x01` status/support flags.
3. `0x21 .. 11` profile-index query (1 s timeout; silence = no onboard profiles).
4. Load `config/keys/<product>.json` (fallback `SI2828HEARGB`), `0x0E` Fn-editable bitmap.
5. Read the current profile: trigger config + every key's trigger, dead zones, poll rate, lighting
   lists + configs, macros (10 slots), advanced keys, SOCD list + switch, switch types, both keymaps.

SYNQ does the same reads (`readAll` in `x68he.ts`), skipping only what the status flags say is absent.

## 4. Commands

Byte positions are 0-based in the 63-byte frame. "len" = byte 4.

### Reads

| Bytes | What | Reply |
|---|---|---|
| `01` | status / support flags | bytes 5..22 = `supportData` (section 5) |
| `0D` | product string | pages; page 0: len at 4, ASCII from 5: `f0,f1,f2,f3,PRODUCT,FIRMWARE,...`; firmware `V1_0_3` shows as `1.0.3` |
| `15` | serial | len at 4 (default 32), ASCII |
| `0E` | Fn-layer editable keys | len at 4, one byte per column, bit = row |
| `0A 00` / `02 00` | light modes (main / side) | len at 4: mode ids, then 4 bytes ending `[.., maxSpeed, maxBrightness]` |
| `07 01` / `08 01` | light config (main / side) | payload from 5: mode, brightness, speed, fg RGB, bg RGB, direction, fullColor, power, timer |
| `09 20` / `09 80` / `09 81` | custom light layer / colours (layers 0/1, 8 pages of 18 keys x RGB) | read only in SYNQ |
| `18 80` / `18 82` | keymap default / Fn | 10 pages, 14 entries x 4 bytes each (index = 14*page + i) |
| `19 8n` | macro slot n (0..9) | pages 0..4; page 0 bytes 5..12 header `[index|0x80 copy, type, ?, stepBytes, count hi, count lo]`, steps `[hid, state<<4|type, delay hi, delay lo]` |
| `22 80` | advanced keys | 40 pages, one per slot (section 8) |
| `24 01` / `24 02` | SOCD list / switch | 2 pages of 10 x `[state, mode, key1, key2]` / payload `[on, ?, ?, ?, key1, key2]` |
| `21 00 00 00 18 04` | trigger config | section 6 |
| `21 00 00 00 18 05 row col` | one key's trigger | section 6 |
| `21 00 00 00 01 09` | poll rate | byte 6 = code |
| `21 00 00 00 00 11` | onboard profile index | reply `[21 .. .. .. .. 11 index 01]` (byte 7 = 1: answer to a query; otherwise the keyboard switched on its own) |
| `25 00` / `25 02` | switch types: list / per key | per key: pages of 58 bytes |
| `26 00` | dead zones | 5 pages, 29 keys x `[top, bottom]` (v1 calls this same frame "resetDeadBand"; it is a read) |

### Writes SYNQ may send (allowlist)

| Bytes | What | Source |
|---|---|---|
| `21 00 00 00 18 MODE bitmap[22] tl tl pl rl th th ph rh` | per-key trigger: MODE 0/12/13, bitmap at 6..27 (column byte, bit = row), travel/press/release little-endian split as shown | XA.setTrigger [v2], setAnyTriggerValue [v1] |
| `21 00 00 00 00 09 01 code` | poll rate (1=1K, 2=2K, 4=4K, 8=8K); **keyboard restarts** | NA.setPollRate |
| `21 00 00 00 00 12 n` | switch onboard profile 0..4 (only if the query answered) | WA.setProfileIndex |
| `18 L 00 page len data` | keymap layer (L 0 = default, 2 = Fn), 10 pages of 56 bytes (last 24) | Nl._sendKeyData |
| `22 slot 00 00 32 type ...` | one advanced-key slot (type 0 clears) | YA.sendAdvancedKeys |
| `24 00 00 page 28 entries` | SOCD table, 2 pages | LA.sendSocdData |
| `24 03 00 00 01 on` | SOCD switch | LA.setSocdPower |
| `07 00 00 00 0E mode bri spd fgRGB bgRGB dir full power timer` | lighting (main; `08` = side) | IA.setConfig |
| `26 01 00 page len data` | dead zones, 5 pages of 58 bytes (last 32) | XA.setDeadBand |
| `14 00 00 00 01 00 .. b12 b13 b14 b15 .. b17 b18` | Win lock (12 Win, 13 Shift+Tab, 14 Alt+F4, 15 Alt+Tab), 17 "super performance", 18 6-key mode; **byte 5 must be 0** | WA._writeDeviceSettings |

Everything else is refused by `checkFrame()` (TypeScript) and again by `x68_frame_allowed()` (Rust,
where the bytes leave), including writes illumipc has but SYNQ doesn't use: macros (`19 0n`,
`19 03`), custom per-key colours (`09 00/01`), music rhythm (`17`), sleep timer (`14 01`), trigger test
(`21 .. 02/03`).

## 5. Status flags (`01` reply, `n = bytes 5..22`) [v2 WA.initSupport]

| Byte | Meaning |
|---|---|
| n[0] == 1 | Win-lock settings available |
| n[9] == 1 | SOCD |
| n[10], n[11] | super-performance supported / on |
| n[12] | bits: 0x01 any-key calibration, 0x02 custom light, 0x04 switch types, 0x08 poll rate, 0x10 dead zones, 0x20 music rhythm, 0x40 report key settings, 0x80 6-key switch |
| n[13] | bits: 0x01 **high precision** (0.01 mm units), 0x02 light position switch, 0x04 gamepad, 0x08 RS, 0x10 RKRT, 0x20 DKS mouse, 0x40 MDS, 0x80 travel precision |
| n[14] == 1 | calibrated |
| n[15] | Win lock bits: 0x01 Win, 0x02 Shift+Tab, 0x04 Alt+F4, 0x08 Alt+Tab |
| n[16] == 1 | music rhythm on |
| n[17] | 0x01 6-key mode, 0x02 **storing to flash** |
| byte 10 | tri-mode (wired/2.4G/BT); sleep timer only for 1/2 |

## 6. Triggers

Config reply (`21 .. 04`), personal edition (`type 0`) [v2 XA.getTriggerConfig]:

* `unitMm = (byte7 || 10) / (highPrecision ? 1000 : 100)` (so 0.01 mm or 0.1 mm per unit)
* `maxUnits = byte9 << 8 | byte6`, `minUnits = byte10`, or when 0: 1 unit for 0.1/0.08 mm, 3 for 0.04 mm
* actuation range `minUnits..maxUnits` x unit; rapid-trigger range `unit .. ceil(max/2/unit)*unit` mm;
  dead zones 0..1 mm (UI); illumipc's default RT sensitivity is 0.5 mm.

Per-key reply (`21 .. 05 row col`): `mode = b6`, `travel = b11<<8 | b7`, `press = b13<<8 | b9`,
`release = b14<<8 | b10`, row/col echoed at 15/16.

Modes illumipc writes (TriggerPanel): **0** fixed actuation, **12** rapid trigger (press = release),
**13** rapid trigger with separate press ("interval1") and release ("interval2"). Mode 1 is only
recognised when read (older firmware). Key index = `row * 22 + col` (6 x 22 matrix).

## 7. Keymap entries

4 bytes per matrix slot, 132 slots per layer, stored exactly as written:

| Byte 0 | Meaning | Bytes 1..3 |
|---|---|---|
| 0x00 | HID keyboard usage | usage, 0, 0 (0/0 = disabled) |
| 0x01 | Fn key | 0xFA, 0, 0 |
| 0x02..0x06 | lighting functions | 02:02 next effect; 03:00/01 brightness +/-; 04:00/01 speed +/-; 05:02 direction; 06:00/01/02 full colour / next fg / next bg |
| 0x07 | media/app | 13 play/pause, 16 stop, 15 prev, 14 next, 12 mute, 10/11 vol +/-, 30 player, 34 this PC, 32 calculator, 20 mail, 23 browser, 21 search, 24 back, 25 forward, 22 bookmarks, 27 refresh, 26 stop |
| 0x10 | macro | key's hid, macro slot, 0 |
| 0x11 | locks | 00 lock keyboard, 02 lock Win, 04 lights off |
| 0x12 | mouse | **swapped**: wheel flag, button/direction, 0 (01 L, 02 R, 04 M, 08 fwd, 10 back; wheel 01 01 up, 01 FF down) |
| 0x13 | combination / shortcut | up to 3 HID usages (first ones modifiers), e.g. `13 E3 07 00` = Win+D |
| 0x17 | advanced key | slot, slot, 0 |
| 0x18 / 0x19 | gamepad (classic / Xbox) | button |

illumipc rebuilds the whole layer from the layout file plus its overrides and writes all 10 pages.
SYNQ instead reads the layer, changes only the chosen slots and writes the read table back, so
slots outside the layout keep whatever the keyboard had.

## 8. Advanced keys (`22`, 40 slots) [v2 YA]

| Type | Byte 5 | Layout from byte 6 | Bound by |
|---|---|---|---|
| DKS | 1 | 6..9 travel points (0.1 mm: press, bottom out, release, back up; illumipc default 1.5 / max-0.4 / max-0.4 / 1.5 mm); 4 x (action[4] at 10+8r, steps[4] at 14+8r) | keymap `17 slot slot 00` |
| MT (tap/hold) | 2 | 6..9 hold action, 10..13 tap action, 14 hold time in 10 ms (default 15) | keymap |
| TGL | 3 | 6..9 action | keymap |
| RS | 4 | 6..9 key A action, 10/11 row/col A, 12..15 key B action, 16/17 row/col B | its own row/col (no keymap entry) |
| RKRT | 5 | 6..9 main key action, 12..15 action sent on release | key code (no keymap entry) |
| MDS (combo macro) | 6 | 6..7 duration (BE), 8 mode (0 after delay / 1 when all detected), 9 count, 10.. HID usages (max 6, max 5 MDS entries) | keymap |

DKS step cells (from illumipc's editor) **[inferred names]**: 0 nothing, 1 tap at this point, 2 hold
starts / continues, 3 hold ends. illumipc always writes all 40 slots, then re-reads them.

## 9. SOCD (`24`)

Up to 20 pairs `[state=1, mode, key1 HID, key2 HID]`, packed in list order, plus a master switch.
Modes (illumipc labels): **0** "the first triggered key is interrupted" (last input wins, i.e. snap
tap), **1** key 1 wins, **2** key 2 wins, **3** "the later key only interrupts" (neutral). illumipc
turns the switch on when saving a pair and, on non-US layouts, writes HID 0x32 when key 2 is 0x31.
The friend has SOCD on A (0x04) and D (0x07); that is `24 00 00 00 28 01 00 04 07 ...` in mode 0.

## 10. Lighting

Mode ids (English i18n): 0 Static, 1 Breathing, 2 Wave, 3 Neon, 4 Radar, 6 Single key, 7 Aurora,
8 Ripple, 9 Stars, 10 Custom (per-key colours), 11 Crosshair, 12 Speed response, 14 Auto ripple,
15 Marquee, 16 Fireworks, 100 Music rhythm (UI only). Side light: 0 Static, 1 Breathing, 2 Wave,
3 Collision, 4 Neon, 5 Off. `power` **0 = on, 1 = off**. Direction illumipc sets on a mode change:
modes 2/4/15 -> 1, 7 -> 5, 12 -> 2, else 0. Brightness 0..maxBrightness, speed 0..maxSpeed (from the
mode list, usually 4).

## 11. Profiles, polling, other settings

* **Onboard profiles** only when the keyboard answers `21 .. 11`. Otherwise illumipc keeps Default +
  Profiles 1-4 in **browser localStorage** and "switching" clears the keymap, SOCD, advanced keys and
  macros on the keyboard and rewrites everything from the stored profile. SYNQ doesn't copy that
  behaviour: it shows the keyboard's current settings, and switches only real onboard profiles.
* Poll rate change restarts the keyboard ("device will restart and disconnect"); SYNQ waits,
  reconnects and reads the rate back.
* "Other Settings" in illumipc: polling, Win lock + 6-key (`14 00`), sleep timer (wireless only,
  `14 01`/`14 02`), firmware version (download only; flashing is done by a separate tool), factory reset.

## 12. Blocked: never sent by SYNQ

| Bytes | illumipc name | Why |
|---|---|---|
| `0B` | `enterBootloader` | firmware/DFU mode |
| `14 00 00 00 01 01` | `resetKeyboard` (part of **Factory Reset**) | same opcode as Win lock; byte 5 = 1 resets |
| `14 02` | `factoryReset` (same bytes as `getSleepTimer` in v1/v2) | ambiguous, destructive name |
| `14 03 .. 01 mode` | `setGamePadMode` | changes the USB PID (C366/C367) |
| `21 .. 18 06` | `resetTrigger` | wipes every key's trigger (Factory Reset step) |
| `21 .. 18 07 row col`, `21 .. 18 08 00/01`, `21 .. 18 0F`, `21 .. 18 10` | `reviseKey`, `startAllKey`/`stopAllKey`, `startAnyKey`/`stopAnyKey` | **switch calibration** |
| `23 .. 01/00` | `openADC`/`closeADC` | raw sensor stream used by calibration |
| `25 01 ...` | `setKeyAxis` | per-key switch type (Switch Calibration page; changes travel maps) |

illumipc's Factory Reset (`restoreFactorySettings`) = `resetKeyboard` + `resetTrigger` + zero dead
zones + default switch types + clear advanced keys, macros, keymaps, SOCD + Win lock off + gamepad
off + sleep timer 0. Calibration can become a deliberate SYNQ feature later; it is blocked now.

## 13. What SYNQ does with it

* Lists and opens only the illumipc ids (`2E3C:C365/C366/C367/C368`, `0416:7372`; section 16) on collection FF1B:0091; feature reports and unrouted output reports
  are refused for this vendor (hid.rs).
* Reads everything first. Writes stay off until the user flips "Allow changes" (remembered).
  Writes are also off when the product code has no layout (not an AK1680/AK1681 code and not in the catalogue of section 16) or a core read failed.
* Before the first write of a session: `%APPDATA%\com.logan.onboard\keyboard\x68he-<id>-backup-<unix>.json`
  (full read + every raw reply), and `x68he-<id>-original.json` once ever.
* After every write the area is read back and compared; a mismatch is an error and the page shows
  what the keyboard reports.
* HID log: `%APPDATA%\com.logan.onboard\keyboard\x68he-<id>-hid-log.txt` (every frame out and in,
  with timing and the allowlist name). `<id>` = `x68he-` + serial (or product code).
* "Save diagnostics" (read-only): `x68he-<id>-diag-<unix>.json` with everything read, raw replies,
  every HID collection Windows lists for the keyboard, what SYNQ opened, and the log tail.

## 14. Check on the first real run

1. Detection: the keyboard appears as "MAGIC-REFINER X68 HE" (needs a USB product string containing
   X68) and `hid_list` shows collection `ff1b:91` (diagnostics `collections`).
2. Product code and firmware from `0D` (which variant, which layout).
3. Status flags: high precision (0.01 mm?), SOCD, dead zones, poll rate.
4. Every key answers `21 .. 05`; travel values look like millimetres x 100.
5. Keymap pages: 132 slots per layer, default layer matches the layout's factory codes.
6. Does it answer the profile query (`21 .. 11`)?
7. Only then a first write, e.g. one key's actuation, and check the read-back and the log.

## 15. Re-extracting

`curl` the loader, `v1.html`, `v2.html`, `app.js`, `js/*.min.js`, `config/device.json`,
`config/keys/<product>.json`. The research tools used (not published): `x68-tools\pretty.cjs` / `fmt.cjs`
(TypeScript-scanner formatter), `deob.cjs` (static string-array decoder for v1; evaluates the rotation
checksum by walking the AST, never runs the bundle), `i18n.cjs` (XOR + base64 decoder),
`devlist.cjs`, `layouts.cjs`.

## 16. Other boards on this protocol (2026-10-14)

illumipc drives about 260 boards on `2E3C:C365` besides the X68 HE, and SYNQ now knows 47 of them by product code
(`src/lib/illumipc/catalog.generated.ts`, written by `scripts/gen-illumipc-catalog.mjs` from illumipc's public
`config/device.json` and `config/keys/<product>.json`, read 2026-10-14; no keyboard was attached and nothing was sent).

* **Catalogue:** 50 boards, one row per product code: 44 Redragon (company `fengrun_redragon`: 30 on `2E3C:C365`, 14 on
  `0416:7372`), 2 Epomaker (HE60 Lite and HE30, `hongfeng_epomaker`), 1 Womier (M68HE PRO, `KF068USHEARGB`) and the 3 X68 HE
  codes of section 1. Each row has the USB ids it enumerates as, the model name illumipc lists, whether illumipc says it has
  lighting, and a layout. 19 layouts cover them all: ANSI (`"us"`) and ISO / ABNT / UK (`"uk"`), from a 29-key pad to a
  104-key board. `K1USliteBYHEARGB` has no layout file at illumipc; illumipc itself falls back to `SI2828HEARGB`'s, so the
  catalogue does the same and records it (`layoutFrom`).
* **Same matrix:** every layout file indexes the 6 x 22 matrix of section 1 (`index = row * 22 + col`); only the slots used
  differ. Key positions in the files are pixels (38 px per key unit); the catalogue stores key units. A key that is not a
  normal key (Fn, the rotary knob, the custom G keys) is drawn and locked. Layout rows with HID 0 and no special kind are
  dropped.
* **Ids opened:** `2E3C:C365`, the gamepad-mode personalities `C366`, `C367`, `C368` (section 1) and `0416:7372`. All five
  sit on collection `FF1B:0091`, report 1, 63 bytes. Exactly one driver (this one) claims them; the bridge list is generated
  from `src/lib/illumipc/ids.ts`. `0416:7372` has not been seen answering like `2E3C:C365` (UNVERIFIED). The shared id never
  decides the photo or the name: the product code does.
* **Identity** (`identityFor` in `src/lib/x68he-layout.ts`): a catalogue board is named by the catalogue ("Redragon
  K673WB-RGB-M"); a code of the X68 family, a MAGIC-REFINER catalogue row, or a USB name containing "X68" is the MAGIC-REFINER
  X68 HE (the friend's board, whichever AK168x code it reports); anything else is "HE keyboard (<product code>)".
* **Layout choice** (`layoutForProduct`): the three known X68 codes, then the catalogue, then the `AK1680`/`AK1681` prefix rule
  of section 1; any other code gives no layout and the page is read-only.
* **Allowlist unchanged:** `checkFrame` and `x68_frame_allowed` accept exactly what they did, for every board; the blocked
  commands of section 12 apply to all of them. Writes still need "Allow changes", and the page adds a caution line for a
  board other than the X68 HE, whose behaviour was the only one read in full.
* **Tests:** `node --test scripts/illumipc-catalog.test.ts` (counts, ids, layouts, identities),
  `node scripts/illumipc-session.sim.mjs` (a Redragon K673 on `C365`, an M82 on `0416:7372`, the HE60 Lite fallback layout, a Womier,
  an HE30 on `C367`, an unknown code read-only, the X68 family keeping its name).
* **Not covered:** the roughly 190 other illumipc entries (other companies on the same ids) and the `0416` ids of OpenRGB's
  Witmod / Winbond controllers (`0416:C345`, `0416:B23C`): those are not opened, and a keyboard whose product code is not in
  the catalogue is read-only. To add a board, regenerate the catalogue with its company in `COMPANIES`.
