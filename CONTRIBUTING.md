# Contributing to SYNQ

Thanks for helping. SYNQ talks to real hardware, so the bar is a little different from a typical app: a wrong byte
can do more than show a wrong number. This page is how to work on it without putting anyone's gear at risk.

## Getting set up

```bash
npm install
node src-tauri/eq-engine/fetch.mjs   # once: the bundled EQ engine installer (checked by SHA-256, kept out of git)
npm run tauri dev                    # the desktop app
npm run dev                          # the UI in a browser with simulated devices; saves nothing, touches no hardware
```

Before you open a pull request, run every check. It is the same command CI runs:

```bash
npm run verify
```

It runs TypeScript, the Node tests, the device simulations, the app's and the helper's Rust tests, and both builds.

## The safety rules for device code

These are not style preferences. A change that breaks one of them won't be merged.

1. **Every report SYNQ sends passes an allowlist, twice.** Each device family has a guard in TypeScript and a mirror
   in the Rust bridge, and both are held to the same fixture file (every frame SYNQ builds, the frames it must refuse,
   and single-byte mutations of them). A new command means a new allowlist entry in both places and new fixture lines.
2. **Never firmware, bootloader, DFU, pairing-reset or factory-reset commands** unless a page offers them on purpose,
   behind a confirmation, with a backup. Firmware updates are never reachable from the app.
3. **Back up first, read back after.** Before the first change to a device, SYNQ keeps what the device reported.
   After each change, it reads the value back and says so if it didn't stick.
4. **Untested means read-only.** A device nobody has tried SYNQ on starts read-only and says Experimental. Changes
   wait for the person to turn on **Allow changes**.
5. **Nothing in the background.** Scans, watchers and timers run only while the page that needs them is on screen and
   SYNQ is the window in front, unless the person turns something on (SYNQ Helper, screen sync) and can see it
   running.
6. **Protocol facts, not other people's code.** Where a protocol comes from another project, cite it and credit it. Copy
   code only under a license compatible with the AGPL, and keep its notice.

Every device family also has a simulation (`scripts/*.sim.mjs`) that plays the device's side. New device support
comes with one.

## What a good pull request has

- One focused change, with `npm run verify` passing.
- For device support: the allowlist in TypeScript and Rust, the shared fixtures, a simulation, and what was tested on
  real hardware (model, firmware, what you changed and read back). If you haven't had the real device in hand, say so;
  it then ships as Experimental.
- Plain, specific wording in the UI and docs: what something does, not how clever it is.

## Reporting a device that misbehaves

Open the device's page, press **Save diagnostics** at the top of the page (where the device offers it), and attach the file to
a [bug report](../../issues/new?template=bug_report.yml). It contains the reports SYNQ sent and received and the
device's identity, never anything else on your PC.

If something could harm a device or your PC, don't open a public issue: see [SECURITY.md](SECURITY.md).

## License

By contributing, you agree that your contribution is licensed under the GNU AGPL 3.0 or later, like the rest of
SYNQ.
