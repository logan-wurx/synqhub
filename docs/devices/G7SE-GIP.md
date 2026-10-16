# GameSir G7 SE over GIP: research notes and the C4 spike

Research item 6 (2026-10-15). The G7 SE (`3537:1010`) is an Xbox-licensed pad. On Windows, `xboxgip` owns it, so
SYNQ can't reach its settings over HID. These notes record what GameSir Nexus does and which messages carry the
pad's settings. They also say exactly what SYNQ's spike would send. The spike is code behind a cargo feature and
has **never been run**. It needs the developer present, with no game running.

Rules followed:
- Only files were read. Nexus was never run or installed, and its services were not touched.
- No ownership, ACL or elevation changes.
- Nothing was sent to any controller.
- No Nexus code is copied here; these are facts only (message ids, framing, field meanings).

## 1. What GameSir Nexus is (files read)

Package: `GuangzhouChickenRunNetwor.GameSirNexusLegacy` 1.5.3.0 (x64), installed from the Microsoft Store. Its folder
under `WindowsApps` was readable without elevation.

| File | What it is |
|---|---|
| `HJC.XboxApp.GameSir.exe` / `.dll` (33 MB) | The UWP app, compiled with **.NET Native**. The PE has no CLI header, so there is no IL and `ilspycmd` can't decompile it. Its strings name the pieces below. |
| `D4XGaming.Devices.dll` + `.winmd` | A small native WinRT component built from a "D4XDeviceSample" project. It is a **custom game controller** (`ICustomGameControllerFactory` + `IGipGameControllerInputSink`) over `Windows.Gaming.Input.Custom`. Read with `ilspycmd` (the winmd's metadata) and with a disassembly of its call sites (capstone, read only). |
| `FirmwarePackages\G7SE\…`, `Resources\JL_Upgrade_Gip.dll` | Firmware images, and a JieLi upgrader that works over GIP (`FirmwareUpgrade_Gip`, `JL_handleGipData`). SYNQ never uses any of these. |
| `AppxManifest.xml` | Declares only the `internetClient` and `confirmAppClose` capabilities. No device capability is needed for the custom-controller path. |

`D4XGaming.Devices` exposes these to the app (from its winmd metadata):
- `D4XDevice.SendMessage(byte[] data, byte messageId)`, `SendMessageA(byte[] data)`, `GetMessageB(...)`.
- `SendReceiveMessageC(MessageCRequest { SettingTag })`, which returns `{ Result, SettingTag, SettingType, SettingValue }`.
- The event `MessageBReceived(device, payload)`, and the statics `D4XDevices`, `D4XDeviceAdded` / `Removed` and `FromGameController`.

The disassembly shows what these do on the system's `GipGameControllerProvider`:
- `SendMessage(data, id)` calls `provider.SendMessage(GipMessageClass 0 = Command, id, data)`.
- `SendMessageA(data)` calls `provider.SendMessage(Command, 0x09, data)` (message 0x09).
- `SendReceiveMessageC` calls `provider.SendReceiveMessage(Command, 0x01, …)`.
- Incoming messages (`OnMessageReceived`) are passed on as `MessageBReceived`.

The component registers its factory for three GIP interfaces. They are stored as a GUID table at file offset 0x8428:
- `b8f31fe7-7386-40e9-a9f8-2f21263acfb7`
- `332054cc-a34b-41d5-a34a-a6a6711ec4b3`
- `082e402c-07df-45e1-a5ab-a3127af197b5` (the Xbox gamepad interface)

## 2. The G7 SE's own GIP identity

Source: the identification capture in gamesir-linux-tools (MIT), `tests/fixtures/g7se-0630-gip-identification.json`.

- **Firmware descriptor:** 6.30 (`bcdDevice 0630`).
- **Class:** `Windows.Xbox.Input.Gamepad`.
- **Interfaces:**
  - `9776ff56-9bfd-4581-ad45-b645bba526d6`
  - `082e402c-07df-45e1-a5ab-a3127af197b5`
  - `b8f31fe7-7386-40e9-a9f8-2f21263acfb7`
  - `ecddd2fe-d387-4294-bd96-1a712e3dc77d`
- **Client commands:**

  | Message | Direction | Length | Use |
  |---|---|---|---|
  | `0x20` | pad → host | 32 | input |
  | `0x09` | host → pad | 9 | rumble |
  | `0x0F` | host → pad | 60 | settings request |
  | `0x10` | pad → host | 60 | settings reply |

## 3. The settings messages (facts)

These were verified on firmware 6.30 by gamesir-linux-tools (MIT, `docs/g7se.md` and `vendors/gamesir/models/g7se/protocol.py`), from Nexus USB captures and Linux round trips.

On the wire each message has a 4-byte GIP header: message id, options `0x00`, sequence, length. On Windows the system
builds that header itself, and the app passes only the **body** to `SendMessage(Command, 0x0F, body)`.

The body is GameSir's register protocol, the same command set its HID pads use over report `0x0F`:

| Request body (message `0x0F`) | Meaning | Reply body (message `0x10`) |
|---|---|---|
| `F2 00` | heartbeat | none |
| `09` | firmware | `0A` + UTF-16LE digits (captured: `"0108"`) |
| `0B` | active profile | `0C pp …` (captured: `0C 01 01`) |
| `04 bank off_hi off_lo len` (5 bytes) | read `len` ≤ 55 bytes; bank 1–4; `off + len` ≤ 421 | `05 bank off_hi off_lo len data…` |
| `03 bank off_hi off_lo len data…` (padded to 60) | write | `06 busy` (`06 00` = done) |

Field meanings:

| Address | Size | Field | Values |
|---|---|---|---|
| `0x0036` | 1 | report rate | `00` 250 Hz, `01` 500 Hz, `02` 1000 Hz. Nexus writes the same code to all four banks, because the rate applies to the whole controller. |
| `0x00AB` | 8 | L4 record | `04 00 00 00 00 00 01 target`, or eight zero bytes for the default. The target byte sits at `0x00B2`. |
| `0x00C7` | 8 | R4 record | as L4 (target byte at `0x00CE`) |

- **Targets:** 1–4 d-pad, 5 LB, 6 RB, 7 LS, 8 RS, 15 A, 16 B, 17 X, 18 Y, 22 View, 23 Menu.
- **Banks:** 1–3 are the three profiles Nexus shows. Bank 4 holds only a rate byte.
- **Size:** each profile is 421 readable bytes.
- **Partial writes:** Nexus writes a remap as the single target byte at `0x00B2` / `0x00CE`. SYNQ writes whole 8-byte records only, as gamesir-linux-tools does.

Never sent:
- GIP power (`0x05`), authentication (`0x06`) or any other system message. Those stay the system's.
- Rumble (`0x09`), firmware (`0x0C`, JieLi over GIP) and calibration.
- The family's firmware loader (`17 55 88`) and profile switch (`07`).
- Any other address.

## 4. The spike: what it would send (not run)

The code is in `src-tauri/src/gip_spike.rs` (WinRT glue) and `src-tauri/src/gip_g7se.rs` (the bodies, the guard
and the reply parser).
- Feature `gip-spike` is off by default and never in a release build.
- Run it by hand only, with the developer present and no game running:
  `cargo test --features gip-spike --lib gip_spike -- --ignored --nocapture`.
- `gip_g7se::check` refuses every body except the ones listed below. Unit tests show that the bodies are exactly the captured Nexus frames.

Sequence:
1. **Register** a custom factory with `GameControllerFactoryManager.RegisterCustomFactoryForGipInterface` for interface `b8f31fe7-7386-40e9-a9f8-2f21263acfb7` (declared by the pad and used by Nexus).
   - The registration lasts only as long as the spike's process.
   - Every provider Windows hands over is logged (vid:pid and firmware).
   - Only `3537:1010` reporting firmware 6.30 is used. Any other pad gets a sink that is never written to.
2. **Heartbeat:** `SendMessage(Command, 0x0F, [F2 00])`.
3. **Firmware:** `[09]`. **Active profile:** `[0B]`.
4. **Report rate**, banks 1–4: `[04 bank 00 36 01]`.
5. **L4 / R4 records**, profiles 1–3: `[04 bank 00 AB 08]`, `[04 bank 00 C7 08]`.
6. **Only with `ONBOARD_GIP_SPIKE_WRITE=1`:** the rate round trip.
   - First, all four rate reads must have answered with a valid code. If any didn't, nothing is written.
   - Then every bank goes to 500 Hz (`[03 bank 00 36 01 01]`, zero-padded to 60), each read back.
   - Then every bank goes back to the code it had, each read back.
   - Any read-back that doesn't match stops the run and prints the original codes.

Each request waits up to 400 ms for its reply on message `0x10`.

**Questions the developer session answers:**
- Does Windows hand the spike a provider for `b8f31fe7…`? If not, try `082e402c…`, the gamepad interface. That one matches every Xbox pad, so the vid:pid gate matters there. Then try `9776ff56…`, the G7 SE's own vendor interface, which Nexus doesn't register for.
- How does `FirmwareVersionInfo` report 6.30? The gate compares `Major.Minor` and prints the four numbers.
- Is `Command` the right class? Nexus's component passes 0 = `Command`. If nothing answers, the alternatives are `StandardLatency` and `LowLatency`.
- Do replies arrive in `OnMessageReceived` as message `0x10` with the bodies above?
- Does a game running at the same time see any difference? Run the first session with no game.

If the session works, the next step is a guarded `gip` transport in the bridge, with the same model as the HID pads: an allowlist mirrored in TS, a backup, read-back, and "Allow changes".

## 5. Runbook for the session with the developer

Do this with the developer at the PC. The pad is the G7 SE on its USB cable. Use a terminal (PowerShell) in
the repo's `src-tauri` folder. Nothing else in SYNQ needs to run.

**Before you start, close:**
- **GameSir Nexus.** Task Manager must show no `HJC.XboxApp.GameSir.exe`.
- **Every game.**
- **Steam**, including Big Picture.
- Anything else that reads the pad (DS4Windows, reWASD, the Xbox Accessories app).

Then open `joy.cpl` ("Set up USB game controllers"). Select the pad, open **Properties**, and check that the sticks and buttons move there. That window is the input check for step 6.

**1. Build (compile only, sends nothing):**

```powershell
cargo test --features gip-spike --lib --no-run
```

The first build compiles the `Windows.Gaming.Input` bindings, so it takes a few minutes. It must end with `Finished` and an `Executable … onboard_lib-….exe` line. Any `error` means stop here.

**2. Read-only run (the default: no writes):**

```powershell
Remove-Item Env:ONBOARD_GIP_SPIKE_WRITE -ErrorAction SilentlyContinue
cargo test --features gip-spike --lib gip_spike::tests::gip_spike_probe -- --ignored --exact --nocapture --test-threads=1
```

Expected output, in order:
1. `running 1 test`.
2. `  provider 3537:1010 firmware A.B.C.D`, once for each pad Windows hands over for the registered interface. **Note the four numbers.** The spike acts only when `A.B` is `6.30`.
3. `G7 SE found. Heartbeat, firmware, active profile:`.
4. A `  <- class … message 0x10 seq … [..]` line for each reply.
5. `  firmware: Some(Firmware("0108"))`. The captures saw `0108`, but any digits are fine.
6. `  active profile: Some(ActiveProfile(1))`, or the profile the pad is on.
7. `  bank 1 report rate: Some(Read { bank: 1, addr: 54, data: [2] })`, and the same for banks 2–4. Here `addr: 54` is `0x0036`, and `2` means 1000 Hz.
8. `  profile 1 L4: Some(Read { bank: 1, addr: 171, data: [..8 bytes..] })`, and so on for R4 (`addr: 199`) and profiles 2–3. The default record is eight zeros.
9. `Read only (set ONBOARD_GIP_SPIKE_WRITE=1 for the report-rate round trip).`
10. `test gip_spike::tests::gip_spike_probe ... ok`.

**What a failed run tells you:**

| Output | Meaning | What to do |
|---|---|---|
| No `provider` line, then `no G7 SE … appeared` after 20 s | Windows didn't hand over a provider for `b8f31fe7…` | Stop. Next session: try `082e402c…`, then `9776ff56…`, by changing `INTERFACE` in `gip_spike.rs`. |
| A `provider 3537:1010` line, then `no G7 SE … appeared` | The firmware gate didn't match (Windows reports the version differently) | Stop. Note the four numbers. Change the gate deliberately before the next run. |
| `firmware: None` and every read `None` | No replies: the class or interface is wrong | Stop. **Don't run the write step.** Next: try `GipMessageClass::StandardLatency`. |
| `register: …` or `SendMessage: …` errors | The API refused | Stop and note the error text. |

**3. Rate round trip (only if step 2 matched everything above):**

```powershell
$env:ONBOARD_GIP_SPIKE_WRITE = '1'
cargo test --features gip-spike --lib gip_spike::tests::gip_spike_probe -- --ignored --exact --nocapture --test-threads=1
Remove-Item Env:ONBOARD_GIP_SPIKE_WRITE
```

Steps 1–8 of the read-only run repeat. Then:
- `  to 500 Hz: bank N write Some(Ack { busy: false }), read back Some(Read { … data: [1] })` for banks 1–4.
- `  back: bank N write …, read back …` with each bank's original code.
- `test … ok`.

Any other ending means a read-back didn't match. The spike stops and prints the original codes, for example `originals were [2, 2, 2, 2]`. To put them back by hand, use Nexus's report-rate setting (1000 Hz is code `2`).

**4. How to abort:**
- Press **Ctrl+C** in the terminal. The factory registration lives only in the spike's process and ends with it. Nothing is installed or left running.
- In read-only mode nothing is written, so unplugging and replugging the pad restores everything.
- If a write step was cut short, the pad keeps whatever rate was last written. Check it in Nexus, or rerun the round trip (it ends on the originals).

**5. How to tell if it disturbs normal input:**

Watch for these while the spike runs (up to 20 s for the pad to appear, then a few seconds of queries) and right after it exits:
- the sticks or buttons stop moving, or stutter, in `joy.cpl`'s test page;
- Windows plays the device disconnect / connect sound;
- the guide-button LED blinks the way it does when it reconnects;
- the pad stops working in `joy.cpl` once the spike has exited.

To check:
1. Before the run, move both sticks in `joy.cpl` and note that they're smooth.
2. During the run, keep moving one stick and watch the page.
3. After `test … ok`, move the sticks again and press A/B/X/Y.

If any of the signs appear, stop. Unplug and replug the pad, confirm `joy.cpl` works again, and note the exact step and output line where it happened. The next session doesn't continue until that is understood.

## 6. Session 1 with the developer (2026-10-16): results

The developer's pad: USB `REV_0625` (firmware 6.25; GameSir Nexus Legacy 1.5.3 called it up to date, the current Nexus 2.5.8
and GameSir Connect 1.16.5 both refuse the pad and point at each other, so 6.30 / 6.40 isn't reachable through
GameSir's apps; all three were uninstalled afterwards at the developer's request). Windows' GIP layer reports the pad as
firmware `1.2.1573.2`. Nothing was written to the pad in any run, and normal input stayed smooth in `joy.cpl` in all of
them.

| Run | Interface | Class | Result |
|---|---|---|---|
| 1 | b8f31fe7 | Command | `provider 3537:1010 firmware 1.2.1573.2`, then the 6.30 gate refused (Windows' GIP version is not the USB bcdDevice) |
| 2 | b8f31fe7 | Command | gate changed to the exact `1.2.1573.2` for reads only; every query sent without an error, no message received |
| 3 | b8f31fe7 | StandardLatency | the same: no message |
| 4-5 | 9776ff56 | Command, StandardLatency | provider handed over; no message |
| 6 | 082e402c (gamepad) | Command | provider handed over; no message, not even the stick input the developer was producing |
| 7-8 | b8f31fe7 | Command | with OnGameControllerAdded / OnInputSuspended / OnInputResumed logged, and then with the thread in a COM MTA: none of them is ever called |

**What it means:** Windows calls `CreateGameController` (so the registration and the interface match work) but never
completes the controller: `OnGameControllerAdded` doesn't fire and the sink gets nothing, on any interface. So the silence
is on our side, not the pad's. Candidates for the next attempt, offline first (no pad needed to check them):
1. **Foreground:** Windows.Gaming.Input delivers to the process that owns the foreground window; the spike is a windowless
   test process. Nexus always runs with its window in front. Next run: inside a focused window (a small test window, or
   SYNQ's own window behind a dev-only switch).
2. **The returned controller object:** check what `CreateGameController` must return (Microsoft's custom-controller
   samples) and whether Windows needs more than `IGameControllerInputSink` / `IGipGameControllerInputSink`.
3. **Registration timing:** register before the pad is plugged in (replug during the run) in case only new arrivals are
   completed.

The spike's code now: reads allowed on the exact `1.2.1573.2` identity, writes only on the verified firmware (so never on
this pad), and `ONBOARD_GIP_SPIKE_CLASS` (command / standard / low) and `ONBOARD_GIP_SPIKE_INTERFACE` (b8f31fe7 / 9776ff56 /
082e402c / 332054cc) pick the variant without a rebuild.

**Session 2 (same day):** `window_probe` with the developer clicking the test window to the front (`window in front` logged
before the registration), interface b8f31fe7, class Command: the provider came again (`1.2.1573.2`), still no
`OnGameControllerAdded`, no message, every read `None`. Normal input fine. So being the foreground process doesn't
complete the controller either. Remaining candidates, in order:
1. **Package identity.** Nexus is a packaged (Store) app; Windows may complete custom GIP controllers only for packaged
   callers. Test: run the spike from a sparse MSIX package (identity without moving the exe), signed with a local test
   certificate; needs the developer's OK (it installs a package and a certificate on the PC).
2. **The returned controller object:** its runtime class name, or interfaces Windows probes for before it calls
   `OnGameControllerAdded` (check Microsoft's custom-controller samples and the Windows SDK headers).
3. **Registration timing:** register before plugging the pad in.

**Session 3 (same day):** Developer Mode was already on, so the probe ran from a loose-registered full-trust package
(identity `SYNQ.GipSpikeTest`, removed afterwards): windowless and with the window in front, still no
`OnGameControllerAdded` and no message. The returned controller object now implements `IGameController` too (Windows hands
it back typed as one): still nothing. So none of package identity (full trust), the foreground window, the COM apartment
or the controller interfaces completes the controller. What is left: Nexus is a UWP app in an AppContainer (not full
trust), and iCUE's `Corsair.GipDevices.dll` (native, so it needs a disassembly, not ilspycmd) is the one Win32 example
known to work; how it registers (GIP interface, hardware id or XUSB type) and what it returns from
`CreateGameController` is the next thing to learn. Parked here at the developer's choice of priorities; nothing was written to
the pad in any session.
