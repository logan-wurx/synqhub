# SYNQ Helper

(Linux: the same helper with XDG autostart, a StatusNotifierItem tray, D-Bus notifications and a /proc process list; see docs/linux.md.)

An opt-in background process for SYNQ: `synq-helper.exe`, a small Rust program with no
WebView and no Tauri (`src-tauri/helper/`). **Off by default.** Nothing runs in the background until
the person turns it on in Settings > SYNQ Helper; turning it off stops it and removes its
sign-in entry.

| | |
|---|---|
| Binary | ~2.7 MB (release, `opt-level = "s"`, LTO, stripped); the website's download also carries SYNQ's program, ~47 MB in all |
| Threads | tray / message loop, one worker, the bridge's listener (+1 per open website tab, at most 4) |
| Idle CPU | none: the worker sleeps until something is due (see below) |
| Expected RAM | about 2–4 MB private working set (not yet measured on a real run) |

## What it does

1. **Per-game profiles** (`profiles.rs`, `watcher.rs`, shared `src/games.rs`). When a game on the Games
   page starts (and has "Apply automatically" on), its mouse / keyboard profile is sent; when it ends,
   the everyday settings are put back. Two games at once: the newest wins (the older one's rows are put
   back first), and the older one's profile comes back when it ends.
   A device plugged in mid-game gets its profile when it appears. Pause, Quit and turning the feature
   off all put the everyday settings back; a crash mid-game is restored on the next start
   (`helper-state.json`). That is for the profiles encoded ahead of time (ATK mice, the X68 HE). Every
   other mouse and keyboard has a **live profile** that SYNQ itself puts on, through the device's own
   session; with SYNQ closed or minimized, the helper starts it with no window for that (`pass.rs`, see
   "Live profiles" below).
2. **Battery alerts** (`battery.rs`). One Windows notification at each alert level, 20%, 10% and 5% by
   default (Settings > SYNQ Helper: 1 to 5 levels, 1 to 50%). Each level alerts once per discharge
   and comes back only after a charge (or a climb of 5 points above it); a big drop (25% to 4%) is one
   notification, for the lowest level crossed. The last level's says "Charge it soon".
   Devices that report a battery are asked every 5 minutes;
   a device that's asleep or doesn't answer is asked half as often each time, down to every 40 minutes;
   one without a battery is never asked again. Supported: the ATK X1 (GetMouseOnline first, which the
   receiver answers itself, then GetBattery only when the mouse is online) and Logitech HID++ 2.0 mice
   (Unified Battery 0x1004 or Battery Status 0x1000; a sleeping mouse gets an HID++ 1.0 error from its
   receiver and isn't woken). While SYNQ itself is open the helper leaves the devices alone.
3. **The web bridge** (`bridge.rs`, `ws.rs`). Lets the website (`npm run build:web`) reach what a browser
   can't: Razer devices on Windows Chromium 153+, the EQ, and the Advanced actions. In a browser without
   WebHID (Firefox; a Chromium with it switched off, such as Brave by a setting or policy) it does all of
   the device work, so the website runs in any browser on Windows and Linux.

## The Games page

**Library** (`src-tauri/src/library.rs`, read-only): installed Steam games from `libraryfolders.vdf` and
each `appmanifest_*.acf` (name, app id, install folder; the program names are the largest .exe files in
that folder, installers / crash reporters / anti-cheat services / launchers left out), installed Epic
games from the launcher's `*.item` manifests, and the built-in favourites (Counter-Strike 2, Valorant,
League of Legends, Fortnite, Apex Legends, Overwatch 2, Rocket League) matched by program name or app id.
"Add a game" takes any program by its .exe name, and every game's program names can be edited.

**Cover art**: Steam's public header image by app id (`shared.cloudflare.steamstatic.com`, falling back to
`cdn.cloudflare.steamstatic.com`), fetched once with Windows' own downloader and kept in `game-art/`
(a miss is remembered, so it isn't asked again); otherwise the program's icon (read from the .exe where its
launcher installs it); or an image the person picks (PNG / JPEG / WebP / GIF, 2 MB at most, checked by
its signature). Tiles ask for their art only when they scroll into view.

**Profiles are settings, not recordings.** Click a game: pick the devices it changes and set them with the
same controls as the device tabs, with "Apply automatically" on or off. **Nothing is sent to a device
while editing.** On save the app encodes each device's settings OFFLINE with its driver's pure frame
builders (`src/lib/profiles/encode.ts`), from the device's last-known state (what its panel last read,
kept in `device-state/`; nothing is read for it):

| Device | In a profile | Encoder |
|---|---|---|
| ATK X1 (8K receiver) | DPI steps and the starting step, polling, lift-off, debounce, motion sync, angle snapping | `atk-protocol.ts` `buildWrite` + `withPair` / `packPaw3955Stage` on the rows as read |
| X68 HE | actuation for every key, rapid trigger and its press / release sensitivity | `x68he-protocol.ts` `encodeTriggerWrites` |
| Every other mouse and keyboard SYNQ drives (Logitech, OpenMouse-driven mice, the Falchion, VIA / Wooting / other keyboards) | DPI steps and the starting step, polling, lift-off, debounce and the mouse's switches; actuation, rapid trigger and its sensitivity | none: a **live profile** (below) |
| A device SYNQ doesn't drive | "Not supported for game profiles yet" | |

Only rows that differ are written. The **restore set** is the same rows as the device last had them, so
the helper puts the everyday settings back exactly; it's re-encoded whenever a panel reads a device again
(not while the helper holds a game profile on it), and the helper keeps the restore set of what each
device holds in `helper-state.json`, so an edited or deleted profile still restores what was there.
Every frame is checked by the driver's guard when encoded (the same verdicts as the Rust guards: the ATK
and X68 fixtures run in both test suites) and by the Rust guards when the helper sends it, with no
Advanced grant. The encoders only build settings writes: no pairing, remap, macro, calibration, reset,
firmware or bootloader frame can be in a profile.

Profiles are kept in `%APPDATA%\com.logan.onboard\games.json` (version 2; checked on save and on load:
sizes, names, program names). A profile that fails to send is retried 3 times, then the helper shows a
notification and leaves the device alone until something changes.

### Live profiles (every other mouse and keyboard)

Logitech's onboard-profile writes and most keyboards' session handshakes need an exchange with the device, so
their profiles can't be encoded ahead of time. A live profile (games.json key `live:<family>`, no reports,
`settings` = `{kind: "feel", family, feel}`; `games::validate` refuses one with reports) is a "Keep your feel"
feel (`src/lib/feel`) that SYNQ puts on through the device's own session, the same calls a change by hand makes
(`src/lib/profiles/live.ts`, `drive.ts`): the tier and "Allow changes", one backup before the first write, a
read-back after each change. While a device's page has its session open, the profile uses that session and the
page shows the new settings.

`src/lib/profiles/runner.ts` looks every 3 s (every 15 s while there's no live profile anywhere): the most recently
started running game with a profile for a device and "Apply automatically" wins it, else its everyday settings.
At a game's start it notes the device's everyday feel (`live-held.json`) **before** anything is written, then puts
the game's on; at the end it puts the everyday feel back. A crash or restart mid-game is put right on the next
look. A change that fails is tried 3 times, then a notification, until what is wanted changes. Games running come
from `games_running` (process names only, as above).

**Who puts them on** (one at a time: a named mutex `Local\SYNQ.GameProfiles`, a lock file on Linux):

1. SYNQ's window, while it's awake. A minimized window whose page is suspended (`src/sleep.rs`) lets go.
2. Else the website, while it's open with the helper connected (it asks `games_running` every few seconds;
   `live_held_load` / `live_held_save` keep the same file).
3. Else the helper starts **SYNQ with no window** (`synq --game-profiles`, `pass.rs`) when a game with a live
   profile starts or ends: its window stays hidden (created hidden in `tauri.conf.json`, shown only on a normal
   start), the page runs one pass (`src/lib/profiles/pass.ts`), at most 6 looks, and SYNQ exits (and in any
   case after 120 s). What it couldn't do comes back on its output as `notice<TAB>title<TAB>text` lines, which
   the helper shows as notifications. Turning game profiles off or pausing the helper starts one with `restore`
   to put everyday settings back. Nothing takes focus. A helper installed from the website starts the SYNQ program
   it keeps beside itself (`synq-profiles.exe`, see "The website's download" below) the same way.

## Anti-cheat

Games are recognised by **process name only**: one Toolhelp snapshot of the process list (what Task
Manager's Details tab shows) every 2 s, and only while at least one game has a profile. No game process
is opened, read, injected into or signalled; no driver, hook or overlay is involved; nothing is sent to
the game. The only process the helper ever opens is Equalizer APO's `Editor.exe` (to read its path,
for the same "editor is open" warning the app shows before an EQ write).

Why a poll and not WMI events: `Win32_ProcessStartTrace` needs admin rights, and
`__InstanceCreationEvent ... WITHIN n` is itself a poll, done by the WMI service with more work per round.

## Safety: the same checks as the desktop app

- The helper compiles SYNQ's own `hid.rs`, `brands.rs`, `advanced.rs`, `eq.rs` and `engine/` from the
  same files (`#[path]` modules in `helper/src/main.rs`), so there is one implementation of every guard.
  The helper's test run includes all of those modules' fixture tests.
- Every device command, from a profile, a battery reading or the website, goes through `hid.rs`
  (`send_report` / `send_report_to` / `send_feature_report`) and its guards. Advanced grants work exactly
  as in the app (one device, one scope, after the panel's confirmation, gone when the device closes).
- No firmware or bootloader path; devices in update mode are never listed or opened (`hid::usable`).
- EQ writes pass `eq::validate` (limits and the net peak) after a backup. Setting up the EQ engine from the
  website (`eq_engine_install` / `_setup` / `_undo`) runs only after the person's yes in the helper's own box, then
  Windows' own administrator prompt, which starts `synq-helper.exe --eq-engine ...` elevated (`src/engine`, the
  same code as the app's): the official Equalizer APO installer (the app's bundled copy, or the official download),
  checked against its size and SHA-256 before it runs. A site passes only the command and a checked output id.
  On Linux it is PipeWire's own EQ for this login: the box, no administrator.
- The website's presets save and delete only in SYNQ's presets folder (`eq::inside`), and an EQ backup restores
  only from SYNQ's backups folder.

## The web bridge

- WebSocket on **127.0.0.1:17860** only (`helper_cfg::BRIDGE_PORT`).
- **Origin allowlist**: exactly `helper_cfg::SITE_ORIGIN` (the website, a placeholder until it's
  deployed: keep `src/lib/web/links.ts` `SITE_ORIGIN` in step). Debug builds also allow
  `http://localhost:1421` / `:4173` (`npm run dev:web` / `preview:web`). The Host header must be
  `127.0.0.1:17860` or `localhost:17860` (no DNS rebinding). The path must be `/`.
- **Pairing**: the first time a site connects, the helper asks (a Windows dialog). A site the person
  allowed gets a random 32-byte token; only its SHA-256 is kept (`helper-pairings.json`). A "no" isn't
  asked again for a minute. "Forget paired websites" in the app's Settings removes them.
- A device is open in one tab at a time and closes when that tab's connection ends.
- The website forwards exactly the commands the bridge answers (`scripts/helper-bridge.test.ts` checks
  both lists match); backups, logs and settings copies stay in the browser.
- **Game profiles and battery alerts from the website**: the Games page reads the games, the installed
  library, the covers and the devices' last-read settings through the bridge, and keeps them where the
  app does. A save (`games_save`), or turning game profiles on (`helper_prefs_set`), happens only after
  the person says yes in the helper's own dialog, which lists what changes game by game (`Consent::confirm`);
  battery alerts and their levels change without asking (notifications only). The helper's other
  settings (`helper_set`) stay the desktop app's.
- **The website's download** (`release/synq-helper.exe`, about 47 MB) is the helper built with
  `--features with-app`: SYNQ's own program is inside it, and when the helper installs itself (no administrator,
  `%LOCALAPPDATA%\SYNQ Helper`) it puts that beside itself as `synq-profiles.exe`. It is never shown and has no
  Start menu entry; the helper starts it with no window to put live game profiles on with the site closed (as for
  the desktop app, above). Uninstalling removes the folder with it. The desktop installer's copy of the helper
  (about 3 MB) leaves it out, since the app is beside it there.
- On the website: Settings > SYNQ Helper > Connect (Chrome may ask to allow access to local network
  devices). The choice of transport is made once per page load; connecting reloads the page.
- Without WebHID the website opens on a "Connect SYNQ Helper" page instead of the app
  (`src/components/web/UnsupportedBrowser.tsx`, offered on Windows and Linux by `helperOffered`); once
  connected, every load reconnects first and the app runs on the helper alone. Firefox allows
  `ws://127.0.0.1` from an https page (loopback is exempt from mixed-content blocking); Safari refuses
  it, and there is no Mac helper yet, so Safari is pointed at Chrome / Edge / Opera.
- An Origin header can be forged by a local program, but such a program already runs as the person and
  could open the devices itself; the allowlist and pairing are there to keep *websites* out.

## Switching it on and off

- Settings > SYNQ Helper writes `helper.json` (only the app writes it) and the per-user sign-in entry
  `HKCU\Software\Microsoft\Windows\CurrentVersion\Run\OnBoardHelper` = `"…\synq-helper.exe" --autostart`,
  only while the helper is on; off removes it and asks a running helper to quit.
- The app talks to a running helper through two named events (`Local\OnBoardHelper.Quit` / `.Reload`);
  the quit event is also the single-instance lock.
- The helper itself re-checks on every start: off means it removes a leftover sign-in entry and exits.
- Tray: Open SYNQ, Pause / Resume (everyday settings back, no alerts, the bridge refuses commands), Quit.

## Install, update, uninstall (`src-tauri/installer/hooks.nsh`)

`npm run build:helper` (run by `tauri build` as `beforeBundleCommand`) builds it into
`src-tauri/target/release/`; the installer copies it next to `synq.exe`. The installer never starts
the helper (it runs elevated):

- before an install/update: `synq-helper.exe --stop` (a running helper quits, restoring devices);
- after: `--register` (puts the sign-in entry back only if the helper was on);
- uninstall: `--uninstall` (stop + remove the sign-in entry), then the entry is deleted again from NSIS
  in case the helper couldn't run, and the exe is deleted.

Caveat: the per-machine installer writes HKCU of the account that approved the UAC prompt; if that's a
different admin account, the person's own entry is fixed the next time SYNQ or the helper starts.

## Tests (no device I/O, nothing shown)

`cargo test --workspace` in `src-tauri`:
origin allowlist and Host check; pairing (asks once, token per origin, only the hash kept, a "no" is
remembered); paused and desktop-only commands; one device per connection; **guard parity** (every frame
of the ATK fixture with every grant set, and 4000 Razer frames, get the desktop guard's verdict through
the bridge); bootloader ids never usable; profile apply / restore / newest-wins / missing device /
retry-and-give-up / crash restore / switching games undoes the old profile first / "Apply automatically"
off / a deleted profile still restores, against simulated devices; Steam / Epic detection on a fake library
(VDF / ACF parsing, program picking, favourites merged), art checks (images only, size cap, the person's
image wins, the icon extracted from a program); battery levels,
re-arming and backoff, and the ATK / HID++ questions against fake devices (the ATK questions pass the
ATK guard with no grant); the process watcher with a fake process source; the Run key against a fake
registry; the WebSocket framing (RFC 6455 key vector, fragments, ping, masks, size cap); and a headless
server test on an ephemeral port (wrong origin / host refused, pairing, commands, ping, shutdown).

`npm test` (node) adds `scripts/profiles.test.ts`: settings read back from the last-known rows, only changed
rows written, every encoded frame passing the ATK / X68 guard, restore = the rows as read, refused
settings, and only offline-encodable drivers offered.
