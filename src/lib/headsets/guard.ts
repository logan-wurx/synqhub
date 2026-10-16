// The headset allowlist: a report may go to a headset only when it is, byte for byte, one SYNQ builds for that
// model (a status read, or one setting at a value SYNQ offers). Firmware, pairing, factory defaults and anything
// else HeadsetControl or the makers' apps can send are not in it. The desktop bridge holds the same rules in Rust
// (src-tauri/src/headsets.rs), checked against headset-frames.txt.
import { CHANNELS, settingFrames, settingsOf, statusRequests, type Frame, type Model, type SettingId } from "./protocol.ts";

const hex = (reportId: number, d: Uint8Array) => `${reportId.toString(16).padStart(2, "0")}:${Array.from(d, (b) => b.toString(16).padStart(2, "0")).join("")}`;

export interface Verdict {
  ok: boolean;
  /** "read", or the setting a write changes. */
  what: "read" | SettingId | null;
}

const cache = new Map<string, Map<string, Verdict["what"]>>();

/** Every frame SYNQ may send to this model, with what it does. */
export function allowedFrames(m: Model): Map<string, Verdict["what"]> {
  const key = `${m.vid}:${m.pid}`;
  let set = cache.get(key);
  if (set) return set;
  set = new Map();
  for (const f of statusRequests(m.family)) set.set(hex(f.reportId, f.data), "read");
  for (const s of settingsOf(m.family)) for (const v of s.values) for (const f of settingFrames(m, s.id, v) ?? []) set.set(hex(f.reportId, f.data), s.id);
  cache.set(key, set);
  return set;
}

/** Whether `data` (shorter data is padded with zeros to the channel's length) may go to this model. */
export function checkHeadsetFrame(m: Model, f: Frame): Verdict {
  const allowed = allowedFrames(m);
  const len = CHANNELS[m.family].length - 1;
  if (f.data.length > len) return { ok: false, what: null };
  const padded = new Uint8Array(len);
  padded.set(f.data);
  const what = allowed.get(hex(f.reportId, padded));
  return what === undefined ? { ok: false, what: null } : { ok: true, what };
}
