// DrunkDeer magnetic keyboards (G65 / A75 family / G60 / G75 / X60) as a generic Keyboard panel driver
// (src/lib/kb/types.ts), on top of DrunkDeerSession and its plan-based writes. KbSession owns "Allow
// changes", the backup and the read-back verdict; DrunkDeerSession keeps its dialect, units, ranges
// and guard. Offered here: per-key actuation and rapid-trigger downstroke / upstroke. Lighting,
// Last-Win / RDT pairs, auto-match and live depth stay in DrunkDeerSession for now.
import type { AnalogValues, BlockedCommand, HidLike as KbHidLike, KbBackend, KbChange, KbDriver, KbLayout, KbPlan, KbState, KbSupport, KeyIndex, NumberSpec } from "../../kb/types.ts";
import type { HidLike, NumRange } from "../local-kb.ts";
import { DD_CHANNEL, GRID, X60_VID, deviceEntry, isOemUpgrader } from "./devices.ts";
import { BLOCKED } from "./guard.ts";
import type { KeyField } from "./protocol.ts";
import { DrunkDeerSession, type DrunkDeerPlan } from "./session.ts";

const DRIVER_ID = "drunkdeer";

/** A DrunkDeer id (not detect-only, not an upgrader), its vendor collection FF00:00, and for the X60 its name. No I/O. */
export function claimsDrunkDeer(d: { vendorId: number; productId: number; productName?: string; collections?: readonly { usagePage?: number; usage?: number }[] }): boolean {
  if (isOemUpgrader(d.vendorId, d.productId)) return false;
  const entry = deviceEntry(d.vendorId, d.productId);
  if (!entry || entry.tier === "detectOnly") return false;
  if (d.vendorId === X60_VID && !/drunk\s*deer|x60/i.test(d.productName ?? "")) return false;
  return (d.collections ?? []).some((c) => c.usagePage === DD_CHANNEL.usagePage && (c.usage ?? 0) === DD_CHANNEL.usage);
}

const asLocal = (d: KbHidLike): HidLike => d as unknown as HidLike;
const spec = (r: NumRange | undefined): NumberSpec | undefined => (r ? { min: r.min, max: r.max, step: r.step ?? 0.1, unit: "mm", decimals: 2 } : undefined);
const FIELD: Partial<Record<keyof AnalogValues, KeyField>> = { actuationMm: "actuation", rtPressMm: "downstroke", rtReleaseMm: "upstroke" };

export const drunkdeerKbDriver: KbDriver = {
  id: DRIVER_ID,
  name: "DrunkDeer keyboards",
  priority: 60,
  vids: [0x352d, X60_VID],
  claims: (d) => claimsDrunkDeer(d),
  async open(device) {
    if (!device.opened) await device.open();
    return new DrunkDeerKbBackend(device, await DrunkDeerSession.connect(asLocal(device), { allowWrites: () => true }));
  },
  async ping(device) {
    const wasOpen = device.opened;
    try {
      if (!wasOpen) await device.open();
      const s = await DrunkDeerSession.connect(asLocal(device));
      await s.close().catch(() => undefined);
      return true;
    } catch {
      return false;
    } finally {
      if (!wasOpen && device.opened) await device.close().catch(() => undefined);
    }
  },
};

export class DrunkDeerKbBackend implements KbBackend {
  readonly driver = DRIVER_ID;
  readonly blocked: readonly BlockedCommand[] = BLOCKED.map((b) => ({ what: b.what, why: b.why }));
  readonly #device: KbHidLike;
  readonly #s: DrunkDeerSession;
  #state: KbState;

  constructor(device: KbHidLike, session: DrunkDeerSession) {
    this.#device = device;
    this.#s = session;
    this.#state = this.#build();
  }

  get state(): KbState {
    return this.#state;
  }

  get support(): KbSupport {
    const t = this.#s.tier;
    return { tier: t === "community" || t === "verified" ? "driver-tested" : "read-only", why: "Built from DrunkDeer's web driver and open-source tools; not yet tried with SYNQ on this keyboard." };
  }

  async load(): Promise<KbState> {
    await this.#s.refresh();
    this.#state = this.#build();
    return this.#state;
  }

  snapshot(): unknown {
    const st = this.#s.state;
    return { identity: st.identity, model: st.model?.name ?? null, common: st.common.value, keyPoints: Object.fromEntries(Object.entries(st.keyPoints).map(([k, v]) => [k, v.value])), lighting: st.lighting.value };
  }

  async close(): Promise<void> {
    await this.#s.close().catch(() => undefined);
    if (this.#device.opened) await this.#device.close().catch(() => undefined);
  }

  #build(): KbState {
    const s = this.#s;
    const st = s.state;
    const f = s.features;
    const pts = st.keyPoints;
    const slots = (pts.actuation.value ?? pts.downstroke.value ?? []).map((_, i) => i);
    const perKey: Record<KeyIndex, AnalogValues> = {};
    for (const i of slots) perKey[i] = { actuationMm: pts.actuation.value?.[i] ?? null, rtPressMm: pts.downstroke.value?.[i] ?? null, rtReleaseMm: pts.upstroke.value?.[i] ?? null };
    const layout: KbLayout = { source: "matrix", width: GRID.cols, height: GRID.rows, keys: slots.map((i) => ({ index: i, x: i % GRID.cols, y: Math.floor(i / GRID.cols), w: 1, h: 1 })), note: "By key slot (6 × 21 grid)" };
    const writes = !!f && (s.tier === "experimental" || s.tier === "community" || s.tier === "verified");
    return {
      info: { brand: "DrunkDeer", model: st.model?.name ?? (this.#device.productName || "Keyboard"), driver: DRIVER_ID, protocol: f ? `${f.dialect} dialect` : undefined, firmware: [st.identity.firmwareText], connection: "USB" },
      analog: f && slots.length
        ? {
            scope: "per-key",
            keys: slots,
            layout,
            fields: { actuationMm: spec(f.units.actuation), rtPressMm: spec(f.units.downstroke), rtReleaseMm: spec(f.units.upstroke) },
            writable: writes ? ["actuationMm", "rtPressMm", "rtReleaseMm"] : [],
            global: null,
            perKey,
            source: pts.actuation.source === "device" ? "device" : "cache",
            note: pts.actuation.source === "device" ? undefined : "This firmware can't report per-key values; what's shown is SYNQ's last write.",
          }
        : undefined,
      keymap: undefined,
      notes: [...st.notes, ...(slots.length ? [] : ["This keyboard's per-key values couldn't be read."])],
    };
  }

  plan(change: KbChange): KbPlan {
    if (change.kind !== "analog") throw new Error("This keyboard's driver can't change that here.");
    const s = this.#s;
    const keys = change.target === "global" ? Object.keys(this.#state.analog?.perKey ?? {}).map(Number) : [...change.target];
    const plans: DrunkDeerPlan<number[]>[] = [];
    for (const [field, wire] of Object.entries(FIELD) as [keyof AnalogValues, KeyField][]) {
      const mm = change.values[field];
      if (typeof mm !== "number") continue;
      plans.push(s.planKeyPoints(wire, Object.fromEntries(keys.map((k) => [k, mm]))));
    }
    if (!plans.length) throw new Error("Nothing to change.");
    return {
      label: `Analog settings on ${keys.length === 1 ? "1 key" : `${keys.length} keys`}`,
      expected: plans.map((p) => p.expected),
      persistence: plans[0].persistence,
      send: async () => {
        for (const p of plans) await p.send();
      },
      readBack: async () => {
        const got: number[][] = [];
        for (const p of plans) {
          const r = await p.readBack();
          if (r.value === undefined) return undefined;
          got.push(r.value);
        }
        this.#state = this.#build();
        return got;
      },
    };
  }
}
