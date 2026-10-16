// Keyboard service for the ROG Falchion Ace HFX ZywOo (USB 0b05:1d1d). It talks to the keyboard's
// vendor control collection (usage page 0xFF00, usage 1: unnumbered 64-byte reports, report id 0)
// through SYNQ's Rust HID bridge, one command at a time, and waits for the echo the keyboard
// sends back for every write. Every byte it sends comes from keyboard-protocol.ts, which reproduces
// what ASUS Gear Link sends (docs/keyboard/PROTOCOL.md). Nothing here touches firmware, resets a
// profile (50 40) or sends anything Gear Link was not seen sending.
//
// Where the settings shown come from: the keyboard only reports its profile, firmware, current
// lighting effect, its own rapid-trigger switch (25 00) and Speed Tap on/off (25 01). Actuation,
// dead zones, rapid-trigger keys, lighting colours, polling rate and remaps can't be read back with
// any command Gear Link uses. Gear Link itself shows the copy its Companion app stores, but that
// needs Gear Link installed and running, and the Companion's read call for that file was never seen
// succeeding. So SYNQ keeps its own copy (app data/keyboard/<serial>.json), updated only after the
// keyboard confirms a write. Before SYNQ has written anything it starts from the state recorded
// at the end of the 2026-10-11 capture (PROTOCOL.md section 10), which is what Gear Link left on it.
// Live readings always win over the copy.
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { liveHardware } from "./backend";
import * as P from "./keyboard-protocol";

// ---------------------------------------------------------------------------------------------
// Constants: device, timing and limits in one place
// ---------------------------------------------------------------------------------------------

export const KEYBOARD = {
  vendorId: 0x0b05,
  productId: 0x1d1d,
  usagePage: 0xff00,
  usage: 0x0001,
  name: "ROG Falchion Ace HFX",
} as const;

const TIMING = {
  /** Echoes usually take 0-15 ms. */
  replyMs: 700,
  /** 50 55 (save) takes 100-270 ms. */
  saveMs: 2000,
  /** Edits made within this window go out as one batch with one save. */
  debounceMs: 300,
  /** How long to wait for the keyboard after a replug or a polling-rate change. */
  reconnectMs: 20000,
  reconnectStepMs: 700,
  /** Pause after a polling-rate write before checking whether the keyboard re-enumerated. */
  pollingSettleMs: 1500,
} as const;

/**
 * Ranges in 0.1 mm units. Actuation uses the keyboard's advertised 0.1-4.0 mm travel. The firmware
 * limits were never probed (Gear Link was seen sending actuation 0.5-2.0, dead zones 0.2-0.4 and
 * rapid trigger 0.1-0.2), so dead zones and rapid trigger stay in a conservative range.
 */
export const LIMITS = {
  actuation: { min: 1, max: 40 },
  deadZone: { min: 1, max: 10 },
  rapidTrigger: { min: 1, max: 20 },
} as const;

export const POLLING_RATES = [1000, 2000, 4000, 8000] as const satisfies readonly P.PollingRateHz[];

// ---------------------------------------------------------------------------------------------
// Settings model (all distances in 0.1 mm units, keys are firmware key indices)
// ---------------------------------------------------------------------------------------------

export interface KeyOverride {
  actuation: number;
  top: number;
  bottom: number;
}

export interface RtSensitivity {
  /** Used when press and release are not separate. */
  sensitivity: number;
  press: number;
  release: number;
}

export interface RapidTrigger extends RtSensitivity {
  /** SYNQ's master switch: off sends every group key with rapid trigger disabled. */
  enabled: boolean;
  keys: number[];
  independent: boolean;
  continuous: boolean;
  /** Keys with their own sensitivity (still in `keys`). */
  custom: Record<number, RtSensitivity>;
}

export interface SpeedTap {
  enabled: boolean;
  key1: number;
  key2: number;
}

export type Effect = Exclude<P.LightingEffect, "quicksand">;

export interface EffectLook {
  /** Raw speed byte, kept at Gear Link's value for the effect (the label mapping is unknown). */
  speed: number;
  singleColor: boolean;
  colors: P.Rgb[];
  /** Rainbow and Ripple only. */
  width?: number;
  direction?: number;
  stops?: P.GradientStop[];
}

export interface Lighting {
  effect: Effect;
  /** 0-100 %. */
  brightness: number;
  looks: Record<Effect, EffectLook>;
}

export interface ProfileSettings {
  actuation: number;
  top: number;
  bottom: number;
  keys: Record<number, KeyOverride>;
  rapidTrigger: RapidTrigger;
  speedTap: SpeedTap;
  pollingHz: P.PollingRateHz;
  lighting: Lighting;
  /** source key -> target key. */
  remaps: Record<number, number>;
}

export const EFFECTS: { id: Effect; label: string; colors: 0 | 1 | 2 }[] = [
  { id: "static", label: "Static", colors: 1 },
  { id: "breathing", label: "Breathing", colors: 2 },
  { id: "colorCycle", label: "Color cycle", colors: 0 },
  { id: "rainbow", label: "Rainbow", colors: 0 },
  { id: "reactive", label: "Reactive", colors: 2 },
  { id: "ripple", label: "Ripple", colors: 0 },
  { id: "starryNight", label: "Starry night", colors: 2 },
  { id: "current", label: "Current", colors: 2 },
  { id: "raindrop", label: "Raindrop", colors: 2 },
];

const RED = { r: 255, g: 0, b: 0 };
/** Gear Link's default 7-stop gradient for Rainbow and Ripple (from the capture). */
const GRADIENT: P.GradientStop[] = [
  { location: 12, r: 245, g: 0, b: 255 },
  { location: 25, r: 0, g: 6, b: 255 },
  { location: 37, r: 0, g: 250, b: 255 },
  { location: 50, r: 1, g: 255, b: 0 },
  { location: 62, r: 255, g: 246, b: 0 },
  { location: 75, r: 255, g: 120, b: 7 },
  { location: 87, r: 255, g: 0, b: 13 },
];

/** Profile 1 as Gear Link left it at the end of the capture (PROTOCOL.md section 10). */
export function capturedProfile(): ProfileSettings {
  const single = (speed: number): EffectLook => ({ speed, singleColor: true, colors: [RED] });
  return {
    actuation: 10,
    top: 2,
    bottom: 2,
    keys: {},
    rapidTrigger: {
      enabled: true,
      keys: [P.FW_KEY.KeyW, P.FW_KEY.KeyA, P.FW_KEY.KeyS, P.FW_KEY.KeyD],
      independent: true,
      continuous: false,
      sensitivity: 2,
      press: 1,
      release: 1,
      custom: {},
    },
    speedTap: { enabled: false, key1: P.FW_KEY.KeyA, key2: P.FW_KEY.KeyD },
    pollingHz: 8000,
    lighting: {
      effect: "breathing",
      brightness: 100,
      looks: {
        static: { speed: 255, singleColor: true, colors: [RED] },
        breathing: { speed: 30, singleColor: false, colors: [{ r: 255, g: 255, b: 0 }, { r: 255, g: 0, b: 255 }] },
        colorCycle: { speed: 31, singleColor: false, colors: [] },
        rainbow: { speed: 62, singleColor: false, colors: [], width: 100, direction: 0, stops: GRADIENT },
        reactive: single(15),
        ripple: { speed: 100, singleColor: false, colors: [], width: 2, direction: 0, stops: GRADIENT },
        starryNight: single(15),
        current: single(10),
        raindrop: single(20),
      },
    },
    remaps: {},
  };
}

// ---------------------------------------------------------------------------------------------
// Key names
// ---------------------------------------------------------------------------------------------

const LABEL: Partial<Record<P.KeyName, string>> = {
  Backquote: "`",
  Minus: "-",
  Equal: "=",
  Backspace: "Backspace",
  BracketLeft: "[",
  BracketRight: "]",
  Backslash: "\\",
  CapsLock: "Caps",
  Semicolon: ";",
  Quote: "'",
  ShiftLeft: "Left Shift",
  ShiftRight: "Right Shift",
  Comma: ",",
  Period: ".",
  Slash: "/",
  ControlLeft: "Left Ctrl",
  ControlRight: "Right Ctrl",
  MetaLeft: "Win",
  AltLeft: "Left Alt",
  AltRight: "Right Alt",
  ContextMenu: "Menu",
  Escape: "Esc",
  Insert: "Ins",
  Delete: "Del",
  PageUp: "PgUp",
  PageDown: "PgDn",
  ArrowUp: "Up",
  ArrowDown: "Down",
  ArrowLeft: "Left",
  ArrowRight: "Right",
  PrintScreen: "Print Screen",
  ScrollLock: "Scroll Lock",
  NumLock: "Num Lock",
  FN: "Fn",
  Space: "Space",
};

export function keyLabel(index: number): string {
  const name = P.keyNameFromFw(index);
  if (!name) return `Key ${index}`;
  return LABEL[name] ?? name.replace(/^Key|^Digit/, "").replace(/^Numpad/, "Num ");
}

/** Targets offered for a remap: everything in Gear Link's normal key table except modifiers-only oddities. */
export const REMAP_TARGETS: { index: number; label: string }[] = (Object.keys(P.FW_KEY) as P.KeyName[])
  .filter((k) => !["FN", "Brazilian", "UK_HashTilde", "IntlYen", "IntlBackslash", "KP_Hanja", "KP_English", "ScreenLightingUp", "ScreenLightingDown", "Brightness", "SpaceRight", "WindowLock"].includes(k))
  .map((k) => ({ index: P.FW_KEY[k], label: keyLabel(P.FW_KEY[k]) }));

// ---------------------------------------------------------------------------------------------
// Turning a settings change into reports
// ---------------------------------------------------------------------------------------------

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const numKeys = (r: Record<number, unknown>) => Object.keys(r).map(Number);
const union = (...lists: number[][]) => [...new Set(lists.flat())].sort((x, y) => x - y);

function rtFor(rt: RapidTrigger, key: number): P.RapidTriggerSettings {
  const c = rt.custom[key];
  return {
    independent: rt.independent,
    continuous: rt.continuous,
    sensitivity: c?.sensitivity ?? rt.sensitivity,
    press: c?.press ?? rt.press,
    release: c?.release ?? rt.release,
  };
}

/** Analog Effect off is written for these, as Gear Link's Sync does. */
const ANALOG_OFF: ReadonlySet<Effect> = new Set(["static", "colorCycle", "rainbow"]);

export function lightingReports(l: Lighting): Uint8Array[] {
  const look = l.looks[l.effect];
  const out: Uint8Array[] = [];
  if (ANALOG_OFF.has(l.effect)) out.push(P.encodeAnalogLighting(l.effect, false));
  if (l.effect === "rainbow" || l.effect === "ripple") {
    out.push(
      ...P.encodeGradientLighting({
        effect: l.effect,
        speed: look.speed,
        brightness: l.brightness,
        randomColor: false,
        direction: look.direction ?? 0,
        width: look.width ?? 2,
        stops: look.stops ?? GRADIENT,
      }),
    );
  } else {
    out.push(
      P.encodeSimpleLighting({
        effect: l.effect,
        speed: look.speed,
        brightness: l.brightness,
        singleColor: look.singleColor,
        randomColor: false,
        colors: look.singleColor ? look.colors.slice(0, 1) : look.colors,
      }),
    );
  }
  return out;
}

/**
 * The reports that take the keyboard from `a` to `b`, in Gear Link's order. Polling rate is left out
 * (it has its own reconnect-aware path). The caller follows them with 50 55.
 */
export function planWrites(a: ProfileSettings, b: ProfileSettings): Uint8Array[] {
  const out: Uint8Array[] = [];
  const globalMoved = a.actuation !== b.actuation;

  // Per-key actuation and dead zones. Gear Link re-sends every override before a global change and
  // clears an override by writing the global values to that key.
  for (const k of union(numKeys(a.keys), numKeys(b.keys))) {
    const was = a.keys[k];
    const now = b.keys[k];
    if (now) {
      if (!was || was.actuation !== now.actuation || globalMoved) out.push(P.encodeKeyActuation(k, now.actuation));
      if (!was || was.top !== now.top || was.bottom !== now.bottom) out.push(P.encodeKeyDeadZone(k, now.top, now.bottom));
    } else if (was) {
      out.push(P.encodeKeyActuation(k, b.actuation), P.encodeKeyDeadZone(k, b.top, b.bottom));
    }
  }
  if (globalMoved) out.push(P.encodeGlobalActuation(b.actuation));
  if (a.top !== b.top || a.bottom !== b.bottom) out.push(P.encodeGlobalDeadZone(b.top, b.bottom));

  // Rapid trigger: like Gear Link, the whole group again, plus "off" for keys that left it (Gear
  // Link sends nothing for those and leaves them on until a profile reset).
  if (!same(a.rapidTrigger, b.rapidTrigger)) {
    const rt = b.rapidTrigger;
    for (const k of rt.keys) out.push(...P.encodeRapidTriggerForKey(k, rtFor(rt, k), rt.enabled));
    for (const k of a.rapidTrigger.keys) {
      if (!rt.keys.includes(k)) out.push(...P.encodeRapidTriggerForKey(k, rtFor(a.rapidTrigger, k), false));
    }
  }

  // Speed Tap: a new pair goes out the way Sync writes it (on, old pair off, new pair on, then the switch).
  const st0 = a.speedTap;
  const st1 = b.speedTap;
  if (st0.key1 !== st1.key1 || st0.key2 !== st1.key2) {
    out.push(
      P.encodeSpeedTapEnable(true),
      P.encodeSpeedTapPair(st0.key1, st0.key2, false),
      P.encodeSpeedTapPair(st1.key1, st1.key2, true),
      P.encodeSpeedTapEnable(st1.enabled),
    );
  } else if (st0.enabled !== st1.enabled) {
    out.push(P.encodeSpeedTapEnable(st1.enabled));
  }

  if (!same(a.lighting, b.lighting)) out.push(...lightingReports(b.lighting));

  // Remaps: a key going back to default is written with target = source.
  for (const src of union(numKeys(a.remaps), numKeys(b.remaps))) {
    const was = a.remaps[src] ?? src;
    const now = b.remaps[src] ?? src;
    if (was !== now) out.push(P.encodeKeyRemap(src, now, b.keys[src]?.actuation ?? b.actuation));
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Session API
// ---------------------------------------------------------------------------------------------

export interface KeyboardInfo {
  name: string;
  serial: string;
  firmware: string;
  profiles: number;
  profile: number;
}

/** Where the shown settings come from: written by SYNQ, the capture record, or a guess. */
export type SettingsSource = "onboard" | "capture" | "assumed";

export interface KeyboardView {
  info: KeyboardInfo;
  /** The keyboard's own rapid-trigger switch (25 00). SYNQ can't flip it. */
  rapidTriggerSwitch: boolean;
  /** What the page shows, including changes still on their way. */
  settings: ProfileSettings;
  source: SettingsSource;
  link: "ok" | "reconnecting" | "lost";
  busy: boolean;
}

export interface BatchResult {
  label: string;
  reports: number;
  /** Total echo time of the setting writes and the save. */
  echoMs: number;
  saveMs: number;
}

export interface KeyboardSession {
  view: KeyboardView;
  subscribe(listener: (v: KeyboardView) => void): () => void;
  /** Queue an edit. Edits within a short window go out together, followed by one save (50 55). */
  update(label: string, change: (s: ProfileSettings) => void): Promise<BatchResult>;
  /** Polling rate: the keyboard may drop off USB and come back, which this waits for. */
  setPolling(hz: P.PollingRateHz): Promise<BatchResult>;
  /** Re-reads the live values (profile, rapid-trigger switch, Speed Tap). */
  refresh(): Promise<KeyboardView>;
  close(): Promise<void>;
}

interface StoredFile {
  version: 1;
  serial: string;
  savedAt: string;
  profiles: Record<number, ProfileSettings>;
}

const EFFECT_BY_TYPE = new Map<number, Effect>(
  (Object.entries(P.LIGHTING_EFFECT) as [P.LightingEffect, number][]).filter(([k]) => k !== "quicksand").map(([k, v]) => [v, k as Effect]),
);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const hex = (b: Uint8Array) => {
  let end = b.length;
  while (end > 2 && b[end - 1] === 0) end--;
  return Array.from(b.subarray(0, end), (x) => x.toString(16).padStart(2, "0")).join(" ");
};

// ---------------------------------------------------------------------------------------------
// Link: one request at a time on the vendor collection, matched to its echo
// ---------------------------------------------------------------------------------------------

interface HidSummary {
  key: string;
  vendorId: number;
  productId: number;
  productName: string;
  collections: { usagePage: number; usage: number }[];
}

interface InputPayload {
  key: string;
  reportId: number;
  usagePage?: number;
  usage?: number;
  data: number[];
}

interface Waiting {
  sent: Uint8Array;
  write: boolean;
  resolve: (reply: Uint8Array) => void;
  reject: (e: Error) => void;
}

async function findKeyboard(): Promise<HidSummary | null> {
  const list = await invoke<HidSummary[]>("hid_list");
  return (
    list.find(
      (d) =>
        d.vendorId === KEYBOARD.vendorId &&
        d.productId === KEYBOARD.productId &&
        d.collections.some((c) => c.usagePage === KEYBOARD.usagePage && c.usage === KEYBOARD.usage),
    ) ?? null
  );
}

class Link {
  key: string;
  serial = "";
  private waiting: Waiting | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private log: string[] = [];

  constructor(key: string) {
    this.key = key;
  }

  deliver(p: InputPayload) {
    if (p.key !== this.key || p.reportId !== P.REPORT_ID) return;
    if (p.usagePage !== undefined && p.usagePage !== KEYBOARD.usagePage) return;
    const w = this.waiting;
    if (!w) return;
    const reply = Uint8Array.from(p.data);
    if (P.isRejected(reply)) {
      w.reject(new Error(`The keyboard doesn't support ${hex(w.sent)} (it answered FF AA).`));
      return;
    }
    // Reads answer with the same first 4 bytes plus data; anything else is someone else's traffic.
    for (let i = 0; i < 4; i++) if (reply[i] !== w.sent[i]) return;
    if (w.write && !P.isEcho(w.sent, reply)) {
      w.reject(new Error(`The keyboard answered ${hex(reply)} to ${hex(w.sent)}.`));
      return;
    }
    w.resolve(reply);
  }

  /** Sends one report built by keyboard-protocol.ts and waits for its echo (writes) or reply (reads). */
  request(report: Uint8Array, kind: "read" | "write", timeoutMs: number = TIMING.replyMs): Promise<{ reply: Uint8Array; ms: number }> {
    const run = async () => {
      const t0 = performance.now();
      let timer = 0;
      const answer = new Promise<Uint8Array>((resolve, reject) => {
        this.waiting = { sent: report, write: kind === "write", resolve, reject };
        timer = window.setTimeout(() => reject(new Error(`No answer from the keyboard to ${hex(report)}.`)), timeoutMs);
      });
      try {
        await invoke("hid_send_report_to", {
          key: this.key,
          usagePage: KEYBOARD.usagePage,
          usage: KEYBOARD.usage,
          reportId: P.REPORT_ID,
          data: Array.from(report),
        });
        const reply = await answer;
        const ms = Math.round(performance.now() - t0);
        this.note(`${kind === "write" ? "write" : "read "} ${hex(report)}  <-  ${kind === "write" ? "echo" : hex(reply)}  ${ms} ms`);
        return { reply, ms };
      } catch (e) {
        this.note(`${kind === "write" ? "write" : "read "} ${hex(report)}  FAILED  ${String(e).replace(/^Error: /, "")}`);
        throw e instanceof Error ? e : new Error(String(e));
      } finally {
        window.clearTimeout(timer);
        this.waiting = null;
      }
    };
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private note(line: string) {
    this.log.push(`${new Date().toISOString()}  ${line}`);
  }

  /** Writes the traffic log next to SYNQ's settings copy, once the serial is known. */
  flushLog() {
    if (!this.serial || !this.log.length) return;
    const lines = this.log.splice(0);
    invoke("keyboard_log", { serial: this.serial, lines }).catch(() => undefined);
  }
}

// ---------------------------------------------------------------------------------------------
// Connect
// ---------------------------------------------------------------------------------------------

interface Live {
  info: KeyboardInfo;
  rapidTriggerSwitch: boolean;
  speedTapOn: boolean;
  effect: Effect | null;
}

async function readLive(link: Link, name: string): Promise<Live> {
  if (!link.serial) link.serial = P.decodeSerial((await link.request(P.encodeGetSerial(), "read")).reply) || "unknown";
  const basic = P.decodeBasicInfo((await link.request(P.encodeGetInfo(P.INFO.basic), "read")).reply);
  const rt = P.decodeStateByte((await link.request(P.encodeGetRapidTriggerState(), "read")).reply);
  const st = P.decodeStateByte((await link.request(P.encodeGetSpeedTapState(), "read")).reply);
  link.flushLog();
  return {
    info: { name, serial: link.serial, firmware: basic.firmware, profiles: basic.profiles, profile: basic.currentProfile },
    rapidTriggerSwitch: rt === 1,
    speedTapOn: st === 1,
    effect: EFFECT_BY_TYPE.get(basic.currentLightingEffect) ?? null,
  };
}

function parseStored(text: string | null, serial: string): StoredFile {
  const empty: StoredFile = { version: 1, serial, savedAt: "", profiles: {} };
  if (!text) return empty;
  try {
    const f = JSON.parse(text) as StoredFile;
    return f && f.version === 1 && f.profiles ? f : empty;
  } catch {
    return empty;
  }
}

export async function connectKeyboard(): Promise<KeyboardSession | null> {
  if (!liveHardware) return previewSession();
  const found = await findKeyboard();
  if (!found) return null;

  const link = new Link(found.key);
  let closed = false;
  let unlistenInput: UnlistenFn | null = null;
  let unlistenLost: UnlistenFn | null = null;
  unlistenInput = await listen<InputPayload>("hid-input", (e) => link.deliver(e.payload));

  const open = async (key: string) => {
    // A stale handle from before a replug would say "already open"; start clean.
    await invoke("hid_close", { key }).catch(() => undefined);
    await invoke("hid_open", { key });
    link.key = key;
  };

  try {
    await open(found.key);
    const name = found.productName ? titleCase(found.productName) : KEYBOARD.name;
    let live = await readLive(link, name);
    const stored = parseStored(await invoke<string | null>("keyboard_state_load", { serial: live.info.serial }), live.info.serial);

    const settingsFor = (profile: number): { s: ProfileSettings; source: SettingsSource } => {
      const saved = stored.profiles[profile];
      if (saved) return { s: structuredClone(saved), source: "onboard" };
      return { s: capturedProfile(), source: profile === 1 ? "capture" : "assumed" };
    };
    const withLive = (s: ProfileSettings, l: Live) => {
      s.speedTap.enabled = l.speedTapOn;
      if (l.effect) s.lighting.effect = l.effect;
      return s;
    };

    let { s: confirmed, source } = settingsFor(live.info.profile);
    confirmed = withLive(confirmed, live);
    let desired = structuredClone(confirmed);
    let busy = false;
    let linkState: KeyboardView["link"] = "ok";
    const listeners = new Set<(v: KeyboardView) => void>();

    const view = (): KeyboardView => ({
      info: live.info,
      rapidTriggerSwitch: live.rapidTriggerSwitch,
      settings: desired,
      source,
      link: linkState,
      busy,
    });
    const emit = () => {
      session.view = view();
      for (const l of [...listeners]) l(session.view);
    };

    const persist = async () => {
      stored.profiles[live.info.profile] = structuredClone(confirmed);
      stored.savedAt = new Date().toISOString();
      source = "onboard";
      await invoke("keyboard_state_save", { serial: live.info.serial, json: JSON.stringify(stored, null, 1) });
    };

    // Reconnect after a replug or re-enumeration. One attempt runs at a time.
    let reopening: Promise<void> | null = null;
    const reopen = (timeoutMs: number = TIMING.reconnectMs) => {
      reopening ??= (async () => {
        linkState = "reconnecting";
        emit();
        const until = Date.now() + timeoutMs;
        try {
          while (!closed) {
            const d = await findKeyboard().catch(() => null);
            if (d) {
              try {
                await open(d.key);
                live = await readLive(link, live.info.name);
                linkState = "ok";
                emit();
                return;
              } catch {
                /* still settling; try again */
              }
            }
            if (Date.now() > until) throw new Error("The keyboard didn't come back. Check the cable, then press Reconnect.");
            await sleep(TIMING.reconnectStepMs);
          }
          throw new Error("Closed.");
        } catch (e) {
          if (!closed) {
            linkState = "lost";
            emit();
          }
          throw e;
        } finally {
          reopening = null;
        }
      })();
      return reopening;
    };
    unlistenLost = await listen<{ key: string }>("hid-lost", (e) => {
      if (!closed && e.payload.key === link.key) reopen().catch(() => undefined);
    });

    // Batching: edits land in `desired` at once (the page shows them), and go out after a pause.
    let chain: Promise<unknown> = Promise.resolve();
    let timer = 0;
    let waiters: { resolve: (r: BatchResult) => void; reject: (e: Error) => void }[] = [];
    let pendingLabel = "";

    const flush = async (label: string): Promise<BatchResult> => {
      if (reopening) await reopening;
      const target = structuredClone(desired);
      const reports = planWrites(confirmed, target);
      if (!reports.length) return { label, reports: 0, echoMs: 0, saveMs: 0 };
      busy = true;
      emit();
      try {
        let echoMs = 0;
        for (const r of reports) echoMs += (await link.request(r, "write")).ms;
        const save = await link.request(P.encodeSaveProfile(), "write", TIMING.saveMs);
        confirmed = { ...target, pollingHz: confirmed.pollingHz };
        await persist();
        return { label, reports: reports.length + 1, echoMs: echoMs + save.ms, saveMs: save.ms };
      } catch (e) {
        // Show what the keyboard is known to have. Writes are idempotent, so a retry re-sends them.
        desired = structuredClone(confirmed);
        throw e;
      } finally {
        busy = false;
        link.flushLog();
        emit();
      }
    };

    const runFlush = () => {
      timer = 0;
      const batch = waiters;
      const label = pendingLabel;
      waiters = [];
      const result = chain.then(() => flush(label));
      chain = result.catch(() => undefined);
      result.then(
        (r) => batch.forEach((w) => w.resolve(r)),
        (e) => batch.forEach((w) => w.reject(e instanceof Error ? e : new Error(String(e)))),
      );
    };

    const session: KeyboardSession = {
      view: view(),
      subscribe(l) {
        listeners.add(l);
        return () => listeners.delete(l);
      },
      update(label, change) {
        const next = structuredClone(desired);
        change(next);
        desired = next;
        pendingLabel = label;
        emit();
        return new Promise<BatchResult>((resolve, reject) => {
          waiters.push({ resolve, reject });
          window.clearTimeout(timer);
          timer = window.setTimeout(runFlush, TIMING.debounceMs);
        });
      },
      async setPolling(hz) {
        if (timer) {
          window.clearTimeout(timer);
          runFlush();
        }
        const run = async (): Promise<BatchResult> => {
          const before = confirmed.pollingHz;
          desired = { ...desired, pollingHz: hz };
          busy = true;
          emit();
          try {
            const t0 = performance.now();
            // The keyboard may re-enumerate on this write and never echo it; that is expected.
            await link.request(P.encodePollingRate(hz), "write").catch(() => undefined);
            await sleep(TIMING.pollingSettleMs);
            const alive = await link
              .request(P.encodeGetInfo(P.INFO.basic), "read")
              .then(() => true)
              .catch(() => false);
            if (!alive) await reopen();
            const save = await link.request(P.encodeSaveProfile(), "write", TIMING.saveMs);
            confirmed = { ...confirmed, pollingHz: hz };
            await persist();
            return { label: `Polling rate set to ${hz / 1000}K`, reports: 2, echoMs: Math.round(performance.now() - t0), saveMs: save.ms };
          } catch (e) {
            desired = { ...desired, pollingHz: before };
            throw e;
          } finally {
            busy = false;
            link.flushLog();
            emit();
          }
        };
        const result = chain.then(run);
        chain = result.catch(() => undefined);
        return result;
      },
      async refresh() {
        if (reopening) await reopening.catch(() => undefined);
        const next = await readLive(link, live.info.name);
        const profileMoved = next.info.profile !== live.info.profile;
        live = next;
        const quiet = !timer && !busy;
        if (profileMoved && quiet) {
          // Switched on the keyboard: show that profile's copy.
          ({ s: confirmed, source } = settingsFor(live.info.profile));
          confirmed = withLive(confirmed, live);
          desired = structuredClone(confirmed);
        } else if (quiet) {
          confirmed = withLive(structuredClone(confirmed), live);
          desired = withLive(structuredClone(desired), live);
        }
        emit();
        return session.view;
      },
      async close() {
        closed = true;
        window.clearTimeout(timer);
        unlistenInput?.();
        unlistenLost?.();
        link.flushLog();
        await invoke("hid_close", { key: link.key }).catch(() => undefined);
      },
    };
    return session;
  } catch (e) {
    unlistenInput?.();
    unlistenLost?.();
    link.flushLog();
    await invoke("hid_close", { key: link.key }).catch(() => undefined);
    throw e;
  }
}

function titleCase(s: string): string {
  // "ROG FALCHION ACE HFX ZYWOO EDITION" -> "ROG Falchion Ace HFX ZywOo Edition"
  const keep = new Set(["ROG", "HFX"]);
  return s
    .split(/\s+/)
    .map((w) => (keep.has(w) ? w : w === "ZYWOO" ? "ZywOo" : w.charAt(0) + w.slice(1).toLowerCase()))
    .join(" ");
}

// ---------------------------------------------------------------------------------------------
// Browser preview: sample keyboard, nothing touches hardware
// ---------------------------------------------------------------------------------------------

function previewSession(): KeyboardSession {
  let desired = capturedProfile();
  desired.keys = { [P.FW_KEY.KeyP]: { actuation: 5, top: 2, bottom: 2 }, [P.FW_KEY.KeyO]: { actuation: 7, top: 2, bottom: 3 } };
  desired.remaps = { [P.FW_KEY.Insert]: P.FW_KEY.ScrollLock };
  let busy = false;
  const listeners = new Set<(v: KeyboardView) => void>();
  const view = (): KeyboardView => ({
    info: { name: "ROG Falchion Ace HFX ZywOo Edition", serial: "PREVIEW", firmware: "1.00.03", profiles: 6, profile: 1 },
    rapidTriggerSwitch: true,
    settings: desired,
    source: "capture",
    link: "ok",
    busy,
  });
  const emit = () => {
    session.view = view();
    for (const l of [...listeners]) l(session.view);
  };
  let timer = 0;
  let waiters: ((r: BatchResult) => void)[] = [];
  const session: KeyboardSession = {
    view: view(),
    subscribe(l) {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    update(label, change) {
      const next = structuredClone(desired);
      change(next);
      desired = next;
      emit();
      return new Promise((resolve) => {
        waiters.push(resolve);
        window.clearTimeout(timer);
        timer = window.setTimeout(async () => {
          const batch = waiters;
          waiters = [];
          busy = true;
          emit();
          await sleep(220);
          busy = false;
          emit();
          batch.forEach((w) => w({ label, reports: 2, echoMs: 4, saveMs: 160 }));
        }, TIMING.debounceMs);
      });
    },
    async setPolling(hz) {
      busy = true;
      desired = { ...desired, pollingHz: hz };
      emit();
      await sleep(900);
      busy = false;
      emit();
      return { label: `Polling rate set to ${hz / 1000}K`, reports: 2, echoMs: 900, saveMs: 160 };
    },
    async refresh() {
      return session.view;
    },
    async close() {},
  };
  return session;
}
