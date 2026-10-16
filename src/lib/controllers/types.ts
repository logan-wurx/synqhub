// Shared types of SYNQ's controller support (docs/devices/CONTROLLERS.md, CONTROLLERS-ROADMAP.md).
// Pure types: no DOM, no React, no device access.

/**
 * How a pad reaches the PC on Windows:
 * - `hid`: a HID gamepad over USB, Bluetooth or a dongle (the Rust bridge's hidapi, WebHID on the website);
 * - `xusb`: an Xbox 360-class pad (xusb22.sys): XInput only;
 * - `gip`: an Xbox One-class pad (xboxgip.sys): XInput only (GIP-custom is a later wave);
 * - `usb`: vendor USB that needs a driver swap (Switch 2 over USB): detect only.
 */
export type PadTransport = "hid" | "xusb" | "gip" | "usb";

/** The controller type, after SDL's controller_list.h (plus the vendor families SDL has HIDAPI drivers for). */
export type PadKind =
  | "xbox360"
  | "xboxone"
  | "xboxelite"
  | "ps3"
  | "ps4"
  | "ps5"
  | "ps5edge"
  | "switchpro"
  | "switchinput"
  | "joycon"
  | "switch2"
  | "steam"
  | "steamdeck"
  | "steamtriton"
  | "horisteam"
  | "8bitdo"
  | "gamesir"
  | "flydigi"
  | "generic";

/**
 * What SYNQ may send to a HID pad (src-tauri/src/pads.rs mirrors it):
 * - `ds5` / `ds4`: Sony's volatile outputs (lightbar, player and mic LEDs, rumble, trigger test), as exact frames,
 *   and the feature reads named in guard.ts;
 * - `edge`: the DualSense's, plus the Edge's profile reads, and (wave C2) writes of its three custom slots and their
 *   deletes, never the default (edge.ts);
 * - `switch`: Nintendo's allowlisted subcommands and the two rumble frames;
 * - `gamesir-cyclone2` / `gamesir-g7pro8k` / `gamesir-tarantula`: GameSir's register protocol on the vendor collection,
 *   reads anywhere in the known banks and writes into the allowlisted fields only (gamesir.ts);
 * - `input`: nothing at all (the tester reads input reports only).
 */
export type PadGuard = "ds5" | "edge" | "ds4" | "switch" | "gamesir-cyclone2" | "gamesir-g7pro8k" | "gamesir-tarantula" | "scuf" | "8bitdo" | "flydigi" | "input";

/** Where a pad keeps its settings (CONTROLLERS-ROADMAP.md rule 4). */
export type PadSettings = "onboard" | "volatile" | "host" | "none";

/** How far SYNQ goes with a pad today. */
export type PadSupport = "tester" | "basics" | "detect";

/** One identity a model takes (a model can have many: modes, dongles, Bluetooth). */
export interface PadIdentity {
  vid: number;
  pid: number;
  /** The personality this id means ("usb", "bluetooth", "dongle", "xinput", "config", "switch"...). */
  personality: string;
  transport: PadTransport;
  /** This identity is read only even when its model takes changes (a mode the sources don't configure). */
  readOnly?: boolean;
}

/** A bootloader or recovery identity: never listed as a pad, never opened. */
export interface PadBootId {
  vid: number;
  pid: number;
  what: string;
}

/** What the tester can show for a model (CONTROLLERS.md §7). */
export interface PadCaps {
  sticks: number;
  triggers: { bits: 8 | 10 | 12 } | null;
  paddles: number;
  gyro: boolean;
  touchpad: boolean;
  battery: boolean;
  /** Rumble motors SYNQ can test (volatile). */
  rumble: boolean;
  /** Lightbar / player LEDs / HOME light SYNQ can test (volatile). */
  lights: boolean;
  adaptiveTriggers: boolean;
}

export interface PadModel {
  /** Stable key ("sony-dualsense"); the photos and the navigation use it. */
  id: string;
  name: string;
  brand: string;
  ids: readonly PadIdentity[];
  guard: PadGuard;
  support: PadSupport;
  settings: PadSettings;
  /** The maker's configurator, where one exists. */
  tool?: { name: string; url?: string };
  /** What can be set on the pad itself, without any app. */
  guide?: string;
  caps: PadCaps;
}

/** One row of the generated table: an id SDL or xpad knows, with its type and transport. */
export type PadRow = readonly [vid: number, pid: number, kind: PadKind, transport: PadTransport, name: string];
