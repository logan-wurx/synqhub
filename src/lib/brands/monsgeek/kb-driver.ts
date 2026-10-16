// MonsGeek / Akko magnetic keyboards (RY5088 gen2, YC3121 read-only) as a generic Keyboard panel
// driver (src/lib/kb/types.ts), on top of MonsGeekSession. KbSession owns "Allow changes", the backup
// and the read-back verdict; MonsGeekSession keeps its own guard, units and range checks, and its
// write-and-read-back result is what this reports. Per-key actuation, release, rapid trigger and the
// bottom dead zone, polling, profile, and snap tap pairs. DKS, mod-tap, remaps and lighting stay in
// MonsGeekSession for now (not offered here).
import type { AdvancedState, AnalogState, AnalogValues, BlockedCommand, HidLike as KbHidLike, KbAdvancedChange, KbBackend, KbChange, KbDriver, KbLayout, KbPlan, KbState, KbSupport, KeyIndex, NumberSpec } from "../../kb/types.ts";
import type { HidLike, NumRange, WriteOutcome } from "../local-kb.ts";
import { MONSGEEK_CHANNEL, MONSGEEK_USB, keyPositions } from "./devices.ts";
import { MONSGEEK_GUARD } from "./guard.ts";
import { MonsGeekSession } from "./session.ts";

const DRIVER_ID = "monsgeek";

/** A MonsGeek / Akko id and its feature collection FFFF:0002. No I/O. */
export function claimsMonsGeek(d: { vendorId: number; productId: number; collections?: readonly { usagePage?: number; usage?: number }[] }): boolean {
  if (!MONSGEEK_USB.some((u) => u.vendorId === d.vendorId && u.productIds.includes(d.productId))) return false;
  return (d.collections ?? []).some((c) => c.usagePage === MONSGEEK_CHANNEL.usagePage && c.usage === MONSGEEK_CHANNEL.usage);
}

const asLocal = (d: KbHidLike): HidLike => d as unknown as HidLike;
const spec = (r: NumRange | undefined): NumberSpec | undefined => (r ? { min: r.min, max: r.max, step: r.step ?? 0.01, unit: "mm", decimals: 2 } : undefined);

/** A plan from one or more MonsGeekSession writes: their read-backs are the verdict. */
function outcomesPlan(label: string, persistence: KbPlan["persistence"], run: () => Promise<WriteOutcome[]>, after: () => void): KbPlan {
  let outcomes: WriteOutcome[] = [];
  return {
    label,
    persistence,
    get expected() {
      return outcomes.map((o) => (o.status === "mismatch" ? o.wrote : o.value));
    },
    async send() {
      outcomes = await run();
      after();
    },
    async readBack() {
      if (outcomes.some((o) => o.status === "unconfirmed")) return undefined;
      return outcomes.map((o) => (o.status === "mismatch" ? o.read : o.value));
    },
  };
}

export const monsgeekKbDriver: KbDriver = {
  id: DRIVER_ID,
  name: "MonsGeek / Akko keyboards",
  priority: 60,
  vids: [...new Set(MONSGEEK_USB.map((u) => u.vendorId))],
  claims: (d) => claimsMonsGeek(d),
  async open(device) {
    if (!device.opened) await device.open();
    const b = new MonsGeekKbBackend(device, await MonsGeekSession.connect({ hid: asLocal(device), allowWrites: () => true }));
    return b;
  },
  async ping(device) {
    const wasOpen = device.opened;
    try {
      if (!wasOpen) await device.open();
      const s = await MonsGeekSession.connect({ hid: asLocal(device), allowWrites: () => false });
      return !!s.identity;
    } catch {
      return false;
    } finally {
      if (!wasOpen && device.opened) await device.close().catch(() => undefined);
    }
  },
};

export class MonsGeekKbBackend implements KbBackend {
  readonly driver = DRIVER_ID;
  readonly blocked: readonly BlockedCommand[] = MONSGEEK_GUARD.blocked.map((b) => ({ what: b.what, why: b.why }));
  readonly #device: KbHidLike;
  readonly #s: MonsGeekSession;
  #state: KbState;

  constructor(device: KbHidLike, session: MonsGeekSession) {
    this.#device = device;
    this.#s = session;
    this.#state = this.#build();
  }

  get state(): KbState {
    return this.#state;
  }

  get support(): KbSupport {
    const t = this.#s.tier;
    const why = this.#s.tierWhy || "Built from MonsGeek's web driver and open-source work; not yet tried on this board with SYNQ.";
    return { tier: t === "community" || t === "verified" ? "driver-tested" : "read-only", why };
  }

  async load(): Promise<KbState> {
    await this.#s.readAll();
    this.#state = this.#build();
    return this.#state;
  }

  snapshot(): unknown {
    const st = this.#s.state;
    return { identity: this.#s.identity, model: this.#s.model?.name ?? null, unitMm: this.#s.unitMm, tables: Object.fromEntries([...st.tables].map(([k, v]) => [k, v.value ? Array.from(v.value) : null])), keymap: st.keymap.map((l) => (l.value ? Array.from(l.value) : null)), profile: st.profile.value, pollingHz: st.pollingHz.value };
  }

  async close(): Promise<void> {
    if (this.#device.opened) await this.#device.close().catch(() => undefined);
  }

  #keys(): KeyIndex[] {
    return keyPositions(this.#s.model) ?? [];
  }

  #build(): KbState {
    const s = this.#s;
    const caps = s.caps;
    const a = caps.analog;
    const writes = s.canWrite().ok;
    const keys = this.#keys();
    const perKey: Record<KeyIndex, AnalogValues> = {};
    for (const k of keys) {
      const ks = s.keySettings(k);
      perKey[k] = { actuationMm: ks.actuationMm, releaseMm: ks.releaseMm, rapidTrigger: ks.rapidTrigger, rtPressMm: ks.rtPressMm, rtReleaseMm: ks.rtReleaseMm, deadBottomMm: ks.deadzoneMm };
    }
    const layout: KbLayout = { source: "matrix", width: 16, height: Math.max(1, Math.ceil(128 / 16)), keys: keys.map((k) => ({ index: k, x: k % 16, y: Math.floor(k / 16), w: 1, h: 1 })), note: "By key position (this board sends no geometry)" };
    const pairs: { keys: readonly [KeyIndex, KeyIndex]; mode: "last" }[] = [];
    for (const k of keys) {
      const p = s.keySettings(k).snapPartner;
      if (p !== null && k < p) pairs.push({ keys: [k, p], mode: "last" });
    }
    const advanced: AdvancedState | undefined = a?.socd ? { socd: { modes: ["last"], pairs, maxPairs: a.socd.maxPairs }, writable: writes ? ["socd"] : [], note: "Snap tap pairs: the last key pressed wins." } : undefined;
    const id = s.identity as { firmware?: number } | null;
    return {
      info: {
        brand: s.model?.brand ?? "MonsGeek",
        model: s.model?.name ?? (this.#device.productName || "Keyboard"),
        driver: DRIVER_ID,
        protocol: s.family === "yc500" ? "YC3121" : "RY5088",
        firmware: id?.firmware !== undefined ? [`Firmware 0x${id.firmware.toString(16)}`] : [],
        connection: "USB",
        extra: [["Travel unit", `${s.unitMm} mm${s.unitsOk ? "" : " (unconfirmed)"}`]],
      },
      analog: keys.length && a
        ? {
            scope: "per-key",
            keys,
            layout,
            fields: { actuationMm: spec(a.actuation), releaseMm: spec(a.release), rapidTrigger: "toggle", rtPressMm: spec(a.rapidTrigger?.press), rtReleaseMm: spec(a.rapidTrigger?.release), deadBottomMm: spec(a.deadzones?.bottom) } as AnalogState["fields"],
            writable: writes && s.unitsOk ? ["actuationMm", "releaseMm", "rapidTrigger", "rtPressMm", "rtReleaseMm", "deadBottomMm"] : [],
            global: null,
            perKey,
            source: "device",
            note: s.unitsOk ? undefined : s.unitsWhy,
          }
        : undefined,
      polling: caps.polling ? { hz: s.state.pollingHz.value, options: [...caps.polling].sort((x, y) => x - y), writable: writes } : undefined,
      profiles: caps.profiles ? { active: s.state.profile.value, count: caps.profiles, names: [], writable: writes } : undefined,
      advanced,
      keymap: undefined,
      notes: [...(writes ? [] : [`Changes aren't sent to this board: ${s.canWrite().why}`]), ...(layout.keys.length ? [] : ["This model's key positions aren't known, so its keys can't be drawn."])],
    };
  }

  #refresh = () => {
    this.#state = this.#build();
  };

  plan(change: KbChange): KbPlan {
    const s = this.#s;
    if (change.kind === "analog") {
      const keys = change.target === "global" ? this.#keys() : [...change.target];
      const v = change.values;
      const steps: (() => Promise<WriteOutcome>)[] = [];
      if (typeof v.actuationMm === "number") steps.push(() => s.setActuation(keys, v.actuationMm!));
      if (typeof v.releaseMm === "number") steps.push(() => s.setRelease(keys, v.releaseMm!));
      if (typeof v.deadBottomMm === "number") steps.push(() => s.setDeadzone(keys, v.deadBottomMm!));
      if (typeof v.rapidTrigger === "boolean" || typeof v.rtPressMm === "number" || typeof v.rtReleaseMm === "number") {
        const enabled = typeof v.rapidTrigger === "boolean" ? v.rapidTrigger : s.keySettings(keys[0]).rapidTrigger;
        steps.push(() => s.setRapidTrigger(keys, { enabled, pressMm: v.rtPressMm ?? undefined, releaseMm: v.rtReleaseMm ?? undefined }));
      }
      if (!steps.length) throw new Error("Nothing to change.");
      return outcomesPlan(`Analog settings on ${keys.length === 1 ? "1 key" : `${keys.length} keys`}`, "saved", async () => {
        const out: WriteOutcome[] = [];
        for (const step of steps) out.push(await step());
        return out;
      }, this.#refresh);
    }
    if (change.kind === "polling") return outcomesPlan(`Polling rate ${change.hz} Hz`, "saved", async () => [await s.setPolling(change.hz)], this.#refresh);
    if (change.kind === "profile") return outcomesPlan(`Profile ${change.index + 1}`, "saved", async () => [await s.setProfile(change.index)], this.#refresh);
    throw new Error("This keyboard's driver can't change that here.");
  }

  planAdvanced(change: KbAdvancedChange): KbPlan {
    const s = this.#s;
    if (change.kind === "socd") {
      if (change.mode !== "last") throw new Error("This keyboard's pairs are snap tap only (last input wins).");
      return outcomesPlan("Snap tap pair", "saved", async () => [await s.setSnapTap(change.keys[0], change.keys[1])], this.#refresh);
    }
    if (change.kind === "advancedClear") {
      return outcomesPlan("Snap tap cleared", "saved", async () => {
        const out: WriteOutcome[] = [];
        for (const k of change.keys) out.push(await s.clearSnapTap(k));
        return out;
      }, this.#refresh);
    }
    throw new Error("DKS and mod-tap aren't offered for this keyboard yet.");
  }
}
