// Which gear a checkup covers and what is known about each piece (from the views the panels keep; nothing is read
// from a device here), and turning a finished run's recordings into one report per device.
import type { Connected, EngineStatus, EqSnapshot } from "@/lib/backend";
import { summarize, type DeviceEntry } from "@/lib/device-model";
import { familyOf } from "@/lib/mouse-family";
import { keyboardFamilyOf } from "@/lib/kb/probe";
import { peekKept } from "@/lib/keep";
import { TIER_LABEL } from "@/lib/kb/types";
import { describeKeyboard, describeMouse } from "@/lib/feel/devices";
import { busiest, expandRun, type RawCapture, type RawMouseRun } from "@/lib/checkup/raw";
import { controllerReport, keyboardReport, mouseReport, soundReport, type MouseMeasure, type Subject } from "@/lib/checkup/report";
import { KEYS } from "@/lib/checkup/thresholds";
import type { DeviceReport, KeyEvent, MotionReport, ButtonEvent } from "@/lib/checkup/types";
import type { PadState } from "@/lib/controllers/parse";

export interface Gear {
  entry: DeviceEntry;
  /** The listed devices behind it (a receiver and a cable can both be there). */
  listed: Connected[];
}

const NO_STEPS = new Set<string>(["headset", "monitor", "webcam", "light", "lamparray", "rgbhub"]);

export function gearOf(entries: readonly DeviceEntry[], devices: readonly Connected[], scope: string | null): Gear[] {
  return entries
    // Headsets, monitors, webcams and lights have no steps: their pages read them.
    .filter((e) => !NO_STEPS.has(e.kind) && (scope === null || e.id === scope))
    .map((entry) => ({
      entry,
      listed:
        entry.kind === "mouse"
          ? devices.filter((d) => familyOf(d) === entry.family)
          : entry.kind === "keyboard"
            ? devices.filter((d) => keyboardFamilyOf(d) === entry.family)
            : entry.kind === "controller" && entry.pad
              ? [entry.pad.device]
              : [],
    }));
}

const viewOf = (e: DeviceEntry): unknown => (e.viewKey ? peekKept<unknown>(e.viewKey, null) : null);

/** What the hand-built mouse drivers can set, known before their panel has read the mouse (generic ones depend on the model). */
const KNOWN_MICE: Readonly<Record<string, { debounce: boolean; polling: boolean }>> = {
  logitech: { debounce: false, polling: true },
  atk: { debounce: true, polling: true },
};

/** Why changes can't be written to it: only for a device read as read-only (unknown until its panel has read it). */
function blockedOf(e: DeviceEntry): string | null {
  const view = viewOf(e);
  if (!view) return null;
  const s = summarize(e, view);
  return s.tier === "read-only" ? (s.tierHint ?? TIER_LABEL["read-only"].hint) : null;
}

export function subjectOf(g: Gear): Subject {
  return { id: g.entry.id, name: g.entry.name, blocked: blockedOf(g.entry) };
}

/** What every step recorded. Raw runs are per step; the window's own events are always there. */
export interface Recordings {
  rest?: { motion: MotionReport[]; keys: KeyEvent[]; raw: RawMouseRun | null; pads: Record<string, PadState[]> };
  clicks?: { buttons: ButtonEvent[]; raw: RawMouseRun | null };
  circles?: { motion: MotionReport[]; raw: RawMouseRun | null };
  keys?: { keys: KeyEvent[]; end: number };
  hold?: { keys: KeyEvent[]; end: number };
  sticks?: { pads: Record<string, PadState[]> };
  sound?: { status: EngineStatus | null; eq: EqSnapshot | null };
}

/** A mouse's own part of a raw run: by its USB ids, or the busiest mouse when only one mouse is being checked. */
function rawFor(run: RawMouseRun | null | undefined, g: Gear, alone: boolean): RawCapture | null {
  if (!run) return null;
  const caps = expandRun(run);
  const ids = new Set(g.listed.map((d) => `${d.vid}:${d.pid}`));
  const own = caps.filter((c) => ids.has(`${c.vid}:${c.pid}`));
  if (own.length) return { vid: own[0].vid, pid: own[0].pid, buttons: own.flatMap((c) => c.buttons), motion: own.flatMap((c) => c.motion) };
  return alone ? busiest(caps) : null;
}

/** A report that only says the device wasn't part of the steps. */
function notUsed(g: Gear, why: string): DeviceReport {
  return { device: g.entry.id, name: g.entry.name, kind: g.entry.kind === "sound" ? "sound" : (g.entry.kind as DeviceReport["kind"]), level: "good", findings: [], checked: [], skipped: why };
}

export function buildReports(gear: readonly Gear[], rec: Recordings, rawUsed: boolean): DeviceReport[] {
  const mice = gear.filter((g) => g.entry.kind === "mouse");
  const keyboards = gear.filter((g) => g.entry.kind === "keyboard");
  const out: DeviceReport[] = [];
  for (const g of gear) {
    const e = g.entry;
    if (e.kind === "mouse") {
      const view = viewOf(e);
      const subject = { ...subjectOf(g), wireless: summarize(e, view).link === "Wireless", device: describeMouse(e.family, view), known: KNOWN_MICE[e.family] };
      let m: MouseMeasure;
      if (rawUsed) {
        const alone = mice.length === 1;
        const clicks = rawFor(rec.clicks?.raw, g, alone);
        const circles = rawFor(rec.circles?.raw, g, alone);
        const rest = rawFor(rec.rest?.raw, g, alone);
        if (!clicks?.buttons.length && !circles?.motion.length) {
          out.push(notUsed(g, mice.length > 1 ? "Not used during the steps: you checked with the other mouse." : "It sent nothing during the steps (asleep, or another mouse was used)."));
          continue;
        }
        m = { source: "raw", throttled: (rec.circles?.raw?.background ?? 0) > 0, clicks: clicks?.buttons ?? [], motion: circles?.motion ?? [], rest: rest?.motion ?? [] };
      } else {
        if (mice.length > 1 && g !== mice[0]) {
          out.push(notUsed(g, "This window can't tell mice apart, so the steps were counted for the first one."));
          continue;
        }
        m = { source: "window", clicks: rec.clicks?.buttons ?? [], motion: rec.circles?.motion ?? [], rest: rec.rest?.motion ?? [] };
      }
      if (!rec.clicks && !rec.circles) continue;
      out.push(mouseReport(subject, m));
    } else if (e.kind === "keyboard") {
      if (!rec.keys && !rec.hold) continue;
      if (keyboards.length > 1 && g !== keyboards[0]) {
        out.push(notUsed(g, "Keys can't be told apart between keyboards here, so the steps were counted for the first one."));
        continue;
      }
      const subject = { ...subjectOf(g), device: describeKeyboard(e.family, viewOf(e)) };
      out.push(keyboardReport(subject, { keys: rec.keys?.keys ?? [], keysEnd: rec.keys?.end ?? 0, asked: KEYS.codes, hold: rec.hold?.keys ?? [], holdEnd: rec.hold?.end ?? 0, rest: rec.rest?.keys ?? [] }));
    } else if (e.kind === "controller") {
      const rest = rec.rest?.pads[e.id] ?? [];
      const spin = rec.sticks?.pads[e.id] ?? [];
      if (!rest.length && !spin.length) {
        out.push(notUsed(g, "SYNQ couldn't listen to this controller (it may be asleep, or another app holds it)."));
        continue;
      }
      out.push(controllerReport(subjectOf(g), { rest, spin }));
    } else if (rec.sound) {
      out.push(soundReport(subjectOf(g), rec.sound.status, rec.sound.eq));
    }
  }
  return out;
}

