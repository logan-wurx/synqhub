// Devices the browser was given but SYNQ can't drive here, each with the reason: a Razer on Windows
// Chromium 153+ ("needs the desktop app"), or a granted device SYNQ has no driver for. The Devices
// home shows them as cards instead of dropping them silently. Written by the device list
// (src/lib/web/devices.ts) on every refresh. No React here; src/components/web/WebNotes.tsx reads it.
export interface WebNote {
  /** vid:pid, lower-case hex. */
  id: string;
  name: string;
  kind: "desktop" | "unsupported";
  title: string;
  message: string;
}

let notes: readonly WebNote[] = [];
const listeners = new Set<() => void>();

export const getWebNotes = (): readonly WebNote[] => notes;

export function setWebNotes(next: readonly WebNote[]): void {
  if (JSON.stringify(next) === JSON.stringify(notes)) return;
  notes = next;
  for (const l of [...listeners]) l();
}

export function subscribeWebNotes(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

// ---------------------------------------------------------------------------------------------
// What the person just picked in the browser's chooser, and whether the website can drive it. Shown as
// a confirmation under the page title until it is dismissed; the verdict comes from availability.ts.
// ---------------------------------------------------------------------------------------------
export interface PickedNote {
  name: string;
  /** "ok": it will show up; "desktop": needs the desktop app; "unknown": the browser let it in, SYNQ has no driver. */
  status: "ok" | "desktop" | "unknown";
  title: string;
  message: string;
}

let picked: readonly PickedNote[] = [];
const pickListeners = new Set<() => void>();

export const getPicked = (): readonly PickedNote[] => picked;

export function setPicked(next: readonly PickedNote[]): void {
  picked = next;
  for (const l of [...pickListeners]) l();
}

export function subscribePicked(l: () => void): () => void {
  pickListeners.add(l);
  return () => pickListeners.delete(l);
}
