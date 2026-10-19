# Changelog

Each release's full notes, with its support tiers and known gaps, are in [`release/`](release/).

## 0.1.0 (2026-10-18)

The first release: the final design, everywhere.

- **A new look across the app.** Frosted glass over live light (the active card over its orange slab, the dock), the
  window's backdrop as a slow ember dot display, Helvetica (the real one where it is installed, Nimbus Sans otherwise),
  text in three strengths, corners that follow one rule and icons on one scale. Pages are laid out for a 1920 x 1080
  window: they fill it down to the dock, and most don't scroll at all.
- **The Gear page by kind:** a bento card per kind by default, shelves or a spotlight stage one click away (the
  switch at the top). The spotlight's rail of photos sizes itself so every device fits.
- **Real photos:** 879 product pictures of mice, keyboards, controllers, headphones, monitors, webcams and lights.
- **One page per device.** The mouse's Overview is a console of three cards: pointer speed (the number, its DPI steps
  and a fader with detents), polling rate on a lit track, and lift-off. The keyboard's keys, a controller's tester and
  a monitor's or webcam's settings each sit on one page.
- **Sound:** pick your own headphones for the Sound device.
- **Games:** covers for 23 popular games that aren't on Steam.
- **Game profiles for every mouse and keyboard SYNQ drives** (the PRO X 2 DEX and other Logitech mice, OpenMouse-driven
  mice, the Falchion and other keyboards), not only the X1 and X68. Pick a game, set its DPI, polling, lift-off,
  actuation or rapid trigger, save: they go on when the game starts and your everyday settings come back when it
  ends, with SYNQ open, minimized or closed. The Games page edits one device at a time and turns game profiles on in
  one click.
- **The website needs only SYNQ Helper.** Its download now carries what switches game profiles for every device with
  the site closed, and the EQ works from the website too: SYNQ Helper sets the EQ engine up after your yes in its own
  box and Windows' administrator prompt, and your presets save and delete from the website.
- **Ctrl K** opens a command menu: any device, page or action by name.
- **Website: game profiles and battery alerts through SYNQ Helper.** Once the helper is connected the Games page
  shows on the website too. Every profile save, and turning game profiles on, waits for your yes in the helper's own
  box on your PC, which lists what changes game by game. Battery alerts and their levels can be set from the website.
- **The taskbar shows SYNQ's own icon** (Windows knew the app only by its path and kept an older icon).
- **The app's window runs under a Content Security Policy** as strict as the website's (`SECURITY.md` lists what it
  may load).
- **Website:** the first visit is two clear steps, SYNQ Helper is easy to find, and the site counts visits anonymously
  through Cloudflare Web Analytics (no cookies, nothing that identifies a person; the desktop app has no analytics).

## 0.1.0-beta.7 (2026-10-16)

- **SYNQ Helper starts on a fresh Windows.** It needed the Visual C++ runtime (VCRUNTIME140.dll), which a clean
  Windows lacks, so there it could not start at all; the runtime is now built into `synq-helper.exe` (the download and
  the installer's copy). Caught by the new Windows Sandbox test of the helper as the website hands it out.
- The helper's "allow this site?" box names everything a site can reach: mouse, keyboard and controller settings, the
  EQ, monitors, webcams and lights.

## 0.1.0-beta.6 (2026-10-16)

- **OnBoard Hub is now SYNQ.** New name, logo and app icon ("Every device. One system."). Installing it removes the
  old OnBoard Hub install first and keeps your settings, your EQ engine and SYNQ Helper's sign-in choice.
- **New look:** the room light behind every page takes the colours you last set on your lights, a floating dock
  replaces the sidebar, the Gear page opens with big live numbers and a bento grid, and the mouse page shows its
  pointer speed in a dial. The default accent follows your lights too.
- **Govee lamps on the website:** in Chrome and Edge, Lights → Add a light picks a lamp in the browser's Bluetooth
  list and opens its page, with everything the desktop's has but screen sync, the same encryption and the same
  allowlist. The browser forgets the lamp when the tab closes, so it is picked again next visit.
- **The website does nearly everything the app does.** In Chrome or Edge with nothing installed: mice, keyboards,
  controllers, Govee lamps, USB RGB hubs and Dynamic Lighting devices (over the HID LampArray standard). With SYNQ Helper:
  monitors, webcams, Wi-Fi lights, screen sync across Wi-Fi lights and hubs (and Hue Entertainment areas), the EQ and
  Razer on Windows, each through the app's own Rust and guards. Lights and Displays are tabs on the site; a page that
  needs the helper says so and leads to it.
- **SYNQ Helper on its own:** one file (`synq-helper.exe`) that installs itself per user, starts with Windows and has
  an Uninstall entry; with the SYNQ app installed it turns that app's helper on instead.
- **Gear Doctor measures polling right:** Windows 11 slows the mouse reports a background listener gets to about
  125 a second, so a 4 kHz mouse read "125 Hz". The checkup now listens through the app's own window.

## 0.1.0-beta.5 (2026-10-16)

- **Open source** under the GNU AGPL 3.0 or later.
- **Lights:** Govee lights over Bluetooth with no Govee app (85 models), Wi-Fi lights on the home network (Philips Hue,
  Nanoleaf, Elgato, Twinkly, WiZ, Yeelight, LIFX), Windows Dynamic Lighting devices and USB RGB hubs (NZXT HUE 2, Corsair
  Lighting Node, Lian Li Uni Hub SL), one Lights view with looks, named groups and screen sync. Nothing ASUS is ever
  touched.
- **Sound:** Find your headphones (about 6,000 AutoEq presets by model) and 27 gaming headsets.
- **Monitors and webcams** over DDC/CI and UVC, read-only until Allow changes.
- **Gear Doctor** (a guided checkup with Fix it and Undo) and **Pro setups** (41 CS2 and Valorant pros).
- **Lights and Displays** get their own tabs; 640 official device pictures; keyboard use, WCAG AA contrast and reduced
  motion everywhere; the device list updates from plug and unplug events instead of a timer.

## 0.1.0-beta.4 (2026-10-16)

- **Controllers:** every pad Windows sees, with a live tester (drift, circularity, deadzones, triggers, buttons, gyro,
  real polling rate), light and rumble tests, Save diagnostics, and experimental settings for DualSense Edge, GameSir,
  8BitDo and Flydigi pads.
- **Linux:** a first `.deb` and AppImage, built and tested in CI.
- **Website:** the controller tester works in every browser.

## 0.1.0-beta.3 (2026-10-14)

- **Redesign:** a Devices home with a card per device, per-device tabs and a status strip.
- **First-run welcome**, and **OnBoard Helper** (opt-in): per-game profiles, battery alerts, a bridge for the website.
- **Advanced section** (pairing, remaps, macros, calibration, factory reset where the commands are known, each behind a
  confirmation and a backup) and **Keep your feel** (carry your setup to a new mouse or keyboard of any brand).

## 0.1.0-beta.2 (2026-10-14)

- **Keyboards for everyone:** VIA and Vial boards (about 2,000 models), hall-effect boards from ASUS ROG, Corsair,
  Razer, SteelSeries, Wooting, DrunkDeer and more, and live key depth on analog boards.
- **More mice** through OpenMouse.

## 0.1.0-beta.1 (2026-10-13)

- The first build: a system-wide EQ on Equalizer APO with presets and auto preamp, Logitech HID++ mice and the ATK X1
  V2 Air+ (DPI, polling up to 8K, lift-off and more), and the ROG Falchion Ace HFX (per-key actuation, rapid trigger,
  lighting, remaps).
