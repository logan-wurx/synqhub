// Which panel shows a detected mouse. No device access, no React: shared by the Mouse page, the
// sidebar hint and the probe that finds out which mouse is actually on.
import type { Connected } from "./backend.ts";

/** "logitech", "atk", or "om:<vid>:<pid>" for a mouse on the generic (OpenMouse) panel. */
export type MouseFamily = string;

/** The panel for a detected mouse: the hand-built Logitech or X1 one, or the generic OpenMouse one. */
export const familyOf = (d: Pick<Connected, "kind" | "generic" | "vid" | "pid" | "bootloader">): MouseFamily | null => {
  if (d.kind !== "mouse" || d.bootloader) return null;
  if (d.generic) return `om:${d.vid}:${d.pid}`;
  if (d.vid === "046d") return "logitech";
  if (d.vid === "373b") return "atk";
  return null;
};

/** Every mouse family that is plugged in, once each: the hand-built panels first, then the generic ones. */
export function mouseFamilies(devices: readonly Pick<Connected, "kind" | "generic" | "vid" | "pid" | "bootloader">[]): MouseFamily[] {
  return [...new Set(devices.map(familyOf).filter((f): f is MouseFamily => !!f))].sort((a, b) => Number(a.startsWith("om:")) - Number(b.startsWith("om:")));
}

/** The name of a family's session and kept state (src/lib/device-session.ts, src/lib/keep.ts). */
export const sessionKeyOf = (family: MouseFamily): string => (family.startsWith("om:") ? `mouse.om.${family.slice(3)}` : `mouse.${family}`);
