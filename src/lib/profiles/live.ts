// Game profiles for every mouse and keyboard, live: the device's own session, opened the way its page opens it (or
// that page's own session while it has one open), so a profile goes on with the very calls a change by hand makes.
// Each session keeps the safety rules: the tier and "Allow changes", one backup before the first write, a read-back
// after each change (src/lib/feel/drive.ts). A profile is a feel (src/lib/feel); a device's everyday settings are its
// feel from before a game's went on.
import { track } from "../device-session.ts";
import type { ApplyOutcome } from "../feel/drive.ts";
import type { KeyboardDevice, KeyboardFeel, MouseDevice, MouseFeel, Step } from "../feel/types.ts";
import type { MouseSession } from "../mouse.ts";
import type { AtkSession } from "../atk-session.ts";
import type { SafeMouse } from "../openmouse/safe-mouse.ts";
import type { KeyboardSession } from "../keyboard.ts";
import type { X68Session } from "../x68he.ts";
import type { KbSession } from "../kb/session.ts";

export type LiveKind = "mouse" | "keyboard";
export type Feel = MouseFeel | KeyboardFeel;

export interface LiveDevice {
  family: string;
  kind: LiveKind;
  /** Its settings now, as a feel; null when the session hasn't read them. */
  now(): Feel | null;
  /** The session's view (what its page shows), for src/lib/profiles/snapshots.ts. */
  view(): unknown;
  /** Puts a feel on: the steps that mapping it onto this device produces, through the session. */
  apply(feel: Feel): Promise<ApplyOutcome<unknown>>;
  /** Closes the session if this opened it; a page's own stays open. */
  release(): Promise<void>;
}

export type Session = MouseSession | AtkSession | SafeMouse | KeyboardSession | X68Session | KbSession;

/** A device page, as a profile sees it: the session it has open (kept while the page is away, until its idle close),
 * whether it is saving a change of its own, and how it shows what the device holds after a profile changed it. */
export interface PageHook {
  session(): Session | null;
  busy(): boolean;
  onView?(view: never): void;
}

/** The mouse or keyboard family (src/lib/device-model.ts), or null for one game profiles don't cover. */
export function liveKind(family: string): LiveKind | null {
  if (family === "logitech" || family === "atk" || family.startsWith("om:")) return "mouse";
  if (family === "falchion" || family === "x68" || family.startsWith("kb:")) return "keyboard";
  return null;
}

/** The kept-state name of the family's page (as its page names it): the session slot a profile's work counts toward. */
export function pageKey(family: string): string {
  if (family.startsWith("om:")) return `mouse.om.${family.slice(3)}`;
  if (family.startsWith("kb:")) return `keyboard.kb.${family.slice(3)}`;
  return `${liveKind(family)}.${family}`;
}

/** The device pages, each registered when its module loads (a page never loaded has no session open). */
const pages: Array<(family: string) => PageHook | null> = [];

/** A device page module says which families it shows and where its session is. */
export function sharePage(hook: (family: string) => PageHook | null): void {
  pages.push(hook);
}

function pageFor(family: string): PageHook | null {
  for (const p of pages) {
    const h = p(family);
    if (h) return h;
  }
  return null;
}

async function connect(family: string): Promise<Session | null> {
  if (family === "logitech") return (await import("../mouse.ts")).connectMouse();
  if (family === "atk") return (await import("../atk-mouse.ts")).connectAtk();
  if (family.startsWith("om:")) {
    const [{ genericHost }, { connectGeneric }] = await Promise.all([import("../generic-mice.ts"), import("../openmouse/host.ts")]);
    return connectGeneric(await genericHost(), family.slice(3));
  }
  if (family === "falchion") return (await import("../keyboard.ts")).connectKeyboard();
  if (family === "x68") return (await import("../x68he.ts")).connectX68();
  if (family.startsWith("kb:")) {
    const [{ kbHost }, { connectKeyboard }] = await Promise.all([import("../kb/confirm.ts"), import("../kb/host.ts")]);
    return connectKeyboard(await kbHost(), family.slice(3));
  }
  return null;
}

/** Opens a device for a profile, or null when it isn't there (or isn't one game profiles cover). */
export async function openLive(family: string): Promise<LiveDevice | null> {
  const kind = liveKind(family);
  if (!kind) return null;
  const page = pageFor(family);
  const own = page?.session() ?? null;
  // Its page is saving a change: this waits for the next look rather than writing alongside it.
  if (own && page?.busy()) throw new Error("its page is still saving a change");
  const s = own ?? (await connect(family));
  if (!s) return null;
  const [devices, drive, { mapMouse }, { mapKeyboard }] = await Promise.all([import("../feel/devices.ts"), import("../feel/drive.ts"), import("../feel/mouse.ts"), import("../feel/keyboard.ts")]);
  const describe = (): MouseDevice | KeyboardDevice | null => (kind === "mouse" ? devices.describeMouse(family, s.view) : devices.describeKeyboard(family, s.view));
  const stepsFor = (feel: Feel): Step[] => {
    const d = describe();
    if (!d) throw new Error("SYNQ couldn't read its settings yet");
    return kind === "mouse" ? mapMouse(feel as MouseFeel, d as MouseDevice).steps : mapKeyboard(feel as KeyboardFeel, d as KeyboardDevice).steps;
  };
  // The page (when it has the session) shows each change as it is read back.
  const show = own && page?.onView ? (v: unknown) => page.onView?.(v as never) : undefined;
  const run = (steps: Step[]): Promise<ApplyOutcome<unknown>> => {
    if (family === "logitech") return drive.driveLogitech(s as MouseSession, steps, show);
    if (family === "atk") return drive.driveAtk(s as AtkSession, steps, show);
    if (family.startsWith("om:")) return drive.driveGenericMouse(s as SafeMouse, steps, show);
    if (family === "falchion") return drive.driveFalchion(s as KeyboardSession, steps);
    if (family === "x68") return drive.driveX68(s as X68Session, (s as X68Session).view.state, steps);
    return drive.driveGenericKeyboard(s as KbSession, (s as KbSession).view, steps, show);
  };
  return {
    family,
    kind,
    now: () => describe()?.now ?? null,
    view: () => s.view,
    // Counted as the page's work: its session isn't closed, nor a minimized window suspended, half way through.
    apply: (feel) => track(pageKey(family), run(stepsFor(feel))),
    release: async () => {
      if (!own) await s.close();
    },
  };
}
