// Calls into the Rust side. Opened in a plain browser (vite dev without Tauri), it falls back to
// an in-memory stand-in seeded with the live config, so the UI can be previewed without touching
// Equalizer APO.
import { invoke } from "@tauri-apps/api/core";
import type { EqState, Limits } from "./eq";
import { peakDb } from "./eq";
import { isLinux, isTauri, isWeb, liveHardware } from "./runtime";
import type { Caps, Reading } from "./displays/vcp";
import type { CamControl } from "./displays/uvc";
import type { LampArrayDevice, LampArrayInfo } from "./lighting/lamparray";

export interface EqSnapshot {
  configPath: string;
  state: EqState;
  advanced: string | null;
  bypassed: boolean;
  peakDb: number;
  editorOpen: boolean;
  modified: number;
  limits: Limits;
}

export interface ApplyResult {
  peakDb: number;
  backup: string | null;
  modified: number;
}

export interface PresetInfo {
  name: string;
  path: string;
  source: "onboard" | "eapo";
  editable: boolean;
}

export interface Parsed {
  state: EqState;
  advanced: string | null;
}

export interface BackupInfo {
  path: string;
  modified: number;
}

/** An app that also drives controllers (src-tauri/src/conflicts.rs). */
export interface PadConflict {
  id: string;
  app: string;
  note: string;
}

/** How a listed game controller is reached (src-tauri/src/devices.rs `PadInfo`). */
export interface PadInfo {
  /** "hid": the bridge (or WebHID) reads its gamepad collection; "xinput": an XInput slot (Windows desktop). */
  via: "hid" | "xinput";
  /** The controller type from the controller table ("ps5", "switchpro", "xboxone", ...). */
  kind: string;
  slot?: number;
  /** XInput's battery: [kind, level 0-3]. */
  battery?: [string, number];
}

export interface Connected {
  kind: "mouse" | "keyboard" | "audio" | "controller" | "headset" | "monitor" | "webcam" | "rgbhub";
  name: string;
  connection: string;
  vid: string;
  pid: string;
  reported: string | null;
  /**
   * A mouse: found through OpenMouse's device table; kept only once one of its drivers claims it.
   * A keyboard: one for the generic Keyboard panel (src/lib/kb), kept once its path confirms it.
   */
  generic?: boolean;
  /** For a claimed generic device: the driver's brand and class (or "via" / "vial"). */
  brand?: string;
  driver?: string;
  /** A generic keyboard's path: @openmouse/keyboard-protocol ("omkb"), QMK raw HID, VIA/Vial ("qmk"), or a brand driver's channel ("brand"). */
  kb?: "omkb" | "qmk" | "brand";
  /** It has a QMK raw-HID collection (0xFF60/0x61), so it may be a VIA/Vial board. */
  qmk?: boolean;
  /** In firmware-update (bootloader) mode: shown only as a note, never opened. */
  bootloader?: boolean;
  /** A game controller: how SYNQ reaches it. */
  pad?: PadInfo;
  /** A monitor or webcam: what SYNQ opens it by (the display device, the camera's interface path). */
  path?: string;
  /** Every HID collection the system lists for it (the desktop's device list sends them; listing opens nothing). */
  collections?: { usagePage: number; usage: number; interface?: number }[];
}

/** Something that keeps Windows from running the EQ engine (blocking) or might (warning). */
export interface EngineIssue {
  code: string;
  blocking: boolean;
  message: string;
}

/** A playback device as Windows lists it. */
export interface EngineOutput {
  id: string;
  /** What Windows shows: "Speakers (USB DAC)". */
  name: string;
  /** For titles: "USB DAC". */
  title: string;
  /** For chips: "USB DAC". */
  short: string;
  state: "active" | "unplugged" | "disabled" | "notPresent";
  engine: boolean;
  slots: string[];
  enhancementsDisabled: boolean;
  isDefault: boolean;
  /** SYNQ can put the engine on it. */
  canAdd: boolean;
  issues: EngineIssue[];
}

export type EngineState = "active" | "missing" | "notOnOutput" | "disabled" | "broken" | "noOutput";

/** Linux: the EQ engine as PipeWire has it (Windows' Equalizer APO status has no such part). */
export interface PipewireInfo {
  running: boolean;
  version: string | null;
  /** The "SYNQ EQ" sink is loaded. */
  filterLoaded: boolean;
  /** ~/.config/pipewire/pipewire.conf.d/onboard-eq.conf */
  configPath: string;
  configWritten: boolean;
  /** The default output's node name ("onboard_eq" while the EQ is the default). */
  defaultSink: string | null;
  /** The output the EQ plays into. */
  target: string | null;
  /** The EQ needs a bigger graph: one restart of the sound loads it. */
  needsRestart: boolean;
  /** PipeWire plays the saved EQ exactly (1.4+); older versions play shelves with a fixed slope. */
  exact: boolean;
}

/** The EQ engine on this PC: Equalizer APO, read from Windows; on Linux PipeWire's filter-chain (`backend`). */
export interface EngineStatus {
  state: EngineState;
  /** "on · USB DAC output" */
  summary: string;
  installed: boolean;
  version: string | null;
  installPath: string | null;
  registered: boolean;
  defaultOutput: EngineOutput | null;
  outputs: EngineOutput[];
  inputsWithEngine: string[];
  problems: EngineIssue[];
  canUndo: boolean;
  installerReady: boolean;
  /** Absent on Windows (Equalizer APO); "pipewire" on Linux. */
  backend?: "pipewire";
  pipewire?: PipewireInfo;
}

/** Linux: SYNQ's udev rule (device access) and the listed devices Linux doesn't let it open yet. */
export interface DeviceAccess {
  /** The card should show. */
  needed: boolean;
  /** Where the rule is installed, if it is. */
  installed: string | null;
  upToDate: boolean;
  /** Running as an AppImage (the .deb installs the rule itself). */
  appimage: boolean;
  /** pkexec is there to install it with one click. */
  canInstall: boolean;
  /** What to paste in a terminal instead. */
  command: string;
  blocked: string[];
}

/** What a setup / install / undo did. */
export interface EngineOutcome {
  ok: boolean;
  result: "done" | "nothing" | "planned" | "unconfirmed" | "cancelled" | "failed";
  message: string;
  log: string[];
  backup: string | null;
  restartedAudio: boolean;
}

/** The person's own name for the headphones on one output of this PC, and which model they are. */
export interface SoundName {
  name: string;
  /** The model's photo key in the picture library ("7hz-salnotes-zero-2"), "iems" for SYNQ's own drawing, or none. */
  picture: string | null;
}
export type SoundNames = Record<string, SoundName>;

/** The desktop app (Tauri). The website and the preview are not. */
export const inTauri = isTauri;
export { isWeb, liveHardware };

const LIMITS: Limits = {
  maxBoostDb: 6,
  maxCutDb: -24,
  preampRangeDb: [-30, 6],
  freqRangeHz: [10, 22000],
  qRange: [0.1, 20],
  maxFilters: 20,
  peakToleranceDb: 0.05,
  sampleRateHz: 48000,
};

// Preview only: the outputs of a sample PC. On Linux (`?platform=linux`, or the end-to-end build on Linux) they are
// PipeWire sinks and the EQ engine is PipeWire's.
const WINDOWS_OUTPUTS = [
  { id: "{00000000-0000-4000-8000-000000000001}", name: "Speakers (USB DAC)", title: "USB DAC", short: "USB DAC", engine: true, slots: ["SFX", "EFX"] },
  { id: "{00000000-0000-4000-8000-000000000002}", name: "Monitor (HDMI Audio)", title: "Monitor", short: "Monitor", engine: false, slots: [] as string[] },
];
const LINUX_OUTPUTS = [
  { id: "alsa_output.usb-FiiO_K5_Pro-00.analog-stereo", name: "FiiO K5 Pro Analog Stereo", title: "FiiO K5 Pro", short: "FiiO K5 Pro", engine: true, slots: [] as string[] },
  { id: "alsa_output.pci-0000_00_1f.3.hdmi-stereo", name: "Built-in Audio Digital Stereo (HDMI)", title: "Built-in Audio", short: "Built-in Audio", engine: false, slots: [] as string[] },
];
const PREVIEW_OUTPUTS = isLinux ? LINUX_OUTPUTS : WINDOWS_OUTPUTS;

const mock = {
  state: {
    preamp: 0.4,
    filters: [
      { enabled: true, kind: "LSC", freq: 120, gain: 0.4, q: 0.71 },
      { enabled: true, kind: "PK", freq: 60, gain: 0.2, q: 1 },
      { enabled: true, kind: "PK", freq: 250, gain: 0.3, q: 0.8 },
      { enabled: true, kind: "PK", freq: 3000, gain: -3, q: 1.2 },
      { enabled: true, kind: "PK", freq: 7500, gain: -2.8, q: 2 },
      { enabled: true, kind: "PK", freq: 10000, gain: -3.1, q: 1.4 },
      { enabled: true, kind: "HSC", freq: 13000, gain: -2.5, q: 0.71 },
    ],
  } as EqState,
  modified: Math.floor(Date.now() / 1000),
  bypassed: false,
  presets: new Map<string, EqState>(),
  // Preview only: a sample PC with the engine on a USB headphone output and two monitors.
  outputs: PREVIEW_OUTPUTS.map((o, i) => ({ ...o, state: "active" as const, enhancementsDisabled: false, isDefault: i === 0, canAdd: !o.engine, issues: [] as EngineIssue[] })),
  names: { [PREVIEW_OUTPUTS[0].id]: { name: "Headphones", picture: "7hz-salnotes-zero-2" } } as SoundNames,
  canUndo: isLinux,
  // Linux: the device rule isn't installed yet (as on a fresh AppImage).
  accessInstalled: false,
};

const PREVIEW_PIPEWIRE_CONF = "~/.config/pipewire/pipewire.conf.d/onboard-eq.conf";

function mockEngineStatus(): EngineStatus {
  const outputs = structuredClone(mock.outputs);
  const d = outputs.find((o) => o.isDefault) ?? null;
  const state: EngineState = !d ? "noOutput" : d.engine ? "active" : "notOnOutput";
  if (isLinux) {
    const target = outputs.find((o) => o.engine)?.id ?? null;
    return {
      state,
      summary: !d ? "no sound output" : d.engine ? `on · ${d.short} output` : `not on ${d.short}`,
      installed: true,
      version: "1.4.2",
      installPath: PREVIEW_PIPEWIRE_CONF,
      registered: true,
      defaultOutput: d,
      outputs,
      inputsWithEngine: [],
      problems: [],
      canUndo: mock.canUndo,
      installerReady: true,
      backend: "pipewire",
      pipewire: { running: true, version: "1.4.2", filterLoaded: true, configPath: PREVIEW_PIPEWIRE_CONF, configWritten: true, defaultSink: d?.engine ? "onboard_eq" : (d?.id ?? null), target, needsRestart: false, exact: true },
    };
  }
  return {
    state,
    summary: !d ? "no sound output" : d.engine ? `on · ${d.short} output` : `not on ${d.short}`,
    installed: true,
    version: "1.4.2",
    installPath: "(preview)",
    registered: true,
    defaultOutput: d,
    outputs,
    inputsWithEngine: [],
    problems: [],
    canUndo: mock.canUndo,
    installerReady: true,
  };
}

function mockOutcome(message: string): EngineOutcome {
  return { ok: true, result: "done", message, log: [], backup: "(preview)", restartedAudio: true };
}

async function call<T>(cmd: string, args: Record<string, unknown> | undefined, fallback: () => T | Promise<T>): Promise<T> {
  if (inTauri) return invoke<T>(cmd, args);
  // The website never pretends: no sample EQ, monitors or webcams. With SYNQ Helper connected those commands
  // reach it (src/lib/web/tauri-core.ts); without it, the same call rejects with WEB_HELPER_ONLY.
  if (isWeb) return invoke<T>(cmd, args);
  await new Promise((r) => setTimeout(r, 80));
  return fallback();
}

export const backend = {
  eqLoad: () =>
    call<EqSnapshot>("eq_load", undefined, () => ({
      configPath: "(preview) config.txt",
      state: structuredClone(mock.state),
      advanced: null,
      bypassed: mock.bypassed,
      peakDb: peakDb(mock.state, LIMITS.sampleRateHz),
      editorOpen: false,
      modified: mock.modified,
      limits: LIMITS,
    })),

  eqApply: (state: EqState, bypass: boolean) =>
    call<ApplyResult>("eq_apply", { state, bypass }, () => {
      const peak = peakDb(state, LIMITS.sampleRateHz);
      if (peak > LIMITS.peakToleranceDb) throw new Error(`Net peak would be +${peak.toFixed(1)} dB.`);
      mock.state = structuredClone(state);
      mock.bypassed = bypass;
      mock.modified = Math.floor(Date.now() / 1000);
      return { peakDb: peak, backup: "(preview)", modified: mock.modified };
    }),

  eqPresets: () =>
    call<PresetInfo[]>("eq_presets", undefined, () => [
      ...[...mock.presets.keys()].map((name) => ({ name, path: name, source: "onboard" as const, editable: true })),
      { name: "Bright-tuned", path: "Bright-tuned", source: "eapo" as const, editable: true },
    ]),

  eqPresetRead: (path: string) =>
    call<Parsed>("eq_preset_read", { path }, () => ({
      state: structuredClone(mock.presets.get(path) ?? mock.state),
      advanced: null,
    })),

  eqPresetSave: (name: string, state: EqState) =>
    call<string>("eq_preset_save", { name, state }, () => {
      mock.presets.set(name, structuredClone(state));
      return name;
    }),

  eqPresetDelete: (path: string) =>
    call<void>("eq_preset_delete", { path }, () => {
      mock.presets.delete(path);
    }),

  eqBackups: () => call<BackupInfo[]>("eq_backups", undefined, () => []),

  eqRestoreBackup: (path: string) =>
    call<ApplyResult>("eq_restore_backup", { path }, () => ({ peakDb: 0, backup: null, modified: mock.modified })),

  /** Read-only: the EQ engine on this PC and its outputs. */
  eqEngineStatus: () => call<EngineStatus>("eq_engine_status", undefined, mockEngineStatus),

  /** Puts the engine on `output` (default: the default output) or repairs it. One Windows prompt. On Linux:
   * PipeWire's EQ plays into that output (the first setup restarts the sound once). */
  eqEngineSetup: (output?: string) =>
    call<EngineOutcome>("eq_engine_setup", { output: output ?? null }, () => {
      const o = mock.outputs.find((x) => x.id === (output ?? mock.outputs.find((y) => y.isDefault)?.id));
      if (isLinux) {
        // One output at a time: the EQ moves there, and that's what you hear.
        for (const x of mock.outputs) Object.assign(x, { engine: x === o, canAdd: x !== o, isDefault: x === o });
      } else if (o) Object.assign(o, { engine: true, canAdd: false, slots: ["SFX", "EFX"] });
      mock.canUndo = true;
      return mockOutcome(isLinux ? `SYNQ's EQ is on ${o?.title ?? "the output"}.` : `The EQ engine is on ${o?.name ?? "the output"}.`);
    }),

  /** Installs the engine and sets it up on the default output. One Windows prompt. */
  eqEngineInstall: () => call<EngineOutcome>("eq_engine_install", undefined, () => mockOutcome("Installed the EQ engine.")),

  /** Puts back what the last setup changed. One Windows prompt. */
  eqEngineUndo: () =>
    call<EngineOutcome>("eq_engine_undo", undefined, () => {
      mock.canUndo = false;
      return mockOutcome("Put the output back the way it was.");
    }),

  /** Linux: is SYNQ's device rule in place, and which listed devices Linux doesn't let it open yet. */
  deviceAccess: () =>
    call<DeviceAccess>("device_access", undefined, () => ({
      needed: !mock.accessInstalled,
      installed: mock.accessInstalled ? "/etc/udev/rules.d/70-onboard-hub.rules" : null,
      upToDate: mock.accessInstalled,
      appimage: true,
      canInstall: true,
      command: "'/home/you/Applications/SYNQ.AppImage' --print-udev-rules | sudo tee /etc/udev/rules.d/70-onboard-hub.rules >/dev/null && sudo udevadm control --reload-rules && sudo udevadm trigger",
      blocked: [],
    })),

  /** Linux: installs the device rule (the system asks for the password once, through pkexec). */
  deviceAccessInstall: () =>
    call<string>("device_access_install", undefined, () => {
      mock.accessInstalled = true;
      return "Installed /etc/udev/rules.d/70-onboard-hub.rules.";
    }),

  soundNamesLoad: () => call<SoundNames>("sound_names_load", undefined, () => structuredClone(mock.names)),

  /** Names the headphones on `output` for this PC; an empty name forgets it. */
  soundNameSave: (output: string, name: string, picture: SoundName["picture"]) =>
    call<SoundNames>("sound_name_save", { output, name, picture }, () => {
      if (name.trim()) mock.names[output] = { name: name.trim(), picture };
      else delete mock.names[output];
      return structuredClone(mock.names);
    }),

  /** Apps running now that also drive controllers (warnings only). */
  padsConflicts: () => call<PadConflict[]>("pads_conflicts", undefined, () => (typeof location !== "undefined" && location.hash.includes("conflicts") ? [{ id: "steam", app: "Steam", note: "Steam Input may take over or remap controllers in games; the tester shows what the pad itself sends." }] : [])),

  /** Keeps a copy of a controller's settings before SYNQ's first change to it; returns where it went. */
  padBackupSave: (prefix: string, json: string) => call<string>("pad_backup_save", { prefix, json }, () => `${prefix}-backup.json (preview: kept in memory only)`),

  /** Saves a controller's diagnostics bundle (addresses already removed); returns where it went. */
  padDiagnosticsSave: (name: string, json: string) => call<string>("pad_diagnostics_save", { name, json }, () => `${name}-diag.json (preview: not saved)`),

  /** A monitor's or webcam's settings before SYNQ's first change; returns where the backup went. */
  displayBackupSave: (prefix: string, json: string) => call<string>("display_backup_save", { prefix, json }, () => `${prefix}-backup.json (preview: kept in memory only)`),
  /** A monitor's DDC/CI capabilities (src-tauri/src/monitors.rs); slow on some monitors. */
  monitorCaps: (id: string) => call<Caps>("monitor_caps", { id }, () => import("./displays/sim").then((m) => m.simMonitorCaps())),
  monitorRead: (id: string, codes: number[]) => call<Reading[]>("monitor_read", { id, codes }, () => import("./displays/sim").then((m) => m.simMonitorRead(codes))),
  /** One allowlisted VCP write, read back; the input source only with `confirm`. */
  monitorWrite: (id: string, code: number, value: number, confirm: boolean) =>
    call<Reading>("monitor_write", { id, code, value, confirm }, () => import("./displays/sim").then((m) => m.simMonitorWrite(code, value, confirm))),
  /** A webcam's allowlisted controls (the camera is opened, never started). */
  webcamControls: (id: string) => call<CamControl[]>("webcam_controls", { id }, () => import("./displays/sim").then((m) => m.simWebcamControls())),
  webcamSet: (id: string, control: string, value: number, auto: boolean) =>
    call<CamControl>("webcam_set", { id, control, value, auto }, () => import("./displays/sim").then((m) => m.simWebcamSet(control, value, auto))),

  /** Windows Dynamic Lighting: counts the asker in (or out) of the device watcher; the devices known now ("lamparray-changed" brings the rest). */
  lampArrayWatch: (on: boolean) => call<LampArrayDevice[]>("lamparray_watch", { on }, () => (on ? [{ id: "sim-lamparray", name: "Keyboard (Dynamic Lighting)", kind: 1, vid: "", pid: "" }] : [])),
  /** Opens one and reads its lamps; it stays open until lampArrayClose. */
  lampArrayInfo: (id: string) => call<LampArrayInfo>("lamparray_info", { id }, () => import("./lighting/lamparray").then((m) => m.simLampArray())),
  /** One colour per lamp, red-green-blue flattened (three numbers: the whole device). Only while SYNQ is in front. */
  lampArraySet: (id: string, colors: number[]) => call<void>("lamparray_set", { id, colors }, () => undefined),
  lampArrayClose: (id: string) => call<void>("lamparray_close", { id }, () => undefined),

  /** On the website: SYNQ Helper's list when it is connected (monitors and webcams too), else the browser's granted devices. */
  devicesList: () =>
    call<Connected[]>("devices_list", undefined, () => [
      { kind: "mouse", name: "PRO X 2 DEX", connection: "USB cable", vid: "046d", pid: "c0a0", reported: "PRO X 2 DEX" },
      { kind: "mouse", name: "ATK X1 V2 Air+", connection: "8K receiver", vid: "373b", pid: "1278", reported: "Wireless mouse 8k dongle-L" },
      { kind: "keyboard", name: "ROG Falchion Ace HFX ZywOo", connection: "USB", vid: "0b05", pid: "1d1d", reported: null },
      { kind: "audio", name: "USB audio (EQ output)", connection: "USB", vid: "3142", pid: "a010", reported: null },
      { kind: "rgbhub", name: "CORSAIR Nautilus LCD Cap", connection: "USB", vid: "1b1c", pid: "0c57", reported: "CORSAIR Nautilus LCD Cap" },
    ]),
};
