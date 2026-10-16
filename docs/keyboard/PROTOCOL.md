# ROG Falchion Ace HFX ZywOo Edition: settings protocol

Captured on 2026-10-11 from **ASUS Gear Link 1.00.24** (gearlink.asus.com, bundle
`view/7453/chunk-1.00.24-7453-1769649440-670a1c`) driving the keyboard over WebHID in Chrome.
Firmware **1.00.03**, serial blanked here. The raw labelled log is in `captures.json`. Pure
encoders and decoders are in `src/lib/keyboard-protocol.ts`, and every encoder is checked
byte for byte against this capture.

How the facts were established:

- **captured**: Gear Link sent these bytes and the keyboard echoed them.
- **source**: read from Gear Link's own JavaScript (the command builders, e.g. `makeCommand(81, 80, 0, …)`), not exercised live.
- **unknown**: not established either way.

## 1. Transport

| Item | Value |
|---|---|
| USB | VID `0x0B05`, PID `0x1D1D` (7453). ASUS model M606. Companion files use the `m605-7453-` prefix |
| Control interface | collection `FF00:0001`, **report id 0**, 64-byte output and 64-byte input |
| Event interface | collections `000C:0001` + `FFC0:0001`, input **report id 3** (key bitmaps `71 …` and events, see §6) |
| Frame | `[cmd] [sub] [arg lo] [arg hi] [payload…]`, zero padded to 64 bytes (Gear Link `makeCommand(cmd, sub, arg16, payload)`) |
| Endianness | multi-byte fields are little-endian |
| Distance unit | **0.1 mm** for actuation, dead zones and rapid-trigger sensitivity (1.0 mm = `0x0a`) |
| Key ids | firmware key index (IBM-style position numbers: `W`=0x12, `A`=0x1f, `S`=0x20, `D`=0x21, `O`=0x19, `P`=0x1a, `Insert`=0x4b, `ScrollLock`=0x7d). Full table: `FW_KEY` in the TS file and `fwKeyIndexFromGearLinkSource` in captures.json. The Fn layer is `0x9F00 + index` |

### Request / echo pattern

- **Every write is echoed verbatim** on input report 0. Usual latency is 0 to 15 ms. `51 00` (profile
  switch) takes about 70 to 100 ms, `50 40` (reset profile) about 120 to 150 ms and `50 55` (save)
  about 100 to 270 ms.
- **Reads** answer with the same first 2 to 4 bytes plus data. Gear Link matches the reply by its first 4 bytes.
- **Unsupported commands** answer `FF AA` (seen for `7d 20 01`, getBoosterInfo).
- Gear Link sends one command at a time and waits for the echo before sending the next.

### `50 55`: save current profile

Gear Link calls `50 55` `setProfile(SetCurrentProfile)`. It sends it after every batch of writes:
1 to 10 setting writes followed by one `50 55`. Sometimes it also sends one before the batch,
because its debounced save of the previous change lands then. The slow echo suggests a flash write.
**Unknown:** whether a setting takes effect before the `50 55` arrives, or only persists after it.
Gear Link always sends the `50 55`, so SYNQ should too.

## 2. Connect sequence and reads (all captured)

On load Gear Link only reads. It runs this model in **"Legacy Mode"** and does not read any
setting back from the keyboard. It shows whatever the Companion stored (§8).

| Send | Reply (trailing zeros stripped) | Meaning |
|---|---|---|
| `12 14 02` | `12 14 02 00` + the serial in ASCII (12 digits) | serial number, from byte 4 to the first `00` |
| `12 00` | `12 00 00 00 03 00 01 00 06 01 01` | BasicInfo: `[4..7]` u32 version `0x00010003` = "1.00.03"; `[8]` profile count 6; `[9]` current lighting effect type; `[10]` current profile; `[11]` "isAlive" flag (0); `[11..13]` version2 (unused here) |
| `12 03` | `12 03` (all zero) | ConnectionType. Zero is presumably wired (**unknown**) |
| `12 12` | `12 12 00 00 01 01` | KeyboardLayoutNation: `[4]` layout type 1 (Gear Link: "104-key"), `[5]` nation 1 (Gear Link: "CA") |
| `12 14` | `12 14` (all zero) | FWInfo with sub 0: no data (**unknown**) |
| `12 16` | `12 16` (all zero) | WDLState, read when the Lighting page opens (**unknown**) |
| `7d 20 01` | `FF AA` | getBoosterInfo: rejected (not supported) |
| `25 00` | `25 00 00 00 01` | **rapid-trigger mode on (1) / off (0)**. Read when the Rapid Trigger page opens and after a profile switch |
| `25 01` | `25 01` (0) | Speed Tap state (0 = off, matching the setting at the time) |
| `22 01` | `22 01 00 00 04` | current touch-panel ("lever") mode = 4 |

`12 xx` types from source: 00 BasicInfo, 01 CurrentPower, 02 RGBMode, 03 ConnectionType, 04 KeyPadState,
05 HWInfo, 06 BLEHostLEDState, 07 WindowsLighting, 08 AutonomousModeState, 0x12 Layout/Nation,
0x13 NationId, 0x14 FWInfo (sub 2 = serial), 0x15 PollingRate index, 0x16 WDLState.

## 3. Write commands (`51 xx`, all captured)

| Bytes | Setting | Encoding | Captured example |
|---|---|---|---|
| `51 50 00 00 AA AA` | global actuation | u16 actuation, 0.1 mm | 1.0 mm `51 50 00 00 0a`, 2.0 mm `…14`, 1.1 mm `…0b` |
| `51 4f 00 00 KK KK AA AA` | per-key actuation | u16 key, u16 actuation | P 0.5 mm `51 4f 00 00 1a 00 05`, O 0.7 mm `…19 00 07` |
| `51 58 00 00 BB TT` | global dead zones | **bottom first**, then top, 1 byte each, 0.1 mm | top 0.4 `51 58 00 00 02 04`, bottom 0.4 `…04 02` |
| `51 59 00 00 KK KK BB TT` | per-key dead zones | u16 key, bottom, top | P back to 0.2/0.2: `51 59 00 00 1a 00 02 02` |
| `51 54 MM 00 KK KK SS CC EE` | rapid trigger, one key | `MM`: 0 = combined sensitivity, 1 = press, 2 = release. `SS` sensitivity (0.1 mm), `CC` continuous 0/1, `EE` enabled 0/1 | W press 0.1: `51 54 01 00 12 00 01 00 01`; continuous on: `…01 01 01`; combined 0.2: `51 54 00 00 12 00 02 00 01` |
| `51 57 00 00 EE` | Speed Tap on/off | 0/1 | on `51 57 00 00 01`, off `51 57` |
| `51 55 00 00 K1 K1 K2 K2 EE` | Speed Tap pair | u16 key1, u16 key2, enabled | A/D `51 55 00 00 1f 00 21 00 01` (Sync first sends it with `EE`=0) |
| `51 31 00 00 II` | polling rate | 0 = 1000, 1 = 2000, 2 = 4000, 3 = 8000 Hz (Gear Link's UI offers 1000 and 8000) | 8000 Hz `51 31 00 00 03` |
| `51 21 SS SS TT TT AA` | key remap (normal key) | **bytes 2-3 = source key**, u16 target key, actuation byte (global value) | Insert to ScrollLock `51 21 4b 00 7d 00 0a`; back to default = target equals source `51 21 4b 00 4b 00 0a` |
| `51 00 00 00 PP` | switch active profile | profile index | Profile 2 `51 00 00 00 02`, Profile 1 `…01`. Sync walks 1..6 |
| `51 2c TT 00 SP BR FL ff ff R1 G1 B1 R2 G2 B2 RB GB BB` | lighting, simple effects | `TT` effect type; `SP` speed byte; `BR` brightness %; `FL` = (single ? 0 : 1) << 4, plus 1 if random; then 2 colours and a background | Breathing double yellow/magenta 100 % Normal: `51 2c 01 00 1e 64 10 ff ff ff ff 00 ff 00 ff`; 95 %: `…1e 5f 10…`; Static red: `51 2c 00 00 ff 64 00 ff ff ff` |
| `51 2c TT NN …` (3 reports) | lighting, Rainbow / Ripple | `NN` counts down 2, 1, 0. First report: speed, brightness, random, direction, width, stop count (7), stops 1-2; second: stops 3-6; third: stop 7. Stop = `[location 0-100, r, g, b]` | `51 2c 04 02 3e 64 00 00 64 07 0c f5 00 ff 19 00 06 ff` / `51 2c 04 01 25 00 fa ff …` / `51 2c 04 00 57 ff 00 0d` |
| `51 2c 07 NN …` (2 reports) | lighting, Quicksand | speed, brightness, random, direction, **one unknown byte (0)**, 6 RGB colours | `51 2c 07 01 0f 64 00 02 00 fe f6 00 01 ff 05 00 e4 ff` / `51 2c 07 00 11 05 ff f5 00 ff ff 00 0e` |
| `51 2d 00 00 TT EE` | "Analog Effect" lighting toggle for effect `TT` | only seen off (0) for Static/Color cycle/Rainbow | `51 2d`, `51 2d 00 00 02`, `51 2d 00 00 04` |

Effect types: 0 Static, 1 Breathing, 2 Color cycle, 3 Reactive, 4 Rainbow, 5 Ripple, 6 Starry Night,
7 Quicksand, 8 Current, 9 Raindrop. The simple layout is used by 0, 1, 2, 3, 6, 8 and 9. The last
effect written becomes the active one; Sync writes all ten effects and then the current one.

Other captured writes:

| Bytes | Meaning |
|---|---|
| `50 55` | save current profile (see §1) |
| `50 40 00` | **reset the current profile to firmware defaults** (sent by Sync before rewriting each profile) |
| `71 00 00 00 FF EE` | touch panel: enable/disable lever function `FF` (0-4) |
| `71 02 00 00 MM` | touch panel: select mode `MM` (profile 1 = 4) |

## 4. What each UI action sends (captured)

| UI action | HID sequence |
|---|---|
| Global actuation | `50 55`, `51 50`, `50 55`. When per-key overrides exist, Gear Link re-sends each `51 4f` first, then `51 50`. The order suggests per-key values survive a global change (**inferred**) |
| Top or bottom dead zone | `50 55`, `51 58 [bottom][top]`, `50 55` |
| Per-key actuation (Individual Key Settings, edit) | `12 12` (layout read, first time only), then `51 4f` for **every selected key**, then `50 55` `50 55`. Clicking keys toggles multi-selection |
| Per-key: set the value back to the global value | **sends nothing**. The key drops out of the list but keeps its old value on the keyboard |
| Per-key: remove chip (x) | `51 4f key = global actuation`, `51 59 key = global dead zones`, `50 55`. This is the correct way to clear an override |
| Rapid trigger press, release, independent or continuous change | `51 54` for every key in the group (press and release reports when independent), then `50 55` |
| Rapid trigger group: add a key | the full list, including the new key |
| Rapid trigger group: remove a key | the full remaining list. **Nothing is sent for the removed key**, so it most likely stays rapid-trigger enabled on the keyboard until a profile reset (`50 40 00`) and rewrite. SYNQ should send `51 54 … EE=0` for removed keys (inferred from the payload layout; never captured) |
| Speed Tap toggle | `51 57 00 00 0/1`, `50 55` |
| Lighting page opened | `12 16` read, then re-sends the current effect `51 2c …`, `50 55` |
| Brightness / effect change | `51 2c …`, `50 55`. Static also sends `51 2d` (analog effect off) and another `50 55` |
| Key remap (Keyboard function) | `51 21 src target act`, `50 55`. "Default" sends target = source |
| Profile dropdown | `51 00 00 00 PP`, then reads `25 00`, `25 01`, `12 00`, then re-sends polling `51 31 00 00 03`. No `50 55`. The Companion gets `50150001` (§8) |
| Polling rate | not changed live: on this keyboard it may force USB re-enumeration and drop the WebHID session. Encoding confirmed from the profile switch and Sync (`51 31 00 00 03`) |

## 5. "Sync Settings"

Sync **does send HID**. It is Gear Link's way of pushing its stored copy (the Companion file) to the
keyboard, because in Legacy Mode it cannot read the keyboard. It asks for confirmation ("will
sequentially sync each profile to the device"), then runs about 19 s and 234 commands:

```
for P in 1..6:
  51 00 00 00 P          switch profile
  50 40 00               reset this profile to defaults
  51 50 …  51 58 …       global actuation, dead zones (plus per-key 51 4f/51 59 if any)
  51 54 … (each RT key)  rapid trigger group
  51 57 01, 51 55 A D 0, 51 55 <pair> 1, 51 57 <enable>     Speed Tap
  71 00 ×5, 71 02 <mode>                                    touch panel
  (51 2d, 51 2c) for all 10 effects, then the current effect   lighting
  51 31 00 00 <rate>     polling
  50 55                  save
51 00 00 00 <original profile>
```

Key bindings are skipped when the stored profile has none (`assignedKeys` empty). It also writes the
Companion file. Side effect: everything on every profile is reset and rewritten, so Sync also cleared
the stale per-key and rapid-trigger leftovers described in §4.

## 6. Events (input report 3, event interface)

| Bytes | Meaning (Gear Link's parser) |
|---|---|
| `71 …` | key-press bitmap for the on-screen keyboard (filtered from the capture) |
| `76 00 00 EE` | rapid-trigger mode changed, `EE` = 1 on / 0 off. Seen after profile switches and resets, and twice as a spontaneous off-then-on pair about 0.75 s apart with no UI action (source **unknown**: the trigger-mode key, the touch panel or the firmware) |
| `91 00 00 MM` | touch-panel mode changed to `MM` |
| `73`/`74`/`75`/`77`/`82`/… | source only: DKS/mod-tap key events, actuation changed, game mode, power/connection |

Rapid-trigger on/off is **not** a Gear Link write on this model. The page says "use the trigger mode
switch", so the keyboard toggles it itself. Read it with `25 00` and watch for `76` events.

## 7. Source-only commands (in Gear Link's bundle, not exercised)

| Bytes | Gear Link name |
|---|---|
| `50 40 01` | ResetAllProfiles (**destructive, never send casually**) |
| `50 60` / `50 61` | reset current key bindings / reset current lighting effect |
| `51 22`, `51 23`, `51 24` | Toggle key, Dynamic Keystroke (DKS), Mod-Tap bindings |
| `51 52 TT 00 …` | resetAnalogTrigger (type 0 actuation+RT, 1 actuation, 2 RT, 3 actuation+RT+dead zone, 4 dead zone; payload actuation u16, RT u16, layer) |
| `51 56` | reset Speed Tap |
| `51 5a`, `51 5b`, `51 5c` | rapid-trigger global settings / key list / enable (another model class; this board uses `51 54`) |
| `25 05` / `25 04 KK KK` | get global / per-key actuation (reply u16 at `[4..5]`) |
| `25 06 KK KK`, `25 22`, `25 0d`, `25 24` | get per-key RT, RT global, key binding, polling rate |
| `6c 00 00 00 NN` | setDebounceTime |

## 8. Gear Link Companion (WebSocket)

The Companion is a settings store and does not drive the keyboard. It runs locally as `gearlink_kbagent.exe`
and `gearlink_utilitycompanion.exe`. Gear Link's localStorage has `MAIN_PAGE_KB_SERVICE_PORT=8000` and
`MAIN_PAGE_UTILITY_SERVICE_PORT=8821`. Every message is JSON with
`vid:"2821", pid:"7453", sn:"<serial>", class_id`.

| class_id | Port | Request | Reply |
|---|---|---|---|
| `60010000` | 8000 | register device | `{port:"8200", result:"0"}` |
| `60120000` | 8200 | list files | `{file:[], result:"0"}` |
| `60060000` | 8200 | read `{file_name, profile_index, model_name:"M606"}` | `{file_data:<base64 JSON>, result}`. `0` = ok, `704` = not found. Gear Link repeatedly polls `m605-7453-key-settings` (profile 1) and `m605-7453-gaming-mode` (profile 99), and both return 704. The 704 replies still carried a 34 KB `file_data` |
| `50130001` | 8200 | write `m605-7453-PROFILES-DATA`, `profile_index:"99"`, `file_data` | `{result:"0"}`. Sent after every change (debounced) |
| `50150001` | 8200 | set current profile `{profile_index}` | `{result:"0"}` |

**PROFILES-DATA model**: `{data:[6 profiles], timestamp, taiwanese_time, isInitial}`. Per profile (`value` "1".."6"):

| Field | Meaning / units |
|---|---|
| `actuationPointDeadZone` | `actuationPoint`, `topDeadZone`, `bottomDeadZone` (0.1 mm); `actuationPointKeyList[{keyCode, actuationPoint}]`; `deadZoneKeyList[{keyCode, topDeadZone, bottomDeadZone}]` |
| `rapidTriggerSetting` | `enable` (mirrors the keyboard's RT mode), `globalEnable`, `globalIndependentSensitivity`, `globalContinuous`, `globalKeyList` (KeyboardEvent.code names), `globalSensitivity` / `globalPress` / `globalRelease` (0.1 mm), `perKeyList` |
| `speedTap` | `enable`, `settings[{key1, key2, enable, displayKey1, displayKey2}]` |
| `currentLightingEffect` / `defaultLightingEffect` | effect type |
| `lightEffects[10]` | per-effect `{type, speed, brightness, colors[], single[], double[], isSingleColor, isRandomColor, singleBackground, backgroundColor, width, direction, separateColors[{r,g,b,location}], analogEffect}`. Stored in UI order: index 3 holds type 4 (Rainbow) and index 4 holds type 3 (Reactive) |
| `assignedKeys` / `assignedFNKeys` | key remaps `{source, target}` |
| `keyTriggers` / `fnKeyTriggers` | DKS / Toggle / Mod-Tap definitions |
| `touchPanel` | `currentLever` (mode), `leverInfo.state{0..4:{enable}}`, `leverUp/Mid/Down.function` |
| `pollingRate` | index (3 = 8000 Hz) |
| `oled`, `power` (`isIdleMode`, `isPowerSaving`, `idleTime`, `powerSaving`, `lowPowerLevel`), `isSWMode` | stored but not written to this keyboard by Sync |

## 9. Unknown / open

- Whether writes apply before `50 55`. Whether `51 50` overwrites per-key overrides (Gear Link's ordering suggests it does not).
- Whether `51 54 … EE=0` disables rapid trigger on a key (not captured; it is the obvious reading of the layout).
- Valid ranges: observed actuation 0.5-2.0 mm, dead zones 0.2-0.4 mm, RT 0.1-0.2 mm. Firmware limits not probed.
- Profile numbering: the dropdown reads "Default Profile, Profile 1-5" while the keyboard reports 6 profiles and Sync walks 1-6. "Profile 1" is `01` and "Profile 2" is `02`. "Default Profile" is probably `06` (not tested).
- Quicksand byte `[8]`; `51 2d` with the toggle on; speed byte to label mapping (Breathing "Normal" = 30).
- What toggled rapid-trigger mode off and on by itself during the capture (`76` events at t≈802.7 s and 864.4 s).
- Polling-rate change at runtime: whether it re-enumerates USB.

## 10. State at the end of the capture (restored)

The final Sync wrote this to profile 1. The Companion copy matches the original snapshot except
actuation 1.5 → 1.0, as intended, and Static's `analogEffect` now stored explicitly as `false`.

- Profile 1 active. Polling 8000 Hz.
- Actuation 1.0 mm. Top and bottom dead zones 0.2 / 0.2 mm. No per-key overrides.
- Rapid trigger: on, global group W/A/S/D, independent sensitivity, press 0.1 mm, release 0.1 mm, continuous off (combined sensitivity 0.2 mm stored).
- Speed Tap off, pair A/D.
- Lighting Breathing, double yellow/magenta, 100 %, speed Normal (30).
- No key remaps (Insert = Insert).
