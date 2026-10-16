<!-- Evidence for src/lib/brands/corsair (Wave 3a, 2026-10-13). Copied from the research notes; the paths below were temporary downloads (a research workspace, not published) of the public CORSAIR Web Hub / FW Updater / Sabre Web Hub files, read as text, never executed. -->

# Corsair Web Hub / Web FW Updater / Sabre Web Hub: HID protocol notes (wave 3)

Researched 2026-10-13. Static reading only: no device I/O, no browser, no downloaded code executed.
Vendor JS is docs-only (proprietary). Quote it as evidence, never copy it. ckb-next headers are GPL-2.0 (docs-only).

## 0. Sources and how to cite them

All paths are relative to `wave3-src\corsair\` unless noted.

| tag | file | what it is |
|---|---|---|
| **W** | `assets\BDiHBs-c.js` (2,481,309 B) | Web Hub main bundle. `index.html` (re-fetched 2026-10-13) still loads `./assets/BDiHBs-c.js`, so this is the live build (byte-identical to `brands-research\dl-mice-big1\corsair-web\webhub-main.js`). Every service the brief asked about (HID, CommandProvider, KeyActual, FlashTap, Calibration, DPI, DeviceSettings, GameMode, Profile, PropertyMap, Firmware) is **inline in W**. |
| W-chunks | `assets\*.js` (70 lazy chunks) | Fetched from `https://www.corsair.com/web-hub/assets/<name>.js` (`chunks.txt` lists them). They are only React UI, SVG device art and per-PID layouts, with no protocol code. `assets\icueWebSocketWorker-CW8boWBS.js` is the iCUE hand-off worker. |
| **devices.json** | `devices.json` | The Web Hub device table (33 records). **How it was extracted:** W contains `l2e=JSON.parse('[...]')` at byte offsets 1113725-1144482, then exports `bn={devices:l2e}`. `wave3-tools\devtable.py` slices that string literal (text only), un-escapes `\'` and runs `json.loads`. Cite it as "W `l2e` / `bn.devices`". |
| defaultProfiles.json | `defaultProfiles.json` | Per-model default profiles. Source: W `Oz=JSON.parse('...')` at offset 1670648. Extracted by `wave3-tools\defprof.py` in the same way. |
| dumps | `dumps\*.js` | Line-broken copies of W regions made by `wave3-tools\dump.py` (`transport.js` = W[1140000:1170000], `devicehandler.js`, `keyactual.js`, `services1.js`, `profile.js`, `propmap.js`, `gamemode.js`, `keyassign.js`, `hidservice.js`, `firmware.js`, `byteutils.js`, `keytest.js`). |
| **F** | `fwupd-main.js` (+ `fwupd-config.js`, `fwupd.html`) | CORSAIR Web FW Updater v2.0.232 (`index.BZMlYzc5.js`). Copied from `brands-research`. It has **named** enums (`Ct` commands, `Ke` properties, `Ft` files, `Tt` modes). Region dumps: `dumps\fwupd-core.js` = F[615000:760000] and `dumps\fwupd-hid.js` = F[855000:900000]. |
| M | `fwstore\mapping.json`, `fwstore\manifests\*.json` | Public firmware-storage metadata from `https://www.corsair.com/firmware-storage/firmware/public/`. Only the manifests were fetched, never firmware images. |
| **S** | `sabre\js\index.js` (+ `sabre\js\devicesettings.js`, `pairing.js`, `main.js`, `sabre\products\<PID>\<PID>.json`) | Sabre Web Hub v1.0.77-live (`https://www.corsair.com/sabre-web-hub/`). The JS is obfuscator.io output. `wave3-tools\deob_sabre.py` decodes the string array **statically**: it re-implements the base64 decoding and array rotation in Python and never executes the bundle. Output: `dumps\sabre-deob.js`, `sabre-pretty.js`, `sabre-devicesettings-pretty.js`, and the other `sabre-*-pretty.js` files. |
| ckb | `..\..\brands-research\dl-mice-big1\licenses\ckb_bragi_proto.h`, `ckb_nxp_proto.h` | ckb-next headers (GPL-2.0, docs-only). |

Confidence tags: **SOURCE** = read directly in vendor code or JSON. **INFERRED** = deduced from code that does not state it outright. **UNKNOWN** = not determinable statically.

Minified names below (for example `Di.setCommand` or `xg.readFile`) are the identifiers in W, so grep W for them. Class `Di` = CommandProvider, `xg`/`w` = DeviceHandler, `pu` = HidClient, `En` = HidUtils, `Tp` = HIDService.

---

## 1. Transport per device family

| item | value | tag / citation |
|---|---|---|
| Bragi command collection | usagePage **0xFF42** (65346), usage **1** (`En.USAGE_CUE_REQUEST`) | SOURCE W `class En{...USAGE_PAGE_CUE=65346...USAGE_CUE_REQUEST=1;static USAGE_DEVICE_NOTIFICATION=2` |
| Bragi notification collection | usagePage 0xFF42, usage **2**. It is a separate WebHID `HIDDevice`, paired with the command device by index (`processAndRegisterDevices`). The listener runs on it (`w.updateListeningDevice`). | SOURCE W `processAndRegisterDevices` |
| Alternate page | usagePage **0xFF03** (`USAGE_PAGE_SABRE_DEVICE`) usage 0. One HIDDevice serves as both command and notification channel. No Web Hub PID is known to use it (the Sabre v2 PIDs are redirected instead). | SOURCE W `En`; which PIDs use it: UNKNOWN |
| Output report id | **0** (`Np=0` / `DEFAULT_REPORT_ID`). `sendReport(0, frame)` | SOURCE W `const EH=1,AH=65346,IH=64,Np=0,V3=3e3` |
| Report length | Read from the descriptor of the 0xFF42/usage 1 collection: the first output item with `reportSize==8 && reportCount>10` gives `reportCount`, falling back to the first item. Default **64** (`IH`). Frames are zero-padded to that length. No PID-specific length exists in code, so 8 kHz/HE boards get whatever their descriptor says (UNKNOWN per PID; assume 64 and read the descriptor). | SOURCE W `pu.getReportLength` |
| Reply | The next `inputreport` event on the **same** HIDDevice (`waitForOne`), checked by command echo (byte1 on v1.0, byte3 on v1.5). | SOURCE W `pu.hidTransport` / `validateCommandId` |
| Timing | Timeout 3000 ms. PID 0x2B04: 6000 ms. Sabre v3 PIDs 0x2B3F/40/41/43/44/45 (`Th`, `J2e`): 10000 ms with 3 retries. A 12 ms pause before every send (`s2`). Backoff 250 ms. At most 1 session restart. Every command is serialized by a global mutex and an app queue. | SOURCE W `nI=t=>t&&t===11012?{...timeoutMs:6e3...}` |
| Unused constant | `En.REPORT_ID={CUE_REPLY:1,CUE_REQUEST:2,DEVICE_NOTIFICATION:3}` is declared but never used in the send path. | SOURCE W; purpose UNKNOWN |
| Keyboard vs mouse | Same Bragi transport. Differences come only from the table: `configInHostControl` (mice and receivers = true wrap every file read/write in SET 0x03=2 ... =1) and header size (section 2). | SOURCE W `xg.readFile/writeFile` |
| Receiver addressing | The dongle is the HIDDevice. A sub-device is addressed by putting its address in header byte 0. Address = `log2(GET 0x36 bitmask)`, normally 1. Some ops force address 0 (the receiver itself): polling rate, firmware version, 0x36. | SOURCE W `getConnectedSubDevicesAddress`, `getCommandOptions(e,n)` |
| iCUE coexistence | Before **every** command Web Hub sends `{type:"releaseDevice", devices:[{pid,vid}], applicationUrl}` over WebSocket **ws://127.0.0.1:50123/** to iCUE through a SharedWorker. On disconnect it sends `restoreDevice`. This is host-side only, not HID. | SOURCE W `class Wp`, `assets\icueWebSocketWorker-CW8boWBS.js` |
| **Sabre v2 Pro family** (0x2B28/25/29 mice, 0x2B2A/35/34 dongles) | **Not Bragi.** Web Hub's picker filters `{vendorId,usagePage:0xFF02,usage:2}` (dongles) and `{vendorId,usagePage:0xFF01,usage:0}` (mice), then `window.open("https://www.corsair.com/sabre-web-hub/index.html")` (`redirectUrl:"SABRE"`, `qbe.SABRE`). The Sabre app uses the collection with usagePage 0xFF02, usage 2 and exactly one input report, id **8**; otherwise it reports `FW_NOT_SUPPORT`. Output is `sendReport(8, 16 bytes)`. Input is report 8, 16 bytes, and reports whose `data[0]==0x0a` are dropped. It also uses feature report 6. There is a BT path with 4 collections plus 0x0C/usage 1 report 2. See section 6b. | SOURCE W `Tp.requestDevice`; S `sabre-pretty.js` ~line 6820 and `class A` (`GetReportFunc`, `CommandProcess`) |
| NXP legacy (ckb) | 64-byte feature reports, report id 0, page 0xFFC2. `CMD_SET 0x07`, `CMD_GET 0x0E`, bulk 0x7F/0xFF. Not used by any Web Hub device. | SOURCE ckb `nxp_proto.h` |

---

## 2. Bragi framing: 1.0, 1.5 and "2", and host-software session control

### 2.1 Headers (SOURCE W `class k2e` (4-byte), `class M2e` (2-byte), `Zw.createHeaderCommand`; F `A_.buildHeader`)

| | request header | payload starts | reply layout |
|---|---|---|---|
| **v1.0** (headerSize 2) | `[0x08 + addr, cmd]`. 0x08 = `Device_Itself` ("answer expected"). Using `0x00 + addr` (`Device_Itself_Suppress_Answer`) gives a no-reply frame. addr 0 = the USB device, 1.. = paired sub-device. | byte 2 | `[?, cmd echo, status, data...]`. Status at **byte 2**, data from **byte 3** (`Si(2)={defaultLength:3,commandStatus:2,commandValue:3}`) |
| **v1.5** (headerSize 4, `PROTOCOL_HEADER_SIZE_V1_5=4`) | `[addr, 0x01, sessionId, cmd]`. Byte1 = 1 means answer expected (0 = none). `hidTransport` **overwrites byte 2 with the stored session id (0 if none)** for every cmd except 0x1B. | byte 4 | `[addr?, protocolCode, ?, cmd echo, status, data...]`. Protocol code at **byte 1**: 0 SUCCESS, 1 BUSY, 15 MALFORMED_REPORT (F `Hi`). Status at **byte 4**, data from **byte 5** (`Si(4)`). Reply bytes 0 and 2: UNKNOWN (probably echo). |
| v"3-byte" (F only) | `[addr+8, 0, cmd]` | byte 3 | status byte 3. Not used by any Web Hub PID. |

For GET/SET, F's `buildHeader` appends `[propId, 0]`. That is the same as W's `prop u16 LE` for ids up to 255, and W writes the full u16 for ids 256-298 (SOURCE).

### 2.2 Session control, cmd **0x1B** (`HOST_SOFTWARE_SESSION_CONTROL`, W `Xw=27`)

| step | bytes (64-byte report, id 0, zero-padded) | tag |
|---|---|---|
| start request | `AA 01 00 1B 01 i0 i1 i2 i3 00`. AA = address byte of the command being retried (`startSession(e,n,r[0])`). i0..i3 = 4 random bytes (`crypto.getRandomValues`). | SOURCE W `Di.startHostSoftwareSessionControlCommand`; F `startSession` (`r_=1`) |
| start reply | byte1 = protocol code (0), byte3 = 0x1B, byte4 = status (0), bytes 5-8 = echo of i0..i3 (F verifies, W does not), **byte 9 = session id** (W `g=9` with `d.slice(9,10)`; F `parseSessionPayload`: `sessionId=f[5]` where `f=r.slice(4)`). | SOURCE |
| use | Every later v1.5 frame carries the session id in **byte 2**. | SOURCE W `hidTransport` |
| expiry / restart | If reply byte1 == **15**, or (v1.5) reply byte4 == **3** (INVALID_STATE), W starts a new session and resends once (`maxRestarts=1`). | SOURCE W `validateExpired`, `validateState` |
| when started | W is **lazy**: the first command goes out with session 0, the device rejects it, and W starts the session. It starts eagerly only for PID 0x2B21 (11041) on connect. F starts a session explicitly before updating. | SOURCE W `Tp.requestDevice` (`l.productId===11041&&await pu.instance.startSession(l,4)`) |
| stop request | `AA 01 SS 1B 02 00 00 00 00 SS`. The reply's session id should equal SS. W defines it (`stopHostSoftwareSessionControlCommand`) but **never calls it**. F's `stopSession` sends it. | SOURCE |
| keep-alive | PING (cmd 0x12, no payload) to every connected device every **30 s** (`dye=3e4`). F also pings every 30 s (`lx=3e4`). | SOURCE; that the purpose is keep-alive is INFERRED |
| session-free props | F sends GET USB_VID (0x11) / USB_PID (0x12) with session byte 0 (`getSessionIdWithRule`). | SOURCE F |
| session timeout | UNKNOWN | |

### 2.3 Which header each PID uses

W logic (`xg.initBaseCorsairDevice` / `getProtocolVersion`), SOURCE:
1. If `supportMultiSessionControl` is falsy, the device is **v1.0**.
2. Otherwise, if the table has `bragiProtocolVersion === 1.5`, the device is **v1.5**.
3. Otherwise W probes with GET 0x0105 in a **4-byte frame**: `00 01 00 02 05 01`. If the status is OK and `data[0] + data[1]*0.1 === 1.5`, it uses 1.5, else 1.0. The table value `2` gets no special handling, so it simply falls through to the probe.

F treats a hard-coded PID list as 1.5 and everything else as 1.0 (`x7`). SOURCE F `l_`.

| PID | model | W table bragi / msc | W effective | F | note |
|---|---|---|---|---|---|
| 0x2B0E | Vanguard Pro 96 | - / true | probe (expect 1.5) | 1.5 | |
| 0x2B54 | Vanguard Pro 96 GUMA | - / true | probe | 1.5 | |
| 0x2B0D | Vanguard 96 | - / true | probe | 1.5 | |
| 0x2B0C | Galleon 100 SD | - / true | probe | 1.5 | |
| 0x2B0F | Vanguard 96 Wireless | 1.5 / true | 1.5 | 1.5 | |
| 0x2B21 | Vanguard Air 99 Wireless | 1.5 / true | 1.5 (eager session) | 1.5 | |
| 0x2B30 | Vanguard Pro 60 Wireless | 1.5 / true | 1.5 | 1.5 | `allowAuthentication:false` |
| **0x2B31** | **Clipper Pro Mini 60** | - / - | **1.0 (2-byte header)** | **1.5** | **Conflict.** INFERRED: 1.5 firmware accepts both framings (header byte0 bit 0x08 vs byte1=1). Safest default is W's 1.0 framing. |
| 0x2B1C | Nightsword V2 Wireless SD | 1.5 / true | 1.5 | 1.5 | |
| 0x2B3F, 0x2B40, 0x2B41, 0x2B43, 0x2B44, 0x2B45 | Sabre v3 Pro family | **2** / true | probe | 1.5 | 2B40/41/44/45 have `allowAuthentication:false` |
| 0x2B33 | Harpoon v2 (wired) | **2** / true | probe | 1.5 | `allowAuthentication:false` |
| 0x2B2E | Harpoon V2 Wireless | 1 / false | 1.0 | 1.0 | |
| 0x2B22 | Scimitar Elite Wireless SE | - / - | 1.0 | 1.0 | |
| 0x2B1B, 0x2B42, 0x2B3C | Slipstream v2 receivers | 1.5 / true | 1.5 | 1.5 | |
| 0x2B00 | Slipstream receiver | - / - | 1.0 | 1.0 | |
| 0x2B04 / 0x2B1A / 0x2B5B | MAKR 75 / MAKR Pro 75 / Nene | - / - | 1.0 | 1.0 | |
| 0x2B3D / 0x2B3E | Skiff 100 / Plus | 1 / - | 1.0 | 1.0 | |
| 0x2B25/28/29, 0x2B35/2A/34 | Sabre v2 Pro family | - | not Bragi (section 6b) | not listed | |

Recommendation (INFERRED): never send the 4-byte probe to a device with msc false. W sends it only to msc devices, because on a 1.0 device `00 01 00 02 ...` would parse as a suppressed SET.

---

## 3. Command, property and file enums

### 3.1 Commands. Header byte = cmd. Payload begins right after the header.

| id | W (`Di` method / const) | F `Ct` name | ckb | payload | reply data | tag |
|---|---|---|---|---|---|---|
| 0x01 | `setCommand` (`V2e`) | SET | SET | `prop u16 LE, value[4]` (u32 LE, or raw dataset zero-padded/truncated to 4) | none | SOURCE |
| 0x02 | `getCommand` (`rL`) | GET | GET | `prop u16 LE` | value bytes 0..3, LE | SOURCE |
| 0x03 | `getMultiplePropertyCommand` (`U2e`) | - | - | `count u8, prop u16 LE x count` | UNKNOWN (defined, never called) | SOURCE |
| 0x05 | `unbindBufferCommand` (`j2e`) | UNBIND_BUFFERS | CLOSE_HANDLE | `count u8, bufIdx...` (W/F send `01 bb`) | | SOURCE |
| 0x06 | `writeBufferBeginCommand` (`K2e`) | WRITE_BUFFER_BEGIN | WRITE_DATA | `bufIdx, totalLen u32 LE, data[<= R-hdr-5]` | | SOURCE |
| 0x07 | `writeBuffer` (`H2e`) | WRITE_BUFFER | CONTINUE_WRITE | `bufIdx, data[<= R-hdr-1]` | | SOURCE |
| 0x08 | `readBufferCommand` (`G2e`) | READ_BUFFER | READ_DATA | `bufIdx` | next chunk of file bytes | SOURCE |
| 0x09 | `describeBufferCommand` (`z2e`) | DESCRIBE_BUFFER | PROBE_HANDLE | `bufIdx` | file size u32 LE at data[2..5] | SOURCE W `xg.describeBuffer` |
| 0x0A | `calibrationControlCommand` (`W2e`) | - | - | `action, target`. action: 1 Start, 2 Abort, 3 Reset, 4 Apply. target: 0 MouseSensor, 1 Accel, 2 Gyro, 3 GamepadRest, 4 LTrig, 5 RTrig, 6 LStick, 7 RStick, 8 MagneticSwitch | | SOURCE W `DI`, `RI` |
| 0x0B | `createFileCommand` (`$2e`) | - | - | `fileId u16 LE` | | SOURCE |
| 0x0C | `deleteFileCommand` (`Y2e`) | - | - | `fileId u16 LE` | | SOURCE |
| 0x0D | `openFileCommand` (`q2e`) | OPEN_FILE | OPEN_HANDLE | `bufIdx, fileId u16 LE`. If the open fails with INVALID_STATE, W unbinds and retries. | | SOURCE |
| 0x0F | `resetToFactorySettingCommand` (`Z2e`) | RESET_TO_DEFAULTS | - | `scope` (0 Everything, 1 Property, 2 File). F sends it with no payload. | | SOURCE |
| 0x10 | - | APPLY_FIRMWARE | - | `fileCount, fileId lo, fileId hi, imageType, 0,0,0` | | SOURCE F |
| 0x11 | - | PAIRING_CONTROL | - | `1` START / `2` ABORT (sent to addr 0) | | SOURCE F |
| 0x12 | `pingCommand` (`iL`) | PING | - | none | | SOURCE |
| 0x12 | `pairingCommand` (`iL`) | - | - | `action (1 START / 2 ABORT), 0 (RF), 0 (NO_SECURE)` | | SOURCE W. **W uses 0x12 where F uses 0x11.** |
| 0x16 | - | APPLY_FIRMWARE_EXTENDED | - | `0, 1, fileId lo, fileId hi, imageType, checksumAlg (1=CRC32/MPEG2), crc32[4]` | | SOURCE F |
| 0x1B | `start/stopHostSoftwareSessionControlCommand` (`Xw`) | HOST_SOFTWARE_SESSION_CONTROL | - | see 2.2 | | SOURCE |

Here R = report length (64) and hdr = 2 or 4. Write chunk sizes: v1.0 first 57 / continuation 61, v1.5 first 55 / continuation 59 (W `xg.writeBufferBegin`: `h=(collections[0].inputReports[0].items[0].reportCount??64)-(5+hdr)`, continuations `h+4`).

Status byte (W `me.Status` = F `K2`): 0 Success, 1 Invalid_Argument_Value, 2 Insufficient_Buffer_Size, 3 Invalid_State, 4 Command_Not_Supported, 5 Property_Not_Supported, 6 Invalid_Device_Address, 7 Hardware_Error, 9 Invalid_Operation, 10 Invalid_Firmware_File, 11 Unknown. SOURCE.

Notifications arrive on the notification collection. Notification id = byte1 (v1.0) or byte3 (v1.5), and data starts at the next byte. Ids (W `Yw`): 1 PropertyValueChange (`prop u16, value u32`; prop **0x36** = sub-device connected/changed), 2 KeyPressStateChange, 3 CalibrationProgress, 4 DeviceLifetime, 5 RelativePropertyChange, 6 Accel, 7 Gyro, 8 PairingProgress, 9 Gesture, 10 TriggerPositions, 11 Thumbstick, 12 AnalogKeyPressChange, 13 TouchEvent. SOURCE W `xg.onListening`, `checkNotification`. Payload layouts for 2/3/12: UNKNOWN.

### 3.2 Properties: every id in W's constant block (W offset ~1113000) plus F `Ke` names and ckb names

Width: GET returns 4 bytes and most readers use the low 2. SET always sends 4 bytes LE. Colours are `[B,G,R,0]` (W `she`: "#RRGGBB" becomes `[B,G,R,0]`).

| dec | hex | name (source of name) | values / units | path in W |
|---|---|---|---|---|
| 1 | 0x01 | POLLING_RATE (F, ckb) | 1..7 = 125/250/500/1000/2000/4000/8000 Hz | SET to addr 0, wrapped in mode 2 |
| 2 | 0x02 | BRIGHTNESS (F, ckb) | 0..1000. W writes `round(pct/10)*100` and reads `/10` | SET |
| 3 | 0x03 | OPERATING_MODE (F) | 1 SELF_OPERATED (hardware), 2 HOST_CONTROLLED, **3 BOOTLOADER**, 4 SLEEP, **5 MCU_BOOTLOADER**, 6 LIMITED_HOST_CONTROLLER, 7 ESPORTS (W `Ee`; F rejects values outside 1..7) | SET |
| 4 | 0x04 | DEBUG_MODE (F) | stored in the profile **properties file**. W resets it to 0 after actuation edits when `resetDebugMode:true` (2B0E/2B54) | file |
| 6 | 0x06 | lift height (W `getLiftHeight`) | 1 LOWEST, 2 LOW, 3 MEDIUM, 4 HIGH, 5 HIGHEST, 6 CALIBRATED_VALUE, 7 LOWER (`au`) | SET |
| 7 | 0x07 | angle snapping on/off (W; ckb ANGLE_SNAP) | 0/1 | SET |
| 8 | 0x08 | angle snapping angle | 0..90 degrees | SET |
| 10 | 0x0A | button/key debounce | `5 + n` for UI n = 0..9 (INFERRED ms, 5..14). Also written to 56. | SET |
| 11 | 0x0B | power-saving mode | 0/1 | SET |
| 13 | 0x0D | auto-sleep enable | 0/1 | SET |
| 14 | 0x0E | auto-sleep timeout (normal) | ms u32 (UI minutes x 60000) | SET |
| 15 | 0x0F | BATTERY_CHARGE_LEVEL (F, ckb) | 0..1000, % = round(v/1000*100) | GET |
| 16 | 0x10 | BATTERY_CHARGE_STATUS (F, ckb) | values UNKNOWN (W never reads it) | GET |
| 17 / 18 | 0x11 / 0x12 | USB_VID / USB_PID (F, ckb) | u16. Sent to a receiver it returns the paired device's VID/PID | GET |
| 19 | 0x13 | FIRMWARE_VERSION (F, ckb) | `major u8, minor u8, build u16 LE` | GET (addr 0) |
| 20-22 | 0x14-0x16 | BOOTLOADER_VERSION, SECONDARY_CHIP_FIRMWARE_VERSION, SECONDARY_CHIP_BOOTLOADER_VERSION (F) | same format | GET |
| 24-28 | 0x18-0x1C | DPI stage 1..5 value (W DPIService) | u32 LE DPI | file (profile) or SET |
| 29 | 0x1D | DPI sniper stage value | u32 DPI | same |
| 30 | 0x1E | active DPI stage index (non-profile devices) (ckb DPI_INDEX) | 0..4 | SET |
| 31 | 0x1F | enabled-stage bitmask (ckb DPI_MASK) | bits 0..4 = stages, bit 31 = sniper. Default 0x8000001F | file or SET |
| 47-51 | 0x2F-0x33 | DPI stage 1..5 colour | `[B,G,R,0]` | file or SET |
| 52 | 0x34 | sniper colour | `[B,G,R,0]` | |
| 54 | 0x36 | CONNECTED_SUBDEVICES_BITMAP (F; ckb SUBDEVICE_BITFIELD) | u32 bitmask, address = log2 | GET addr 0 |
| 55 | 0x37 | auto-sleep timeout in power-saving mode | ms | SET |
| 56 | 0x38 | second debounce property (name UNKNOWN) | same value as 10 | SET |
| 58 | 0x3A | connection mode | 0 USB, 1 RF, 2 BLE1, 3 BLE2, 6 RF+BLE, 7 USB+BLE, 8 BLE3 | GET |
| 59 | 0x3B | surface-calibration preset **mode** | 0 CALIBRATED, 1 STORED_PRESET, 2 FILE_PRESET | SET |
| 60 | 0x3C | surface-calibration preset **index** | 0 DEFAULT, 1 MM_GLASS, 2 MM_PRO, 3 SLOWPOKE, 4 MM350_PRO, 5 MM200 | SET |
| 62 | 0x3E | free storage bytes (INFERRED: used for the screen-upload size check) | u32 | GET |
| 65 | 0x41 | physical layout (ckb HWLAYOUT) | 1 ANSI, 2 ISO, 3 BR, 4 JP, 5 KR | GET |
| 69 | 0x45 | Win-lock | 0/1 | SET |
| 73 | 0x49 | profile colour | `[B,G,R,0]` | properties file |
| 74 | 0x4A | UNKNOWN (default 1 in every keyboard properties file) | | file |
| 79, 80, 81, 164, 165 | 0x4F-0x51, 0xA4, 0xA5 | active DPI stage index for hardware profile 0..4 | 0..4 | SET |
| 92, 94, 161, 214, 262 | | UNKNOWN (defaults in the properties map: white, white, red, 0, 0) | | file |
| 93 | 0x5D | Win-lock indicator colour | BGR0 | file |
| 99 | 0x63 | Win-lock indicator behaviour | 0 off / 2 continuous (`lu`: 0, 1 TEMPORARY, 2 CONTINUOUS) | SET |
| 108 | 0x6C | active dial-mode index | | file |
| 110 | 0x6E | **active hardware profile index** | 0..4 | SET/GET |
| 115 | 0x73 | WIRELESS_CONNECTION_CONFIGURATION (F) | UNKNOWN | |
| 120 | 0x78 | console host operation | UNKNOWN enum | SET |
| 150 | 0x96 | maximum polling rate (ckb MAX_POLLRATE) | 1..7 | GET |
| 155 / 156 | 0x9B / 0x9C | Caps / Scroll-lock indicator behaviour | 0/2 | SET |
| 158 / 159 | 0x9E / 0x9F | Caps / Scroll-lock indicator colour | BGR0 | file |
| 176 | 0xB0 | button debounce **algorithm** | 0 best latency, 1 no-slam optimisation | SET |
| 207 | 0xCF | Fn-action indicator colour | BGR0 (raw dataset) | SET |
| 215 | 0xD7 | motion-based power saving | 0/1 | SET |
| 216 | 0xD8 | case colour | 1..7 (read-only enum) | GET |
| 217 / 218 | 0xD9 / 0xDA | SCREEN_MODULE_VERSION / DIAL_MODULE_VERSION (F) | | GET |
| 223 | 0xDF | wireless polling rate (read path) | 1..7 | GET |
| 225 | 0xE1 | Game Mode enabled | 0/1 (W also sets 239 to the same value) | SET |
| 227 / 228 | 0xE3 / 0xE4 | GM lighting override / GM lighting colour | 0/1, BGR0 | SET |
| 229 | 0xE5 | GM USB polling rate | 1..7 | SET |
| 230 / 231 / 232 | 0xE6-0xE8 | SCREEN / DIAL / WIRELESS_MODULE_PRESENT (F) | 0 absent, 1 present, 2 malfunction, 3 incompatible firmware | GET |
| 234 | 0xEA | GM brightness | pct x 10 (0..1000) | SET |
| 235 | 0xEB | GM Win-lock override | 0/1 | SET |
| 236 | 0xEC | GM rapid-trigger override enable (only when the table has `useGameModeRapidTriggerOverrideEnabled`: 2B31, 2B30) | 0/1 | SET |
| 238 / 239 | 0xEE / 0xEF | GM switch animation / GM USB-polling override | 0/1 | SET |
| 240, 242, 243 | | screen start-up animation, screen width, screen height | | GET |
| 250 | 0xFA | GM actuation override enable | 0/1 | SET |
| 251-255 | 0xFB-0xFF | **FlashTap**: enable, mode, indicator colour, key 1, key 2 | see section 4 | properties file |
| 256-260 | 0x100-0x104 | **GM FlashTap**: override enable, mode, colour, key 1, key 2 | same encodings | SET |
| 261 | 0x105 | BRAGI_PROTOCOL_VERSION (F) | data[0] = major, data[1] = minor | GET |
| 263 / 265 | 0x107 / 0x109 | active screen-mode index / active theme index | | properties file |
| 275 / 276 | 0x113 / 0x114 | mouse motion sync / ripple control | 0/1 | SET |
| 278 / 279 | 0x116 / 0x117 | rapid-trigger indicator behaviour / colour | 0/2, BGR0 | SET / file |
| 291 | 0x123 | dynamic dial screen-position index | | GET |
| 298 | 0x12A | PureVector/OmniSense calibrated-surface bitmask | 5 bits | GET |

ckb-only, not used by W: 0x21/0x22 live DPI X/Y and 0x44 coarse brightness.

### 3.3 File ("resource") ids. Opened with 0x0D, read with 0x09+0x08, written with 0x06/0x07, closed with 0x05.

| id | meaning | source |
|---|---|---|
| 2 | key mappings for non-profile devices (`gP`) | W |
| **3** | **FIRMWARE** | F `Ft` |
| **5 / 6** | **PAIRING_ID / WIRELESS_ENCRYPTION_KEY** | F `Ft`, ckb `RES_PAIRINGID 0x05`, `RES_ENCRYPTIONKEY 0x06` |
| 15 (0x0F) | profiles list: `hdr u16 (0x0013), count u16, profileFileId u16 x count` | W `Cd`, `fx=19` |
| **18** | **SECONDARY_CHIP_FIRMWARE** | F |
| **20** | **BLUETOOTH_DEVICE_ADDRESS** | F |
| 36 | PAIRED_SUBDEVICES_IDS (read only): `hdr[2], count u8, {vid u16, corsairId u16, pid u16, type u8, serialLen u8, serial ascii}` | F, W `getConnectedDevicesIds` |
| 38 | serial number (UTF-8 from byte 3) | W `getSerialNumber` |
| **53** | **PAIRING_ID_V2** (W reads bytes 3..6 as the pairing id) | F, W `getDevicePairingId` |
| 54 | CONNECTED_SUBDEVICES_IDS | F |
| **59 / 60** | **SCREEN_MODULE_FIRMWARE / DIAL_MODULE_FIRMWARE** | F |
| 61, 62 | screen resource map / screen index | W |
| 19 | profile-activation action list (UNKNOWN layout) | W `nL` |
| 72 (0x48) | **Game Mode actuation** (section 4.5) | W `Wb` |
| 75 (0x4B) | **switch settings / calibration** file (section 8) | W `$w` |
| 28000-32767 | host-allocated files (profiles and their sub-files). W `findUnusedNumber` reserves 28049. | W |
| 31000 (keyboards) / 28399 (mice) | **"deviceId" file. W writes a host UUID string here on first connect.** | W `xg.setDeviceId`, `fileIds.deviceId` |
| 30999-30996 / 28398-28396 | keyStrokeListing, disableKeyListing, keyStrokeDialListing, customDialListing | W `fileIds` |

Buffer index (handle slot): W always uses 0 (`Common_File_Index`). Indexes 0..3 are allowed and anything above 3 becomes 1. SOURCE W `xg.readFile`.

### 3.4 Profile structures (all files, SOURCE W `bp.convertBytesToProfileFileFormat` and `M7`)

- **Profile file** (fileId = profileId, for example 0x6D60): `magic u16 0xF11E (Jb=61726)`, `cookie u32` (unix seconds), then u16 file ids: assignments, **properties**, archive, lightings, keyMappings, coolers, dialModes, gamepadCurves, fwSpecific, **primaryActuationDistance**, **secondaryActuationDistance**, lightingChannelsPlayback, `nameLength u16`, `name[nameLength+1]` (UTF-8, NUL-terminated), **primaryActuationResetDistances**, **secondaryActuationResetDistances**, **rapidTriggerSettings**, screenModesLayout.
- **Properties file**: `magic u16 0xD43D (oG=54333)`, `count u16`, then `{id u16 LE, value[4]}` x count. W reads the whole file, patches ids and rewrites the whole file (`Kz.updatePropertyProfile`).
- W's `updateCookie` rewrites the profile file with a new cookie after DPI, FlashTap, colour and name edits. W uses the cookie for its own change detection; whether firmware requires it is INFERRED no.
- Active profile = `profilesList.fileIDs[GET 0x6E]`. INFERRED: W keeps the mapping in IndexedDB and SETs 0x6E with the list index.

---

## 4. Keyboard analog settings (Hall-effect boards: 2B0E, 2B54, 2B31, 2B30; also 2B1A, 2B5B, 2B0C)

**Units:** device value = mm x 10 (**0.1 mm**, u8). SOURCE W `Va=t=>t/10,$o=t=>Number(t)*10`, applied in the UI before `keyActualService.setPrimaryKeyActual(keys,$o(v))`.

**Mechanism:** files, **not SET**. Every write is a whole-file rewrite through open (0x0D), write (0x06, then 0x07...), close (0x05), wrapped in SET 0x03=2 ... SET 0x03=1. File ids come from the active profile file. SOURCE W `fI` (KeyActualService).

### 4.1 Per-key actuation files (primary and secondary press, primary and secondary reset)

All four use the same layout. SOURCE W `fI.buildDistanceArray`, `fromBytesToActuationKeys`.

```
off 0  u16 LE  header   (re-used from what was read; default 0x0030 = RL 48 when created)
off 2  u8      count    (number of keys in the host's map)
off 3  count x { u8 keyIndex, u8 flags, u8 distance(0.1 mm) }
```

- primary press file: flags 1 = enabled. W defaults: press 20 (2.0 mm), reset 19.
- primary reset file: the distance is the release point. `setPrimaryKeyActual` defaults reset to `max(round(press-1),1)` and sets flag = `press>1 ? 1 : 0`.
- secondary files: flags 0 = disabled, 1 = enabled. Default 30/29. W rejects reset >= press ("message.msg74").
- Ranges come from the table's `actuationDistanceRange` in mm: 2B0E/2B54/2B1A/2B5B {0..4}, **2B31 {0.2..3.8}**, **2B30 {0.1..3.5}**. `keysNotAllowForActuation` exists (2B54: 130-135).

### 4.2 Rapid trigger file (profile `rapidTriggerSettings`)

SOURCE W `fI.fromRapidTriggerSettingToBytes`.

```
off 0  u16 LE  header (default 0x0036 = i4e 54)
off 2  u8      count
off 3  count x { u8 keyIndex, u8 flags, u8 actuationDeadzone, u8 pressDistance, u8 releaseDistance }
```

- flags: 0 off, 1 RT (`hs.Enabled`), plus 2 for continuous RT (`EnabledContinuous`), so continuous is written as 3. The reader decodes `t&2?2:t&1?1:0`.
- `actuationDeadzone`: the per-key UI passes **the key's actuation point** (`cn(flags, actuation, press, release)` calls `setKeyRapidTrigger(keys,flags,$o(actuation),$o(press),$o(release))`). So this byte is the RT start/top dead zone in 0.1 mm. INFERRED name meaning. Default 10 (1.0 mm).
- press / release sensitivity: 0.1 mm units, default 1 (0.1 mm). release = press unless "separate sensitivity" is on.

### 4.3 FlashTap (SOCD)

Stored in the profile **properties file**, not via SET. SOURCE W `Sp` (FlashTapService).

| id | content | encoding |
|---|---|---|
| 251 | enable | u32 0/1 |
| 252 | mode | u32: **0 Neutral, 1 Last-input priority (default), 2 First-input priority** (W `kd`) |
| 253 | indicator colour | `[B,G,R,0]` (default 0xFFBF00, amber) |
| 254 | key 1 | u32 key index (default 4 = A) |
| 255 | key 2 | u32 key index (default 7 = D) |

There is one pair per profile. The table's `keysNotAllowForFlashTap` (for example 2B54: 122,129-136) lists keys that cannot be used. Game Mode has a parallel set via live SET: 256 enable, 257 mode, 258 colour, 259 key 1, 260 key 2.

### 4.4 Key index scheme (SOURCE W `xa`/`MA` key tables, `T7`, `Oz` defaults)

- Standard keys use their **HID usage ids**: A=4 ... Z=29, 1=30 ... ESC=41, F1=58 ... F12=69, PrintScreen=70, Home=74, PgUp=75, Delete=76, End=77, PgDn=78, arrows 79-82, keypad 83-99, IntlBackslash=100, App=101.
- Modifiers use **105 LCtrl, 106 LShift, 107 LAlt, 108 LWin, 109 RCtrl, 110 RShift, 111 RAlt**. W maps them to HID 0xE0-0xE6 when they are remap targets.
- 112-119: INFERRED RWin / international keys.
- 122 = Fn (INFERRED: it is non-assignable on the main layer).
- 129 Dial key, 130 Game-mode key, 131-135 G1-G5 (from the Vanguard Pro 96 `keyMappings`).
- Per-layout key lists are in `defaultProfiles.json`, `indicationLeds`. Vanguard Pro 96 ANSI: `4-49, 51-70, 76, 79-99, 105-111, 122, 129-136`. Clipper Pro Mini 60 ANSI: `4-49, 51-82, 101, 105-111, 122, 129-136`. Vanguard Pro 60 ANSI: `4-49, 51-52, 54-57, 101, 105-111, 122`.

### 4.5 Game Mode actuation (file 72, applies to all keys when GM and prop 250 are on)

14 bytes. SOURCE W `Ep.fromActuationToBytes`.

`[0x63,0x00]` (header n4e=99), then `pFlags, pDist, prFlags, prDist, sFlags, sDist, srFlags, srDist, rtFlags, rtDeadzone, rtPress, rtRelease`.

- Actuation flags = `1<<enum` (ENABLED=0 gives 0x01, DISABLED=1 gives 0x02).
- rtFlags is a bitmask: bit0 RT, bit1 continuous.
- In GM, W sets rtDeadzone = the primary actuation point.

### 4.6 Worked example (INFERRED composition of SOURCE pieces): Vanguard Pro 96 (v1.5, session SS), all keys to 1.5 mm

1. `00 01 SS 01 03 00 02 00 00 00`: SET 0x03 = 2 (host-controlled). The first try may fail with byte1 = 15. Start a session (`00 01 00 1B 01 r0 r1 r2 r3 00`), read SS from reply byte 9 and resend.
2. `00 01 SS 02 6E 00`: GET 0x6E gives the active index `i`.
3. Read file 0x000F:
   - `00 01 SS 0D 00 0F 00` (open into buffer 0)
   - `00 01 SS 09 00` (describe: size at reply bytes 7..10, i.e. data[2..5])
   - `00 01 SS 08 00` repeated until `size` bytes are collected (data from reply byte 5)
   - `00 01 SS 05 01 00` (close)
   
   The result is the profile id list. Take entry `i`, for example 0x6D60.
4. Read profile file 0x6D60 the same way (`0D 00 60 6D`). Parse `primaryActuationDistanceFile` (profile bytes 24-25; properties file id at bytes 8-9) and `primaryActuationResetDistances` (the u16 right after `name`, at offset 33+nameLength).
5. Build the primary file for the N keys in the layout list, for example N=114 (0x72): `30 00 72 | 04 01 0F | 05 01 0F | ... | 88 01 0F`. Length = 3 + 3N = 345 (0x159).
6. Write it:
   - `00 01 SS 0D 00 <fileLo> <fileHi>` (if this fails, W sends 0x05 then `0B <fileLo> <fileHi>` and opens again)
   - `00 01 SS 06 00 59 01 00 00 <first 55 bytes>`
   - `00 01 SS 07 00 <next 59 bytes>`, repeated
   - `00 01 SS 05 01 00`
7. Write the reset file the same way with distance 14 (0x0E) and flags 1.
8. `00 01 SS 01 03 00 01 00 00 00`: back to SET 0x03 = 1 (self-operated).

For a v1.0 board (Clipper Pro Mini 60 as W drives it) the same steps use 2-byte headers, for example `08 01 03 00 02 00 00 00` and `08 06 00 59 01 00 00 <57 bytes>`.

Per-key RT example (W UI): the RT file entry for W (key 26) is `1A 01 0F 01 01`: RT on, start 1.5 mm, press 0.1 mm, release 0.1 mm.

---

## 5. Keyboard: other settings

| feature | how | tag |
|---|---|---|
| Polling rate | SET 0x01 (1..7) sent to address 0, wrapped in mode 2. The table lists allowed indices (`wiredPollingRate` 0..6 maps by index to `Cve` 125..8000 Hz; 2B0C only [0,3,6]; Skiff [0,3]). Wireless: SET 0x01 on the receiver (addr 0) or GET 0xDF. `supportUpdateWirelessPollingRate` selects which. | SOURCE W `wp.setPollingRateAsync`, `Cve` |
| Profile select | SET 0x6E = index. Up to 5 profiles (`profileMax:5`). Profiles list = file 0x0F. | SOURCE W `bp.setActiveHardwareProfileIndex` |
| Save / commit | **There is no separate "save to onboard" command.** Each file write or SET goes straight to device storage. W bumps the profile **cookie** after DPI, FlashTap, colour and name edits. | SOURCE W, absence verified by grep |
| Brightness | SET 0x02, 0..1000 (W uses 100 steps). | SOURCE |
| Win-lock | SET 0x45 0/1. Indicator: SET 0x63 0/2, colour in properties 93. | SOURCE |
| Game Mode | live SETs 225..260 (section 3.2), plus file 72 for actuation. Setting 225 also sets 239. | SOURCE W `Ep` |
| Remaps / layers | **Key-mappings file** (profile `keyMappingsFileIndex`): `hdr u16, then one byte per key index`. Each byte is a bitmask of `er`: bit0 key enabled, 1 Fn layer, 2 Fn2, 3 Ctrl, 4 Alt, 5 Shift (63 = all). **Assignment map** (profile `assignmentsFileIndex`): `hdr u16` (V1 = **0xAC3D**, V2 = **0x002D**, V3 = **0x0075**; table `keyAssignmentVersion`: HE boards 3, MAKR/Galleon 2, mice 1) + 2 zero bytes + per key `{key u8, n u8, flags u16, n x action}`. V2 action = `{fileId u16, options u16}`. V3 action is 10 bytes with fileId at offset +2 (layout partly UNKNOWN). **Remap action file**: `0x076E (1902), type u8 (1 keys, 2 mouse, 3 consumer, 4 internal, 5 gamepad), duration u16, 3 zero bytes`, then type 1: `count u8, HID codes u8...`; type 2: `button u8`; types 3-5: `code u16`. Text action: magic 940 (0x03AC), `interCharDelay u32, count u16, secondAction u16, 6 zero bytes, UTF-8`. Macro magic 12460 (0x30AC), event list per `Ri`. | SOURCE W `keyassign.js` (`setRemapActionFile`, `buildAssignmentMapBytes`, `buildKeyMappingsBytes`) |
| Lighting | Effect files under the profile `lightingsFileIndex`, effect catalogue `t8e` (ids 0 horizon, 1 static, 2 watercolor, ...). File layout not extracted (UNKNOWN). | |
| Switch type / max travel | file 75 (section 8). | SOURCE |

---

## 6. Mice

### 6a. Bragi mice: 2B22, 2B1C, 2B2E (profile-based); 2B3F-2B45 and 2B33 (`supportsProfile:false`)

| setting | property / mechanism | values / read-back | tag |
|---|---|---|---|
| DPI stages | 24-28 stage values, 29 sniper, 31 enabled mask (bit31 sniper), 47-52 colours. **Profile devices:** patched into the profile properties file, then the cookie is bumped. **Non-profile devices** (Sabre v3, Harpoon v2 wired): direct SET of each id, wrapped in mode 2. | u32 DPI. W writes **one value per stage, no separate X/Y**. Ranges and steps from `dpiConfig`: Sabre v3 100-42000 step 1, Scimitar SE 100-33000 step 50, Nightsword V2/Harpoon V2 W 100-26000 step 50, Harpoon v2 wired 100-12000 step 100. | SOURCE W `xp` (DPIService) |
| Active stage | non-profile: SET **0x1E** (0..4). Profile devices: SET 0x4F/0x50/0x51/0xA4/0xA5 for profiles 0..4. | | SOURCE W `getActiveMouseSensorResolutionStageIndex` |
| Sniper | W initialises it to 200 DPI and #FFFFFF when it is below 100. | | SOURCE |
| Polling | SET 0x01 (1..7) to addr 0, mode 2. Wired index list 0..6 (2B22/2B2E/2B33: 0..3). | | SOURCE |
| LOD | SET **0x06**. The UI sends the selected value raw (`setLiftHeight(parseInt(v))`). The device table's `liftHeights` [0,1,2] are option indices; their mapping to the 1..7 enum is UNKNOWN. | 1..7 enum (3.2) | SOURCE / UNKNOWN mapping |
| Angle snap | SET 0x07 0/1 and SET 0x08 angle (0..90; the UI rejects >90). | | SOURCE |
| Debounce | SET 0x0A **and** 0x38 = 5 + n (n = 0..9). Algorithm: SET 0xB0 (0/1). | INFERRED ms | SOURCE |
| Motion sync / ripple | SET 0x113 / 0x114, each 0/1. | | SOURCE |
| Sleep | 0x0D enable, 0x0E ms, 0x37 ms (power-saving), 0x0B power-saving mode, 0xD7 motion power saving. | | SOURCE |
| Battery | GET 0x0F, 0..1000 per-mille. 0x10 status values UNKNOWN. | | SOURCE |
| Surface | SET 0x3B = 1 (STORED_PRESET) if the current mode is 0, then SET 0x3C = preset 0..5. GET 0x12A reports the calibrated-surface bitmask (OmniSense, `omniSenseCalibration:true` on Sabre v3). W has **no** sensor-calibration command (0x0A with target 0 is never sent). | | SOURCE |
| GET reply layout | v1.0: status at byte 2, value LE at bytes 3..6. v1.5: status at byte 4, value at bytes 5..8. | | SOURCE |

### 6b. Sabre v2 Pro (0x2B28 Ultralight W, 0x2B29 MG, 0x2B25 CF; receivers 0x2B2A / 0x2B35 / 0x2B34). Sabre Web Hub, **EEPROM protocol, not Bragi**

This is the same family OpenMouse implements in `dist\atk\index.js` (AGPL, reusable): "ATK shares the Endgame Gear WE framing ... command 0x08 reads an EEPROM address, 0x07 writes one, every frame and every value/checksum pair sums to 0x55".

**Frame** (SOURCE S `class A`):
- Output is `sendReport(8, p[16])` with `p = [cmd, 0, addrHi, addrLo, len, data0..9, cs]`.
- Checksum `cs = (0x55 - (0x08 + sum(p[0..14]))) & 0xFF`.
- Reply: input report 8, 16 bytes, `[cmd echo, ?, addrHi, addrLo, len, data0..9, cs]`, so data starts at reply[5].
- Each EEPROM value is stored as a `[value, 0x55-value]` pair. Multi-byte entries carry one checksum over their bytes (`CheckSum` on a 2- or 4-byte array).

| cmd | meaning | payload / reply | tag |
|---|---|---|---|
| 0x01 | handshake / device info | len 8, data0..3 random. Reply: CID=r[9], MID=r[10], JmType=r[11] | SOURCE `GetDeviceInfo` |
| 0x02 | driver mode | len 1, data0 = 1/0 | SOURCE `SetDriverMode` |
| 0x03 | wireless link active? | reply r[5]==1 | SOURCE `CheckActive` |
| 0x04 | battery | r[5] level %, r[6] status | SOURCE `GetBatteryStatus` |
| 0x07 | **write EEPROM** | addr u16 BE, len <= 10, data | SOURCE `SetBuffer` |
| 0x08 | read EEPROM | addr, len <= 10, reply data at r[5..] | SOURCE `GetBuffer` |
| **0x09** | **factory reset** (W waits 1000 ms) | none | SOURCE `SetFactoryReset` |
| 0x0E / 0x0F | get / set active profile | 0x0F: len 1, data0 = profile-1 | SOURCE |
| 0x10 | pairing check | | SOURCE `CheckPairing` |
| 0x12 / 0x1D | mouse / receiver firmware version | r[5]<<8 \| r[6] | SOURCE |
| feature report 6 | **pairing** `[0xA0, a, b]` (set) / status (get) | | SOURCE `SetPairing` |

EEPROM map (SOURCE S `GetConfigMemorry`, setters, `devicesettings.js`):

| addr | content |
|---|---|
| 0x00 | polling: product JSON `PollingRate` values **1=1000 Hz, 16=2000, 32=4000, 64=8000** (USB and wireless) |
| 0x02 / 0x04 | stage count / active stage-1 |
| 0x0A | **LOD: Low=0, Medium=3, High=4** (`[0x0,0x3,0x4]`) |
| 0x0C + 4i | DPI stage i: `[Xcode lo, Ycode lo, hi, cs]` |
| 0x4C-0x53 | DPI LED: 0x4C effect, 0x4E brightness, 0x50 speed, 0x52 on/off |
| 0x60 + 4(b-1) | button b assignment (4 bytes) |
| 0x100 + 0x20(n-1) | key button data |
| 0x300 + 0x180(m-1) | macro m (name at +0: len, up to 30 bytes; data at +0x1F) |
| 0xAB | motion sync 0/1 |
| 0xAD | sleep time in 10 s units (UI 1/3/5/10/20/30/40 min) |
| 0xAF | angle snapping 0/1 |
| 0xB1 | ripple control 0/1 |
| 0xB5 / 0xB7 | sensor sleep enable / time in 10 s units |
| **0xDB-0xDD** | **surface-calibration data** (3 bytes from the product JSON `CalibrationDataTable`) |
| **0xDF** | **calibration enable** |

DPI code (SOURCE S, generic map used because model 750 is not in the `ee` list):
- for i = 0..0x2FF, DPI = 50(i+1);
- code = i (i < 0x100), (i-0x100) | 0x4400 (i < 0x200), (i-0x200) | 0x8800 (otherwise);
- the map runs from 100 up to 33000.

Stage bytes are `[code&0xFF, Ycode&0xFF, code>>8, cs]`, so the high byte carries per-axis nibbles 0x04/0x40 or 0x08/0x80. These are X-only sensors (`DpiXOnly`).

Firmware is updated with a downloadable Windows tool (`UpdateToolLink` ...`sabre-firmware-updater/public/*.zip`), not in the browser.

---

## 7. Hardware vs software mode

- W never parks a device in host mode. Every operation that needs it is wrapped as `setOperatingMode(HOST_CONTROLLED=2)`, then the work, then `finally setOperatingMode(SELF_OPERATED=1)` (105 HOST_CONTROLLED call sites, 107 SELF_OPERATED). SOURCE W.
- On connect (`processConnectedDevice` / `saveDeviceToDB`): for `configInHostControl` devices W sends SET 0x03=2. It then reads the deviceId file, settings, profiles and battery, and finally sends SET 0x03=1. If the deviceId file is empty W **writes a new UUID into file 31000/28399**. If the device has no profiles, W **creates a first profile** (`createFirstProfile`). SOURCE W `hidservice.js`.
- On disconnect W does no device writes. It only sends iCUE `restoreDevice` over the WebSocket. SOURCE.
- **Plain SETs are sent without any mode switch:** brightness, Win-lock, sleep, power saving, angle snap, LOD, debounce, motion sync, ripple, surface preset, indicators. So these are writable in mode 1 (SOURCE that W does it; firmware acceptance INFERRED).
- **File I/O on mice and receivers needs mode 2.** Keyboard file I/O in W is also wrapped by each service.
- Polling rate and Game-Mode writes are explicitly wrapped in mode 2.
- ckb/OpenMouse note: mode 2 means software control, and a device left in it ignores its onboard settings. Always restore mode 1.

---

## 8. Safety: everything to block (default-deny)

| what | bytes / ids | where | risk |
|---|---|---|---|
| Enter bootloader | SET 0x03 = **3** (BOOTLOADER) or **5** (MCU_BOOTLOADER). The device re-enumerates under a new USB identity (F `requestReconnectBootloader`). Also 4 SLEEP, 6 LIMITED_HOST_CONTROLLER, 7 ESPORTS. | F `Tt`, `setOperatingMode` (accepts 1..7); W `Ee` (never sends 3-7) | brick / USB-identity change |
| Firmware image upload | open/write/close of file **3** (FIRMWARE), **18** (SECONDARY_CHIP_FIRMWARE, F writes it in *host-controlled* mode), **59** / **60** (screen / dial module firmware) | F `Ft`, manifests (`operating-modes:["bootloader"]` or `["host-controlled"]` for the secondary chip) | brick |
| Apply firmware | cmd **0x10** APPLY_FIRMWARE, cmd **0x16** APPLY_FIRMWARE_EXTENDED (CRC32/MPEG2) | F `Ct` | brick / reboot |
| Factory reset | cmd **0x0F** RESET_TO_DEFAULTS (scope 0/1/2). W sends it to the sub-device and then to the receiver. | W `xg.resetToFactorySetting`, F | data loss |
| Pairing | cmd **0x11** PAIRING_CONTROL (F) and cmd **0x12 with payload** (W `pairingCommand`: `01 00 00` start, `02 00 00` abort; a bare 0x12 is PING). W polls for up to 120 s. | W `startPairingControl`, F | receiver un-pairing |
| Pairing secrets | files **5**, **6**, **53**, **20**, and 36/54. Reads are low-risk; **never write**. | F `Ft`, ckb | breaks the wireless link |
| Calibration | cmd **0x0A** (any). W sends `01 08` (Start, MagneticSwitch) for HE key calibration (`CalibrationService.calibrate`, `KeyCalibrationLiteService`). Also writes to **file 75** (switch settings: `hdr[2], count u8, {key u8, switchType u8, maxDistance u8 (0.1 mm), 0}`; switchType 0 Other, 1 GentySilent, 2 Jade, 3 JadePro, 4 JadeMax, 5 Hyperdrive, 6 HyperdriveV2). SET 0x3B / 0x3C surface presets are allowed. | W `Bz`, `p4` | wrong actuation until recalibrated |
| File create / delete | cmd **0x0B**, **0x0C** | W | storage corruption |
| Identity writes | the W deviceId file 31000/28399 (UUID). SYNQ does not need it, so keep it read-only. | W `setDeviceId` / `resetDeviceId` | changes iCUE/Web Hub identity |
| Session hijack | cmd 0x1B with byte 4 = 2 (stop) for a session SYNQ does not own | F | other host loses control |
| Debug mode | prop 4 (properties file); only writing 0 is allowed | W | UNKNOWN |
| Sabre v2 EEPROM | cmd 0x09 (factory reset); feature report 6 (pairing); EEPROM writes outside the allowlisted addresses (0x00, 0x02, 0x04, 0x0A, 0x0C-0x23, 0xAB, 0xAD, 0xAF, 0xB1, 0xB5, 0xB7). Block 0xDB-0xDF calibration unless explicitly enabled. | S | brick / calibration |
| SiXpand OTA (F, not our PIDs) | report **0x55** `[0x55,0x00]` (OTA init), report **0x41** data chunks, `[0x71,0,3]` version | F `updateOTAFirmware` | brick |
| NXP legacy (ckb) | feature report: CMD_SET **0x07** + FIELD_RESET **0x02** (RESET_BLD **0xAA** = reboot to bootloader / FAT12; 0xF0 slow reset), FIELD_FW_START **0x0C**, FIELD_FW_DATA **0x0D**. Bulk writes 0x7F. | ckb `nxp_proto.h` | brick |

Firmware endpoints (block from the app):
- W: `https://app.corsair.com/api/firmware/latest?pid=&vid=` (version check only) and a link to `https://www.corsair.com/firmware-updater/index.html`. **W itself never flashes.**
- F: `https://www.corsair.com/firmware-storage/firmware/public/` (`mapping.json`, `/manifests/*`, `/fw/*`).
- S: `https://www.corsair.com/sabre-firmware-updater/public/`.

Suggested allowlist (INFERRED):
- cmds 0x01 (SET, allowlisted props and values), 0x02, 0x05, 0x06/0x07 (only to files resolved from the active profile: properties, actuation x4, RT, key-mapping, assignment, action files), 0x08, 0x09, 0x0D, 0x12 with an empty payload, and 0x1B start/stop of our own session.
- Everything else is denied.

---

## 9. Device table (W `l2e` / `devices.json`; F Bragi-1.5 list; M manifests)

`msc` = supportMultiSessionControl, `auth` = allowAuthentication (false = hidden from the picker), `host` = configInHostControl, `prof` = supportsProfile (`-` = default true), `kav` = keyAssignmentVersion. Polling arrays are indices into 125/250/500/1k/2k/4k/8k.

| PID | type | name | bragi | msc | auth | host | prof / max | kav | polling (wired / wireless / GM) | other |
|---|---|---|---|---|---|---|---|---|---|---|
| 2B04 | kb | MAKR 75 | - | - | Y | N | -/5 | 2 | 0-6 / 0-3 / 0-6 | |
| 2B0C | kb | GALLEON 100 SD | - | Y | Y | N | -/5 | 2 | [0,3,6] / - / [0,3,6] | screen |
| 2B0D | kb | VANGUARD 96 | - | Y | Y | N | -/5 | 2 | 0-6 / 0-4 / 0-6 | step 20 |
| **2B0E** | kb | **VANGUARD PRO 96** (K70 Wired Magnetic-Mechanical) | - | Y | Y | N | -/5 | 3 | 0-6 / 0-4 / 0-6 | act 0-4 mm, `resetDebugMode`, step 20, screen 248x170, services incl. KeyActual, Calibration, FlashTap, SmartTap, TapLock, KeyTesting |
| **2B0F** | kb | **VANGUARD 96 WIRELESS** (Magnetic) | 1.5 | Y | Y | N | -/5 | 2 | 0-6 / 0-6 / 0-6 | wireless polling update |
| 2B1A | kb | MAKR PRO 75 | - | - | Y | N | -/5 | 2 | 0-6 / 0-4 / 0-6 | act 0-4 |
| 2B21 | kb | VANGUARD AIR 99 WIRELESS | 1.5 | Y | Y | N | -/5 | 2 | 0-6 / 0-6 / 0-6 | eager session |
| **2B30** | kb | **VANGUARD PRO 60 WIRELESS** (HE) | 1.5 | Y | **N** | N | Y/5 | 3 | 0-6 / 0-6 / 0-6 | act 0.1-3.5 (restricted), GM RT override |
| **2B31** | kb | **CLIPPER PRO MINI 60** (HE) | - | - | Y | N | Y/5 | 3 | 0-6 / [] / 0-6 | act 0.2-3.8 (restricted), GM RT override, settings fields incl. 93/158/159/279 |
| 2B3D / 2B3E | kb | SKIFF 100 / PLUS | 1 | - | Y | N | N | - | [0,3] | non-profile files |
| 2B54 | kb | VANGUARD PRO 96 GUMA | - | Y | Y | N | -/5 | 3 | 0-6 / 0-4 / 0-6 | as 2B0E |
| 2B5B | kb | MAKR PRO 75 Nene | - | - | Y | N | -/5 | 2 | 0-6 / 0-4 / 0-6 | act 0-4 |
| 2B22 | mouse | SCIMITAR ELITE WIRELESS SE | - | - | Y | Y | -/5 | 1 | 0-3 / 0-3 | DPI 100-33000/50, sniper, LOD [0,1,2] |
| 2B1C | mouse | NIGHTSWORD V2 WIRELESS SD | 1.5 | Y | Y | Y | -/5 | 1 | 0-6 / 0-6 | DPI 100-26000/50 |
| 2B2E | mouse | HARPOON V2 WIRELESS | 1 | **N** | Y | Y | -/5 | 1 | 0-3 / 0-3 | DPI 100-26000/50 |
| 2B33 | mouse | HARPOON v2 (wired) | 2 | Y | **N** | Y | N | 1 | 0-3 | DPI 100-12000/100 |
| 2B3F / 2B43 | mouse | SABRE v3 PRO UL W (ERGO / std) | 2 | Y | Y | Y | N | 1 | 0-6 / 0-6 | DPI 100-42000/1, OmniSense, 10 s timeout |
| 2B40 / 2B41 / 2B44 / 2B45 | mouse | SABRE v3 PRO W MG ERGO / CF ERGO / MG / CF | 2 | Y | **N** | Y | N | 1 | 0-6 / 0-6 | same |
| 2B25 / 2B28 / 2B29 | mouse | SABRE v2 PRO CF / ULTRALIGHT / MG | - | - | Y | - | - | - | (Sabre app: 1k/2k/4k/8k) | **redirect SABRE**. Filter `{0xFF01, usage 0}`. Sensor model 750, 100-33000/50 |
| 2B35 / 2B2A / 2B34 | dongle | SABRE v2 PRO receivers | - | - | Y | - | - | - | | redirect. Filter `{0xFF02, usage 2}` |
| 2B00 | dongle | SLIPSTREAM | - | - | Y | Y | | | 0-6 / 0-4 | |
| 2B1B / 2B3C / 2B42 | dongle | SLIPSTREAM v2 | 1.5 | Y | Y | Y | | | 0-6 / 0-4 / 0-6 | |

- Filters (SOURCE W `Tp.requestDevice`): `{vendorId:0x1B1C, productId}` for every `auth:true` row except the six Sabre v2 PIDs.
- F's Bragi-1.5 PIDs: 2B0D, 2B0E, 2B1B, 2B1C, 2B0F, 2B21, 2B31, 2B0C, 2B3F, 2B40, 2B41, 2B42, 2B30, 2B43, 2B44, 2B45, 2B33, 2B3C, 2B54.
- Firmware manifests (M) show the HE boards and receivers use `apply-extended` + `crc32-mpeg2` + `bootloader` mode. 2B0F/2B21 also have `secondary-chip-firmware` in host-controlled mode. Pairing is `manual`, `v2-variable-size`, 4-byte id.

## 10. Open questions (UNKNOWN)

- Real report lengths of the HE boards' 0xFF42 collections (code handles any length; 64 assumed).
- Session timeout. Reply bytes 0 and 2 on v1.5.
- How a v1.5 device reacts to v1.0 framing. This matters for 2B31, which W drives as v1.0.
- Values of property 16 (battery status). Bragi LOD option mapping (`liftHeights` index to the 1..7 enum).
- Layouts of the KeyPressStateChange (2), CalibrationProgress (3) and AnalogKeyPressChange (12) notifications.
- Lighting file layout. V3 assignment action internals. Names of properties 56, 74, 92, 94, 161, 214, 262.
