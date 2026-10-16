// Razer Huntsman analog / HE keyboards as a Wave 1 keyboard driver (src/lib/kb/types.ts KbDriver /
// KbBackend), on top of RazerKeyboardSession. Not registered anywhere yet (no page wiring in Wave 3b):
// add `razerKbDriver` to the keyboard driver list when the bridge allows the collection.
//
// Tiers: nothing here has run on hardware, so every board is "read-only" until the person allows
// changes (Wave 1's KbSession enforces that, takes the backup and judges the read-back). Boards the
// device table marks readOnly (desktop-Synapse-only V3 Pro / TKL) refuse every plan regardless.

import type { AnalogValues, BlockedCommand, HidLike as KbHidLike, KbBackend, KbChange, KbContext, KbDriver, KbPlan, KbState, KbSupport, NumberSpec } from "../../kb/types.ts";
import type { HidLike, BlockReason } from "../local-kb.ts";
import { RAZER_VID, findRazerKeyboard, type RazerKeyboardModel } from "./devices.ts";
import { RAZER_BLOCKED_SUMMARY } from "./guard.ts";
import { razerLayout } from "./layout.ts";
import { rawToMm, RT_MAX_RAW, RT_MIN_RAW } from "./protocol.ts";
import { RazerKeyboardSession } from "./session.ts";

const DRIVER_ID = "razer-he";
const DZ_LEVELS = ["responsive", "medium", "stable"] as const;

const WHY: Record<BlockReason, BlockedCommand["why"]> = {
  firmware: "firmware",
  bootloader: "bootloader",
  "device-mode": "bootloader",
  "factory-reset": "factory-reset",
  "profile-wipe": "factory-reset",
  calibration: "calibration",
  pairing: "pairing",
  identity: "identity",
  shape: "unverified",
  unknown: "unverified",
};

/** Is this HID device a Razer analog keyboard's control collection (Consumer page, feature reports)? No I/O. */
export function claimsRazerKeyboard(device: { vendorId: number; productId: number; collections?: readonly { usagePage?: number }[] }): boolean {
  if (device.vendorId !== RAZER_VID || !findRazerKeyboard(device.productId)) return false;
  const cols = device.collections ?? [];
  return cols.length > 0 && cols.every((c) => c.usagePage === 0x000c);
}

const asLocal = (d: KbHidLike): HidLike => d as unknown as HidLike;

async function ensureOpen(d: KbHidLike): Promise<void> {
  if (!d.opened) await d.open();
}

export const razerKbDriver: KbDriver = {
  id: DRIVER_ID,
  name: "Razer analog keyboards",
  priority: 60,
  vids: [RAZER_VID],
  claims: (device) => claimsRazerKeyboard(device),
  async open(device: KbHidLike, _ctx: KbContext): Promise<KbBackend> {
    await ensureOpen(device);
    const backend = new RazerKbBackend(device);
    await backend.load();
    return backend;
  },
  async ping(device: KbHidLike): Promise<boolean> {
    const wasOpen = device.opened;
    try {
      await ensureOpen(device);
      const s = RazerKeyboardSession.forDevice(asLocal(device), { maxOut: 1, maxIn: 5 });
      await s.link.request({ cmd: "firmware", args: new Uint8Array(2), dataSize: 2 });
      return true;
    } catch {
      return false;
    } finally {
      if (!wasOpen && device.opened) await device.close().catch(() => undefined);
    }
  },
};

export class RazerKbBackend implements KbBackend {
  readonly driver = DRIVER_ID;
  readonly blocked: readonly BlockedCommand[] = RAZER_BLOCKED_SUMMARY.map((b) => ({ what: b.what, why: WHY[b.why] }));
  readonly support: KbSupport;
  readonly model: RazerKeyboardModel;
  readonly session: RazerKeyboardSession;
  readonly #device: KbHidLike;
  #state: KbState;

  constructor(device: KbHidLike) {
    const model = findRazerKeyboard(device.productId);
    if (!model) throw new Error("Not a Razer analog keyboard.");
    this.#device = device;
    this.model = model;
    // Wave 1's KbSession owns "Allow changes"; the backend only refuses what the model can't do.
    this.session = new RazerKeyboardSession(asLocal(device), model, { allowWrites: () => true });
    this.support = {
      tier: "read-only",
      why:
        model.tier === "readOnly"
          ? `${model.model}: not in Razer's web configurator, so SYNQ only reads it.`
          : `Built from Razer Synapse Web's own code (${model.synapseId ?? "?"}); not yet tried on a real ${model.model}.`,
    };
    this.#state = this.#toKb();
  }

  get state(): KbState {
    return this.#state;
  }

  async load(): Promise<KbState> {
    await this.session.connect();
    this.#state = this.#toKb();
    return this.#state;
  }

  snapshot(): unknown {
    const s = this.session.state;
    return {
      model: this.model.model, pid: this.model.pid, firmware: s.firmware, serial: s.serial, profileIds: s.profileIds, activeProfile: s.activeProfile, profile: s.profile,
      actuation: Object.fromEntries(s.actuation), rapidTrigger: Object.fromEntries(s.rapidTrigger), bottomDeadZone: s.bottomDeadZone, snapTap: s.snapTap,
      singleSnapTap: s.singleSnapTap, dualPriority: s.dualPriority, pollingHz: s.pollingHz, brightness: s.brightness, readAt: s.readAt, problems: s.problems,
    };
  }

  async close(): Promise<void> {
    if (this.#device.opened) await this.#device.close().catch(() => undefined);
  }

  plan(change: KbChange): KbPlan {
    if (this.model.tier === "readOnly") throw new Error(this.support.why);
    const s = this.session;
    const refresh = () => (this.#state = this.#toKb());
    const plan = (label: string, expected: unknown, send: () => Promise<unknown>, readBack: () => unknown, caution?: string): KbPlan => ({
      label,
      expected,
      persistence: "saved",
      caution,
      send: async () => {
        await send();
        refresh();
      },
      readBack: async () => readBack(),
    });
    switch (change.kind) {
      case "analog": {
        const target = change.target === "global" ? ("all" as const) : change.target;
        const v = change.values;
        const keys = target === "all" ? s.state.keys : [...target];
        const expected: AnalogValues = {};
        if (v.actuationMm != null) expected.actuationMm = rawToMm(Math.round(v.actuationMm * 10) * 1638);
        if (v.rapidTrigger != null) expected.rapidTrigger = v.rapidTrigger;
        if (v.rtPressMm != null) expected.rtPressMm = rawToMm(Math.round(v.rtPressMm * 10) * 1638);
        if (v.rtReleaseMm != null) expected.rtReleaseMm = rawToMm(Math.round(v.rtReleaseMm * 10) * 1638);
        if (Object.keys(expected).length === 0) throw new Error("Razer boards take actuation and rapid trigger here; dead zones are the Bottom dead zone option.");
        const count = target === "all" ? "every key" : `${keys.length} key${keys.length === 1 ? "" : "s"}`;
        return plan(
          `Analog settings on ${count}`,
          expected,
          async () => {
            if (expected.actuationMm != null) await s.setActuation(target, expected.actuationMm);
            if (expected.rapidTrigger != null || expected.rtPressMm != null || expected.rtReleaseMm != null) {
              const cur = s.state.rapidTrigger.get(keys[0]);
              const press = expected.rtPressMm ?? (cur ? rawToMm(cur.pressRaw) : 0.3);
              await s.setRapidTrigger(target, { enabled: expected.rapidTrigger ?? cur?.enabled ?? true, pressMm: press, releaseMm: expected.rtReleaseMm ?? (cur ? rawToMm(cur.releaseRaw) : press) });
            }
          },
          () => {
            for (const k of keys) {
              const got = this.#analogOf(k, expected);
              if (JSON.stringify(got) !== JSON.stringify(expected)) return got;
            }
            return expected;
          },
        );
      }
      case "polling":
        return plan(`Polling ${change.hz} Hz`, change.hz, () => s.setPolling(change.hz), () => s.state.pollingHz ?? undefined, change.hz > 1000 ? "8 kHz-class rates use more CPU." : undefined);
      case "profile": {
        const id = s.state.profileIds[change.index];
        if (id === undefined) throw new Error("That profile isn't on the keyboard.");
        return plan(`Onboard profile ${change.index + 1}`, change.index, () => s.setActiveProfile(id), () => {
          const i = s.state.activeProfile === null ? -1 : s.state.profileIds.indexOf(s.state.activeProfile);
          return i < 0 ? undefined : i;
        });
      }
      case "lighting":
        if (change.id !== "brightness" || typeof change.value !== "number") throw new Error("Only backlight brightness is supported on Razer boards for now.");
        return plan(`Brightness ${change.value} %`, Math.round((Math.floor((change.value / 100) * 255) * 100) / 255), () => s.setBrightness(change.value as number), () => s.state.brightness ?? undefined);
      case "option":
        return this.#planOption(change.id, change.value, plan);
      case "keycode":
        throw new Error("Key remapping isn't implemented for Razer boards yet.");
    }
  }

  #planOption(id: string, value: number, plan: (label: string, expected: unknown, send: () => Promise<unknown>, readBack: () => unknown) => KbPlan): KbPlan {
    const s = this.session;
    if (id === "bottomDeadZone") {
      const level = DZ_LEVELS[value];
      if (!level || !this.model.bottomDeadZone) throw new Error("Unknown bottom dead-zone level.");
      return plan(`Bottom dead zone: ${level}`, value, () => s.setBottomDeadZone(level), () => this.#dzIndex() ?? undefined);
    }
    if (id === "snapTap") {
      const cur = s.state.snapTap;
      if (!cur) throw new Error("Snap tap wasn't read.");
      return plan(`Snap tap ${value ? "on" : "off"}`, value, () => s.setSnapTap({ enabled: !!value, pairs: cur.pairs }), () => (s.state.snapTap ? (s.state.snapTap.enabled ? 1 : 0) : undefined));
    }
    if (id === "singleSnapTap") {
      return plan(`Single-key snap tap ${value ? "on" : "off"}`, value, () => s.setSingleSnapTapEnabled(!!value), () => (s.state.singleSnapTap ? (s.state.singleSnapTap.enabled ? 1 : 0) : undefined));
    }
    if (id === "dualPriority") {
      const cur = s.state.dualPriority;
      if (!cur) throw new Error("Dual keypress priority wasn't read.");
      return plan(`Dual keypress priority ${value ? "on" : "off"}`, value, () => s.setDualPriority({ enabled: !!value, keys: cur.keys }), () => (s.state.dualPriority ? (s.state.dualPriority.enabled ? 1 : 0) : undefined));
    }
    throw new Error(`Unknown option ${id}.`);
  }

  #dzIndex(): number | null {
    const v = this.session.state.bottomDeadZone;
    const dz = this.model.bottomDeadZone;
    if (v === null || !dz) return null;
    const i = DZ_LEVELS.findIndex((l) => dz[l] === v);
    return i < 0 ? null : i;
  }

  #analogOf(key: number, like?: AnalogValues): AnalogValues {
    const a = this.session.state.actuation.get(key);
    const r = this.session.state.rapidTrigger.get(key);
    const full: AnalogValues = {
      actuationMm: a ? rawToMm(a.actuationRaw) : null,
      releaseMm: a ? rawToMm(a.releaseRaw) : null,
      rapidTrigger: r ? r.enabled : null,
      rtPressMm: r ? rawToMm(r.pressRaw) : null,
      rtReleaseMm: r ? rawToMm(r.releaseRaw) : null,
    };
    if (!like) return full;
    const out: AnalogValues = {};
    for (const k of Object.keys(like) as (keyof AnalogValues)[]) (out as Record<string, unknown>)[k] = full[k];
    return out;
  }

  #toKb(): KbState {
    const m = this.model;
    const s = this.session.state;
    const mm = (min: number, max: number): NumberSpec => ({ min, max, step: 0.1, unit: "mm", decimals: 1 });
    const geo = razerLayout(m);
    const perKey: Record<number, AnalogValues> = {};
    for (const k of s.keys) perKey[k] = this.#analogOf(k);
    const writableGroups = m.tier !== "readOnly";
    const dz = this.#dzIndex();
    const options: KbState["options"] = [
      ...(m.features.bottomDeadZone && m.bottomDeadZone
        ? [{ id: "bottomDeadZone", label: "Bottom dead zone", hint: "How far from the bottom a key counts as fully pressed.", kind: "choice" as const, choice: { options: DZ_LEVELS.map((l, i) => ({ value: i, label: l[0].toUpperCase() + l.slice(1) })) }, value: dz, writable: writableGroups }]
        : []),
      ...(m.features.snapTap && s.snapTap ? [{ id: "snapTap", label: "Snap tap", hint: `${s.snapTap.pairs.length} key pair(s) on the keyboard`, kind: "toggle" as const, value: s.snapTap.enabled ? 1 : 0, writable: writableGroups }] : []),
      ...(m.features.singleKeySnapTap && s.singleSnapTap ? [{ id: "singleSnapTap", label: "Single-key snap tap", kind: "toggle" as const, value: s.singleSnapTap.enabled ? 1 : 0, writable: writableGroups }] : []),
      ...(m.features.dualKeypressPriority && s.dualPriority ? [{ id: "dualPriority", label: "Dual keypress priority", kind: "toggle" as const, value: s.dualPriority.enabled ? 1 : 0, writable: writableGroups }] : []),
    ];
    const activeIdx = s.activeProfile === null ? null : s.profileIds.indexOf(s.activeProfile);
    return {
      info: {
        brand: "Razer",
        model: m.model,
        driver: DRIVER_ID,
        protocol: "Razer 90-byte feature reports (Synapse Web rzDevice25)",
        firmware: s.firmware ? [s.firmware] : [],
        serial: s.serial,
        connection: "USB",
        extra: [["Profile", s.profile ? String(s.profile) : "?"], ["Analog keys", String(s.keys.length)]],
      },
      analog: {
        scope: "per-key",
        keys: s.keys,
        travelMm: rawToMm(m.actuation.maxRaw),
        fields: {
          actuationMm: mm(rawToMm(m.actuation.minRaw), rawToMm(m.actuation.maxRaw)),
          releaseMm: mm(0, rawToMm(m.actuation.maxRaw)),
          rapidTrigger: "toggle",
          rtPressMm: mm(rawToMm(RT_MIN_RAW), rawToMm(RT_MAX_RAW)),
          rtReleaseMm: mm(rawToMm(RT_MIN_RAW), rawToMm(RT_MAX_RAW)),
        },
        writable: writableGroups ? ["actuationMm", "rapidTrigger", "rtPressMm", "rtReleaseMm"] : [],
        global: null,
        perKey,
        source: s.readAt ? "device" : "unknown",
        note: "Release point follows Synapse: 0.1 mm above the actuation point.",
      },
      keymap: {
        layout: { source: "driver", width: geo.width, height: geo.height, keys: geo.keys.map((k) => ({ index: k.id, x: k.x, y: k.y, w: k.w, h: k.h, label: k.label })), note: "ANSI geometry; Razer key ids." },
        layers: 1,
        codes: [null],
        keySpace: "vendor",
        assignable: [],
        writable: false,
        source: "unknown",
        note: "Key remapping isn't implemented for Razer boards yet.",
      },
      lighting: {
        groups: [{ id: "backlight", label: "Backlight", settings: [{ id: "brightness", label: "Brightness", kind: "range", spec: { min: 0, max: 100, step: 1, unit: "%" }, value: s.brightness, writable: writableGroups }] }],
        source: s.brightness === null ? "unknown" : "device",
      },
      polling: m.features.highSpeedPolling ? { hz: s.pollingHz, options: m.polling, writable: writableGroups } : { hz: null, options: m.polling, writable: false, note: "No polling setting on this board." },
      profiles: { active: activeIdx === null || activeIdx < 0 ? null : activeIdx, count: s.profileIds.length || null, names: s.profileIds.map(() => null), writable: writableGroups && s.profileIds.length > 1 },
      options,
      notes: [...(m.notes ? [m.notes] : []), ...s.problems],
    };
  }
}
