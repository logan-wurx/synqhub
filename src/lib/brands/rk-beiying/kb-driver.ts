// Royal Kludge "BeiYing" boards (RK61 / 68 / 84 / 87 / 100, the M75 family and about 160 more) as a generic Keyboard
// panel driver (src/lib/kb/types.ts), on top of RkSession. KbSession owns "Allow changes" and the backup; RkSession
// owns the shadow (what SYNQ last sent), the guard and the reports.
//
// These keyboards can't be read: no setting comes back, so the panel shows what this PC last sent (the board's
// default map and lighting before that), says so, and every change ends "Unconfirmed". Offered: lighting (mode,
// brightness, speed, colour, random colours, sleep time) and, where every key's default is known, one-key remaps of the
// base layer. Not offered: per-key colours and the other layers.
//
// Protocol and layouts from Rangoli, KludgeKnight and Fighting Control Center (all GPL-3.0(-or-later)); SYNQ is AGPL-3.0.
import type { BlockedCommand, HidLike as KbHidLike, KbBackend, KbChange, KbDriver, KbKey, KbLayout, KbOption, KbPlan, KbState, KbSupport, LightingSetting } from "../../kb/types.ts";
import { hsToRgb, rgbToHs } from "../../kb/color.ts";
import { HID_NAMES } from "../../x68he-protocol.ts";
import type { HidLike } from "../local-kb.ts";
import { RK_CHANNEL, RK_VID, layoutOf, rkModel } from "./devices.ts";
import { BLOCKED } from "./guard.ts";
import * as P from "./protocol.ts";
import { RkSession, type RkPlan, type ShadowStore } from "./session.ts";

const DRIVER_ID = "rk-beiying";

/** An RK BeiYing id the table names and its System Control collection. No I/O. */
export function claimsRkBeiying(d: { vendorId: number; productId: number; collections?: readonly { usagePage?: number; usage?: number }[] }): boolean {
  if (!rkModel(d.vendorId, d.productId)) return false;
  return (d.collections ?? []).some((c) => c.usagePage === RK_CHANNEL.usagePage && (c.usage ?? 0) === RK_CHANNEL.usage);
}

const asLocal = (d: KbHidLike): HidLike => d as unknown as HidLike;

/** Where the driver keeps its shadow (the desktop's localStorage by default; the tests pass memory). */
export interface RkDriverOptions {
  store?: ShadowStore;
}

export function createRkKbDriver(options: RkDriverOptions = {}): KbDriver {
  return {
    id: DRIVER_ID,
    name: "Royal Kludge (BeiYing) keyboards",
    priority: 60,
    vids: [RK_VID],
    claims: (d) => claimsRkBeiying(d),
    async open(device) {
      if (!device.opened) await device.open();
      return new RkKbBackend(device, RkSession.connect(asLocal(device), { allowWrites: () => true, store: options.store }));
    },
    /** These boards never answer, so there is nothing to ask: listed and present is all a ping can say. */
    async ping(device) {
      return claimsRkBeiying(device);
    },
  };
}

export const rkBeiyingKbDriver: KbDriver = createRkKbDriver();

// ---------------------------------------------------------------------------------------------
// Key codes in the panel: the firmware's 32-bit code is the key code (keySpace "vendor")
// ---------------------------------------------------------------------------------------------

const MOD_NAMES: Record<number, string> = { 1: "Ctrl", 2: "Shift", 4: "Alt", 8: "Win", 0x10: "R-Ctrl", 0x20: "R-Shift", 0x40: "R-Alt", 0x80: "R-Win" };
const MODIFIER_LABEL: Record<number, string> = { 0xe0: "L-Ctrl", 0xe1: "L-Shift", 0xe2: "L-Alt", 0xe3: "L-Win", 0xe4: "R-Ctrl", 0xe5: "R-Shift", 0xe6: "R-Alt", 0xe7: "R-Win" };
const MEDIA: readonly [number, string][] = [
  [0xcd, "Play / pause"],
  [0xb7, "Stop"],
  [0xb6, "Previous track"],
  [0xb5, "Next track"],
  [0xe9, "Volume up"],
  [0xea, "Volume down"],
  [0xe2, "Mute"],
  [0x194, "File explorer"],
];
const SHORTCUTS: readonly [number, string][] = [
  [P.keyCode(0x1b, 1), "Cut (Ctrl+X)"],
  [P.keyCode(0x06, 1), "Copy (Ctrl+C)"],
  [P.keyCode(0x19, 1), "Paste (Ctrl+V)"],
  [P.keyCode(0x16, 1), "Save (Ctrl+S)"],
  [P.keyCode(0x04, 1), "Select all (Ctrl+A)"],
  [P.keyCode(0x1d, 1), "Undo (Ctrl+Z)"],
  [P.keyCode(0x07, 8), "Show desktop (Win+D)"],
  [P.keyCode(0x0f, 8), "Lock (Win+L)"],
  [P.keyCode(0x2b, 4), "Switch window (Alt+Tab)"],
  [P.keyCode(0x3d, 4), "Close window (Alt+F4)"],
];

/** A short keycap label for a firmware code. */
export function codeLabel(code: number): string {
  const c = P.classifyCode(code);
  switch (c.kind) {
    case "none":
      return "—";
    case "fn":
      return "Fn";
    case "consumer":
      return MEDIA.find(([u]) => u === c.usage)?.[1] ?? `Media 0x${c.usage!.toString(16)}`;
    case "modifier":
      return MODIFIER_LABEL[c.hid!];
    case "key": {
      const base = HID_NAMES[c.hid!] ?? `0x${c.hid!.toString(16)}`;
      const mods = [1, 2, 4, 8, 0x10, 0x20, 0x40, 0x80].filter((m) => (c.mods! & m) !== 0).map((m) => MOD_NAMES[m]);
      return mods.length ? `${mods.join("+")}+${base}` : base;
    }
    default:
      return `0x${code.toString(16)}`;
  }
}

/** The picker's choices: the default, every named key, modifiers, Fn, media keys and shortcuts. */
export const RK_ASSIGNABLE: readonly { code: number; label: string; group: string }[] = [
  { code: 0, label: "Default (the key's own function)", group: "Basic" },
  ...Object.entries(HID_NAMES)
    .map(([hid, label]) => ({ hid: Number(hid), label }))
    .filter(({ hid }) => hid >= 0x04 && hid <= 0x65)
    .map(({ hid, label }) => ({ code: P.keyCode(hid), label, group: hid >= 0x3a && hid <= 0x45 ? "Function" : "Keys" })),
  ...[0xe0, 0xe1, 0xe2, 0xe3, 0xe4, 0xe5, 0xe6, 0xe7].map((hid) => ({ code: P.modifierCode(hid), label: MODIFIER_LABEL[hid], group: "Modifiers" })),
  { code: P.FN, label: "Fn", group: "Modifiers" },
  ...MEDIA.map(([usage, label]) => ({ code: P.consumerCode(usage), label, group: "Media" })),
  ...SHORTCUTS.map(([code, label]) => ({ code, label, group: "Shortcuts" })),
];

// ---------------------------------------------------------------------------------------------
// Backend
// ---------------------------------------------------------------------------------------------

export class RkKbBackend implements KbBackend {
  readonly driver = DRIVER_ID;
  readonly blocked: readonly BlockedCommand[] = BLOCKED.map((b) => ({ what: b.what, why: b.why }));
  readonly #device: KbHidLike;
  readonly #s: RkSession;
  #state: KbState;

  constructor(device: KbHidLike, session: RkSession) {
    this.#device = device;
    this.#s = session;
    this.#state = this.#build();
  }

  get state(): KbState {
    return this.#state;
  }

  get support(): KbSupport {
    return { tier: "read-only", why: `${this.#s.model.evidence} It can't be read back, so SYNQ hasn't tried it on one either.` };
  }

  async load(): Promise<KbState> {
    this.#state = this.#build();
    return this.#state;
  }

  snapshot(): unknown {
    return { model: this.#s.model.model, id: this.#s.id, note: "Write-only keyboard: this is what SYNQ last sent, not what the keyboard holds.", shadow: this.#s.shadow };
  }

  async close(): Promise<void> {
    if (this.#device.opened) await this.#device.close().catch(() => undefined);
  }

  #layout(): KbLayout {
    const s = this.#s;
    const keys: KbKey[] = layoutOf(s.model.board).map(([index, , x, y, w, h]) => ({ index, x, y, w, h, label: codeLabel(s.codeOf(index)) }));
    return { source: "driver", width: Math.max(1, ...keys.map((k) => k.x + k.w)), height: Math.max(1, ...keys.map((k) => k.y + k.h)), keys, note: "Layout from RK's own software data, via Rangoli, KludgeKnight and Fighting Control Center" };
  }

  #build(): KbState {
    const s = this.#s;
    const b = s.model.board;
    const l = s.shadow.lighting;
    const mode = s.modeOf(l.mode);
    const notes = [
      "This keyboard can't report its settings, so SYNQ shows what it last sent from this PC (the keyboard's defaults before that). Every change is unconfirmed.",
      s.model.evidence,
    ];
    if (!b.keymap) notes.push("The key map isn't offered for this keyboard: not every key's default is known, and SYNQ rewrites the whole map.");
    if (b.quirks.includes("swap-red-green")) notes.push("Rangoli reports red and green swapped on this board; SYNQ swaps them back.");
    const settings: LightingSetting[] = [
      { id: "effect", label: "Mode", kind: "choice", choice: { options: s.modes.map((m) => ({ value: m.n, label: m.name })) }, value: l.mode, writable: true },
    ];
    if (mode?.brightness) settings.push({ id: "brightness", label: "Brightness", kind: "range", spec: { min: P.BRIGHTNESS.min, max: P.BRIGHTNESS.max, step: 1, unit: "level" }, value: l.brightness, writable: true });
    if (mode?.speed) settings.push({ id: "speed", label: "Speed", kind: "range", spec: { min: P.SPEED.min, max: P.SPEED.max, step: 1, unit: "level" }, value: l.speed, writable: true });
    if (mode?.color && b.rgb) settings.push({ id: "color", label: "Colour", kind: "color", value: rgbToHs(...l.rgb), writable: !l.random });
    if (mode?.random && b.rgb) settings.push({ id: "rainbow", label: "Random colours", kind: "toggle", value: l.random ? 1 : 0, writable: true });
    const options: KbOption[] = [
      { id: "sleep", label: "Sleep after", hint: "Sent together with the lighting", kind: "choice", choice: { options: P.SLEEP_CODES.map((c) => ({ value: c.code, label: c.label })) }, value: l.sleep, writable: true },
    ];
    const codes: Record<number, number> = {};
    const layout = this.#layout();
    for (const k of layout.keys) codes[k.index] = s.codeOf(k.index);
    return {
      info: {
        brand: "Royal Kludge",
        model: b.name,
        driver: DRIVER_ID,
        protocol: "BeiYing legacy channel (write-only)",
        firmware: [],
        connection: "USB",
        extra: [
          ["Settings", s.shadow.sent.lighting || s.shadow.sent.keymap ? "As last sent from this PC" : "RK's defaults (nothing sent from this PC yet)"],
        ],
      },
      keymap: b.keymap
        ? { layout, layers: 1, codes: [codes], keySpace: "vendor", label: codeLabel, assignable: RK_ASSIGNABLE, writable: s.canRemap, source: "cache", note: "Base layer only. Every change sends the whole map; remaps made with other tools aren't visible here and are replaced." }
        : undefined,
      lighting: { groups: [{ id: "lighting", label: "Lighting", settings }], source: "cache", note: "Per-key colours aren't offered here yet." },
      options,
      notes,
    };
  }

  #wrap(p: RkPlan): KbPlan {
    return {
      label: p.label,
      expected: p.expected,
      persistence: p.persistence,
      caution: p.caution,
      send: async () => {
        await p.send();
        this.#state = this.#build();
      },
      /** Nothing comes back from these keyboards. */
      readBack: async () => undefined,
    };
  }

  plan(change: KbChange): KbPlan {
    const s = this.#s;
    if (change.kind === "keycode") {
      if (change.layer !== 0) throw new Error("Only the base layer can be changed on this keyboard.");
      const code = change.code === 0 ? null : change.code;
      return this.#wrap(s.planKey(change.key, code, code === null ? `Key ${change.key}: default function` : `Key ${change.key}: ${codeLabel(code)}`));
    }
    if (change.kind === "lighting") {
      const v = change.value;
      switch (change.id) {
        case "effect": {
          if (typeof v !== "number") throw new Error("A mode is a number.");
          const mode = s.modeOf(v);
          if (!mode) throw new Error("This keyboard doesn't offer that mode.");
          return this.#wrap(s.planLighting({ mode: v }, `Lighting mode: ${mode.name}`));
        }
        case "brightness":
          return this.#wrap(s.planLighting({ brightness: v as number }, `Brightness ${v}`));
        case "speed":
          return this.#wrap(s.planLighting({ speed: v as number }, `Lighting speed ${v}`));
        case "rainbow":
          return this.#wrap(s.planLighting({ random: v === 1 }, v === 1 ? "Random colours on" : "Random colours off"));
        case "color": {
          if (typeof v === "number") throw new Error("A colour is a hue and a saturation.");
          return this.#wrap(s.planLighting({ rgb: hsToRgb(v[0], v[1]), random: false }, "Lighting colour"));
        }
        default:
          throw new Error("This keyboard has no such lighting setting.");
      }
    }
    if (change.kind === "option" && change.id === "sleep") return this.#wrap(s.planLighting({ sleep: change.value }, `Sleep after ${P.SLEEP_CODES.find((c) => c.code === change.value)?.label ?? change.value}`));
    throw new Error("This keyboard's driver can't change that here.");
  }
}
