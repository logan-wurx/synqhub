# Performance (Phase 1: same WebView2 UI, lighter)

What SYNQ does to stay light, why, and what it costs. Measured on the release build, hidden
(window off-screen, never focused), 2026-10-13. "Private" is commit (Private Bytes); "in RAM" is the
private working set, which is what Task Manager shows.

| | Before | After |
|---|---|---|
| Sound page, idle | 232–236 MB private (124 in RAM) | 123–125 MB private (96–97 in RAM) |
| Keyboard page open | 272–274 MB | 140–141 MB |
| Back on Sound after every page (+30 s) | 272–277 MB (154–161 in RAM) | 144–145 MB (58 in RAM) |
| Minimized | not handled | 127 MB private, **11–12 MB in RAM**, 0 CPU |
| Idle CPU | ~0 | ~0 |
| EQ on screen after launch | 590–630 ms | 460–520 ms |

## WebView2 flags (`src-tauri/tauri.conf.json`, `additionalBrowserArgs`)

`--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection` are Tauri's defaults and stay.

- `--in-process-gpu` (−64 MB): the GPU process' work runs inside the WebView2 browser process.
  WebView2 then turns GPU compositing off by itself (measured: `gpu_compositing: disabled_software`),
  so the page is drawn in software either way.
- `--disable-gpu` (−48 MB more): since the page is software-drawn anyway, this skips creating the
  Direct3D device that nothing used. Screenshots are pixel-identical with and without it.
- `--enable-features=NetworkServiceInProcess2` (−9 MB): the network service runs in the browser
  process instead of its own. SYNQ's pages come from the app itself; the only requests it makes are
  the one-time VIA layout fetch, Find your headphones' AutoEq download and the Games page's Steam cover art, all described below.

Tried and not kept (no measurable win, or a visible change): `--renderer-process-limit=1`,
`--js-flags=--max-semi-space-size=1`, `--force-gpu-mem-available-mb`, `--force-gpu-mem-discardable-limit-mb`,
`--disable-direct-composition`, `--disable-gpu-shader-disk-cache`, `--disable-breakpad`,
`StorageServiceOutOfProcess` (gone from this WebView2), `--enable-low-end-device-mode` (no win),
`--js-flags=--lite-mode` (−7 MB, but every script runs interpreted).

**Trade-offs**
- Software drawing vs. the old GPU drawing: up to ~1% of pixels differ by anti-aliasing at shape
  edges (text stays sub-pixel; nothing a person can see). CPU while interacting is about the same:
  hovering the EQ graph costs less, a notice animation costs a little more (~+0.1 s CPU per notice).
  Frame pacing stayed at the display rate (240 Hz here) with no long frames.
- GPU crash behaviour: with `--in-process-gpu` alone, a graphics-driver crash or reset would take the
  whole WebView down (blank window, restart SYNQ) instead of only restarting a GPU process.
  With `--disable-gpu` next to it no driver code runs in SYNQ at all, so that risk is gone. If a
  future page needs WebGL, video or GPU canvas, remove `--disable-gpu` first, and then also weigh
  `--in-process-gpu` against that crash risk.
- No sandbox or security switch is changed. The network service and the compositor lose their own
  process (SYNQ loads nothing from the internet but the one-time VIA layout, and when asked, the AutoEq list and Steam cover art below).

## Pages that aren't on screen are unmounted (`src/App.tsx`)

The Mouse and Keyboard pages exist only while shown. What was being done on them is kept in small
module stores (`src/lib/keep.ts`): the picked mouse/keyboard, unsaved DPI steps, the key map mode and
selection, inspector drafts, the X68 forms, pending polling choices and the scroll position. Coming
back shows the page exactly as it was.

Device sessions live in `src/lib/device-session.ts`: leaving a page doesn't close its session, so
anything in flight finishes. With no page holding it for 30 s, nothing in flight and no unsaved DPI
steps, the session closes (the driver's own `close()`); coming back reconnects quietly behind the
last view, and a change made before it has reconnected waits for it. A device that's unplugged has
its session closed at once and its panel starts fresh, as before. No protocol, write or timing changed.

The Sound page stays mounted (hidden) on purpose: it holds the EQ and its pending save, so it is
never reloaded under an edit. Hidden, it costs about 820 DOM nodes and nothing in layout or paint.

15 s after a device page is closed, and 30 s after the window loses focus, SYNQ asks WebView2 for
the Low memory target for 1.5 s (`memory_trim`, `src/lib/trim.ts`): scripts keep running, nothing on
screen changes (screenshots identical), and what the page isn't using leaves RAM.

## Devices home and device tabs (`src/components/devices/`, `src/lib/nav.ts`)

The app opens on the Devices home: one card per connected device (each mouse, each keyboard, the sound
output). It reads only what the panels already keep (`src/lib/keep.ts`, `src/lib/device-model.ts`: name,
capabilities, tier, battery, whether the mouse answered the read-only check) and never opens a device, so
the home costs no device I/O and no timer. Like the Mouse and Keyboard pages it is mounted only while shown
(its renders are decoded only then); Settings is a lazy chunk and mounted only while shown too.

A device page is a header with a tab bar and one tab's content: only the active tab is rendered (the others
aren't in the DOM), and the tab and its scroll position are kept per device (`useDeviceTab`, kept state plus
`localStorage`; nothing is sent anywhere). Tabs come from what the device reports, so a keyboard without
analog keys has no Actuation tab. Changing tab clears the key selection; the device session, drafts and
"Allow changes" are untouched.

Live key travel (Actuation tab, boards whose driver offers a depth source) starts when the tab mounts and
stops when it unmounts; the source also pauses while the window is hidden (`live.ts`), and a stream
keyboard sends nothing at all. With no key down no frame arrives and nothing re-renders. The key map's drag
selection adds two window listeners only while a key map is mounted.

Bundle: the first-load chunk went from 358.6 kB to 395.2 kB (the home, the shared tab header and the
nav store); the key map, the Advanced Keys flow and live travel ship in the lazy Keyboard chunks.

## Keep your feel (`src/lib/feel/`, `src/components/feel/`)

"Switch brands, not your aim": a saved, device-neutral feel (mouse: DPI steps and the one in use, polling, lift-off,
debounce, angle snapping, motion sync, ripple; keyboard: actuation, rapid-trigger on/off and distances, SOCD pairs;
optionally the CS2 / Valorant sens) that a new mouse or keyboard can take in one click, with a preview first.

- **Storage**: one small JSON document (the feel, the list of devices already seen, the mouse and keyboard configured
  last): `feel.json` in the app data folder (`feel_load` / `feel_save`, checked as JSON, 64 kB cap), the website's
  IndexedDB `states` table (so "Download backup" includes it), memory in the preview. A write happens when a feel is
  saved, when the list of devices changes and settles a device, and after a burst of changes to a device (at most one
  per 2 s). No timer, no poll, no device I/O: the home reads only the views the panels keep, and the mapping is pure.
- **Apply** is the panel's own guarded session (`src/lib/feel/drive.ts` turns the plan's human-unit steps into the calls
  the panel makes for a hand change), so the tiers, "Allow changes", the backup before the first write and the
  read-back all apply as they do for a hand change. It stops at the first change that fails or doesn't read back and
  says how far it got. Steps that would write what the device already holds are left out. No new device command, no
  Advanced scope.
- **A new device** is one not in the seen list while a feel has something for its kind. The list starts from what is
  plugged in on the first look (so nothing is offered for devices that were there before), and a device is settled
  as soon as there is no feel to offer it. A Logitech receiver is one device, whichever of its mice is on.
- **Bundle** (2026-10-14): the first-load JS + CSS is unchanged (desktop 889.7 -> 889.2 kB raw, 254.2 -> 254.1 gzip;
  website 776.4 -> 775.0 kB). The home's banners and card are a lazy chunk (12.7 kB, 3.9 gzip), the store and its
  storage another (8.0 kB), and the mapping, the preview and the drive code (33.0 kB, 10.7 gzip) load with the device
  pages.
- **Preview only**: `?arrive` holds back five sample devices until the address ends in `#arrived`, to see a new mouse or
  keyboard turn up (`src/lib/device-names.ts`); the sample "SYNQ Sample Mouse" has a short fixed DPI list.

## OpenMouse drivers load per vendor (`src/lib/openmouse/`)

OpenMouse's `createSupportedClient` imports all ~80 drivers. SYNQ walks the same list in the same
order from a generated index (`driver-index.generated.ts`, `node scripts/gen-openmouse-index.mjs`)
whose entries are dynamic imports keyed by vendor id, so a driver is downloaded only when a device
with that vendor id is plugged in. A PC with only the DEX and the X1 loads none of them. The check that
a candidate is really a mouse runs only when the device list changes and holds such a candidate; no
timer or poll was added. The Rust bridge reads each collection's report descriptor once per path
(cached) so the drivers see report ids and sizes as they would in Chrome.

## Keyboard drivers load per vendor, VIA layouts are fetched once (`src/lib/kb/`)

The generic Keyboard panel's drivers (`src/lib/kb/registry.ts`) are dynamic imports keyed by vendor
id, like the mouse drivers: a brand's code (ASUS, Corsair, Logitech, SteelSeries, Razer, MonsGeek,
DrunkDeer, Sonix, @openmouse/keyboard-protocol's per-vendor index) is downloaded only when a keyboard
with that vendor id is connected; VIA / Vial (any vendor) loads only once a keyboard is on the panel.
Nothing polls: live key depth runs only while its view is on screen.

A VIA keyboard doesn't carry its own layout. The first time one is connected, SYNQ fetches that
board's definition once from `https://usevia.app/definitions/<v2|v3>/<vendor·product id>.json`
(one small JSON file, 8 s timeout, no cookies) and keeps it in the app data folder
(`via-definitions/`); from then on the copy is used and the network isn't touched again for that
board. A board usevia.app doesn't know is remembered for the session, so it isn't asked for again on
every reconnect. Vial boards carry their layout (read from the board) and never fetch.

## Monitors and webcams in the device list (`src-tauri/src/monitors.rs`, `webcams.rs`)

The device list (read when a device arrives or leaves on Windows; every 8 s while focused elsewhere) also names the monitors (EnumDisplayMonitors and the EDID in the registry) and
webcams (cfgmgr32's camera interfaces and their registry names). Neither opens anything: no DDC/CI, no camera. A monitor
is asked over DDC/CI only while its page is open; a webcam's controls are read only while its page is open (the device
source is created, never started), and its preview runs only after "Show preview".

## PC lighting: RGB hubs and Dynamic Lighting devices (`src-tauri/src/lighting/hidrgb.rs`, `lamparray.rs`)

The device list also looks for USB RGB hubs in one more HID enumeration (nothing opened; about
the cost of the first). Windows Dynamic Lighting devices come from a device watcher (`DeviceWatcher` on the LampArray
selector) that runs only while the Devices home or a Dynamic Lighting page is on screen and stops when neither is; it is
told of arrivals and removals, so there is no timer (nothing opened; not on the website). A hub is opened only while its page
is open and only to send what the page asks; a Dynamic Lighting device is opened by its page and let go when the page
closes or the window loses focus. An effect on a Dynamic Lighting device sends the lamps' colours 20 times a second, only
while its page is open and SYNQ is in front; one colour is sent once per change.

## Find your headphones downloads the headphone list from GitHub when you open it (`src/components/eq/AutoEqFinder.tsx`)

Nothing is fetched until the person opens "Find your headphones" on the Sound page. Then SYNQ downloads AutoEq's list
of headphones once per run (`https://raw.githubusercontent.com/jaakkopasanen/AutoEq/master/results/README.md`, about
486 KB, public, no cookies; kept in memory only) and, when a model is picked, that model's `ParametricEQ.txt` (under
1 KB). Nothing about the person or their gear is sent. No AutoEq data is bundled with SYNQ: the code is MIT, but
AutoEq states no terms for the measurement data behind the presets, so it is only fetched on request.

## Which mouse opens first (`src/lib/mouse-probe.ts`)

A LIGHTSPEED or 8K receiver stays plugged in when its mouse is switched off, so "plugged in" can't say
which mouse is in use. With two or more mice listed, SYNQ asks each one for a quick read-only reply, all
at once, each with a 1 s limit: a HID++ ping (IRoot.GetProtocolVersion) to the Logitech receiver's six slots
(`logitech-ping.ts`), GetMouseOnline + CID/MID for the X1 (`atk-wire.ts`, the same checked wire the panel
uses), and for a generic mouse its driver's cheapest read (`CHEAPEST_READ` in `openmouse/policy.ts`: Razer's
`readStatus` writes a setting back once per connection, so it is asked for its firmware version instead).

The Mouse page waits for that (a "Looking for your mouse..." card) and opens on the mouse that answers: the
one picked by hand last time if it answers, else the one on screen last time if it answers, else the first
that does. It decides as soon as the answers so far settle that, so a mouse that is off doesn't hold it up
(`decideEarly`, checked against waiting for everyone). A mouse that doesn't answer goes last in the
switcher, marked "Off or asleep", and can still be picked; its label turns normal if its panel connects.
The order stays put for the visit. The sidebar hint names the mouse that answers when only one does.

- When it runs: when the Mouse page opens (unless a check finished in the last 2 s) and when the list of
  mice changes. No timer, no poll; one mouse, or none, sends nothing. A receiver's mouse switching on or off
  while the page is open is not noticed until the page is opened again.
- It only reads, and a device it had to open is closed again right after; one a panel has open is left
  alone, and a mouse whose panel is connected counts as answering without being asked.
- The probe code is about 20 kB of lazy JS (the HID++ driver isn't loaded for it).
- Measured on the release build, hidden, DEX off with its receiver plugged in, X1 on (2026-10-13):
  at startup the two checks run once (ATK: 2 reads, answered in ~40 ms; Logitech: 6 pings, which the receiver
  answers for an absent mouse either with a HID++ 1.0 error, ending the check at once, or not at all, so it runs
  out its ~0.9 s; both were seen) and both devices are closed again; the sidebar says "X1 V2 Air+" before the page is
  ever opened; opening the Mouse page shows the X1 panel after ~0.05-0.25 s (the pick answers at once), or
  after ~1 s when nothing earlier decides it; idle CPU on the page 0 ms over 10 s.

## Razer mice on their mouse / consumer collection (`src-tauri/src/hid.rs`)

Many Razer mice take their settings as feature reports on their Generic Desktop mouse (0x01:0x02) or
Consumer Control (0x0C:0x01) collection, which the bridge otherwise never opens. For exactly the Razer ids
in `RAZER_FEATURE_ONLY_PIDS` (57 of the 115 OpenMouse lists; derived from OpenMouse's Razer drivers by
`scripts/razer-feature-only.mjs`, written into `openmouse_ids.rs`, checked by `scripts/openmouse-safety.test.ts`)
those two collections open **feature-only** (`Access::FeatureOnly`): no reader thread, no input report ever
read or forwarded, no output report ever written (the handle type has no such method), nothing about
movement or clicks leaves Rust. Each is listed on its own, as Chrome lists a collection. On Windows hidapi
opens a mouse collection zero-access, which still allows HidD_GetFeature / HidD_SetFeature. Razer's "set
device mode" command (class 0x00 id 0x04, which includes bootloader and test modes) is refused in Rust
whatever asks, and no allowlisted driver method can send it. No Razer was available, so this is verified by
unit tests, not hardware.

## Minimized (`src-tauri/src/sleep.rs`)

Minimizing sets WebView2's memory target to Low at once and, 2 s later, hides and suspends the page
(`TrySuspend`): scripts, timers and drawing stop. It waits while the page reports device work in
flight (`page_busy`), so a write or read-back is never frozen half way. Restoring shows and resumes
it and puts the target back to Normal; the page drew its next frame 12–14 ms after being shown.
`--features perf-test` adds `perf_test_suspend`/`perf_test_log`, which run the same path without
minimizing a window (for the hidden test harness); release builds answer them with an error.

## Lamp screen sync (`src-tauri/src/lighting/screen.rs`, `govee/stream.rs`)

Off by default; while off there is no thread, no timer and no screen read. While on, the bridge (not the page, so a
background or minimized window changes nothing) reads one thin strip of one display per sample (the primary, or the
one picked on the tab): 1 % of its width, full height, shrunk by GDI (`StretchBlt`, `COLORONCOLOR`) straight into an
8 × 56 bitmap, so the full frame is never copied to the CPU. "Both edges" and "Whole screen" read their two or three strips in turn and keep the others'
last colours, so every edge costs one read. The screen DC and the bitmap are made once per sync (making them per
sample cost more than the sample). Then the colours are eased, and only the segment pages that moved by more than 8 on
a channel are built, checked by the guard and encrypted; a still picture sends nothing.

Measured 2026-10-16 on this PC, release build, the thread's own CPU cycles (`QueryThreadCycleTime`):

| | CPU per cycle |
|---|---|
| One sample (any edge) | 145–156 µs |
| One cycle, worst case: a sample plus all four pages built, checked and encrypted (v1) | ~160 µs |
| The radio write | not included: measured in the developer session |

Pace: 6 cycles a second while the picture moves, 2 once it has stood still for 3 s, so about 1 ms of CPU a second
(0.1 % of one core), 0.3 ms when still. Each GDI read waits for the next desktop frame (~one refresh); the thread
sleeps through it and nothing waits on it. The debug build measures 250–330 µs a cycle.
`cargo test --release --lib cost -- --ignored --nocapture` repeats both measurements (`sample_cost`, `sync_cycle_cost`).

Screen sync across Wi-Fi lights and USB hubs (wave L5, `src-tauri/src/lighting/sync.rs`) uses the same sampler once a
cycle for all of them (one colour per light along the edge), at the same pace, so its screen cost is the lamp sync's: about
0.15 ms a cycle, whatever the number of lights. Sending happens on one thread per light, which sleeps between colours
(at most 20 a second, for LIFX) and only wakes when its colour moved; a Hue Entertainment stream is one thread sending
25 small encrypted datagrams a second. Govee lamps in the same sync keep their own sampler each, as before.

The read never touches a game's swap chain: a window in exclusive full screen (or protected video) reads black through
GDI, and then the lamp keeps its last colours instead (after a second the page says "Can't see this window, holding
colours"); black is never sent.

## The idle home, measured (2026-10-16 hardening pass)

How it was measured: the built frontend (`vite build`) served on 127.0.0.1 in headless Edge (Chromium, the engine
WebView2 uses), with `setInterval` / `setTimeout` wrapped before the page loads so every timer scheduled, fired and still
waiting is listed, and Chromium's own counters (`Performance.getMetrics`: task, script, layout and style time) read at
the start and end of the idle stretch. The desktop app was stood in for by a stub of the bridge (every command answers,
`hotplug_watch` says yes), the window focused (`Emulation.setFocusEmulationEnabled`), nobody touching anything.

- **Timers:** after 100 s idle on the Devices home, nothing is scheduled. The Govee scan asked every 4 s for the first
  minute and then rested (15 asks, then none; it wakes on the next mouse or key input). The device list was read once
  at start and never polled.
- **CPU:** 13 ms of main-thread work in those 100 s (0.01 %); no layout or style recalculation.
- **What still runs while idle, and why:** on Windows, nothing on a timer. A Windows notification registration
  (`CM_Register_Notification`, src-tauri/src/hotplug.rs) costs nothing until a device arrives or leaves. With an XInput
  pad listed, the device list is read every 30 s while the window is shown, because XInput gives a pad's battery only
  when asked. On Linux and the website (no plug notifications here), the list is still polled: every 8 s focused, 30 s
  in the background, none minimized.

Fixed in this pass:

- The device-list poll (every 8 s while focused): replaced on Windows by plug and unplug notifications; the bridge
  waits 400 ms for a burst (a USB device brings several interfaces) and sends "devices-changed" once.
- The lamp scan (every 4 s for as long as the home was on screen and focused, so the Bluetooth watcher never stopped):
  it now rests after a minute without mouse or key input, and the bridge stops the watcher a minute after that.
- Dynamic Lighting devices: a device watcher instead of a 15 s re-list (wave L4 follow-up).

Desktop bundle (`vite build`, minified; gzip -9 for comparison), 09248c9 (before tonight's waves) against f19c649 (after
the lighting L5 merges) and now (the cold-start split below). An earlier count of 911 kB for the entry was taken before
the L5 merges.

| | 09248c9 | f19c649 | now |
|---|---|---|---|
| All JavaScript | 747 files, 3,983 kB (1,186 kB gzip) | 908 files, 4,994 kB (1,473 kB gzip) | 905 files, 4,989 kB (1,472 kB gzip) |
| Entry chunk (`index`) | 464 kB (138 kB gzip) | 681 kB (203 kB gzip) | 827 kB (220 kB gzip) |
| JavaScript fetched before the home paints | 28 files, 1,075 kB | 32 files, 1,245 kB | 24 files, 1,124 kB |
| Loaded by the Devices home (first 6 s) | 70 files, 1,687 kB | 82 files, 1,860 kB | 79 files, 1,856 kB |
| CSS | 98 kB | 112 kB | 112 kB |
| Govee scene catalogue (`frames`) | none | 644 kB (157 kB gzip), lamp page only | the same |

The entry chunk's size is a poor guide on its own. Rolldown decides which modules sit in the entry and which go in
chunks preloaded next to it, and the home needs both before it can paint. The steady measure is the JavaScript fetched
before the first device card is painted. That grew by 170 kB up to f19c649 and by 49 kB now.

What the home needs before it paints: the device model (no longer a chunk of its own), the photo index (640 pictures),
the lighting tables (Govee, Wi-Fi lights, RGB hubs) and the controllers' identification. The Govee scene catalogue and
every device page stay out of it.

### Cold start, 09248c9 against now

These numbers come from the release frontend (`vite build`) in headless Edge, the engine WebView2 runs. The Tauri
bridge is stubbed and reports the same three devices to every build. SYNQ itself isn't launched for this (no windows
on this PC), so the native part of a launch (starting the process and creating the WebView2) isn't counted. That part
doesn't depend on the bundle, and the bridge does nothing new before the page asks.

How the runs work:

- Every run is a new Edge process with a new profile: no HTTP cache and no compiled-script cache.
- Edge gets 1.5 s to finish its own start-up before navigating, as WebView2 does before the app loads.
- Runs alternate between the builds. One warm-up per build isn't counted.
- Time runs from navigation start until the first device card is in the page and two frames have been drawn after it
  ("painted").

| Home painted, median of 10 cold runs | 09248c9 | f19c649 | now |
|---|---|---|---|
| Full speed | 81 ms | 103 ms (+27 %) | 87 ms (+7 %) |
| CPU slowed 4× | 354 ms | 375 ms (+6 %) | 360 ms (+2 %) |

Medians of the same build move by up to about 15 % from one session to the next. Over three sessions f19c649 was more
than 10 % slower than 09248c9 in two, so it went over the bar. Two things now load after the first paint instead of
before it:

- The controller stack: `connect.ts` and everything behind it (the links, the simulated pads, the vendor protocols),
  79 kB. It loads only when a controller is listed, from the effect that asks receivers whether their pad is on, and
  that runs after the home has painted. The home names controllers through `identify.ts` and the ids table, which
  stay.
- The screen-sync chip on light cards and the sync engine behind it (24 kB), through `React.lazy`. Until it arrives,
  the card shows what it showed anyway when no screen sync runs.

The photo index and the lighting tables stay before the paint. The cards need them to draw, and moving them would save
at most the remaining 49 kB while the photos popped in after the first paint.

## Kept as they are

- Grain overlay (`body::after`): one full-window layer, rastered once; hiding it saved no
  measurable process memory or CPU, so there is nothing to gain from a lookalike.
- Notice pill blur: a flat fill would save ~0.1 s CPU per notice, but it also changes the page's text
  anti-aliasing while a notice is up (the blur switches it to grayscale), so it fails the pixel test.
- Startup: the window and the WebView start on the dark `#121113` background, so there is no white
  flash; nothing changed there.

## The website build (`npm run build:web`, `vite.web.config.ts`)

A third run mode next to the desktop app and the `vite dev` preview (`src/lib/runtime.ts`: `web`, `tauri`,
`preview`). Same source; `dist-web/` is a static site for Chrome, Edge and Opera over WebHID. Nothing is
deployed from this repo. The desktop build defines `__ONBOARD_WEB__` false, so everything under
`src/lib/web` and `src/components/web` is dropped from it: measured on the same machine, the desktop
first-load chunks are unchanged (720 kB raw / 215 kB gzip at HEAD, 721 / 215 now, 209 files both).

- **Bundle** (2026-10-14): first load 622 kB raw / 184 kB gzip (JS + CSS); `dist-web/` in all 3.35 MB raw
  / 1.44 MB gzip across 238 files, of which 2.77 MB / 879 kB is JS. The EQ page is replaced by an empty
  stub in this build (the Sound entry is a "desktop app" card), so none of the equalizer ships.
- **Per-vendor lazy loading is unchanged**: the OpenMouse and keyboard drivers are the same dynamic
  imports keyed by vendor id; the guard loads only the brand guard of a device that is granted
  (`src/lib/web/guard.ts`), the policy tables (22 kB) load with the first device list, and the browser
  store with the first backup or the Settings card.
- **No new timers**: the device list re-reads the browser's granted list on the same 8 s / 30 s poll as the
  desktop (no device I/O), plus a refresh at once on the browser's connect / disconnect events.
- **Safety**: the browser has no Rust bridge, so every device is wrapped in the guarded proxy
  (`src/lib/web/proxy.ts`) before any driver sees it; `scripts/web-guard.test.ts` runs the same frame
  fixtures the Rust tests use through it.

## SYNQ Helper (`src-tauri/helper`, docs/helper.md)

Opt-in and off by default: with it off, nothing new runs and the app's own behaviour is unchanged. When on,
it's its own ~0.95 MB Rust binary (no WebView): a message-only window for the tray icon, one worker thread
and the bridge's listener. The worker blocks on a channel until something is due: a Toolhelp process
snapshot every 2 s **only while a game has a profile** (none at all otherwise), and a battery reading per
device every 5 minutes (backing off to 40 when asleep). Devices are opened only for the moment a profile
or a reading is sent, then closed (no reader threads at idle). Expected: about 2–4 MB private working set
and ~0% CPU idle (not yet measured on a real run). Website bundle: first-load JS +7.8 kB (533.8 → 541.6 kB:
the helper client and the "Use SYNQ Helper" links); the real EQ page is now a lazy chunk on the website,
loaded only when the helper is connected. Desktop bundle: the Games page and the Settings card are lazy
chunks (12.5 kB and 10.3 kB); the website's helper client isn't in it.

Games page (desktop only, a lazy chunk): the library is read when the page opens (folder listings and a few
small text files, no device I/O); each tile asks for its cover art only when it scrolls into view, and Steam
art is downloaded once per game and kept in `game-art/`. Editing a profile sends nothing; saving encodes it in
the page (a few kB of frames).
