# EQ engine

(This is the Windows engine. On Linux the EQ runs in PipeWire's filter-chain; see docs/linux.md.)

SYNQ's EQ runs in **Equalizer APO** 1.4.2 (GPL-2.0), an effect plug-in (APO) that Windows' own
audio engine loads into its sound process. Nothing of it runs as a separate process. SYNQ installs
it, puts it on an output, repairs it and undoes its own changes, so nobody needs Equalizer APO's own
tools. The code is in `src-tauri/src/engine/`: `model.rs` holds the logic and its unit tests,
`registry.rs` the reads and writes, `win.rs` Core Audio, elevation, the service restart and the
load check, and `installer.rs` the installer.

## Detection (read-only, no admin)

`eq_engine_status` and `synq.exe --eq-engine status` read:

- **Installed:** `HKLM\SOFTWARE\EqualizerAPO\InstallPath` is set and `EqualizerAPO.dll` is in it. The
  version comes from `...\Uninstall\EqualizerAPO\DisplayVersion`.
- **Registered:** the pre-mix `{EACD2258-…}` and post-mix `{EC1CC9CE-…}` classes exist in both
  `HKCR\CLSID` and `HKCR\AudioEngine\AudioProcessingObjects`.
- **Unsigned effects allowed:** `HKLM\…\CurrentVersion\Audio\DisableProtectedAudioDG` = 1.
- **Default output:** `IMMDeviceEnumerator::GetDefaultAudioEndpoint(eRender, eMultimedia)`, the same
  role Device Selector uses.
- **Per output** (`HKLM\…\MMDevices\Audio\Render\{id}`), with its name from `Properties`:
  - *Has the engine:* any of `FxProperties` `{d04e05a6-…},1/2/5/6/7` (LFX/GFX/SFX/MFX/EFX) holds
    one of the two classes. This is Device Selector's own test.
  - *Enhancements off:* `{1da5d803-…},5` (`PKEY_AudioEndpoint_Disable_SysFx`) ≠ 0. This blocks it.
  - *Processing modes:* `{d3993a3f-…},5/6/7` are `PKEY_{SFX,MFX,EFX}_ProcessingModes_Supported_For_Streaming`,
    lists of modes. `{C18E2F7E-933D-4965-B7D1-1EEF228D2AF3}` is `AUDIO_SIGNALPROCESSINGMODE_DEFAULT`.
    It is not a COM class, so it is never in `HKCR\CLSID`. Equalizer APO's `install()` writes it when
    the list is missing. A list without it means Windows skips the engine for normal playback, which
    blocks it. A missing list is only a warning.
  - *Composite FX:* `{d04e05a6-…},13/14/15` (`PKEY_CompositeFX_*`) list several effects for one slot.
    If one of these lists lacks the engine, Windows may run that list instead. This is a warning; the
    load check after setup settles it.
  - *Newer setup:* `Child APOs\{id}\Version` ≠ 2. SYNQ leaves such an output alone.

The overall state is one of `missing`, `notOnOutput`, `disabled` (enhancements off), `broken` (any
other blocking issue), `noOutput` or `active`. The Sound page shows it as "EQ engine: on · fifine
output" and offers one button: **Set it up** or **Fix it**. It checks again on window focus.

## Setup (one UAC prompt)

Equalizer APO's Device Selector has no silent per-output command line: `/i` opens its window and `/u`
uninstalls from every device. So SYNQ does the same registry writes itself, following
`DeviceAPOInfo::install()` with Device Selector's defaults (use the original effects as children,
auto-adjust on, silent-buffer handling off). The app starts `synq.exe --eq-engine setup --output
{id}` through `ShellExecuteExW("runas")` and reads the result from
`%APPDATA%\com.logan.onboard\eq-engine\last-run.json`.

For a fresh setup the writes are, in order (all `HKLM`):

1. When missing, `CREATE KEY SOFTWARE\EqualizerAPO\Child APOs` and `…\Child APOs\{id}`.
2. Under `Child APOs\{id}`:
   - the output's own LFX/GFX/SFX/MFX/EFX classes (`!VALUE` where a slot was empty);
   - `PreMixChild` and `PostMixChild`, the original effects the engine wraps;
   - `AllowSilentBufferModification` = `false`;
   - `Version` = `2`.
3. The effect positions, chosen the way Device Selector chooses them:
   - SFX/EFX normally;
   - SFX/MFX for combined Bluetooth endpoints (`{b3f8fa53-…},41`);
   - LFX/GFX when the driver only has LFX/GFX.

   The engine goes into the pre-mix and post-mix slots, LFX/GFX are removed in SFX modes, and a
   `[{C18E2F7E-…}]` mode list is added where none exists.
4. `Disable_SysFx` is deleted if present ("force-enable enhancements").

A repair only fixes what blocks the engine: it sets `DisableProtectedAudioDG` = 1, runs
`regsvr32 /s EqualizerAPO.dll`, deletes `Disable_SysFx` and adds the default mode to the mode list.

The helper also:

- **Refuses** any write outside these places (`op_allowed`): `Render\{id}\FxProperties`, `Child
  APOs[\{id}]`, `DisableProtectedAudioDG`, and `DeviceTestPipeName` (the check below).
- **Restarts Windows Audio** (`AudioSrv` plus its running dependents, as `ServiceHelper` does) only
  when something was written. If the restart fails, it starts `AudioSrv` again so sound isn't left off.
- **Checks the load** the way Device Selector does. It sets `HKLM\SOFTWARE\EqualizerAPO\DeviceTestPipeName`,
  opens a shared stream on the output, and waits up to 3 s for `EqualizerAPO.dll` to report
  `PreMix`/`PostMix` `Initialize` (and `ChildAPO`) on the pipe. It then deletes the value. If a fresh
  setup doesn't report in, it tries SFX/EFX, then SFX/MFX, then LFX/GFX, and keeps the best.

Preview any of it without admin: `synq.exe --eq-engine setup --dry-run [--output {id}]`.

## Backups and undo

Before the first write, the helper saves every value it may touch to
`%APPDATA%\com.logan.onboard\eq-engine\backups\eq-engine-<time>-<id>.json`, with exact type and bytes
or "not set", plus whether each key existed. It writes a `.reg` twin next to it. **Undo** (in the
engine panel, or `--eq-engine undo`) applies the newest backup: it sets or deletes each value, deletes
keys that setup created, restarts Windows Audio, and renames the backup to `.undone.json`.
`DisableProtectedAudioDG` stays as it is, because the engine needs it on every output and only its
uninstaller clears it. If an apply fails halfway, the backup is put back at once.

## Install when missing

- **Bundled:** `EqualizerAPO-x64-1.4.2.exe` (11,980,366 bytes, SHA-256
  `7403be7427bbe1936a40dded082829b6e217fc4f5990fee5cba501f0ae055afa`, as published on SourceForge)
  ships as a resource (`src-tauri/eq-engine/`, fetched by `node src-tauri/eq-engine/fetch.mjs`; kept out
  of git). Without it, the helper downloads the same file from the official release and checks it the
  same way.
- **Silent run:** the helper copies the installer into a new folder under `%SystemRoot%\Temp` that
  only admins can change, re-checks the hash, and runs it with NSIS's `/S`. The script still starts
  `DeviceSelector.exe /i`, so the helper closes that window as it appears; SYNQ sets the output up
  itself. The helper then deletes the logon task `EqualizerAPOUpdateChecker` that the installer adds,
  so nothing runs on its own. If the installer created `config.txt` (its own sample config, not
  checked here; it also ships demo files such as `example.txt`), the helper backs it up and replaces
  it with a flat one through `eq.rs`, so a fresh PC starts flat. An existing `config.txt` is never
  touched. Finally the helper runs setup on the default output.
- **SYNQ's installer:** with `installMode: perMachine` it is elevated once. Its
  `NSIS_HOOK_POSTINSTALL` (`src-tauri/installer/hooks.nsh`) runs `synq.exe --eq-engine install
  --only-if-missing`. A PC that already has the engine is left untouched.
- **In the app:** **Set it up** runs the same `install` (one UAC prompt).
- **Not removed:** uninstalling SYNQ leaves the engine installed (Windows Settings › Apps ›
  Equalizer APO). Its Start-menu shortcuts stay as its installer made them.
