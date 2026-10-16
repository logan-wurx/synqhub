// A simulated USB RGB hub for the preview and the tests: it answers the identify requests as the real hubs do
// (OpenRGB's description), keeps the colour each channel was last given, and records any report the guard would refuse.
import { checkHubFrame } from "./guard.ts";
import { LIANLI_COLOUR_LEN, type Frame, type HubModel, type Rgb } from "./protocol.ts";
import type { HubTransport } from "./session.ts";

export interface SimHub extends HubTransport {
  sent: Frame[];
  forbidden: Frame[];
  /** The colour each channel shows (first LED), as the sim understood the reports. */
  lit: Map<number, Rgb>;
}

export function simulateHub(m: HubModel): SimHub {
  const sent: Frame[] = [];
  const forbidden: Frame[] = [];
  const lit = new Map<number, Rgb>();
  const queue: Uint8Array[] = [];
  const reply = (bytes: number[], len = 64) => {
    const r = new Uint8Array(len);
    r.set(bytes);
    queue.push(r);
  };
  return {
    sent,
    forbidden,
    lit,
    async write(f) {
      if (!checkHubFrame(m, f).ok) {
        forbidden.push(f);
        return;
      }
      sent.push(f);
      const d = f.data;
      if (m.family === "nzxt-hue2") {
        if (f.reportId === 0x10) {
          const r = new Array(0x14).fill(0);
          [r[0], r[1], r[0x11], r[0x12], r[0x13]] = [0x11, 0x01, 1, 13, 0];
          reply(r);
        }
        if (f.reportId === 0x20) {
          const r = new Array(64).fill(0);
          [r[0], r[1]] = [0x21, 0x03];
          // Two F120 RGB fans on channel 1, a HUE 2 strip on channel 2.
          [r[0x0f], r[0x10], r[0x15]] = [0x13, 0x13, 0x04];
          reply(r);
        }
        if (f.reportId === 0x22 && d[0] === 0x10) lit.set(Math.log2(d[1]), [d[4], d[3], d[5]]);
      }
      if (m.family === "corsair-node") {
        if (d[0] === 0x02) reply([0x00, 0, 10, 4], 17);
        else reply([0x00], 17);
        if (d[0] === 0x35) lit.set(d[1], [d[9], d[10], d[11]]);
      }
      if (m.family === "lianli-sl" && d.length === LIANLI_COLOUR_LEN) lit.set(d[0] - 0x30, [d[1], d[3], d[2]]);
    },
    async read() {
      return queue.shift() ?? null;
    },
    async close() {},
  };
}
