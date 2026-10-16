// Simulated controllers for the browser preview, the end-to-end build and the tests: a DualSense (USB), a DualSense
// Edge, a Switch Pro Controller (Bluetooth), GameSir's HID pads (Cyclone 2, G7 Pro 8K, Tarantula Pro 8K), a read-only
// HID pad, and an XInput pad (the developer's GameSir G7 SE). They speak the real
// reports through the same code the tester uses (link.ts, parse.ts), so every panel runs its real path. Every report
// SYNQ sends one is checked by guard.ts first and refused exactly as the bridge would. No hardware, no Tauri.
import { checkPadFeatureGet, checkPadFeatureSet, checkPadOutput } from "./guard.ts";
import { EDGE_DELETE, EDGE_PART, EDGE_SLOTS, edgeWriteFrames, parseEdgeProfile } from "./edge.ts";
import { SWITCH } from "./frames.ts";
import { EBD_CMD, EBD_CONFIG_SIZE, EBD_IN, EBD_OUT, EBD_SAVE_SUB, ebdSampleConfig } from "./eightbitdo.ts";
import { flydigiSampleConfig } from "./flydigi.ts";
import { CMD, GAMESIR_ANSWER, GAMESIR_LEN, GAMESIR_MAPS, GAMESIR_OUT, GAMESIR_STATE, LIGHT_BANK, type GamesirModel } from "./gamesir.ts";
import type { PadGuard } from "./types.ts";
import type { XInputBackend } from "./link.ts";
import type { XInputReading } from "./parse.ts";

export interface SimPad {
  readonly device: HIDDevice;
  /** Every report SYNQ sent it, in order: [report id, bytes]. */
  readonly sent: [number, Uint8Array][];
  /** Every feature report read. */
  readonly reads: number[];
  stop(): void;
}

type Listener = (e: HIDInputReportEvent) => void;

interface SimSpec {
  vendorId: number;
  productId: number;
  productName: string;
  guard: PadGuard;
  outputReports: number[];
  /** Input report period (ms) and the report to send at time t (ms). */
  periodMs: number;
  report(t: number, n: number): { id: number; data: Uint8Array } | null;
  feature?(id: number): Uint8Array | null;
  /** A feature SET the guard let through (the Edge's profile parts and deletes). */
  setFeature?(id: number, data: Uint8Array): void;
  /** Answers to what it was sent (Switch replies); `usagePage` tags the collection, as the bridge does. */
  answer?(id: number, data: Uint8Array, reply: (id: number, data: Uint8Array, usagePage?: number) => void): void;
  /** Its top-level collections (default: one gamepad or joystick collection with the output reports). */
  collections?: HIDCollectionInfo[];
}

/** A stick path: a slow circle with the slightly square gate of a real pad, plus a little noise. */
function circle(t: number, period: number, r = 0.97): [number, number] {
  const a = (t / period) * 2 * Math.PI;
  const squareness = 1 + 0.04 * Math.abs(Math.sin(2 * a));
  return [Math.cos(a) * r * Math.min(1.02, squareness), Math.sin(a) * r * Math.min(1.02, squareness)];
}
const to8 = (v: number) => Math.max(0, Math.min(255, Math.round(128 + v * 127)));

function simulate(spec: SimSpec): SimPad {
  const listeners = new Set<Listener>();
  const sent: [number, Uint8Array][] = [];
  const reads: number[] = [];
  let timer: ReturnType<typeof setInterval> | null = null;
  let n = 0;
  const t0 = typeof performance !== "undefined" ? performance.now() : Date.now();
  const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now()) - t0;
  const deliver = (id: number, data: Uint8Array, usagePage?: number) => {
    const event = { reportId: id, data: new DataView(data.buffer, data.byteOffset, data.byteLength), timeStamp: now(), device, usagePage } as unknown as HIDInputReportEvent;
    for (const l of [...listeners]) l(event);
  };
  const device = {
    vendorId: spec.vendorId,
    productId: spec.productId,
    productName: spec.productName,
    opened: false,
    collections: spec.collections ?? [{ usagePage: 0x0001, usage: spec.guard === "switch" ? 0x0004 : 0x0005, type: 1, children: [], inputReports: [], outputReports: spec.outputReports.map((reportId) => ({ reportId, items: [] })), featureReports: [] }],
    async open() {
      device.opened = true;
      if (timer) return;
      timer = setInterval(() => {
        const r = spec.report(now(), n++);
        if (r) deliver(r.id, r.data);
      }, spec.periodMs);
    },
    async close() {
      device.opened = false;
      if (timer) clearInterval(timer);
      timer = null;
    },
    async forget() {},
    async sendReport(reportId: number, data: BufferSource) {
      const bytes = data instanceof ArrayBuffer ? new Uint8Array(data).slice() : new Uint8Array((data as ArrayBufferView).buffer, (data as ArrayBufferView).byteOffset, (data as ArrayBufferView).byteLength).slice();
      const v = checkPadOutput(spec.guard, reportId, bytes);
      if (!v.ok) throw new Error(`Refused: ${v.why}`);
      sent.push([reportId, bytes]);
      spec.answer?.(reportId, bytes, (id, d, page) => setTimeout(() => deliver(id, d, page), 2));
    },
    async sendFeatureReport(reportId: number, data: BufferSource) {
      const bytes = data instanceof ArrayBuffer ? new Uint8Array(data).slice() : new Uint8Array((data as ArrayBufferView).buffer, (data as ArrayBufferView).byteOffset, (data as ArrayBufferView).byteLength).slice();
      const v = checkPadFeatureSet(spec.guard, reportId, bytes);
      if (!v.ok) throw new Error(`Refused: ${v.why}`);
      sent.push([reportId, bytes]);
      spec.setFeature?.(reportId, bytes);
    },
    async receiveFeatureReport(reportId: number) {
      const v = checkPadFeatureGet(spec.guard, reportId);
      if (!v.ok) throw new Error(`Refused: ${v.why}`);
      reads.push(reportId);
      const b = spec.feature?.(reportId);
      if (!b) throw new Error("No such report.");
      return new DataView(b.buffer, b.byteOffset, b.byteLength);
    },
    addEventListener(type: string, l: Listener) {
      if (type === "inputreport") listeners.add(l);
    },
    removeEventListener(type: string, l: Listener) {
      if (type === "inputreport") listeners.delete(l);
    },
    dispatchEvent() {
      return true;
    },
    oninputreport: null,
  };
  return {
    device: device as unknown as HIDDevice,
    sent,
    reads,
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}

/** A DualSense on USB: 250 Hz reports, the left stick circling, triggers ramping, buttons taking turns. */
export function simulateDualSense(): SimPad {
  return simulate({
    vendorId: 0x054c,
    productId: 0x0ce6,
    productName: "DualSense Wireless Controller",
    guard: "ds5",
    outputReports: [0x02],
    periodMs: 4,
    report(t, n) {
      const d = new Uint8Array(63);
      const [lx, ly] = circle(t, 2400);
      d[0] = to8(lx);
      d[1] = to8(ly);
      // The right stick rests a little off centre (drift to find).
      d[2] = 131;
      d[3] = 126 + (n % 7 === 0 ? 1 : 0);
      const ramp = (Math.sin(t / 500) + 1) / 2;
      d[4] = Math.round(ramp * 255);
      d[5] = Math.round((1 - ramp) * 255);
      d[6] = n & 0xff;
      const slot = Math.floor(t / 600) % 8;
      d[7] = 0x08 | (0x10 << (slot % 4)); // hat centred, one face button
      d[8] = slot >= 4 ? 1 << (slot - 4) : 0;
      // Gyro and accel near rest.
      const v = new DataView(d.buffer);
      v.setInt16(15, Math.round(Math.sin(t / 90) * 6), true);
      v.setInt16(17, -3, true);
      v.setInt16(19, 2, true);
      v.setInt16(25, 8192, true);
      d[52] = 0x07; // discharging, 75 %
      return { id: 0x01, data: d };
    },
    feature(id) {
      if (id === 0x20) {
        const b = new Uint8Array(64);
        b[0] = 0x20;
        b.set(Array.from("Sep 21 2026", (c) => c.charCodeAt(0)), 1);
        b.set(Array.from("10:31:07", (c) => c.charCodeAt(0)), 12);
        new DataView(b.buffer).setUint32(24, 0x00000617, true);
        new DataView(b.buffer).setUint32(28, 0x0110002a, true);
        return b;
      }
      if (id === 0x05) {
        const b = new Uint8Array(41);
        b[0] = 0x05;
        return b;
      }
      return null;
    },
  });
}

/** The DualSense report the DualSense sim sends, for the Edge sim too. */
function dualSenseReport(t: number, n: number): { id: number; data: Uint8Array } {
  const d = new Uint8Array(63);
  const [lx, ly] = circle(t, 2400);
  d[0] = to8(lx);
  d[1] = to8(ly);
  d[2] = 131;
  d[3] = 126 + (n % 7 === 0 ? 1 : 0);
  const ramp = (Math.sin(t / 500) + 1) / 2;
  d[4] = Math.round(ramp * 255);
  d[5] = Math.round((1 - ramp) * 255);
  d[6] = n & 0xff;
  d[7] = 0x08;
  d[52] = 0x07;
  return { id: 0x01, data: d };
}

export interface EdgeSim extends SimPad {
  /** The four slots' parts as stored (report id = the write id, as last written). */
  readonly slots: Uint8Array[][];
}

/**
 * A DualSense Edge on USB with its four profile slots: the default (Triangle), "FPS" on Square, and two empty ones.
 * Reads give each slot's three parts; the guard-checked writes (0x60-0x62, three parts) and deletes (0x68) change them.
 */
export function simulateDualSenseEdge(): EdgeSim {
  const empty = (slot: number) =>
    [0, 1, 2].map((part) => {
      const b = new Uint8Array(EDGE_PART);
      b[0] = EDGE_SLOTS[slot].read + part;
      if (part === 0) b[1] = 16;
      return b;
    });
  const seeded = () => {
    let x = 7;
    return () => ((x = (x * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  };
  const build = (slot: number, label: string, preset: number, step: number) => {
    const blank = parseEdgeProfile({ ...EDGE_SLOTS[slot], protected: false }, empty(slot));
    const frames = edgeWriteFrames(blank, { label, sticks: [{ preset, step }, { preset, step }], triggers: [{ min: 0, max: 255 }, { min: 20, max: 200 }], buttons: blank.buttons }, Array.from({ length: 16 }, seeded()).map((v) => Math.floor(v * 256)));
    return frames.map((f) => Uint8Array.from([EDGE_SLOTS[slot].read, ...f.data]));
  };
  const slots: Uint8Array[][] = [build(0, "Default", 0, 0), build(1, "FPS", 1, 4), empty(2), empty(3)];
  const pending = new Map<number, Uint8Array[]>();
  const base = simulate({
    vendorId: 0x054c,
    productId: 0x0df2,
    productName: "DualSense Edge Wireless Controller",
    guard: "edge",
    outputReports: [0x02],
    periodMs: 4,
    report: dualSenseReport,
    feature(id) {
      if (id >= 0x70 && id <= 0x7b) {
        const slot = Math.floor((id - 0x70) / 3);
        const part = slots[slot][(id - 0x70) % 3].slice();
        part[0] = id;
        return part;
      }
      if (id === 0x20) {
        const b = new Uint8Array(64);
        b[0] = 0x20;
        b.set(Array.from("Aug 02 2026", (c) => c.charCodeAt(0)), 1);
        b.set(Array.from("08:12:44", (c) => c.charCodeAt(0)), 12);
        return b;
      }
      if (id === 0x05) {
        const b = new Uint8Array(41);
        b[0] = 0x05;
        return b;
      }
      return null;
    },
    setFeature(id, data) {
      if (id === EDGE_DELETE) {
        slots[data[0] - 1] = empty(data[0] - 1);
        return;
      }
      const slot = EDGE_SLOTS.findIndex((s) => s.write === id);
      const parts = pending.get(slot) ?? [];
      parts[data[0]] = Uint8Array.from([id, ...data]);
      pending.set(slot, parts);
      if (parts.filter(Boolean).length === 3) {
        slots[slot] = parts.map((p, i) => {
          const c = p.slice();
          c[0] = EDGE_SLOTS[slot].read + i;
          return c;
        });
        pending.delete(slot);
      }
    },
  });
  return { ...base, slots };
}

/** A Switch Pro Controller over Bluetooth: simple 0x3F reports until asked for 0x30, then 0x30 at 60 Hz with IMU. */
export function simulateSwitchPro(): SimPad {
  let mode = 0x3f;
  let timer = 0;
  return simulate({
    vendorId: 0x057e,
    productId: 0x2009,
    productName: "Pro Controller",
    guard: "switch",
    outputReports: [0x01, 0x10],
    periodMs: 15,
    report(t) {
      const [lx, ly] = circle(t, 3000, 0.95);
      if (mode === 0x3f) {
        const d = new Uint8Array(11);
        const v = new DataView(d.buffer);
        d[2] = 8;
        v.setUint16(3, 0x8000 + Math.round(lx * 0x7fff), true);
        v.setUint16(5, 0x8000 - Math.round(ly * 0x7fff), true);
        v.setUint16(7, 0x8000, true);
        v.setUint16(9, 0x8000, true);
        return { id: 0x3f, data: d };
      }
      const d = new Uint8Array(48);
      d[0] = timer++ & 0xff;
      d[1] = 0x90; // battery full-ish (level 4)
      const x = Math.round(2048 + lx * 1400);
      const y = Math.round(2048 - ly * 1400);
      d[5] = x & 0xff;
      d[6] = ((x >> 8) & 0x0f) | ((y & 0x0f) << 4);
      d[7] = y >> 4;
      d[8] = 0x00;
      d[9] = 0x08;
      d[10] = 0x80;
      const v = new DataView(d.buffer);
      v.setInt16(12, 4096, true);
      v.setInt16(18, Math.round(Math.sin(t / 120) * 20), true);
      return { id: 0x30, data: d };
    },
    answer(id, data, reply) {
      if (id !== SWITCH.SUBCOMMAND) return;
      const sub = data[9];
      const r = new Uint8Array(48);
      r[12] = 0x80;
      r[13] = sub;
      if (sub === 0x03) mode = data[10];
      if (sub === 0x02) r.set([0x04, 0x33, 0x03, 0x02, 0xde, 0xad, 0xbe, 0xef, 0x00, 0x01, 0x01, 0x01], 14);
      if (sub === 0x10) {
        r.set(data.subarray(10, 15), 14);
        // Factory stick calibration: centre 2048, 1400 each way.
        // Left: above-centre, centre, below-centre; right: centre, below, above (12-bit pairs packed in 3 bytes).
        const cal = [0x78, 0x85, 0x57, 0x00, 0x08, 0x80, 0x78, 0x85, 0x57, 0x00, 0x08, 0x80, 0x78, 0x85, 0x57, 0x78, 0x85, 0x57];
        r.set(cal.slice(0, data[14]), 19);
      }
      reply(0x21, r);
    },
  });
}

/** A pad SYNQ only reads (no parser for its layout): raw reports at 125 Hz, a counter in the first byte. */
export interface GamesirSim extends SimPad {
  /** Bank images as the pad keeps them: 1-4 and 0x20. */
  readonly banks: Map<number, Uint8Array>;
  /** The active profile, and the motors (0-100 each) as last set. */
  readonly state: { active: number; motors: [number, number]; dropped: number; busyOnce: boolean };
}

/**
 * A GameSir pad on its vendor collection (page 0xFFF0): output report 0x0F commands, answers on 0x10, the state on 0x12
 * at 250 Hz, zeros unless the host's keep-alive arrived within the last second (as a real pad that is asleep). Four
 * profile banks with the family's defaults (profile 2 has A and B swapped, profile 3 one paddle on a keyboard key, as
 * GameSir's own app can set), a lighting bank, writes accepted into the active profile only, the first write after a
 * profile switch answered busy once, and a command closer than 8 ms to the last one dropped, as the real pads do.
 */
export function simulateGamesir(model: GamesirModel, productId: number): GamesirSim {
  const m = GAMESIR_MAPS[model];
  const wide = m.wideDeadzones;
  const dz = (values: number[]) => (wide ? values.flatMap((v) => [(v * 10) >> 8, (v * 10) & 0xff]) : values);
  const profile = (n: number) => {
    const b = new Uint8Array(m.profileSize);
    if (m.vibration) b.set([75, 75], 0x20);
    b[0x2e] = 2;
    b.set(dz([5, 95, 0, 100]), m.trigger.dzMin);
    b.set(dz([5, 95, 0, 100]), m.trigger.dzMin + m.trigger.rtOffset);
    b.set(dz([10, 100, 0, 100]), m.stick.dzMin);
    b.set(dz([10, 100, 0, 100]), m.stick.dzMin + m.stick.rsOffset);
    const linear = [0x00, 0x64, 0x00, 0x00, 0x28, 0x29, 0x80, 0x80, 0xd7, 0xd6];
    if (m.stick.curve !== null) for (const at of [m.stick.curve, m.stick.curve + m.stick.rsOffset]) b.set(linear, at);
    if (m.trigger.curve !== null) for (const at of [m.trigger.curve, m.trigger.curve + m.trigger.rtOffset]) b.set(linear, at);
    const at = (name: string) => m.remaps.find((r) => r.name === name)!.at;
    if (n === 2) {
      b.set([1, 0x0a], at("A"));
      b.set([1, 0x09], at("B"));
    }
    if (n === 3) b.set([1, 0x5c], at("L4")); // a keyboard key (A): set in GameSir's app, kept by SYNQ
    return b;
  };
  const banks = new Map<number, Uint8Array>([1, 2, 3, 4].map((n) => [n, profile(n)]));
  if (m.lightSize) {
    const light = new Uint8Array(m.lightSize);
    if (m.light?.kind === "mode") light.set([0x04, 75]);
    banks.set(LIGHT_BANK, light);
  }
  const state = { active: 1, motors: [0, 0] as [number, number], dropped: 0, busyOnce: false };
  let lastBeat = -Infinity;
  let lastCmd = -Infinity;
  const clock = () => (typeof performance !== "undefined" ? performance.now() : Date.now());
  const answer = (...bytes: number[]) => {
    const d = new Uint8Array(GAMESIR_LEN);
    d.set(bytes);
    return d;
  };
  const ascii = (s: string) => Array.from(s, (c) => c.charCodeAt(0));
  const base = simulate({
    vendorId: 0x3537,
    productId,
    productName: m.name,
    guard: `gamesir-${model}` as PadGuard,
    outputReports: [GAMESIR_OUT],
    periodMs: 4,
    collections: [
      {
        usagePage: 0xfff0,
        usage: 0x0001,
        type: 1,
        children: [],
        inputReports: [{ reportId: GAMESIR_ANSWER, items: [] }, { reportId: GAMESIR_STATE, items: [] }],
        outputReports: [{ reportId: GAMESIR_OUT, items: [] }],
        featureReports: [],
      } as unknown as HIDCollectionInfo,
    ],
    report(t, n) {
      const d = new Uint8Array(GAMESIR_LEN);
      if (clock() - lastBeat > 1000) return { id: GAMESIR_STATE, data: d };
      const [lx, ly] = circle(t, 2400);
      const ramp = (Math.sin(t / 500) + 1) / 2;
      const slot = Math.floor(t / 600) % 8;
      const block = [0, to8(lx), to8(ly), 129, 127 + (n % 9 === 0 ? 1 : 0), 0x0f | (slot < 4 ? 0x10 << slot : 0), slot >= 4 ? 1 << (slot - 4) : 0, 0, Math.round(ramp * 255), Math.round((1 - ramp) * 255)];
      d.set(block, 0);
      d.set(block, 52);
      d[34] = 0;
      d[35] = 80;
      return { id: GAMESIR_STATE, data: d };
    },
    answer(id, data, reply) {
      if (id !== GAMESIR_OUT) return;
      const t = clock();
      const close = t - lastCmd < 8;
      lastCmd = t;
      if (close) {
        state.dropped++;
        return;
      }
      const [cmd, a1, a2, a3, a4] = data;
      if (cmd === CMD.heartbeat) {
        lastBeat = t;
        return;
      }
      if (t - lastBeat > 1000) return; // asleep: no answers
      const addr = (a2 << 8) | a3;
      switch (cmd) {
        case CMD.firmware:
          reply(GAMESIR_ANSWER, answer(CMD.firmwareAck, 0, 0, ...ascii("356"), 0, 0, 0, 0, 0, ...ascii("120")));
          return;
        case CMD.active:
          reply(GAMESIR_ANSWER, answer(CMD.activeAck, state.active === 1 ? 0 : state.active));
          return;
        case CMD.switchProfile:
          state.active = a1;
          state.busyOnce = true;
          reply(GAMESIR_ANSWER, answer(CMD.ack, 0));
          return;
        case CMD.rumble:
          state.motors = [a3, a4];
          return;
        case CMD.read: {
          const bank = banks.get(a1);
          if (!bank) return;
          reply(GAMESIR_ANSWER, answer(CMD.readAck, a1, a2, a3, a4, ...bank.subarray(addr, addr + a4)));
          return;
        }
        case CMD.write: {
          if (state.busyOnce) {
            state.busyOnce = false;
            reply(GAMESIR_ANSWER, answer(CMD.ack, 1));
            return;
          }
          const bank = banks.get(a1);
          // Profile writes land only in the active profile; the lighting bank is global.
          if (bank && (a1 === LIGHT_BANK || a1 === state.active)) bank.set(data.subarray(5, 5 + a4), addr);
          reply(GAMESIR_ANSWER, answer(CMD.ack, 0));
          return;
        }
      }
    },
  });
  return { ...base, banks, state };
}

/**
 * A SCUF Envision Pro receiver (2E95:434E) with its pad at BRAGI address 1, or the pad on its cable: a gamepad
 * collection that streams (layout not parsed) and the BRAGI channel answering GETs (firmware, the connected-pad
 * bitmap, vid / pid, battery). Answers come tagged with their collection, as the bridge delivers them.
 */
export function simulateScuf(vendorId: number, productId: number, productName: string, receiver: boolean): SimPad {
  const u32 = (v: number) => [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff];
  const props = (addr: number): Record<number, number[]> =>
    addr === 0 && receiver
      ? { 0x13: [5, 31, 101, 0], 0x36: u32(0b10), 0x11: u32(vendorId), 0x12: u32(productId) }
      : { 0x13: [2, 4, 17, 0], 0x11: u32(vendorId), 0x12: u32(receiver ? 0x434c : productId), 0x0f: u32(870), 0x10: u32(2) };
  return simulate({
    vendorId,
    productId,
    productName,
    guard: "scuf",
    outputReports: [0],
    periodMs: 4,
    collections: [
      { usagePage: 0x0001, usage: 0x0005, type: 1, children: [], inputReports: [{ reportId: 0x01, items: [] }], outputReports: [], featureReports: [] },
      { usagePage: 0xff42, usage: 0x0001, type: 1, children: [], inputReports: [{ reportId: 0, items: [] }], outputReports: [{ reportId: 0, items: [] }], featureReports: [] },
    ] as unknown as HIDCollectionInfo[],
    report(t) {
      const d = new Uint8Array(15);
      const [x, y] = circle(t, 2000);
      d[0] = to8(x);
      d[1] = to8(y);
      return { id: 0x01, data: d };
    },
    answer(id, data, reply) {
      if (id !== 0 || data[1] !== 0x02) return;
      const addr = data[0] & 0x07;
      const prop = data[2] | (data[3] << 8);
      const value = addr === 0 || (receiver && addr === 1) ? props(addr)[prop] : undefined;
      const r = new Uint8Array(64);
      r.set([data[0], 0x02, value ? 0 : 5, ...(value ?? [])]);
      reply(0, r, 0xff42);
    },
  });
}

export interface EbdSim extends SimPad {
  /** The config as saved on the pad, and the motors as the last vibration test set them. */
  readonly state: { config: Uint8Array; motors: [number, number]; saves: number };
}

/**
 * An 8BitDo Ultimate in its HID config mode (2DC8:6007): a gamepad collection that streams (layout not parsed here)
 * and takes report 0x81. Report state, version, chunk reads and writes (staged until the save command commits them),
 * the vibration test; answers on input report 0x02 as ultimatecontroller-rs saw them.
 */
export function simulate8BitDo(productId: number): EbdSim {
  const state = { config: ebdSampleConfig(), motors: [0, 0] as [number, number], saves: 0 };
  let staged: Uint8Array | null = null;
  const le16 = (v: number) => [v & 0xff, (v >> 8) & 0xff];
  const le32 = (v: number) => [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff];
  const answer = (...bytes: number[]) => {
    const d = new Uint8Array(63);
    d.set(bytes);
    return d;
  };
  return {
    ...simulate({
      vendorId: 0x2dc8,
      productId,
      productName: "8BitDo Ultimate Wireless Controller",
      guard: "8bitdo",
      outputReports: [EBD_OUT],
      periodMs: 4,
      report(t) {
        const d = new Uint8Array(10);
        const [x, y] = circle(t, 2200);
        d[2] = to8(x);
        d[3] = to8(y);
        return { id: 0x03, data: d };
      },
      answer(id, data, reply) {
        if (id !== EBD_OUT) return;
        if (data[1] !== 0x04) {
          if (data[2] === 0x21) reply(EBD_IN, answer(0x22, 0x6d, 0x00));
          return;
        }
        const cmd = data[2] | (data[3] << 8);
        const sub = data[4] | (data[5] << 8);
        const n = data[6] | (data[7] << 8);
        const offset = (data[14] | (data[15] << 8) | (data[16] << 16) | (data[17] << 24)) >>> 0;
        if (cmd === EBD_CMD.reportState) reply(EBD_IN, answer(0x04, ...le16(EBD_CMD.readResponse), ...le16(EBD_CMD.reportState)));
        else if (cmd === EBD_CMD.read) reply(EBD_IN, answer(0x04, ...le16(EBD_CMD.readResponse), ...le16(EBD_CMD.read), ...le16(n), 0, 0, ...le32(EBD_CONFIG_SIZE), ...le32(offset), ...state.config.subarray(offset, offset + n)));
        else if (cmd === EBD_CMD.write) {
          staged ??= state.config.slice();
          staged.set(data.subarray(18, 18 + n), offset);
          reply(EBD_IN, answer(0x04, ...le16(EBD_CMD.readResponse), ...le16(EBD_CMD.write), ...le16(n), 0, 0, ...le32(EBD_CONFIG_SIZE), ...le32(offset)));
        } else if (cmd === EBD_CMD.save && sub === EBD_SAVE_SUB) {
          if (staged) state.config = staged;
          staged = null;
          state.saves++;
          reply(EBD_IN, answer(0x04, ...le16(EBD_CMD.readResponse), ...le16(EBD_CMD.save)));
        } else if (cmd === EBD_CMD.vibrate) {
          state.motors = [data[6], data[7]];
          setTimeout(() => (state.motors = [0, 0]), sub);
        }
      },
    }),
    state,
  };
}

export interface FdSim extends SimPad {
  /** Each slot as the pad runs it (RAM) and as saved to flash, the motors, the saves. */
  readonly state: { slots: Uint8Array[]; flash: Uint8Array[]; motors: [number, number]; saves: number };
}

/**
 * A Flydigi Apex 4 in D-input mode (04B4:2412, device id 84 unless given): a gamepad collection that streams and the
 * vendor collection 0xFFA0 (output report 5, input report 4) with four slots of factory-like configs. Writes land in
 * RAM; save-to-flash (the slot's random id + 1) keeps them. Answers come tagged with their collection.
 */
export function simulateFlydigi(deviceId = 84): FdSim {
  const slots = [0, 1, 2, 3].map(flydigiSampleConfig);
  const state = { slots, flash: slots.map((x) => x.slice()), motors: [0, 0] as [number, number], saves: 0 };
  let writing: { slot: number; buf: Uint8Array } | null = null;
  let idSlot = 0;
  const answer = (bytes: number[], tag?: number) => {
    const d = new Uint8Array(63);
    d.set(bytes);
    if (tag !== undefined) d[14] = tag;
    return d;
  };
  return {
    ...simulate({
      vendorId: 0x04b4,
      productId: 0x2412,
      productName: "Flydigi Apex 4",
      guard: "flydigi",
      outputReports: [0x05],
      periodMs: 4,
      collections: [
        { usagePage: 0x0001, usage: 0x0005, type: 1, children: [], inputReports: [{ reportId: 0x01, items: [] }], outputReports: [], featureReports: [] },
        { usagePage: 0xffa0, usage: 0x0001, type: 1, children: [], inputReports: [{ reportId: 0x04, items: [] }], outputReports: [{ reportId: 0x05, items: [] }], featureReports: [] },
      ] as unknown as HIDCollectionInfo[],
      report(t) {
        const d = new Uint8Array(12);
        const [x, y] = circle(t, 2600);
        d[0] = to8(x);
        d[1] = to8(y);
        return { id: 0x01, data: d };
      },
      answer(id, data, reply) {
        if (id !== 0x05) return;
        const send = (d: Uint8Array) => reply(0x04, d, 0xffa0);
        const version = (slot: number) => (state.slots[slot][225] << 8) | state.slots[slot][226];
        switch (data[0]) {
          case 0xec:
            send(answer([0, 0, deviceId, 0, 0x11, 0x22, 0x33, 0x44, 0x30, 0x68, 80, 2, 1, 1], 0xec));
            return;
          case 0xeb: {
            const s = state.slots[data[1]];
            for (let i = 0; i < 79; i++) send(answer([0, 0, i, 0, ...s.subarray(i * 10, i * 10 + 10)], 0xeb));
            return;
          }
          case 0xea:
            writing = { slot: data[3], buf: state.slots[data[3]].slice() };
            send(answer([0, 0, 0xff], 0xea));
            return;
          case 0x22: {
            if (!writing) return;
            const i = data[12];
            writing.buf.set(data.subarray(1, 1 + Math.min(10, 790 - i * 10)), i * 10);
            if (i === 78) {
              state.slots[writing.slot] = writing.buf;
              writing = null;
            }
            send(answer([0, 0, i + 1], 0xea));
            return;
          }
          case 0x50:
            if (data[1] === 0x02) {
              idSlot = data[2];
              send(answer([0, 0, 0x50, 0x02, version(idSlot) >> 8, version(idSlot) & 0xff, idSlot]));
            } else if (data[1] === 0x03) {
              const id = (data[2] << 8) | data[3];
              const ok = id === ((version(idSlot) + 1) & 0xffff);
              if (ok) {
                state.slots[idSlot].set([data[2], data[3]], 225);
                state.flash[idSlot] = state.slots[idSlot].slice();
                state.saves++;
              }
              send(answer([0, 0, 0x50, 0x03, ok ? 1 : 0]));
            }
            return;
          case 0x0f:
            state.motors = [data[1], data[2]];
            return;
        }
      },
    }),
    state,
  };
}

export function simulateReadOnlyPad(vendorId: number, productId: number, productName: string, quiet = false): SimPad {
  return simulate({
    vendorId,
    productId,
    productName,
    guard: "input",
    outputReports: [],
    periodMs: 8,
    report(t, n) {
      if (quiet) return null; // a receiver whose pad is off
      const d = new Uint8Array(16);
      d[0] = n & 0xff;
      const [x, y] = circle(t, 2000);
      d[1] = to8(x);
      d[2] = to8(y);
      return { id: 0x03, data: d };
    },
  });
}

/** The developer's GameSir G7 SE as XInput sees it: a change every millisecond while the stick circles. */
export function simulatedXInput(): XInputBackend {
  const t0 = performance.now();
  let n = 0;
  const reading = (t: number): XInputReading => {
    const [x, y] = circle(t, 2000, 0.98);
    return { t: Math.round(t * 1000), n: ++n, b: Math.floor(t / 700) % 2 ? 0x1000 : 0, lt: Math.round(((Math.sin(t / 400) + 1) / 2) * 255), rt: 0, lx: Math.round(x * 32767), ly: Math.round(-y * 32767), rx: 300, ry: -250 };
  };
  let running: ReturnType<typeof setInterval> | null = null;
  return {
    async read() {
      return reading(performance.now() - t0);
    },
    async sample(_slot, seconds, onBatch) {
      const start = performance.now();
      let last = start;
      running = setInterval(() => {
        const now = performance.now();
        const readings: XInputReading[] = [];
        // One change per millisecond since the last batch (a 1000 Hz pad).
        for (let t = last; t < now; t += 1) readings.push(reading(t - t0));
        last = now;
        const done = now - start >= seconds * 1000;
        onBatch({ readings, sampleHz: 250_000, done });
        if (done && running) clearInterval(running);
      }, 12);
      return () => running && clearInterval(running);
    },
    async stop() {
      if (running) clearInterval(running);
      running = null;
    },
  };
}
