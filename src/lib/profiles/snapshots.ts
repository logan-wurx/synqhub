// What the Games page builds a live profile from: each mouse and keyboard's settings and what it can take (the same
// description "Keep your feel" uses, src/lib/feel/devices.ts). Taken from its page when that is open, else from the
// last time it was read (kept with the other device states, so nothing has to be plugged in to edit), else read once
// now through its own session. Reading changes nothing on the device.
import { invoke } from "@tauri-apps/api/core";
import { isTauri, viaHelper } from "../runtime.ts";
import { peekKept } from "../keep.ts";
import { describeKeyboard, describeMouse } from "../feel/devices.ts";
import type { KeyboardTarget, MouseTarget } from "../feel/types.ts";
import { liveKind, openLive, pageKey, type Feel, type LiveKind } from "./live.ts";

export interface LiveSnapshot {
  live: true;
  family: string;
  kind: LiveKind;
  name: string;
  target: MouseTarget | KeyboardTarget;
  now: Feel;
  updated: number;
}

const stateId = (family: string) => `live-${family.replace(/[^a-zA-Z0-9-]/g, "-")}`;

function snapshot(family: string, name: string, view: unknown): LiveSnapshot | null {
  const kind = liveKind(family);
  if (!kind) return null;
  const d = kind === "mouse" ? describeMouse(family, view) : describeKeyboard(family, view);
  if (!d?.now) return null;
  return { live: true, family, kind, name, target: d.target, now: d.now, updated: Math.floor(Date.now() / 1000) };
}

async function keep(s: LiveSnapshot): Promise<void> {
  if (isTauri || (await viaHelper())) await invoke("device_state_save", { id: stateId(s.family), json: JSON.stringify(s) }).catch(() => undefined);
}

/** Every live device read before. */
export async function loadSnapshots(): Promise<LiveSnapshot[]> {
  if (!isTauri && !(await viaHelper())) return previewSnapshots();
  const list = await invoke<string[]>("device_states_load").catch(() => [] as string[]);
  const out: LiveSnapshot[] = [];
  for (const t of list) {
    try {
      const s = JSON.parse(t) as LiveSnapshot;
      if (s?.live === true && typeof s.family === "string" && liveKind(s.family) && s.now && s.target) out.push(s);
    } catch {
      /* a damaged file is skipped */
    }
  }
  return out;
}

/** From the device's page, when it has read the device in this session (nothing is sent); kept for next time. */
export function fromPage(family: string, name: string): LiveSnapshot | null {
  const s = snapshot(family, name, peekKept<unknown>(`${pageKey(family)}.view`, null));
  if (s) void keep(s);
  return s;
}

/** Reads the device now (it opens the way its page opens it, and closes again unless its page has it). */
export async function readNow(family: string, name: string): Promise<LiveSnapshot> {
  const dev = await openLive(family);
  if (!dev) throw new Error(`${name} isn't plugged in.`);
  try {
    const s = snapshot(family, name, dev.view());
    if (!s) throw new Error(`SYNQ couldn't read ${name}'s settings.`);
    await keep(s);
    return s;
  } finally {
    await dev.release().catch(() => undefined);
  }
}

/** The browser preview: a PRO X 2 DEX and a Falchion Ace HFX as they might have been read. */
function previewSnapshots(): LiveSnapshot[] {
  const t = Math.floor(Date.now() / 1000);
  return [
    {
      live: true,
      family: "logitech",
      kind: "mouse",
      name: "PRO X 2 DEX",
      target: { dpi: { min: 100, max: 44000, step: 50 }, stages: { max: 5, fixedCount: null }, polling: { options: [125, 250, 500, 1000, 2000, 4000, 8000] }, lod: { kind: "levels", levels: ["Low", "Medium", "High"] }, debounce: null, toggles: { angleSnapping: false, motionSync: false, ripple: false } },
      now: { stages: [400, 800, 1600], active: 1, pollingHz: 2000, lod: { kind: "level", level: "Low" }, debounceMs: null, angleSnapping: null, motionSync: null, ripple: null },
      updated: t,
    },
    {
      live: true,
      family: "falchion",
      kind: "keyboard",
      name: "Falchion Ace HFX",
      target: { actuation: { min: 0.1, max: 4, step: 0.1 }, rapidTrigger: true, rtSensitivity: { min: 0.1, max: 2, step: 0.1, independent: true }, socd: null },
      now: { actuationMm: 1.5, rapidTrigger: true, rtPressMm: 0.3, rtReleaseMm: 0.3, socd: null },
      updated: t,
    },
  ];
}
