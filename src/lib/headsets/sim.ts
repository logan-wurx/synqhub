// A simulated headset of any family in src/lib/headsets/headsets.json, answering SYNQ's reads the way
// HeadsetControl's code expects and keeping the settings it is sent. The preview's headset and the tests use it.
// Every report is checked against the allowlist again (a tripwire): a frame the guard refuses is recorded and
// fails the session's send.
import { checkHeadsetFrame } from "./guard.ts";
import { CHANNELS, type Model, type SettingId } from "./protocol.ts";
import type { HidLike } from "./session.ts";

type Listener = (e: { reportId: number; data: DataView }) => void;

export interface SimHeadset extends HidLike {
  readonly sent: { reportId: number; data: Uint8Array }[];
  readonly forbidden: Uint8Array[];
  /** What the headset holds now (as its firmware would). */
  readonly held: Partial<Record<SettingId, number>>;
  battery: number;
  charging: boolean;
  connected: boolean;
  chat: number;
  game: number;
}

export function simulateHeadset(model: Model): SimHeadset {
  const listeners = new Set<Listener>();
  const length = CHANNELS[model.family].length - 1;
  const reply = (reportId: number, bytes: number[]) => {
    const d = new Uint8Array(length);
    d.set(bytes);
    setTimeout(() => {
      for (const l of [...listeners]) l({ reportId, data: new DataView(d.buffer) });
    }, 2);
  };
  const sim: SimHeadset = {
    opened: false,
    sent: [],
    forbidden: [],
    held: {},
    battery: 72,
    charging: false,
    connected: true,
    chat: 100,
    game: 60,
    async open() {
      (sim as { opened: boolean }).opened = true;
    },
    async close() {
      (sim as { opened: boolean }).opened = false;
    },
    addEventListener(_t, l) {
      listeners.add(l);
    },
    removeEventListener(_t, l) {
      listeners.delete(l);
    },
    async sendReport(reportId, data) {
      const d = new Uint8Array(data instanceof ArrayBuffer ? data : (data as ArrayBufferView).buffer);
      sim.sent.push({ reportId, data: d });
      const v = checkHeadsetFrame(model, { reportId, data: d });
      if (!v.ok) {
        sim.forbidden.push(d);
        throw new Error("BLOCKED FRAME REACHED THE HEADSET");
      }
      const status = sim.connected ? (sim.charging ? 0x01 : 0x03) : 0x00;
      const mv = Math.round(3330 + (sim.battery / 100) * 850);
      switch (model.family) {
        case "ss-nova7":
          if (d[0] === 0xb0) reply(0, [0xb0, 0x00, model.battery === "levels" ? Math.round(sim.battery / 25) : sim.battery, status, sim.game, sim.chat]);
          else if (d[0] === 0x39) sim.held.sidetone = d[1];
          else if (d[0] === 0xa3) sim.held.autoOff = d[1];
          else if (d[0] === 0xae) sim.held.micLight = d[1];
          else if (d[0] === 0x3a) sim.held.limiter = d[1];
          else if (d[0] === 0x33) sim.held.eqPreset = d[2] === 25 ? 1 : d[1] === 15 ? 2 : d[1] === 23 && d[10] === 24 ? 3 : 0;
          break;
        case "logi-g535":
        case "logi-gpro":
        case "logi-g633":
          if (!sim.connected) reply(0x11, [0xff, 0xff, d[1], d[2], 0x05]);
          else if (d[3] === 0 && d[2] !== 0x3c && (d[2] === 0x0d || d[2] === 0x0a)) reply(0x11, [0xff, d[1], d[2], mv >> 8, mv & 0xff, sim.charging ? 0x03 : 0x01]);
          else if (d[2] === 0x1d || d[2] === 0x1a) {
            sim.held.sidetone = d[3];
            reply(0x11, [0xff, d[1], d[2], d[3]]);
          } else if (d[2] === 0x2d || d[2] === 0x21) sim.held.autoOff = d[3];
          else if (d[2] === 0x3c) sim.held.lights = d[4] ? 1 : 0;
          break;
        case "hyperx-cloud2w":
          if (d[2] === 0x02) reply(6, [0xff, 0xbb, 0x02, 0, 0x0f, 0x8c, sim.battery]);
          else if (d[2] === 0x03) reply(6, [0xff, 0xbb, 0x03, sim.charging ? 1 : 0]);
          else if (d[2] === 0x07) reply(6, [0xff, 0xbb, 0x07, sim.held.autoOff ?? 20]);
          else if (d[2] === 0x22) {
            sim.held.autoOff = d[3];
            reply(6, [0xff, 0xbb, 0x22, d[3]]);
          }
          break;
      }
    },
  };
  return sim;
}
