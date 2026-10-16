// Monitors over DDC/CI (MCCS): the codes SYNQ may write (src/lib/displays/vcp.json, the same file the Rust side
// reads), names for the values monitors list, and the TypeScript copy of the write guard. The bridge checks every
// write again (src-tauri/src/monitors.rs `guard`); both are held to display-cases.txt. Pure.
import table from "./vcp.json" with { type: "json" };

export type VcpId = "brightness" | "contrast" | "colorPreset" | "redGain" | "greenGain" | "blueGain" | "volume" | "mute" | "input";

export interface VcpSpec {
  code: number;
  id: VcpId;
  label: string;
  rule: "continuous" | "listed";
  /** Switching it blanks this screen: confirmation, then an automatic switch back unless kept. */
  confirm?: boolean;
}

export const VCP: readonly VcpSpec[] = table.allowed as VcpSpec[];
export const READ_ONLY: readonly number[] = table.readOnly;
export const INPUT_CODE = 0x60;
export const POWER_CODE = 0xd6;

/** What a monitor's capabilities string says (src-tauri/src/monitors.rs `Caps`). */
export interface Caps {
  model: string | null;
  mccs: string | null;
  /** Code -> values listed for it (empty for a continuous code). JSON keys are the codes in decimal. */
  vcp: Record<string, number[]>;
}

export interface Reading {
  code: number;
  value: number;
  max: number;
}

/** MCCS input source values (VESA MCCS 2.2a, table 8-3, the common ones). */
export const INPUT_NAMES: Readonly<Record<number, string>> = {
  0x01: "VGA",
  0x02: "VGA 2",
  0x03: "DVI",
  0x04: "DVI 2",
  0x0f: "DisplayPort",
  0x10: "DisplayPort 2",
  0x11: "HDMI",
  0x12: "HDMI 2",
  0x1b: "USB-C",
};

/** MCCS colour presets (0x14). */
export const PRESET_NAMES: Readonly<Record<number, string>> = {
  0x01: "sRGB",
  0x02: "Native",
  0x03: "4000 K",
  0x04: "5000 K",
  0x05: "6500 K",
  0x06: "7500 K",
  0x07: "8200 K",
  0x08: "9300 K",
  0x09: "10000 K",
  0x0a: "11500 K",
  0x0b: "User 1",
  0x0c: "User 2",
  0x0d: "User 3",
};

export const MUTE_NAMES: Readonly<Record<number, string>> = { 0x01: "Muted", 0x02: "On" };

export function valueName(code: number, value: number): string {
  const names = code === INPUT_CODE ? INPUT_NAMES : code === 0x14 ? PRESET_NAMES : code === 0x8d ? MUTE_NAMES : null;
  return names?.[value] ?? (names ? `0x${value.toString(16).toUpperCase().padStart(2, "0")}` : `${value}`);
}

export const listed = (caps: Caps, code: number): number[] | null => caps.vcp[String(code)] ?? null;

/** Whether SYNQ may set `code` to `value`: the same rules as the bridge's `guard`. Null when it may, else why not. */
export function vcpRefusal(code: number, value: number, caps: Caps, max: number, confirm: boolean): string | null {
  const spec = VCP.find((s) => s.code === code);
  if (!spec) return `Refused: VCP code 0x${code.toString(16).toUpperCase().padStart(2, "0")} isn't one SYNQ changes.`;
  const values = listed(caps, code);
  if (!values) return `Refused: this monitor doesn't list VCP 0x${code.toString(16).toUpperCase().padStart(2, "0")}.`;
  if (spec.confirm && !confirm) return "Switching the input blanks this screen: it needs your confirmation.";
  if (spec.rule === "continuous") return value <= max && max > 0 ? null : `Refused: ${value} is past this monitor's maximum (${max}).`;
  return values.includes(value) ? null : `Refused: ${value} isn't a value this monitor lists.`;
}
