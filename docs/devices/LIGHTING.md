# Lighting (waves L1–L5)

SYNQ drives lamps and light strips directly, with no vendor app, account or cloud. Wave L1 is the **Govee H6076**
floor lamp (the "RGBICW Smart Corner Floor Lamp Basic") at the Govee Home app's level, over Bluetooth LE, from the
Windows app. Wave L2 is **every Govee model with a published scene catalogue** (81 models: strips, neon, bars, bulbs,
wall and glide lights, TV backlights, outdoor lights), each driven by its own row in a model table (§3a). Wave L3 is
the **Wi-Fi lights** that take commands on the local network (Philips Hue, Nanoleaf, Elgato, Twinkly, WiZ, Yeelight,
LIFX; §3b). Wave L4 is PC lighting without kernel drivers (Windows Dynamic Lighting and USB RGB hubs; §3c), and wave L5
is **one look everywhere**: every light in one view, looks and named groups, and screen sync across all of them (§3d).

Status words: **PROVEN** means the developer saw it on the lamp. **UNVERIFIED** means it is sent exactly as the
references describe and still needs the developer (§8).

## 1. Safety

- **Allowlist, twice.** Every frame passes `src-tauri/src/lighting/govee/guard.rs` in the bridge (the last word) and
  its mirror `checkLightFrame` / `checkLightUpload` in `src/lib/lighting/govee/frames.ts`. Both judge every line of
  `src-tauri/src/lighting/govee/frames.txt` (2,830 lines from `scripts/govee-fixtures.ts`: every allowed frame, the
  refused ones, and single-byte mutations with the checksum fixed) the same way, and build identical A3 frames
  (`light_guard_matches_the_frontend`).
- **The website** (Chrome and Edge, Web Bluetooth): every frame passes `src/lib/lighting/web/guard.ts` before it is
  sealed and written, built on the same `checkLightFrame` / `checkLightUpload` and framing uploads itself as the
  bridge does; `scripts/web-govee.test.ts` sends every line of `frames.txt` through it and gets the bridge's verdicts
  and A3 frames.
- **Refused, explicitly:** firmware and OTA (`0xEE` towards the lamp), reset, Wi-Fi and network provisioning,
  renaming, `aa b1` (it carries the device key), loose `0xA3` multi-packet frames (the bridge builds them only from a
  checked upload), the handshake frames (`0xE7`, the bridge's own), video and DreamView modes, any command or mode not
  listed in §3.
- **Uploads:** a catalogue scene's data must match the catalogue byte for byte; a DIY effect must have the shape the
  references decode (§4).
- **Connections:** a lamp is connected only while its page is open and the window is in use. The page lets go when
  the window goes to the background, and the bridge closes any lamp left open 3 s after focus is lost (the backstop
  in `lib.rs` `on_focus`). Scanning (listening to advertisements) runs only while the Devices home or a lamp page is
  on screen and someone has used the mouse or keyboard in the last minute, and stops a minute after the last ask.
- **Models:** only the SKUs in the model table (`scripts/lighting/govee/models.json` and `catalogue.json`, generated
  into `catalogue.rs` `MODELS`) are listed or opened. A Govee thermometer (`GVH5075_…`) or a model outside the table is
  never connected to. Every frame and upload is judged against the lamp's own model (its colour dialects, segments,
  white range, brightness scale, scenes, music modes, DIY); a scene's data goes only with that scene's code, on that
  model, byte for byte.
- Nothing from the vendor runs, nothing is installed, no firmware is touched.

## 2. Transport

| Fact | Value | Status |
|---|---|---|
| Service | `00010203-0405-0607-0809-0a0b0c0d1910` | PROVEN |
| Write (without response) | `…2b11` | PROVEN |
| Notify | `…2b10` | PROVEN |
| Version marker | `…2b12` (2 = v2); absent on the H6076 | PROVEN (absent) |
| Advertised names | `Govee_`, `ihoment_`, `GBK_`, `GVH` + SKU + last 4 of the address | PROVEN (`Govee_H6076_7A21`, `Govee_H6076_B308`) |
| Frame | 20 bytes: head, command, payload, XOR of bytes 0–18 in byte 19 | PROVEN |
| Heads | `0x33` set, `0xAA` query, `0xEE` event (lamp to SYNQ), `0xA3` multi-packet | PROVEN (33, AA, EE) |
| Keep-alive | an idle link drops in under 15 s; SYNQ sends `aa 01` after 5 s of quiet | PROVEN |

**Encryption.** Detection cascade (references' §10.3), cached per lamp for the app's lifetime:
`2b12` says 2 → v2; else an `e7 01` probe answered within 700 ms → v1; else plaintext.

- **v1 ("Safe"), PROVEN on the H6076:** AES-128-ECB on each whole 16-byte block, RC4 on the tail (re-keyed per
  frame). Handshake `e7 01` / `e7 02` under `K_COMM` (`MakingLifeSmarte`); the session key is the reply's
  plaintext bytes 2–17. The cipher tests replay the developer's captured handshake (`cipher.rs`).
- **v2 (AES-GCM), UNVERIFIED (no v2 lamp here):** handshake `e7 11` under `K_HS`; device key = AES-ECB(SKU ‖ MAC in
  wire order ‖ zeros) under `K_DEV`; data frames `[counter BE 4][ciphertext 20][tag 16]`, nonce = IV key (8) ‖
  counter, AAD = counter, the host counter starts at 2. Tested against NIST GCM vectors and a simulated lamp.
- AES and GCM come from Windows CNG (`BCrypt`); nothing is bundled.
- The website's copy (`src/lib/lighting/web/cipher.ts`, `session.ts`) takes AES-ECB and GCM from `@noble/ciphers`
  (WebCrypto has no ECB). The bridge's tests write `cipher-vectors.txt` (AES, RC4, v1 at every length 0–40, GCM, v2
  device keys) and `session-wire.txt` (each scheme's whole conversation with the simulated lamp, byte for byte), and
  `scripts/web-govee.test.ts` holds the website to both.

## 3. Commands (H6076)

| What | Frame | Status |
|---|---|---|
| Power | `33 01 00/01` | PROVEN |
| Brightness 1–100 % | `33 04 pp` | PROVEN |
| Whole-lamp colour | `33 05 15 01 RR GG BB 00 00 00 00 00 mask(LE16)`, mask `3FFF` = 14 segments | UNVERIFIED (the lamp names dialect 0x15 in its `aa 05` answer) |
| White 2700–6500 K, steps of 100 | `33 05 15 01 00 00 00 K(BE16) R G B mask`; R G B is SYNQ's rendering of K (Tanner Helland's fit; the app sent `ffae54` for 2700 K, so SYNQ sends its own table, `scenes.rs` `KELVIN_RGB`) | UNVERIFIED |
| Segment colours | `33 a3 00` (gradual change off, as the app does first), then `33 05 15 04 page RGB×4` for pages 1–4 (4 + 4 + 4 + 2) | UNVERIFIED |
| Segment brightness | `33 05 15 02 pp mask` | UNVERIFIED |
| Scene | `33 05 04 code(LE16)`, after the scene's A3 data when it has some | UNVERIFIED |
| Music | `33 05 13 mode sens style count [RGB]`; modes 05 Energetic, 03 Rhythm, 04 Spectrum, 06 Rolling | UNVERIFIED (field order from the H617A grammar) |
| DIY apply | `33 05 0a code(LE16)`, code 24 (the references' Type04) or 254 | UNVERIFIED (which slot the H6076 takes) |
| Queries | `aa 01` power, `aa 04` brightness, `aa 05 [00/01]` mode, `aa 06` firmware, `aa 40` LED count, `aa a5 page` segment colours | PROVEN: 01 (the keep-alive), 05. UNVERIFIED: 04, 06, 40, a5 |
| Events | `ee 30 01 xx`: power changed | PROVEN |
| Timers | not sent: their write form isn't clear from the references | needs the developer (§8) |

## 3a. Models (wave L2)

`scripts/lighting/govee/models.json` is the table; `scripts/gen-govee-scenes.ts` turns it and `catalogue.json` into
`models.generated.ts` (the app), `scenes.generated.ts` (every model's scenes) and `catalogue.rs` + `scenes.bin` (the
bridge). A model not named in the table gets the defaults.

| Field | What it decides | Where it comes from |
|---|---|---|
| `dialect` / `dialects` | The colour sub-mode SYNQ starts with, and the ones the guard lets through: `0x15` (type-tagged RGBIC: colour, white, segment pages and brightness), `0x0b` (colour + a 15-bit segment mask), `0x0d` (colour or Kelvin + its rendering), `0x02` (plain colour) | H6076: proven `0x15` only. H66A0, H66A1, H1A42: the reference's measurements, `0x15` only. H6053, H6072, H6102, H6199: `0x15` first (Beshelmek's 15-segment list). Everyone else: `0x02` first (as Beshelmek sends), all four allowed |
| `segments` | The segment count (masks, pages, the drawing) | H6076 14, H66A0/1 14, H1A42 5, the `0x15` four 15; else 0: one colour until the lamp reports a count in `aa 40` |
| `kelvin` | The white range (and whether the page shows White) | 2700–6500 K where a model is `0x15`; none elsewhere |
| `brightnessMax` | The brightness scale the guard allows | 100 where measured; 254 elsewhere (the app's other scale) |
| `music` | The lamp's own music modes, with names | H6076: the base set; H1A42: its eight measured ids; else none |
| `diy` | Whether DIY effects are sent | H6076, H617A (the Type04 table's own model); else no |

**Following the lamp.** On connecting, SYNQ asks `aa 05` (and `aa 40` when the segments aren't in the table). A
colour mode it reports that the model's row allows becomes the dialect from then on (COMMANDS.md §3.4's advice); a
segment count in `aa 40` up to the dialect's most (16 for `0x15`, 15 for `0x0b`) becomes the drawing's and the masks';
a brightness answer above 100 moves the page to the 254 scale. The page offers only the tabs the model has (Scenes when
its catalogue has some, Segments when it is paintable, Effects with DIY, Music with modes, Screen sync on `0x15` lights
with known segments). "All lamps" of mixed models: each lamp takes what its model has (a scene goes only to lamps whose
catalogue has it).

**Scenes.** `scripts/lighting/govee/extract-catalogue.ts` keeps, from Beshelmek's per-model JSON, each scene's code,
name, group and parameter data (the per-SKU `specialEffect` data where the catalogue has one): 5,991 scenes, 1,548 blobs
deduplicated to about 200 KB. Activation is the same `33 05 04 <code LE16>` after the upload.

**Pictures.** Govee's own product pictures for 52 of the 85 models: from its store where it still sells the model
(H6076, H6173, H617F, H61A8, H61C3, H61F5, H66A0, H1A42, H6046, H6061, H6079), and for the rest from
the Wayback Machine's copy of Govee's own product page, whose gallery addresses on Shopify's CDN still answer
(`scripts/device-photos/tools/vendors/goveewb.py`, rows in `goveewb-rows.json`): H6199, H605B, H61B2, H604B, H6047,
H6056, H6054, H6072, H6078, H6066, H6062, H6065, H610B, H619A, H61A0, H61E1, H6143, H618A, H6138, H6171, H7090,
H6602, H6609, H7033. Other lengths of the same light share its picture (`aliases.json`: H619C / H619E, H61A1 / H61A2
/ H61A5, H66A1, H6144, H618C / H618E / H618F, H6139 / H6196, H617C / H617E, H6175 / H6176, H61C5). The same pages
name each model and give its form (`kind` in `models.json`), and add four models no scene catalogue lists (H605B,
H6079, H6175, H6176; they get the defaults). Govee's kit shots (the box, the phone with the app and the light) are
cropped to the light alone (`CROP` in `lights.py` and `goveewb.py`), a cut strip fading out where the crop cuts it. **Still drawn** (by form, `device-shape.ts`: a TV with a glow for TV
backlights, two upright bars, a hexagon cluster, a floor lamp, the coiled strip for strips and neon only, else a
bulb): H6067 (Glide Triangle; the only gallery shots are room scenes that don't cut out cleanly), H605C (Envisual T2)
and H6088 (Cube Wall Sconces), whose only pictures are kit shots where the box hides part of the light, H617A (no
archived page), and the models no archived page names, so their form is unknown and they are drawn as a bulb: H6006, H6009,
H6010, H601A, H601B, H604A, H6053, H6057, H6059, H6102, H610A, H615E, H6172, H61E0, H7020, H7021, H7041, H7050,
H7051, H7055, H705A, H705B, H705C, H7060, H7061, H7062, H7065, H7066, H70B1. Not found on any archived Govee page
(so not added): H6159, H61A3, H6168, H6022, H6051.

Everything in a row that isn't in `proven` is UNVERIFIED (§8).

## 3b. Wi-Fi lights (wave L3)

Philips Hue, Nanoleaf, Elgato, Twinkly, WiZ, Yeelight and LIFX, reached **on the local network only**: no cloud, no
account, no maker's app at run time. All UNVERIFIED on real lights (§8, items 14–20).

**Finding them.** Only when the person presses **Find lights** (the quiet "Find Wi-Fi lights" tile at the end of the
Devices home's All and Lights views, the Lights view, or a light's page): never in the background, never on a timer. The bridge asks for about 1.5 s: mDNS for `_hue._tcp`,
`_nanoleafapi._tcp` and `_elg._tcp` (Twinkly answers its own `\x01discover` on UDP 5555), SSDP `M-SEARCH` to
239.255.255.250:1982 for Yeelight, WiZ's `getPilot` broadcast on UDP 38899, LIFX's `GetService` broadcast on UDP 56700.
The list lasts for the session. Messages go only to the addresses discovery found (`src-tauri/src/lighting/net/mod.rs`).

**Windows Firewall.** SYNQ never listens: no fixed port is bound (not 5353, not 56700), no multicast group is
joined, nothing calls `listen`. Each discovery question goes out from its own ephemeral UDP port and the answers are
unicast replies to that port within 1.5 s, which Windows lets through as responses to a multicast or broadcast just
sent ("unicast response to multicast", a 3 s allowance on by default; read on the developer's PC, profile Public:
`UnicastResponseToMulticast Enable`, `InboundUserNotification Enable`). mDNS asks with the unicast-response bit and from
a port other than 5353, so responders answer by unicast (RFC 6762 §6.7). Every message to a light is an outgoing TCP
connection (Hue, Nanoleaf, Elgato, Twinkly over HTTP; Yeelight's JSON lines) or a UDP socket **connected** to the light
(WiZ, LIFX), which takes datagrams from that light only. Windows shows its "allow access" dialog when an app listens
for inbound traffic, so none of this should raise it; that is UNVERIFIED on the developer's PC (§8 item 14), and the first
Find lights says beforehand that Windows may ask. SYNQ never adds or changes firewall rules. If a network's policy
turns the multicast allowance off, Find lights finds nothing and nothing is asked.

**Pairing.** Hue and Nanoleaf need a key, and getting one takes a step at the device: the page walks through it with a
30 s countdown (press Pair, then Hue's round link button, or hold Nanoleaf's power button 5–7 s until it flashes),
asking every 2 s while the device has pairing open. The bridge keeps the keys in `lighting-keys.json` in the app's data
folder (Hue's username and client key, Nanoleaf's token); the page never sees one; "Forget pairing" deletes it there.
Twinkly logs the bridge in with its own challenge each session (no key to keep). Elgato, WiZ and LIFX need nothing.
**Yeelight** takes commands from the network only after **LAN Control** is switched on per light in Yeelight's own
app: that breaks the one-app rule, and the page says so plainly rather than hiding it. First-time Wi-Fi setup is the
maker's app for every brand; each light's page names it. SYNQ never provisions Wi-Fi.

**What each brand is sent** (`src/lib/lighting/net/allowlist.json`, judged the same by `guard.ts` and the bridge's
`guard.rs`, held together by `src-tauri/src/lighting/net/messages.txt`):

| Brand | Transport | Allowed | Refused (examples) |
|---|---|---|---|
| Hue | HTTP, bridge v1 API | `POST /api` (pairing), `GET` config and lights, `PUT /lights/<n>/state` with on, bri, hue, sat, ct, transitiontime; `GET /scenes` and `/scenes/<id>`, `PUT /groups/<n>/action` with only `scene` (recall) | config and firmware (`swupdate`), names, schedules, rules, the whitelist, alerts; making, changing or deleting a scene (`POST /scenes`, `PUT /scenes/<id>`, its `lightstates`, `DELETE`) |
| Nanoleaf | HTTP :16021 | `POST /api/v1/new` (pairing), `GET` state (with the effects list), `PUT state` (on, brightness, hue, sat, ct), `PUT effects` with only `select` (an effect by name) | identify, layout, deleting or writing effects (`write`: add, request, delete, rename) |
| Elgato | HTTP :9123 | `GET` accessory info and lights, `PUT /elgato/lights` (one light: on, brightness, temperature, hue, saturation) | names, power-on behaviour, identify, Wi-Fi |
| Twinkly | HTTP | `GET` gestalt, LED mode and brightness; `POST` LED mode (off, color, movie, effect, playlist), brightness, colour (login and verify are the bridge's own) | network, firmware, reset, device name, real-time mode |
| WiZ | UDP JSON :38899 | `getPilot`, `getSystemConfig`, `setPilot` (state, dimming, r g b, temp, sceneId, speed) | `setWifiConfig`, `setSystemConfig`, `reboot`, `reset` |
| Yeelight | TCP JSON lines :55443 | `get_prop`, `set_power`, `set_bright`, `set_rgb`, `set_ct_abx` | `set_name`, `set_default`, `cron_*`, `set_music` |
| LIFX | UDP binary :56700 | `GetService` (discovery), `GetLabel`, `GetVersion`, `Get`, `SetColor`, `SetLightPower`, each to one light by its MAC | labels, reboot, any set sent to all lights at once |

**The page.** A Wi-Fi light gets the same Light tab as a lamp (colour wheel, white where it has a range, brightness,
power), a white-only light (Elgato's Key Light) shows white only, and a light with no white range (Twinkly) colour only.
Changes go out coalesced at each brand's pace (Yeelight about one message a second, its quota; Hue and Nanoleaf ten;
LIFX twenty), and after a burst the light is asked what it shows. A paired Hue bridge's lights each get a card.
Hue's Entertainment streaming (DTLS) comes with L5's screen sync across lights: the client key is fetched at pairing
so it won't need pairing again then (§9).

**Scenes (recall only).** A Hue light's page and a Nanoleaf controller's page have a Scenes tab
(`src/lib/lighting/net/scenes.ts`, `NetScenesTab.tsx`) with the scenes the light already has, in the same cards as a
Govee lamp's: Hue, the bridge's scenes that include the light (`GET /scenes`; the Hue app's own `recycle` scenes left
out), each with swatches from its lights' colours (`GET /scenes/<id>`: xy, colour temperature or hue and saturation,
up to five); Nanoleaf, the effects list in its state, by name (no colours: the list has names only), the one showing
marked. A tap recalls it: Hue through the scene's group's action (`PUT /groups/<n>/action` `{"scene": id}`; a scene of
lights through group 0, which sets every light in the scene, as the page says), Nanoleaf by selecting the effect by
name. SYNQ never makes, edits or deletes a scene or an effect; the allowlist has exactly those reads and the two
recalls, with fixtures for each and for the scene writes it refuses (`messages.txt`).

**Pictures** (`scripts/device-photos/tools/vendors/wifilights.py`), matched by the model a light reports: Philips Hue's
own renders (Signify's image server, transparent) for the White and Color Ambiance A19 ("Hue color lamp"), the
Gradient Lightstrip, the Play Gradient Light Tube and the Flux strip; Nanoleaf Shapes Hexagons (NL42) and Lines (NL59);
Elgato's Key Light and Light Strip; Twinkly Strings for any Twinkly (it reports only its brand); a WiZ color bulb for
any WiZ; the Hue Bridge (BSB002) itself, on its card and its page. Still drawn: LIFX (its store has only packaging
shots), Yeelight (no product picture reachable), the Key Light Air and any other model without a picture; a strip or stripe is drawn as a strip,
Nanoleaf as panels, the rest as a bulb.

## 3c. PC lighting (wave L4)

Two paths, neither with a kernel driver. **Never** ASUS Aura, Armoury Crate, AsIO, SMBus, motherboard or RAM RGB: those
devices aren't in any table here, aren't listed, and nothing is sent to them.

**Windows Dynamic Lighting (LampArray).** A device watcher on `LampArray.GetDeviceSelector` (running only while the
Devices home or a Dynamic Lighting page is on screen) learns of every device that speaks the HID LampArray standard as it
arrives or leaves. Each device is opened once, on arrival, to read what kind it is (keyboard, mouse, case, scene light...)
and its USB ids, then let go; nothing is set on it. The kind picks its drawing (a keyboard is drawn as a keyboard, a case as
a box, a scene light as a light; `device-shape.ts`), and a device SYNQ has a picture of (same USB id) shows that
picture. A device's page opens it (`LampArray.FromIdAsync`) and reads its
kind, size, lamp count and each lamp's position and purposes, and draws the lamps where the device puts them. One
colour (`SetColor`) or a simple effect (breathe, rainbow, wave; `SetColorsForIndices` about 20 times a second) runs while
the page is open and SYNQ is the window in front; the bridge checks that itself before every write, and lets go of
the device when the window loses focus. ASUS devices (by the vendor in the interface id, the vendor Windows reports, or an
ASUS / Aura / Armoury / ROG name) are never listed, opened or lit.

- **Background control: not possible for SYNQ.** Windows hands LampArray devices to the app in front. A background
  ("ambient") controller must declare the `com.microsoft.windows.lighting` AppExtension in its package manifest, and
  Windows' ambient lighting server accepts only processes with package identity (Microsoft Learn, "Dynamic Lighting",
  `lighting-dynamic-lamparray`; Windows 11 build 23466 and later). `LampArray.AvailabilityChanged` has the same
  requirement. SYNQ is an unpackaged Win32 app, so the page says plainly that only the app in front drives these
  lights and points to Settings > Personalization > Dynamic Lighting for background effects. (A signed MSIX or sparse
  package would lift this; SYNQ ships unsigned.)
- UNVERIFIED (no LampArray device here was opened): lamp positions, availability while another app holds the device.

**USB RGB hubs.** From the protocol facts OpenRGB documents (§10). Listed from HID enumeration (nothing opened); opened
only on the hub's vendor collection (Lian Li: `0xFF72:0xA1`; the others: their one vendor-defined page), only for a
model in `src/lib/lighting/hidrgb/hubs.json`. Every report passes `checkHubFrame` in the page and `hidrgb::check` in the
bridge; both judge `src/lib/lighting/hidrgb/rgb-frames.txt` (1,224 lines from `scripts/hidrgb-fixture.ts`: every report
SYNQ builds, the refused ones and single-byte mutations) the same way.

| Family | Models | Read | Sent | Status |
|---|---|---|---|---|
| NZXT HUE 2 (`1E71`) | HUE 2, HUE 2 Ambient, Smart Device V2, RGB & Fan Controller (2/6 channels), RGB Controller | firmware (`10 01`), accessories per channel (`20 03`) | colours `22 10/11` (G, R, B; 20 LEDs a report), apply `22 A0` | UNVERIFIED |
| Corsair Lighting Node (`1B1C`) | Lighting Node Pro / Core, Commander Pro, LS100, LT100 | firmware (`02`) | reset, begin, hardware control, one static colour effect, commit | UNVERIFIED |
| Lian Li Uni Hub SL (`0CF2:A100`) | Uni Hub SL | (nothing to read) | activate fans, colours (R, B, G), static mode at full brightness | UNVERIFIED |

- Refused: fan and pump speeds, firmware and bootloader commands, effects other than one static colour, Corsair's
  software (direct) mode (it needs a running app's keep-alive every 5 s; the hardware effect stays with no app), LED
  count and protocol setup, temperatures, other channels or lengths. NZXT's motherboard devices are left out.
- Before the first change, SYNQ keeps everything the hub reported (firmware, NZXT's accessories) as a backup in the
  app's data folder (`rgbhub-` files). The hubs can't report the effect or colours they show (Corsair's protocol has no
  read for its effect either), so Put back sends the colour SYNQ sent before the latest one, and the page says so next
  to "Allow changes", which every change waits for.
- **The developer's PC:** `1B1C:0C57` is the **CORSAIR Nautilus LCD Cap** (the screen cap of a Nautilus cooler; its USB
  product string). It has a single HID collection, Consumer Control (`0x000C`), and no open project documents its
  screen or lighting, so SYNQ lists it read-only and sends it nothing.
- Lian Li's first Uni Hub (`0CF2:7750`) and the AL v1.0 talk over USB control transfers, which need a WinUSB driver swap;
  SYNQ doesn't change drivers, so they aren't listed.

## 3d. One look everywhere (wave L5)

**The Lights view.** The Devices home's "All lights" card (shown once there are two lights of any kind) opens one view
of every light SYNQ drives: Govee lamps over Bluetooth, Wi-Fi lights found by Find lights, Windows Dynamic Lighting
devices, and USB RGB hubs (one light per hub: the channels chosen on its page). `src/lib/lighting/look/` keeps them in
one list with keys that stay the same (`govee:<address>`, `wifi:net~<brand>~<id>[~<n>]`, `dl:<id>`, `hub:<vid:pid>`).

- **A look** (one colour, a white, or a gradient; a brightness; on or off) goes to every light in the group at once,
  each through its own controller and guard and at its own pace (`LookControl`, `drivers.ts`). A light that joins takes
  the current look; a light without a white of its own gets the white as a colour, one without brightness the colour
  dimmed, one without segments a gradient's middle, and a white-only light (a Key Light) only whites and brightness.
- **Groups** are named by the person and kept in `lighting.json` (`groups`: an id, a name and the lights' keys).
- Lights are opened while the view is open and the window is in use, and let go when it closes (Bluetooth lamps also
  when the window goes to the background, as on their pages). A hub takes changes only after "Allow changes" in the
  view, as on its own page; a Dynamic Lighting device takes colours only while SYNQ is in front (Windows' rule), and
  the view says so. The Govee lamps' shared scenes, effects and music stay one click away ("Govee lamps together").

**Screen sync across lights.** The view's Screen sync tab starts it for the group's lights that can follow:

- Govee lamps run their own sync (L1's, one bridge thread per lamp, unchanged). Wi-Fi lights and USB hubs follow one
  sampler in the bridge (`src-tauri/src/lighting/sync.rs`): the chosen edge is read into one colour per light, the
  lights in order along it, and each light gets its colour from a thread of its own at its pace (LIFX 20 a second, WiZ
  and Nanoleaf 10, Hue's REST and Elgato's Light Strip about 7, Twinkly 4, a hub 5), only when it moved by more than 6
  on a channel. The bridge builds these messages itself (the page may be in the background): a Wi-Fi light's through
  `net/colour.rs` and `guard.rs`; a hub's one static colour on each channel chosen on its page through `hubframes.rs`,
  byte for byte the page's (a test holds it to `rgb-frames.txt`) and `hidrgb.rs`'s guard. A hub follows only once
  its changes are allowed in the view, and one change goes through its page's session first so its backup is kept.
- Left out, greyed in the picker with the reason: Dynamic Lighting devices ("Dynamic Lighting devices follow the app in
  front, so they can't follow the screen."), Yeelight (about one change a second, its quota), white-only lights, and
  Govee models without a segmented colour mode.
- **Which display.** With more than one display, both sync tabs (a lamp's and the Lights view's) show a picker of the
  displays, named and sized as Windows reports them, primary first (`screen::monitors`: `EnumDisplayMonitors` and
  `GetMonitorInfoW` for each one's place and size, the display configuration's target name for its name, "Display n"
  when it has none). The sampler reads the chosen display's strips at its place on the desktop; a display that has
  gone falls back to the primary. A running lamp sync moves to a newly picked display at once; the Lights view's picker
  waits until its sync is stopped. Any display change (one added, removed, moved or resized) still stops a sync.
- The same safeguards as the lamp sync: it stops when the screen locks, the PC sleeps or the displays change; a black
  or failed grab holds the colours (black is never sent, and the view says "Can't see this window, holding colours");
  a light that fails twice in a row is let go and named; with none left it stops. It runs on with SYNQ in the
  background until Stop: in the view, or on any synced light's card and the All lights card.

**Hue Entertainment.** Hue lights follow smoothly through an Entertainment area: one HueStream v1 stream (`net/hue.rs`)
inside DTLS 1.2 with a pre-shared key (TLS_PSK_WITH_AES_128_GCM_SHA256, `net/dtls.rs`, SYNQ's own small client:
AES-GCM by Windows CNG, SHA-256 by the `sha2` crate) on UDP port 2100, the bridge username as identity and the client
key from pairing as the key, 25 messages a second. If the bridge has areas, the person picks one. If it has none, the
view says exactly what changes: "SYNQ will add an Entertainment area named 'SYNQ' to your Hue Bridge with these
lights. Nothing else on the bridge changes. You can remove it here any time." Create makes it and records its number
(`lighting-keys.json`, `hue:<bridge>#area`); "Remove SYNQ's area" deletes only that number. An area SYNQ didn't
make is never changed or removed: the bridge refuses a plain message that would make or delete a group, and the
allowlist takes exactly these Entertainment calls (fixtures in `messages.txt` for each, and the variants it refuses):
`GET /api/<key>/groups`; `POST /api/<key>/groups` with `name` "SYNQ", `type` "Entertainment", `class` TV or Free
and up to 20 lights; `DELETE /api/<key>/groups/<n>`; `PUT /api/<key>/groups/<n>` with `{"stream": {"active": …}}`.
Hue lights outside the chosen area (or with no area) still follow, through the bridge's REST, more slowly.
The DTLS handshake is tested in memory against a server built from the same pieces (a cookie, a lost flight, a wrong
key) with HMAC and the PRF checked against known answers; it is UNVERIFIED with a real bridge (§8, item 22).

## 4. Uploads (A3 multi-packet)

Payload `01 <frame count> <type> <body…>`, cut into frames `a3 <index> <17 bytes>`; the last index is `ff`; a single
chunk gets an extra terminator frame. The lamp answers `a3 <type> <result>` (0 = taken); the bridge paces frames
100 ms apart and waits up to 1.5 s for the answer.

- **Scenes (type 02):** the model's catalogue data for that scene, verbatim (the upload names the scene's code; the
  guard compares). The H6076 has 58 scenes, 49 with data; every model's catalogue is Govee's published library for the
  SKU as mirrored by Beshelmek/govee_ble_lights (MIT; extracted at build time, `scripts/lighting/govee/`).
- **DIY (type 04):** `[family][variant][speed 0–100][3n][RGB × n]`, n ≤ 8, family / variant from the H617A Type04
  table (`diy.ts` `DIY_STYLES`); a combo is family `ff` + `[2k][family variant × k]`, k ≤ 4. Only models with `diy`.

## 5. What the app does

- **Devices home:** a card per light the scan hears ("Floor Lamp 7A21", Govee's own product picture), "All lamps" once
  two are heard ("All lights" when one of them isn't a lamp), greyed when only heard faintly (below −92 dBm).
- **Lamp page:** the light drawn as it looks, from its model's form (`src/lib/lighting/stage.ts`): a floor lamp's pole
  on its foot (segment 1 at the bottom), a TV backlight up the left edge, across the top and down the right edge of a
  dim TV, light bars as two upright bars (the first half of the segments on the left bar, each from its foot up), a
  strip or neon rope as a wave (segment 1 at the left), panels as a cluster of tiles chained row by row, one colour as
  a single glow; each segment lit as the light reports it; tap or drag along it to paint with a brush (the arrow keys
  and Enter too); the colour wheel with recent and saved colours (kept in `lighting.json` in the app's data folder); white
  from warm to cool; brightness; power; Segments: gradients over 2–6 colours (ready-made and saved) and each segment's
  own brightness. Changes show at once, go out at about 14 writes a second (the last value wins), and 0.9 s after a
  burst the lamp is asked what it shows (`aa 01/04/05/a5`), so the page settles on the lamp's own answer.
- **Scenes:** all 58 of the lamp's library, grouped like Govee's app (Life, Funny, Natural, Emotion, Festival) with a
  search, each card a moving preview in the scene's own colours (CSS transforms only; still while the window is idle).
  One tap: the scene's data is uploaded (when it has some), then the scene is switched on.
- **Effects (Govee's DIY):** up to eight colours, a motion (Fade, Jump, Flash, Marquee, Music, Stream, Flow, Chase)
  and its variant, or a mix of two to four motions, and a speed; "Try it on the lamp", Save, and the saved effects
  (in `lighting.json`) each with Apply, Edit and Delete. Three starters while none are saved.
- **Music:** the lamp's own modes (Energetic, Rhythm, Spectrum, Rolling) on its own microphone, sensitivity, style
  (Dynamic / Calm), and the lamp's colours or one colour of yours. SYNQ doesn't listen or send sound.
- **Screen sync:** off by default. When started, the bridge reads thin strips of one display (the primary, or another
  picked on the tab when there are several: §3d) (the left or
  right edge, both, or three strips for the whole screen) about 6 times a second (2 once the picture stands still) and
  sends only the segment pages that changed (`govee/stream.rs`, the same page frames the guard allows, plus one
  gradual-off). Black (exclusive full screen, protected video) is never sent: the lamp holds its last colours and the
  page says so. While it runs the lamp stays connected even without its page and in the background (the only
  exception to the focus backstop), with a "Syncing to the screen" chip and Stop on its Devices home card. It stops on
  Stop, a colour / scene / effect / music change or power off, the screen locking, the PC sleeping, the displays
  changing, or the lamp not answering after one retry. Cost: docs/performance.md.
- **States:** looking (not heard yet), connecting, out of reach (with the likely reasons: range, the wall switch, a
  phone holding the lamp), paused (window in the background), connection lost (Reconnect).
- **All lamps:** every change goes to each lamp that answered; the lamps that didn't are named; each lamp's own page
  is one click away.
- **The website** (Chrome and Edge, which have Web Bluetooth): Lights has **Add a light**, which opens the browser's
  Bluetooth chooser filtered to Govee names; the lamp picked opens on the same page with every tab but Screen sync (a
  tab can't read the screen). There is no scan: the chooser is the list, and Chrome keeps `getDevices()` and
  `watchAdvertisements()` behind a flag, so a lamp is kept for the tab only (picked again next visit) and has no
  signal reading. Web Bluetooth gives no address, so the lamp's id is the browser's own; nothing needs the address (a
  v2 lamp names it in its handshake). Encryption, keep-alive, pacing and letting go in the background are the bridge's.
- Linux lists no lamps (the desktop's Bluetooth path is the Windows bridge's for now).

## 6. Where the code is

| Piece | Where |
|---|---|
| Frames, guard, report parser | `src/lib/lighting/govee/frames.ts`, `spec.ts` (a model's spec), `diy.ts`, `kelvin.ts` |
| Model table and scene catalogues | `scripts/lighting/govee/models.json`, `catalogue.json` (`extract-catalogue.ts`), `scripts/gen-govee-scenes.ts` |
| Generated tables | `src/lib/lighting/govee/models.generated.ts`, `scenes.generated.ts`; `src-tauri/src/lighting/govee/catalogue.rs`, `scenes.bin` |
| Simulated lamps (preview, e2e, tests) | `src/lib/lighting/govee/sim.ts`, `models.ts` `SIM_LAMPS` |
| Lamp list, link, session, controller | `src/lib/lighting/lamps.ts`, `link.ts`, `session.ts`, `lamp.ts` (`LampController`, `LampGroup`) |
| Saved colours, gradients, DIY | `src/lib/lighting/saved.ts` (`lighting_load` / `lighting_save`) |
| UI | `src/components/lighting/` |
| Bridge | `src-tauri/src/lighting/govee/` (`ble.rs` scan and GATT, `session.rs` detection and handshakes, `cipher.rs`, `guard.rs`, `mod.rs`) |
| Tests | `scripts/lighting.test.ts`; Rust `guard`, `cipher`, `session`, `mod` tests; e2e "opens a lamp, paints it…" |
| Website (Web Bluetooth) | `src/lib/lighting/web/` (`cipher.ts`, `session.ts`, `guard.ts`, `bluetooth.ts` the GATT link, `link.ts` the lamps added and their LampLink), `src/components/web/AddLight.tsx`; fixtures `cipher-vectors.txt`, `session-wire.txt` next to `cipher.rs`; tests `scripts/web-govee.test.ts` |
| Photos | `src/assets/devices/govee/` (`scripts/device-photos`: `tools/vendors/lights.py`, today's store; `goveewb.py`, Govee's archived pages) |
| Wi-Fi lights (L3): rules, guard, brands, link, store, controller, sims | `src/lib/lighting/net/allowlist.json`, `guard.ts`, `brands.ts`, `link.ts`, `lights.ts`, `control.ts`, `sim.ts`; `src/components/lighting/NetLightPage.tsx`, `FindLights.tsx` |
| Wi-Fi bridge | `src-tauri/src/lighting/net/` (`discover.rs` Find lights, `wire.rs` HTTP / UDP / TCP, `guard.rs`, `mod.rs` pairing, keys, sending); fixture `messages.txt` (`scripts/net-fixtures.ts`); tests `scripts/lighting-net.test.ts` |
| The paint drawing by form | `src/lib/lighting/stage.ts` (`formOf`, `stageGeometry`, `segmentAt`), drawn by `LampStage.tsx`; `scripts/lighting-stage.test.ts` |
| One look everywhere (L5) | `src/lib/lighting/look/` (`lights.ts` the list, `control.ts` the look, `drivers.ts` each kind, `sync.ts`), `saved.ts` (groups); `src/components/lighting/LightsView.tsx`, `LightsSync.tsx`; bridge `src-tauri/src/lighting/sync.rs`, `hubframes.rs`, `net/colour.rs`, `net/hue.rs`, `net/dtls.rs`; tests `scripts/lighting-look.test.ts`, Rust `dtls`, `hue`, `colour`, `sync` tests |
| PC lighting (L4) | `src/lib/lighting/lamparray.ts` (effects), `lamparrays.ts` (the list), `hidrgb/` (`hubs.json`, `protocol.ts`, `guard.ts`, `session.ts`, `sim.ts`, `connect.ts`, `rgb-frames.txt`); `src/components/lighting/LampArrayPage.tsx`, `RgbHubPage.tsx`, `ColourPicker.tsx`; bridge `src-tauri/src/lighting/lamparray.rs`, `hidrgb.rs`; tests `scripts/hidrgb.test.ts`, Rust `hidrgb` and `lamparray` tests |

## 7. Not done yet

Timers (§8). Scenes on Hue and Nanoleaf are recalled only, never made or changed (by design).

## 8. Needs the developer

Each of these is sent exactly as the references describe; the developer session confirms it on the lamp (the ordered
checklist is in the milestone report):

1. The segment order: is segment 1 the bottom of the lamp (as drawn) or the top? For other forms the drawing follows
   the usual way each is laid (a TV backlight from the bottom left, bars left then right, strips from the left);
   which end each model counts from is UNVERIFIED.
2. All 14 segments exist and respond (painting segment 14 lights the last one).
3. The segment pages and the `33 a3 00` prelude (gradual change off).
4. Segment brightness.
5. White: real white LEDs or mixed RGB, and whether the H6076's range is 2700–6500 K.
6. `aa a5` page answers (the drawing shows the lamp's real colours after reopening).
7. Whether a colour change turns on a lamp that is off by itself (SYNQ turns it on first).
8. Scenes: the upload is acknowledged (`a3 02 00`) and the lamp runs the scene; a built-in scene (no data) switches
   on by its code alone.
9. Effects: the upload is acknowledged (`a3 04 00`) and slot 24 runs it (else 254 is the one); each motion and the
   speed look right; a mix plays its motions in turn.
10. Music: each mode reacts to sound; the style byte (0 / 1) really is Dynamic / Calm; one colour vs the lamp's.
11. Screen sync: the lamp follows the edge colours smoothly with no visible lag or flicker; a game in exclusive full
    screen holds the colours (no dark lamp); locking the PC stops it.
12. Every other model (wave L2): power and brightness (and whether a value above 100 means the 254 scale), the colour
    dialect its row starts with (else the one it reports), its segment count in `aa 40`, white where its row has a
    range, and one scene with data and one without from its catalogue. Owners of other Govee lights can report what
    worked; until then the Devices home marks them Experimental.
13. Timers: the write form isn't clear, so SYNQ doesn't send them. If the developer wants them, a capture of the Govee
   app setting one (the developer's phone, not SYNQ) would settle it.
14. Wi-Fi lights, Find lights: pressing it on the developer's PC raises no Windows Firewall dialog (if it does, say which
    profile and which choice was made; SYNQ changes no rule either way), and it lists the Wi-Fi lights in the house.
15. Hue: pairing with the link button inside the countdown; each light gets a card; power, brightness, colour and white
    on one light; Forget pairing then Find lights shows the bridge unpaired again.
16. Nanoleaf: pairing with the power-button hold; power, brightness, colour, white.
17. Elgato: a Key Light shows white only and takes temperature and brightness; a Light Strip takes colour.
18. Twinkly: the bridge's login works; power, brightness and one colour.
19. WiZ and LIFX: power, brightness, colour and white; LIFX's colour after a brightness change keeps its hue.
20. Yeelight: with LAN Control on, power, brightness, colour and white, and a dragged slider stays inside its quota (no
    "client quota exceeded" errors).
21. The Lights view: a colour, a white and a gradient reach every kind of light at once; a group saved and reopened;
    a hub changes only after Allow changes there.
22. Hue Entertainment: with no area, Create makes "SYNQ" with the chosen lights and nothing else changes in the Hue
    app; Remove deletes only it; with the Hue app's own area picked, the stream starts (the DTLS handshake completes)
    and the lights follow the screen at full pace; stopping returns the area to normal.
23. Screen sync across lights: Govee lamps, Wi-Fi lights and a hub (after Allow changes) follow together, each at its
    place along the edge; locking the PC stops everything; a light unplugged mid-sync is named as let go and the rest
    carry on.
24. Scenes: a Hue light's tab lists the bridge's scenes that include it, with swatches like the Hue app's; a tap
    recalls one (every light in that scene changes, nothing on the bridge is edited); a Nanoleaf controller's tab lists
    its effects and a tap switches to one.
25. Another display: with a second monitor connected, both sync tabs name it as Windows does with its size; the lamp
    and the lights follow that display's edge; unplugging or moving a monitor stops the sync.
26. The website in Chrome or Edge (desktop app closed, Govee Home closed on the phone): Add a light lists the H6076s
    and nothing that isn't a Govee name; the page says `encryption v1` and connects; power, brightness, a colour, a
    painted segment, a scene with data and an effect reach the lamp; alt-tabbing away lets go of it and coming back
    reconnects; switching it off at the wall says the connection was lost.

## 9. Later waves

- **L3, done (§3b).** Hue's and Nanoleaf's own scenes are recalled from their tabs; Hue's Entertainment streaming came
  with L5's screen sync across lights (§3d).
- **L4, PC RGB without kernel drivers (first part done, §3c):** Windows Dynamic Lighting (LampArray), USB HID hubs with open documentation
  (Corsair Commander Core / Pro and iCUE LINK, NZXT RGB & Fan, Lian Li Uni Hub, …). **Never** SMBus, motherboard or
  RAM RGB: those need kernel drivers.
- **L5, done (§3d).** Mice and keyboards keep their own lighting tabs; the Lights view doesn't drive them.

## 10. Credits

- **OpenRGB** (GPL-2.0, Adam Honse and contributors, gitlab.com/CalcProgrammer1/OpenRGB): the USB hub protocols of wave L4
  (`NZXTHue2Controller`, `CorsairLightingNodeController`, `LianLiUniHubSLController`). Facts only; no code copied.

- **Fredde87/ha-govee-led-ble** (MIT, © 2024 teh-hippo and contributors): the protocol write-up (`PROTOCOL.md`,
  `COMMANDS.md`, the Kaitai grammars) this wave is built from: both encryption generations, the detection cascade,
  the command and upload layouts. SYNQ's code is its own; no code was copied.
- **Beshelmek/govee_ble_lights** (MIT, © 2021 Vladimir Votyakov): the scene catalogues Govee publishes per SKU, extracted
  for the build (`scripts/lighting/govee/SOURCE`), and the colour dialect it sends each model.
- The product pictures are Govee's own (us.govee.com, today's or the Wayback Machine's copy), © Govee.
- Wave L3 is written from each maker's published local API: Philips Hue's developer documentation (v1 API), Nanoleaf's
  OpenAPI, Elgato's local API as documented by adamesch/elgato-key-light-api, Twinkly's xled API as documented by
  scrool/xled-docs, WiZ's UDP messages as documented by pywizlight, the Yeelight Inter-Operation Specification and the
  LIFX LAN protocol. SYNQ's code is its own; no code was copied.
