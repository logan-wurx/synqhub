# SteelSeries Apex keyboards (GG protocol) — desktop only

Protocol notes for SYNQ's SteelSeries driver (`src/lib/brands/steelseries/`). Everything below is either read
from the SteelSeries GG 121.0.0 installer as data, or taken from open-source projects that captured / tested the
bytes on real keyboards. **Nothing was sent to any device, and SYNQ has not been tried on a SteelSeries board:
every model is tier `read-only`.**

Paths in citations are relative to the Wave 4 scratch folder `wave4-src/steelseries/`:

| Path | What |
|---|---|
| `installer/SteelSeriesGG121.0.0Setup.exe` | the installer (433,340,936 B, SHA-256 `2fffd8fe5a22172f6d8c47bdcd79237c097f0691d6c7db531fa4d37e2dc21907`, logged in `wave4-src/DOWNLOADS.md`) |
| `keep/nsis/files.tsv` | installer manifest: data offset, size, install path, magic of all 3,368 files |
| `keep/nsis/header.bin` | decompressed NSIS header (string table holds the EULA) |
| `keep/gg/apps/engine/db/migrations/**.sql` | GG engine SQL migrations (plain text): `devices`, `physical_devices` rows |
| `keep/gg/apps/engine/firmware/<VID<<16\|PID>/version.json` | firmware line GG ships per PID |
| `keep/gg/apps/engine/configurationMigrations/apex*.migration` | GG's Lisp settings migrations (plain text) |
| `keep/gg/apps/engine/deviceSpecifications/apex*.edevice` | per-device descriptors — **encrypted**, not read |
| `keep/asar/render/463.js` | GG UI bundle from `resources/app.asar` (device pages); cut-out modules in `keep/ui-modules/` |
| `keep/gg-actuation-tables.json` | the actuation tables pulled from 463.js (source of `tables.ts`) |
| `keep/nsis/engine.strings.txt` | strings of `apps/engine/SteelSeriesEngine.exe` (offset = file offset in the exe) |
| `oss/…` | open-source cross-check copies (commit SHAs in `oss/SHAS.txt`) |

Extraction (no vendor code run): NSIS firstheader at file offset `0x13C00`, solid LZMA (props `5D`, dict 64 MiB),
streamed with Python `lzma` (`tools/steelseries/nsis_stream.py`), file names from the header's `EW_EXTRACTFILE`
entries (`nsis_header.py`), app.asar read with `tools/asar.py`. Bulky payloads were deleted afterwards.

## What the installer does and doesn't give us

* **Plain text, used:** the device catalogue (PIDs, GG names, bootloader PIDs, default settings JSON), the
  firmware line per PID, and the UI's per-model actuation tables + value meanings (release modes, sensitivity
  scale, defaults). These pin the *values*.
* **Encrypted, not used:** the per-device command builders live in `deviceSpecifications/*.edevice`. Each file is
  an armored OpenPGP message (`-----BEGIN DESCRIPTOR-----`; first packet `C3 1E 04 07 03 08` = symmetric-key
  session key, AES-128, iterated+salted S2K, SHA-256, followed by an encrypted data packet; see
  `keep/gg/apps/engine/deviceSpecifications/apex_pro.edevice`). The engine decrypts them itself
  (`golang.org/x/crypto/openpgp.ReadMessage`, `keep/nsis/engine.strings.txt` @`0xbaf783`). **I did not try to
  decrypt them**: that would mean pulling a key out of the engine to get around a protection the vendor chose,
  which goes beyond "read the installer" and should be the developer's call (see EULA below). So the *byte layouts*
  below come from community USB captures / tools, and GG's plain-text data is used to cross-check them.
* The Go engine (`SteelSeriesEngine.exe`, go1.24.3) only carries generic plumbing (`MultiWriteBufferWithProtocol`,
  `FindPhysicalDeviceByBootloaderPId`, `not-bootloader` …) — no Apex byte strings.

### EULA

The installer's licence (NSIS string table, `keep/nsis/header.bin` @`0x7ef52`, UTF-16) says users may not
"reverse engineer, decompile, disassemble, translate, or attempt to derive the source code". The same section
carves out decompiling to the extent local law requires it for interoperability, after first asking SteelSeries
for the information. The installer was never run, so its licence was never accepted on this PC. Not legal
advice; worth the developer deciding before shipping anything SteelSeries-specific.

## Cross-check sources

| Tag | Project | Covers | Licence / use |
|---|---|---|---|
| [zunuza] | `github.com/zunuza/apex-control@5d07f1d` (`oss/zunuza/apex-control/docs/PROTOCOL_NOTES.md`, `docs/reference/*.txt`) | Apex Pro TKL 2019 `1038:1614`, fw 4.16.8: USB captures of GG, actuation replayed on hardware | MIT (data reused in tests with attribution) |
| [rikearon] | `github.com/Rikearon/apex-control@f7db8c5` (`oss/Rikearon/apex-control/docs/PROTOCOL.md`, `Sources/ApexKit/Protocol/Actuation.swift`) | Apex Pro TKL Gen 3 wired `1038:1642`, fw 1.19.7, many commands verified on hardware | MIT; PROTOCOL.md CC BY 4.0 — credit "Apex Control (github.com/Rikearon/apex-control)" |
| [opengg] | `github.com/GUHPY/OpenGG@1853cfb` (`oss/GUHPY/OpenGG/docs/protocol.md`, `ApexProtocol.cs`) | Apex Pro TKL Wireless Gen 3: receiver `1038:1644`, cable `1038:1646`, fw 3.24.1, hardware-tested | Non-commercial licence: **facts only, no code or text copied** |
| [openrgb] | `CalcProgrammer1/OpenRGB@9515475` `Controllers/SteelSeriesController/` (`oss/openrgb/`) | Apex lighting (direct, brightness, init/onboard), PIDs | GPL-2.0-or-later: learned from, not copied |
| — | `Ven0m0/steelseriesgg-rs` (`oss/Ven0m0/…`) | 1628 notes (0x2D actuation from command probing) | MIT; **not used** — probing results contradict GG's per-key data model |

rivalcfg was checked: mice only, nothing for Apex keyboards.

Confidence labels used below: **captured** (GG's own traffic on this PID, replayed on hardware), **source-hw**
(open-source tool for this PID, tested by its author), **cross-checked** (matches GG's plain-text data too),
**open-source** (one project, no hardware note for this PID), **inferred**.

## Models and PIDs (VID `0x1038`)

PIDs, GG names and bootloader PIDs from `devices` / `physical_devices` rows in the SQL migrations; firmware line
from `firmware/<id>/version.json`. A receiver maps to its keyboard via `devices_to_physical_devices`.

| PID | GG name | Model | Line (fw) | Bootloader | SYNQ does | Evidence | SQL citation (`keep/gg/apps/engine/db/migrations/`) |
|---|---|---|---|---|---|---|---|
| `1614` | apex_pro_tkl | Apex Pro TKL (2019) | legacy 4.16.8 | `1615` | actuation, colour, brightness, profile, fw | actuation **captured** + table cross-checked | `3.15.0/20190607095158_squash.sql:1778`, `:2371` |
| `1610` | apex_pro | Apex Pro (2019) | legacy 4.16.8 | `1611` | same as 1614 | inferred (same fw, same GG map 26977 Wp, same 68-key default) | `…:1120`, `:1773` |
| `1640` | apex_pro_2024 | Apex Pro (2024, Gen 3 full size) | legacy 4.16.8 | `1641` | colour, brightness, fw (actuation shown only) | open-source ([openrgb]) | `gg-71.0.0/20240916111722_squash.sql:4`, `:23` |
| `1612` / `1618` | apex_7 / apex_7_tkl | Apex 7 / 7 TKL | legacy 4.16.8 | `1613` / `1619` | colour, brightness, fw | open-source | `3.15.0/…:4`, `:587` / `:592`, `:1115` |
| `161C` | apex_5 | Apex 5 | legacy 2.1.1 | `161D` | colour, brightness, fw | open-source | `3.17.2/20200117160341_squash.sql:4`, `:557` |
| `1652` / `1650` | apex_7_2024 / apex_5_2024 | Apex 7 / Apex 5 (2024) | 4.16.8 / 2.2.3 | `1653` / `1651` | fw only | inferred | `gg-73.0.0/20241014153235_squash.sql:12,16` / `:3,7` |
| `1642` | apex_pro_tkl_2024 | Apex Pro TKL (2024, Gen 3) | single 1.19.7 | `1643` | actuation, rapid trigger, sensitivity, colour, region/layout, fw | **source-hw** + table cross-checked | `gg-71.0.0/…:29`, `:48` |
| `1628` | apex_pro_tkl_2022 | Apex Pro TKL (2023) | single 1.19.7 | `1629` | colour, fw (actuation shown only) | open-source | `gg-25.0.0/20220926100614_squash.sql:449`, `:887` |
| `1660` / `1662` | apex_pro_tkl_2024_cyber / _steel | Apex Pro TKL Cyber / Steel | single 1.20.00 | `1661` / `1663` | fw only | inferred | `gg-117.0.0/20260811100835_squash.sql:997,5461` / `:5463,9927` |
| `161E` / `1648` | apex_pro_mini / apex_pro_mini_2024 | Apex Pro Mini / Mini (2024) | single 1.19.7 / 1.19.6 | — | fw only | inferred | `gg-20.0.0/20220616103339_squash.sql:4` / `gg-76.0.0/20241202181419_squash.sql:3` |
| `1644` → `1646` | apex_pro_tkl_wireless_2024(_dongle) | Apex Pro TKL Wireless (2024) receiver | wireless 3.24.1 | `1645` | actuation, rapid trigger, sensitivity, colour, connection/battery | **source-hw** + table cross-checked | `gg-71.0.0/…:76`, `:79` |
| `1646` | apex_pro_tkl_wireless_2024 | same keyboard on its USB cable | wireless 3.24.1 | `1647` | actuation, sensitivity, colour, battery | **source-hw** | `gg-71.0.0/…:54`, `:75` |
| `1630` → `1632` | apex_pro_tkl_wireless(_dongle) | Apex Pro TKL Wireless (2023) | wireless 3.24.1 | `1631` / `1633` | receiver: colour + status; cable: nothing | open-source / inferred | `gg-25.0.0/…:440,443` / `:4,441` |
| `1624` → `1626` | apex_pro_mini_wireless(_dongle) | Apex Pro Mini Wireless | wireless 3.24.1 | `1625` / `1627` | detected only | — | `gg-20.0.0/…:784,787` / `:405,785` |
| `1620`, `1634`, `161A`, `1622`, `1616` | apex_9_mini, apex_9_tkl, apex_3, apex_3_tkl, apex_150 | Apex 9 Mini / 9 TKL / 3 / 3 TKL / 150 | other | `161B`, `1623`, `1617` | not claimed (detect only) | — | `gg-23.0.0/…:75,335`, `3.17.0/…:4`, `gg-9.0.0/…:5`, `3.11.3/…:4` |

Firmware lines (`keep/gg/apps/engine/firmware/2721111{20,24,…}/version.json`): **legacy** = "4.16.8/4.16.8"
(keyboard-app + lighting-app MCUs; Apex Pro / TKL 2019, Apex Pro 2024 full size, Apex 7), **single** = "1.19.x" /
"1.20.00" (TKL 2023/2024, Cyber, Steel, Minis), **wireless** = "3.24.1" (nordic + stm + dongle). The command sets
below follow these lines, which is why the 2024 *full-size* Apex Pro (legacy line) and the 2024 TKL (single line)
need different drivers despite the shared "Gen 3" name.

## Transport

| | All Apex lines |
|---|---|
| Interface | vendor collection, usage page `0xFFC0`, usage `0x0001` (mi_01 wired; mi_03 on the wireless keyboard) [zunuza][rikearon][opengg][openrgb `IPU … 0xFFC0, 1`] |
| Report id | none (WebHID report id `0`) |
| Output / input | 64 data bytes. Short commands go out as **output** reports; replies and ACKs come back as **input** reports on the same collection |
| Feature | bulk frames. Data length: **642** legacy [zunuza wLength 642; openrgb 643 incl. id], **644** single [rikearon; 645 incl. id per steelclock-go PR #50], **641** wireless [opengg 642 incl. id] |
| Other collection | `0xFFC1` input-only notifications — never used |

Handshake: none needed for settings. Single line: `4B` (output) before a direct-colour frame [rikearon][openrgb].
Wireless: while a temporary colour (`61`/`21`) is active the receiver drops advanced feature commands without an
ACK, so `62`/`22` is sent first [opengg "Shared channel"]; every wireless feature write waits for its ACK
(`<op> 00`), minimum ~31 ms apart [opengg]. Legacy / single feature writes have no ACK.

## Commands SYNQ builds (`protocol.ts`)

`[hid, h, l]` = HID usage, actuation threshold, release threshold (raw Hall units, `l ≤ h`). All frames are
zero-padded; the guard refuses any non-zero tail.

### Legacy line (1610 / 1614; lighting also 1640, 1612, 1618, 161C)

| Command | Report | Bytes | Read-back | Confidence / source |
|---|---|---|---|---|
| Firmware version | output | `90 00` (keyboard), `90 01` (LED MCU) → input: bare ASCII `"4.16.8"` | — | captured [zunuza "reply begins 34 2e 31 36 2e 38"]; [openrgb GetVersion] |
| Live actuation (global / per key) | feature 642 | `31 47` + 68 × `[hid, h, l]`, keys `04–28, 2A–39, 64, 87–8B, E0–E7, F0` ascending | **none** (live value not readable; not stored in the profile) | **captured** [zunuza "Actuation"] + values = GG map `keep/asar/render/463.js` @397836 (module 26977 `Wp`). GG's default 1.8 mm = `32 2E` — byte-identical with every captured frame (test golden) |
| Brightness | output | `23 <0..10>` | `A3` → `A3 00 <level>` (`A3 FF` = unsupported; SYNQ offers brightness only if this read answers) | open-source [openrgb SetBrightness/ReadBrightness] |
| Direct colour | feature 642 | `3A <n> [led,R,G,B]×n`, LEDs `04–64, 87–8B, E0–E7, F0, FB` | none (volatile) | open-source [openrgb SetLEDsDirect]; GG's `3a 57 04 …` refresh seen in [zunuza] |
| Lighting back to profile | output | `3B` | — | open-source [openrgb `APEX_GEN1_PACKET_ID_ONBOARD`] |
| Select profile Config N | output | `89 <1..5>` | **none** — no "active profile" query exists [zunuza] | captured [zunuza "Profile switching"] (GG also sends `69` when slot 1 is involved; SYNQ doesn't) |

Not used: `85 00 <slot> <region> …` + `83 00 00 <half> 00 02` (profile flash read, hardware-verified by [zunuza];
would give *stored* values, not live) and the whole profile write transaction (BLOCKED).

### Single line (1642; colour also 1628)

| Command | Report | Bytes | Read-back | Confidence / source |
|---|---|---|---|---|
| Firmware | output | `90 00` → `90 00 <ascii "1.19.7">` | — | source-hw [rikearon Queries] |
| Region / layout | output | `F5` → `F5 <err> <region>`; `F2` → `F2 <err> <layout>` (regions 1 US, 3 UK, 4 DE, 6 FR, 10 Nordic, 13 JP, 20 TR; layouts 0 US, 1 EU, 2 JP) | — | source-hw [rikearon] |
| Actuation | feature 644 | `38 61 44 00` + 68 × `[hid, h, l]` | **none** (RAM only) | source-hw [rikearon "Actuation & rapid trigger"]; (l,h) = GG map @411249 (module 29359), identical to [rikearon]'s table |
| Rapid trigger per key | feature 644 | `38 62 44` + 68 × `[hid, mode]`, SYNQ writes `0` off / `2` on | none | source-hw (0/2 verified) [rikearon]; GG page: 3 = protection, 4 = both (@412446 / @412723) — never written |
| RT sensitivity | feature 644 | `38 65 44` + 68 × `[hid, sens]`, sens = mm × 10 (1..40, default 2) | none | source-hw [rikearon]; GG scale + default `A=2` @817292 |
| Direct colour | feature 644 | `4B` (output) then `40 <n> [led,R,G,B]×n`, LEDs `04–45, 49–52, E0–E7, F0, FB` (86) | none; **no safe hand-back** (see `41` below) — the colour stays until unplug | source-hw [rikearon Lighting]; 1628: open-source [openrgb, no `4B`] |

Known but not built: `38 61 44 02` second actuation (dual bind, `FF FF` = off), `38 66 <en>` / `38 67 …` rapid tap
(output), `B6` binding read, `1F 81` live OLED, `B2 <id>` load profile, `83 01 <fs> …` flash read.

### Wireless line (1644 receiver / 1646 cable; colour also 1630)

| Command | Receiver | Cable | Bytes after the opcode | Read-back | Confidence |
|---|---|---|---|---|---|
| Actuation | `6F` | `2F` | `00 44` + 68 × `[usage, l, h]` (**l first** on this line) → ACK `<op> 00` | none | source-hw [opengg "Live settings", 1.5 mm = `1C 1F`]; table = GG map @1372345 (module 98480) |
| Rapid trigger | `76` | — | `44` + 68 × `[usage, 0/1]` → ACK | none | source-hw [opengg]; GG page: release_mode 1 = RT on this line (@1373456) |
| RT sensitivity | `77` | `37` | `44` + 68 × `[usage, sens]` → ACK | none | source-hw [opengg] |
| Direct colour | `61` | `21` | `<n> [usage,R,G,B]×n` (no ACK) | none | source-hw [opengg]; [openrgb] |
| Colour release | `62` | `22` | (output) | — | source-hw [opengg] |
| Connection | `BC` | — | → `BC <1 = connected>` | yes | source-hw [opengg] |
| Battery | `D2` | `92` | → `<op> <state>`: level = state & 7F, % = (level−1)×5, bit 7 charging (scale not calibrated) | yes | source-hw [opengg] |

Rapid-trigger on/off over the **cable** would be `36`, which is the key-binding write on the single line — the
static guard refuses `36` everywhere, so the cable gets actuation + sensitivity only. Protection (`54`), rapid tap
(`57`/`58`) and OLED (`4A`/`4B`, `0A`/`0B`) are known [opengg] but not built.

## Values and units

* **Actuation:** GG's UI maps 0.1 mm steps (0.1–4.0 mm, 40 levels) to `"l:h"` strings per model; the maps are in
  `tables.ts` (generated from `keep/asar/render/463.js`, offsets per table). They are non-linear and differ per
  model (e.g. 1.8 mm = 46/50 on the 2019 boards, 37/40 on the 1642, 38/41 on the wireless 2024). SYNQ only sends
  pairs from the connected model's own table; the guard checks the same. The 2019 boards' **3.2 mm (144/156) is
  refused**: [zunuza] saw key-repeat with it on hardware. GG also keeps a 10-level map (module 26977 `w5`,
  @397430; level 5 = 58/63 = the SQL default `l 58 h 63`, `3.15.0/…:1369`) — unused by current pages.
* **Wire order:** legacy and single send `h, l`; wireless sends `l, h` (see table sources).
* **RT sensitivity:** raw = mm × 10, 1..40, one value for press and release; default 2 (0.2 mm).
* **Release mode** (`release_mode` in GG's settings JSON): legacy pages use `2` = RT plus a separate
  `protection_mode` 0/1 (@564844 / @565021); single pages use 0 / 2 / 3 / 4 (off / RT / protection / both);
  wireless pages use 0/1 plus separate `protection_mode`.
* **GG defaults** (SQL settings JSON): 1614/1610 `l 58 h 63` (10-level map, level 5); 1642 `l 37 h 40` (1.8 mm);
  1646 `l 42 h 47`; `rapid_trigger_sensitivity` 2; `release_mode` 0; second actuation `255/255` (off).

## Read-back summary

| Setting | Read back? |
|---|---|
| Firmware, region, layout, connection, battery | yes (queries above) |
| Brightness (legacy) | yes, `A3` → the plan's read-back compares it ("confirmed") |
| Actuation, rapid trigger, sensitivity (all lines) | **no** — read-back resolves `undefined` ("Unconfirmed"); the panel shows SYNQ's own last write (`cache`). Because every frame carries all 68 keys, a per-key change is refused until SYNQ has set that field for all keys this session |
| Direct colour, active profile | no |

Persistence: analog writes are `volatile` (RAM only on 1642 [rikearon]; not in the stored profile on 1614
[zunuza]); brightness and profile `unknown`; colour `volatile`.

## Dangerous / never-sent commands (`guard.ts` `BLOCKED`)

The guard is default-deny; these are additionally refused by pattern (any report type), before any allow rule.

| Bytes (prefix) | What | Why | Source |
|---|---|---|---|
| `02 ..` | flash profile erase (`02 01 <fs>` wired Gen 3; `02 03 <slot>` / `02 01 <10+slot>` wireless) | profile-wipe | [rikearon] Onboard profiles; [opengg] Profile file reports |
| `03 ..` | flash write chunk (`03 01 <fs> <size> <offset> …`; legacy page data `03 00 00 <half> 00 02 …`) | profile-wipe | [rikearon]; [opengg]; [zunuza] Burst structure |
| `B1 ..`, `E6 ..`, `A6 ..` | validate / commit a written slot | profile-wipe | [rikearon]; [opengg] |
| `42 ..`, `43 ..` | erase / write a keyboard slot through the receiver | profile-wipe | [opengg] |
| `88 ..`, `05 ..`, `EB ..` | legacy profile write: begin region, commit 1 KB page, end | profile-wipe | [zunuza] Write transaction |
| `75 ..` | region write (flash on every call) | identity | [rikearon] Queries & misc |
| `36 ..`, `3C ..`, `35 ..` | key-binding write, Fn-key mask, Fn-key choice (a blank Fn layer erases the factory shortcuts); `36` is also RT on the wireless cable | keymap / profile-wipe | [rikearon] Key bindings; [opengg] |
| `38 83 ..`, `4C ..` | OLED image saved into the flash profile | profile-wipe | [rikearon] OLED; [opengg] |
| `41` | lighting clear on the 1642 but "a reset" on the wireless line — ambiguous | factory-reset (treated as) | [rikearon] Lighting; [opengg] Shared channel |
| `34 ..`, `69`, `74 ..`, `1A ..` | profile volatility; legacy unknowns around profile switches / saves; legacy rapid-tap live switch | unknown | [rikearon]; [zunuza] |
| `53 ..`, `13 ..`, `68 ..`, `28 ..` | wireless slot activation / "use persistent settings" | unknown | [opengg] |

**Firmware / DFU / bootloader:** no command bytes are known — they live in the encrypted descriptors. The engine
treats a device as "in bootloader mode" by its `bootloader_product_id`
(`FindPhysicalDeviceByBootloaderPId`, engine strings @`0xb96801`), which for every Apex is **PID + 1**
(`1611, 1613, 1615, 1617, 1619, 161B, 161D, 1623, 1625, 1627, 1629, 1631, 1633, 1641, 1643, 1645, 1647, 1651,
1653, 1661, 1663`). SYNQ never claims those ids, and every unlisted command is refused. Firmware images ship
in `apps/engine/firmware/<id>/` (e.g. `firmware-apex-pro-tkl-4.16.8.bin` + `keyboard-app.bin` / `lighting-app.bin`;
deleted after the read). No factory-reset, calibration or device-mode command is known for these boards.

## Bridge fixture

`src/lib/brands/steelseries/steelseries-frames.txt` (written by `node scripts/steelseries-allowlist-fixture.ts`,
seed 1038): one line per frame, `<1|0> <hex>`, hex = `00` (report id) + data, trailing zeros dropped. Lines carry no
report type: pad the data to `naturalShape(data).length` and classify it as `naturalShape(data).type`
(`protocol.ts`; output 64, feature 642/644/641 by opcode). `STEELSERIES_BRIDGE` (`devices.ts`) is the matching
hid.rs allowance (page `0xFFC0` only, report id 0).

## What still needs a real keyboard

1. Any write at all with SYNQ (all tiers are read-only). First targets: 1614 global actuation, then per key
   (closest to captured GG traffic), 1642 actuation / RT / sensitivity, 1644 receiver ACK flow.
2. Apex Pro 2019 full size (1610): confirm `31 47` and its key list (inferred from the TKL).
3. Brightness `23`/`A3` on the legacy line (OpenRGB only), and whether `3B` is the right hand-back on firmware 4.16.8
   (GG itself sends `41` there in [zunuza]'s close-out).
4. 1628 / 1630 / 1632 / Minis / Cyber / Steel / 1640 actuation: capture GG once, then enable (tables are already in
   `tables.ts`).
5. Whether live analog writes survive a power cycle on each line (documented as volatile).

## Tests

* `node --test scripts/steelseries-codec.test.ts` — golden frames (incl. GG's captured 1614 frame decoded with GG's
  own table and re-encoded byte-identically), round trips, every BLOCKED pattern refused by every guard, no
  encoder output matches a BLOCKED pattern, out-of-range / unknown / dirty frames refused, fixture line-for-line.
* `node scripts/steelseries.sim.mjs` — simulated 1614 / 1642 / 1644 driven through `steelseriesKbDriver` →
  `KbSession`: values land on the device, brightness reads back "confirmed", analog "unconfirmed", blocked frames
  never reach the device.
