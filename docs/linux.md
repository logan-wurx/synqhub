# SYNQ on Linux

The Linux desktop app is the same app as on Windows (same React UI, same drivers, same Rust guards), built with
Tauri on WebKitGTK. What differs is underneath: hidraw instead of Windows HID handles, PipeWire instead of
Equalizer APO, XDG autostart instead of the Run key. Built and tested in CI on Ubuntu 22.04
(`.github/workflows/linux.yml`); **not yet run on a real Linux machine with real devices** (see the last section).

| | Windows | Linux |
|---|---|---|
| Mouse / keyboard panels, every brand driver | yes | yes (hidraw, per-report-id filtering; see below) |
| Device access | automatic | a udev rule (the .deb installs it; the AppImage offers it on first run) |
| EQ engine | Equalizer APO (installed and set up by SYNQ) | PipeWire's filter-chain (a virtual "SYNQ EQ" output) |
| EQ limits, bypass, net-peak gate, backups, presets | yes | yes (the same eq.rs) |
| Minimized-window memory trim / suspend | WebView2 | not available (WebKitGTK has no equivalent API) |
| SYNQ Helper (game profiles, battery alerts, web bridge) | yes | yes |
| Helper tray icon | taskbar | StatusNotifierItem, where the desktop shows one; else notifications only |
| Game library | Steam, Epic | Steam (native and Proton games); no Epic launcher on Linux |
| Game art | Steam header, program icon, your image | Steam header, your image (no icon from a Windows .exe) |
| Installer | NSIS | .deb (Ubuntu 22.04+, Debian 12+) and AppImage |

## Install

- **.deb**: `sudo apt install ./SYNQ.Hub_<version>_amd64.deb`. It installs the app (`/usr/bin/onboard`), SYNQ
  Helper (`/usr/bin/synq-helper`) and the device rule (`/usr/lib/udev/rules.d/70-onboard-hub.rules`), and its
  postinst runs `udevadm control --reload-rules && udevadm trigger`, so devices already plugged in work at once.
  It needs WebKitGTK 4.1 and libudev (pulled in as dependencies) and recommends `pipewire-bin` (the EQ's tools) and
  `curl` (game art). Removing the package stops a running helper (SIGTERM, which first puts every device back on its
  everyday settings) and reloads udev without the rule.
- **AppImage**: make it executable and run it. It carries the helper inside. It can't install the device rule by
  itself, so on first run the Devices home shows a **device access** card: "Install the rule" (pkexec asks for your
  password once, only after that click; SYNQ never sees it) or a command to paste in a terminal:

  ```bash
  '/path/to/SYNQ.AppImage' --print-udev-rules | sudo tee /etc/udev/rules.d/70-onboard-hub.rules >/dev/null \
    && sudo udevadm control --reload-rules && sudo udevadm trigger
  ```

Both are built on Ubuntu 22.04 (glibc 2.35), so they run on 22.04 and newer and on distributions of the same age.

## Device access (udev)

Linux lets an app open a HID device only when a udev rule says so. `70-onboard-hub.rules` gives the logged-in
user (`TAG+="uaccess"`, applied by systemd-logind) access to exactly the devices SYNQ's bridge may open, and
nothing else:

- It is **generated from the bridge's own tables** (`src-tauri/src/udev.rs` `rules()`: hid.rs `allowed`,
  `analog_input_only`, the VIA boards the tables name, brands.rs / brand_ids.rs, openmouse_ids.rs). A Rust test
  fails when the shipped file (`src-tauri/linux/70-onboard-hub.rules`) isn't exactly what the tables give;
  regenerate it with `node scripts/gen-udev-rules.mjs` (or `npm run gen:udev`). The app prints the same text with
  `onboard --print-udev-rules`.
- Whole vendors are granted where the bridge allows any product of the vendor (OpenMouse's vendor-wide filters,
  Logitech, Wooting's analog collections); everything else is one rule per product. Devices in firmware-update mode
  are skipped before any rule (`GOTO`), so they never get access from it.
- Matching is on the HID device's kernel name (`*:VID:PID.*`), so USB and Bluetooth devices are both covered.
- Like Solaar's, OpenRGB's or Steam's rules, it opens those devices to every program you run, not only to
  SYNQ. What SYNQ itself reads and writes is still decided per collection and per report id (next section).

## The HID bridge on Linux (safety)

On Windows each top-level collection is its own handle and Windows keeps keyboards and mice to itself. On Linux one
hidraw node carries a whole USB interface: reading it returns every collection's input reports, keystrokes and
mouse movement included, and a write reaches whichever collection its report id names. So the bridge plans every
node from its report descriptor before opening it (`src-tauri/src/hid_plan.rs`), on top of the unchanged
per-collection rules (`collection_access`, brands.rs, advanced.rs and every guard and frame fixture apply as on
Windows):

- **Only interfaces whose descriptor holds an allowed collection are opened** (read from sysfs, which needs no access
  to the device). A collection that isn't in the descriptor, or a descriptor that can't be read, means not opened.
- **Input reports are forwarded only when their report id belongs to an allowed collection and to no other
  collection on the node**; everything else is dropped in Rust and never reaches the page (`NodePlan::route_input`).
- **Typing, pointing, consumer, digitizer and FIDO collections are never read or written.** They open feature-only,
  and only where the rules already say feature-only (the Razer mice and keyboards, Royal Kludge BeiYing); the
  "everything" vendors (Logitech, the Falchion) get their vendor collections only.
- **Unnumbered reports shared with another collection** (no report ids, and another collection on the node has input
  reports) can't be told apart: the node is used for **feature reports only**, or refused when the allowed collection
  has none.
- **Output and feature reports** go out only when their id is that collection's own and not another collection's,
  padded to the length the descriptor gives and never longer (as Windows sizes them); feature reads ask for exactly
  that length.
- **Logitech's DJ collection** (FF00:0004), where Linux's receiver driver puts the paired keyboard's keys and the
  mouse's movement, is never opened, and DJ reports 0x20 / 0x21 are never forwarded from any collection.
- Razer feature-only collections: one handle, no reader, feature reports of report id 0 at the descriptor's length;
  the device-mode command stays refused (hid.rs `razer_frame_allowed`).
- **Game controllers** (src-tauri/src/pads.rs): only ids in the controller table, only their Gamepad / Joystick
  collection (and Valve's vendor input collection), routed per report id like everything else here, so a pad's
  keyboard or mouse emulation on the same node is never forwarded. The udev rule covers these pads. Xbox-class pads
  over USB belong to the kernel's xpad driver (no hidraw node): there the tester has nothing to read; over Bluetooth
  they are HID pads.

Tests (`cargo test --lib hid_plan`, run on every OS): synthetic report descriptors for a gaming keyboard interface
(NKRO + consumer + vendor channel), a Logitech receiver (HID++ + DJ), a receiver with mouse, keyboard and consumer on
one interface, colliding report ids, unnumbered shared interfaces, a Razer mouse, the 0x19F5 usage-0 channel,
Wooting's analog stream, and 4000 generated interfaces mixing all of them: no report id a typing or pointing
collection declares is ever forwarded or writable.

## EQ on Linux (PipeWire)

The EQ is the same file as on Windows: `config.txt` in Equalizer APO's syntax, kept by SYNQ in
`~/.local/share/com.logan.onboard/eq/` and read, checked (limits and the net peak at or under 0 dB), backed up and
written by `eq.rs`, bypass included. PipeWire plays it:

- **A virtual "SYNQ EQ" output** (`onboard_eq`), a filter-chain of PipeWire's builtin biquads: a preamp (the
  builtin `mixer`) followed by `bq_peaking`, `bq_lowshelf`, `bq_highshelf`, `bq_lowpass`, `bq_highpass` and `bq_notch`
  slots, playing into the output you pick. Its config is `~/.config/pipewire/pipewire.conf.d/onboard-eq.conf`
  (generated by `src-tauri/src/eq_graph.rs`).
- **Setting it up** (Sound › Set it up, your click) writes that file, restarts PipeWire for your login once
  (`systemctl --user restart pipewire …`: the sound stops for a moment) and makes "SYNQ EQ" the default output.
  No password is asked. Moving it to another output later (Engine › Use) is live: no restart.
- **Every EQ change is live**: all controls are set at once with `pw-cli set-param <id> Props`, and the config file is
  rewritten so the next PipeWire start plays the current EQ. The graph has fixed slots (20 peaks, 2 low and 2 high
  shelves, 1 low-pass, 1 high-pass, 2 notches); an unused slot is set to an exact identity, so adding, removing,
  turning off or changing the kind of a band never needs a restart. Only an EQ with more bands of one kind than that
  needs one more restart (the Sound page says so and offers it).
- **Bypass** plays every slot flat at 0 dB, exactly as Equalizer APO is given a bypassed file.
- **Status** (`onboard --eq-engine status`, the Engine tab): is PipeWire running, is "SYNQ EQ" loaded, which output
  is the default, which output the EQ plays into. A system where PipeWire runs only for screen sharing and
  PulseAudio plays the sound (stock Ubuntu 22.04) is reported as such.
- **Undo** (Engine › Remove SYNQ's EQ) removes the file (putting back a file of the same name that wasn't
  SYNQ's), restores the previous default output and restarts PipeWire once.
- **PipeWire versions**: 1.4 and newer play the EQ exactly as Equalizer APO does (the same RBJ filters). Before 1.4,
  PipeWire's shelves ignore Q (slope 1, Q ≈ 0.71) and its low/high-pass take a resonance in dB (Q 0.71 at the least;
  SYNQ converts); before 0.3.52 boosts above 5 dB were capped. SYNQ runs the peak gate on what that PipeWire
  really plays and refuses a save that would clip there; the Engine tab notes the difference.
- `.txt` presets dropped into `~/.local/share/com.logan.onboard/eq/` (AutoEQ's ParametricEQ.txt, Equalizer APO
  files) show up as "EQ engine folder" presets, as Equalizer APO's own folder does on Windows.

The config generation, the slot plan, every identity, the version rules, the `pw-cli` argument and the status from
`pw-dump` output are unit-tested (`cargo test --lib eq_graph`, every OS), including a check that the graph's response
equals eq.rs' at many frequencies. **Real audio can't be tested in CI**; see the last section.

## SYNQ Helper on Linux

Same switches (Settings › SYNQ Helper), same files, same bridge and guards (docs/helper.md):

- **Autostart**: `~/.config/autostart/synq-helper.desktop`, written only while the helper is on and removed when
  it's turned off. From an AppImage the entry starts the AppImage with `--helper` (an AppImage's files only exist
  while it runs).
- **Talking to the app**: a socket in `$XDG_RUNTIME_DIR` (`synq-helper.sock`, owner only) plus a lock for one helper
  per login. SIGTERM / SIGINT (logout, `kill`, removing the .deb) quit like the tray's Quit: devices back first.
- **Tray**: a StatusNotifierItem (Open SYNQ, Pause / Resume, Quit) on KDE, Cinnamon, XFCE, LXQt, Budgie, and GNOME
  with the AppIndicator extension. Without a tray host it runs headless: notifications only.
- **Battery alerts**: desktop notifications over D-Bus (notify-rust).
- **Game profiles**: the process list from `/proc` (each process's command line and short name, nothing else), every
  2 s only while a game has a profile. A Proton game's command line starts with its Windows path, so `cs2.exe`-style
  names work unchanged; a native game's program gets `.exe` added after its build suffix (`cs2` → `cs2.exe`,
  `Game.x86_64` → `game.exe`), so one profile matches both builds.
- **Steam library**: `~/.steam/steam`, `~/.local/share/Steam` or Flatpak's copy, read-only: libraryfolders.vdf, each
  appmanifest, and the largest programs of each game (a Proton game's .exe files, a native game's ELF executables;
  only their first four bytes are read).
- **Web bridge pairing**: "Allow this website?" is asked with the notification's own buttons, or with zenity or
  kdialog; with none of those, pairing is refused.

## Command line

```bash
onboard --self-test             # HID layer, device tables, EQ engine detection: JSON, exit 0 when all passed (no window)
onboard --print-udev-rules      # the device rule, generated from the tables
onboard --eq-engine status      # the PipeWire EQ engine's state (JSON)
onboard --eq-engine setup [--output <sink node.name>] [--dry-run]
onboard --eq-engine undo  [--dry-run]
onboard --eq-engine config      # the PipeWire config SYNQ wrote
```

## Tests and CI

`npm run verify` runs every check, the same locally and in CI: TypeScript, the node tests, every simulation, the app's
and the helper's Rust tests, and both web builds. The Linux workflow (push on `linux-port`, or by hand with each stage
switchable) runs it on Ubuntu 22.04, builds the .deb and the AppImage, installs the .deb and checks what it put in
place, runs `--self-test` of the built app, the installed .deb and the AppImage under Xvfb, and runs the end-to-end UI
tests: WebdriverIO + tauri-driver + WebKitWebDriver drive the real app built with `npm run build:e2e` (the preview's
sample devices; nothing real) through the first-run welcome, the Devices home and its device-access card, a mouse and
a keyboard with their tabs, the Sound page and its PipeWire engine panel, Settings and the Helper card, and check that
no console error happened (`e2e/`). Screenshots, the .deb and the AppImage are artifacts of each run. The same
scenarios (`e2e/flows.mjs`) can be dry-run against the browser preview to check selectors.

## Known gaps

- **QMK / VIA / Vial boards from a vendor the tables don't name** open on Windows (any vendor's raw-HID collection)
  but on Linux need a rule for their VID:PID (`KERNELS=="*:VVVV:PPPP.*", TAG+="uaccess"`).
- **Distributions without systemd-logind** (eudev without elogind's `uaccess`): the rule's `TAG+="uaccess"` does
  nothing there; a group-based rule is needed.
- **Two identical devices without serial numbers** on the same interface number share one device key (as on Windows).
- **PulseAudio-only systems** (stock Ubuntu 22.04): no EQ; switch to PipeWire (`pipewire-pulse` + `wireplumber`).
- **One EQ output at a time** (Windows can have the engine on several outputs).
- **PipeWire not run by systemd** (some distributions start it from XDG autostart): the first setup can't restart it;
  log out and back in instead.
- No minimized-window memory trim or suspend (WebKitGTK has no equivalent); no Epic library; no program icons as
  game art.
- The helper's tray needs a StatusNotifierItem host (GNOME needs the AppIndicator extension).

## Untested on real hardware (needs a real Linux machine)

1. Every device panel against real hardware over hidraw: the DEX on its LIGHTSPEED receiver and on a cable (HID++ on
   interface 2 with the kernel's hid-logitech-dj loaded), the ATK X1 V2 Air+ receiver, the Falchion (whether its
   FF00:0001 channel is alone on its interface; if not, the unnumbered rule makes it feature-only), the X68 HE, a VIA
   board, a Wooting (analog stream), a Razer mouse (feature reports of id 0 on the mouse collection through hidraw)
   and keyboard, and the brand keyboards (Corsair, SteelSeries, ASUS Gear Link, Logitech G, 0x19F5 family, MonsGeek,
   DrunkDeer, SparkLink, RK BeiYing).
2. That no keystroke or mouse movement ever reaches the page with real devices (proven with synthetic descriptors
   only).
3. The udev rule granting access through logind on a real session (Ubuntu, Fedora, Arch), USB and Bluetooth; the
   .deb's postinst on a real system; the AppImage's pkexec install with a real polkit agent; the device-access card
   clearing after install.
4. Real audio through the PipeWire EQ: the first setup and its PipeWire restart, the "SYNQ EQ" sink becoming the
   default, live `pw-cli set-param` updates (and that the filter-chain takes every control), moving the EQ to another
   output with metadata, bypass, undo, a reboot loading the current EQ, PipeWire 1.0/1.2 (shelf slope) versus 1.4+,
   and Bluetooth outputs coming and going.
5. The helper: XDG autostart at login, the SNI tray on KDE and on GNOME with the extension, notifications and the
   pairing question's buttons, `/proc` game detection with real Proton and native games, battery readings from the X1
   and a Logitech mouse over hidraw, SIGTERM at logout restoring devices, the AppImage `--helper` path.
6. Steam detection on real ~/.steam and Flatpak libraries; game art download with curl.
7. The app's look on WebKitGTK at different scale factors (the end-to-end screenshots are from Xvfb at 1x).
