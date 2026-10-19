// Changes asked for somewhere else (a checkup's "Fix it", a pro's setup, the Gear page's active-device slider) that wait for
// their device's page: only the panel there holds the device's guarded session (Allow changes, a backup before the
// first write, every change read back), so that is where they run. Each device keeps at most one waiting request and
// the result of the last one, with what it takes to undo it. In memory only.
import { setKept, useKeptState } from "../keep";
import type { FixIntent } from "../checkup/fix";
import type { KeyboardFeel, MouseFeel, Step } from "./types";

export type PendingRequest =
  /** A checkup finding's fix, resolved against the device once its page has read it. */
  | { kind: "fix"; intent: FixIntent; label: string; at: number; auto: boolean; ref?: string }
  /** A pro's setup (src/lib/pros), translated to the device with the Keep your feel math. */
  | { kind: "pro"; pro: string; at: number; auto: boolean }
  /** Exact changes from the Gear page's active card ("1600 DPI"), `label` saying what they are. */
  | { kind: "set"; steps: Step[]; label: string; at: number; auto: boolean };

/** A request this old is shown with an Apply button instead of running by itself. */
export const AUTO_MS = 60_000;

export const pendingKey = (deviceId: string) => `feel.pending.${deviceId}`;
export const resultKey = (deviceId: string) => `feel.result.${deviceId}`;

/** Asks the device's page to make a change; `auto`: run it as soon as the page has read the device. */
export function requestChange(deviceId: string, r: PendingRequest): void {
  setKept<PendingRequest | null>(pendingKey(deviceId), r);
}

/** The Gear page's active card: these changes, made by the device's page as soon as it has read the device. */
export function requestSet(deviceId: string, steps: Step[], label: string): void {
  requestChange(deviceId, { kind: "set", steps, label, at: Date.now(), auto: true });
}

export const usePending = (deviceId: string) => useKeptState<PendingRequest | null>(pendingKey(deviceId), null);

/** What the device held before a change: applying it again (the Keep your feel mapping) is the undo. */
export type Before = { kind: "mouse"; feel: MouseFeel } | { kind: "keyboard"; feel: KeyboardFeel };

export interface AppliedResult {
  kind: PendingRequest["kind"];
  /** "Fixed", "ZywOo's setup is on your X1 V2 Air+". */
  title: string;
  /** What changed: "Debounce 2 ms → 8 ms". */
  detail: string;
  before: Before | null;
  /** The in-game sensitivity that keeps a pro's eDPI at this mouse's DPI. */
  sens?: { game: "cs2" | "valorant"; value: number; edpi: number; dpi: number };
  /** The change came from a checkup, so its page offers the way back to the results. */
  fromCheckup: boolean;
  /** The checkup finding it fixed (`<device>:<finding id>`). */
  ref?: string;
  /** Undo ran. */
  undone?: boolean;
}

export const useResult = (deviceId: string) => useKeptState<AppliedResult | null>(resultKey(deviceId), null);
