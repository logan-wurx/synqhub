// The USB RGB hub allowlist: a report passes only when it is one SYNQ builds (src/lib/lighting/hidrgb/protocol.ts),
// for that hub's family and channels. The bridge holds every report to the same rules (src-tauri/src/lighting/hidrgb.rs),
// and both judge rgb-frames.txt (scripts/hidrgb-fixture.ts) line for line. Refused, whatever the bytes: fan and pump
// speeds, firmware and bootloader commands, Corsair's software (direct) mode and LED-count / protocol setup, effects
// other than one static colour, and anything for another model.
import { DATA_LEN, FAMILIES, LIANLI_COLOUR_LEN, LIANLI_MAX_FANS, type Frame, type HubModel } from "./protocol.ts";

export type Verdict = { ok: true; what: "identify" | "colour" | "apply" | "setup" | "commit" } | { ok: false; why: string };

const zeroFrom = (d: Uint8Array, at: number) => d.subarray(at).every((b) => b === 0);
const no = (why: string): Verdict => ({ ok: false, why });
const bit = (v: number, channels: number) => Array.from({ length: channels }, (_, c) => 1 << c).includes(v);
const APPLY = [0xa0, -1, 0x00, 0x01, 0, 0, 0x28, 0, 0, 0x80, 0, 0x32, 0, 0, 0x01];

function nzxt(m: HubModel, f: Frame): Verdict {
  const d = f.data;
  if (f.reportId === 0x10) return d[0] === 0x01 && zeroFrom(d, 1) ? { ok: true, what: "identify" } : no("Not the firmware request.");
  if (f.reportId === 0x20) return d[0] === 0x03 && zeroFrom(d, 1) ? { ok: true, what: "identify" } : no("Not the accessory list request.");
  if (f.reportId !== 0x22) return no("Not a report SYNQ sends this hub (fans, pump and effects are never sent).");
  if (!bit(d[1], m.channels)) return no("Not one of this hub's channels.");
  if ((d[0] === 0x10 || d[0] === 0x11) && d[2] === 0) return { ok: true, what: "colour" };
  if (d[0] === 0xa0) return APPLY.every((b, i) => b === -1 || d[i] === b) && zeroFrom(d, APPLY.length) ? { ok: true, what: "apply" } : no("Not the apply SYNQ sends.");
  return no("Not a colour or apply report.");
}

function corsair(m: HubModel, f: Frame): Verdict {
  const d = f.data;
  if (f.reportId !== 0) return no("Corsair hubs take report 0 only.");
  const ch = d[1];
  switch (d[0]) {
    case 0x02:
      return zeroFrom(d, 1) ? { ok: true, what: "identify" } : no("Not the firmware request.");
    case 0x33:
      return ch === 0xff && zeroFrom(d, 2) ? { ok: true, what: "commit" } : no("Not the commit SYNQ sends.");
    case 0x34:
    case 0x37:
      return ch < m.channels && zeroFrom(d, 2) ? { ok: true, what: "setup" } : no("Not one of this hub's channels.");
    case 0x38:
      // Hardware control only: software (direct) mode needs a keep-alive from a running app, which SYNQ doesn't do.
      return ch < m.channels && d[2] === 0x01 && zeroFrom(d, 3) ? { ok: true, what: "setup" } : no("Only hardware control is sent.");
    case 0x35: {
      if (ch >= m.channels) return no("Not one of this hub's channels.");
      const leds = d[3];
      if (d[2] !== 0 || leds < 1 || leds > FAMILIES["corsair-node"].maxLeds) return no("LED count out of range.");
      if (d[4] !== 0x04 || d[5] !== 0 || d[6] !== 0 || d[7] !== 0 || d[8] !== 0) return no("Only a static colour is sent.");
      return zeroFrom(d, 12) ? { ok: true, what: "colour" } : no("Only one colour is sent.");
    }
    default:
      return no("Not a command SYNQ sends (direct mode, LED count, protocol, temperature, fans and firmware are never sent).");
  }
}

function lianli(m: HubModel, f: Frame): Verdict {
  const d = f.data;
  if (f.reportId !== 0xe0) return no("The Uni Hub SL takes report 0xE0 only.");
  if (d.length === LIANLI_COLOUR_LEN) {
    const ch = d[0] - 0x30;
    return ch >= 0 && ch < m.channels ? { ok: true, what: "colour" } : no("Not one of this hub's channels.");
  }
  if (d[0] === 0x10 && d[1] === 0x32) {
    const ch = d[2] >> 4;
    const fans = d[2] & 0x0f;
    return ch < m.channels && fans >= 1 && fans <= LIANLI_MAX_FANS && zeroFrom(d, 3) ? { ok: true, what: "setup" } : no("Not a channel and fan count SYNQ sends.");
  }
  const ch = d[0] - 0x10;
  if (ch >= 0 && ch < m.channels && d[1] === 0x01 && d[2] === 0x02 && d[3] === 0 && d[4] === 0 && zeroFrom(d, 5)) return { ok: true, what: "apply" };
  return no("Only static mode at full brightness is sent.");
}

/** Whether SYNQ may send this report to this hub, and what it is. */
export function checkHubFrame(m: HubModel, f: Frame): Verdict {
  const len = m.family === "lianli-sl" ? [DATA_LEN["lianli-sl"], LIANLI_COLOUR_LEN] : [DATA_LEN[m.family]];
  if (!len.includes(f.data.length)) return no(`A ${m.family} report is ${len.join(" or ")} bytes after the report id.`);
  if (m.family === "nzxt-hue2") return nzxt(m, f);
  if (m.family === "corsair-node") return corsair(m, f);
  return lianli(m, f);
}

