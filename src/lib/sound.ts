// What the Sound page is about on this PC: the current default output and the EQ engine on it,
// plus the name the person gave the headphones on that output (kept per PC in app data, so one
// PC's gear never shows on another). Shared by the Sound page and the sidebar.
import { useSyncExternalStore } from "react";
import { backend, isWeb, type EngineOutput, type EngineStatus, type SoundName, type SoundNames } from "./backend";

export interface SoundSnapshot {
  status: EngineStatus | null;
  names: SoundNames;
}

let snap: SoundSnapshot = { status: null, names: {} };
const listeners = new Set<() => void>();
let started = false;

function emit() {
  for (const l of listeners) l();
}

export function setEngineStatus(status: EngineStatus) {
  snap = { ...snap, status };
  emit();
}

export function setSoundNames(names: SoundNames) {
  snap = { ...snap, names };
  emit();
}

/** Reads the engine state and the names again (window focus, after a setup). */
export async function refreshSound(): Promise<EngineStatus | null> {
  // The website has no system audio to read: the Sound page is a "desktop app" card there.
  if (isWeb) return null;
  const [status, names] = await Promise.all([backend.eqEngineStatus().catch(() => null), backend.soundNamesLoad().catch(() => null)]);
  snap = { status: status ?? snap.status, names: names ?? snap.names };
  emit();
  return status;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (!started) {
    started = true;
    void refreshSound();
  }
  return () => {
    listeners.delete(listener);
  };
}

export function useSound(): SoundSnapshot {
  return useSyncExternalStore(subscribe, () => snap);
}

export interface SoundLabel {
  output: EngineOutput | null;
  /** The person's name for the headphones on this output, if they gave one. */
  custom: SoundName | null;
  /** Custom name, else the output's name, else "No output". */
  title: string;
}

export function soundLabel(s: SoundSnapshot): SoundLabel {
  const output = s.status?.defaultOutput ?? null;
  const custom = (output && s.names[output.id]) || null;
  return { output, custom, title: custom?.name ?? output?.title ?? "No output" };
}

/** The sidebar's Sound entry: the hint names what's playing; the dot is lit while the EQ runs. */
export function useSoundNav(): { hint: string; status: "on" | "off" } {
  const s = useSound();
  return { hint: s.status ? soundLabel(s).title : "", status: s.status?.state === "active" ? "on" : "off" };
}
