// Which QMK lighting a VIA / Vial board has and how its values are addressed. VIA v3 boards (VIA
// protocol 11 and up) address values by channel (1 backlight, 2 rgblight, 3 rgb matrix; QMK
// quantum/via.h); older VIA and Vial boards use the legacy value ids (backlight 0x09/0x0A, rgblight
// 0x80-0x83). Which channels exist comes from the definition (VIA v3 `menus`, Vial / VIA v2
// `lighting`). Effect names follow VIA's own built-in menus; a firmware built with fewer effects
// numbers them differently, which the panel says. Pure.
import type { ChoiceSpec, NumberSpec } from "../types.ts";
import type { LightingScheme } from "./protocol.ts";

export type LightingKey = "brightness" | "effect" | "speed" | "color";

export interface LightingValueDef {
  key: LightingKey;
  label: string;
  /** Channel value id (scheme "channel") or legacy value id (scheme "legacy"). */
  valueId: number;
  kind: "range" | "choice" | "toggle" | "color";
  bytes: 1 | 2;
  spec?: NumberSpec;
  choice?: ChoiceSpec;
}

export interface LightingChannelDef {
  /** "backlight" | "rgblight" | "rgb_matrix" */
  id: string;
  label: string;
  scheme: LightingScheme;
  /** The VIA v3 channel (1-3); for the legacy scheme the channel it corresponds to. */
  channel: number;
  values: readonly LightingValueDef[];
}

const RGB_MATRIX_EFFECTS = [
  "Off", "Solid color", "Alphas / mods", "Gradient up-down", "Gradient left-right", "Breathing", "Band saturation", "Band value", "Band pinwheel saturation",
  "Band pinwheel value", "Band spiral saturation", "Band spiral value", "Cycle all", "Cycle left-right", "Cycle up-down", "Rainbow moving chevron", "Cycle out-in",
  "Cycle out-in dual", "Cycle pinwheel", "Cycle spiral", "Dual beacon", "Rainbow beacon", "Rainbow pinwheels", "Raindrops", "Jellybean raindrops", "Hue breathing",
  "Hue pendulum", "Hue wave", "Pixel rain", "Pixel flow", "Pixel fractal", "Typing heatmap", "Digital rain", "Solid reactive simple", "Solid reactive", "Solid reactive wide",
  "Solid reactive multi wide", "Solid reactive cross", "Solid reactive multi cross", "Solid reactive nexus", "Solid reactive multi nexus", "Splash", "Multi splash",
  "Solid splash", "Solid multi splash",
];
const RGBLIGHT_EFFECTS = [
  "Off", "Solid color",
  ...[1, 2, 3, 4].map((n) => `Breathing ${n}`),
  ...[1, 2, 3].map((n) => `Rainbow mood ${n}`),
  ...[1, 2, 3, 4, 5, 6].map((n) => `Rainbow swirl ${n}`),
  ...[1, 2, 3, 4, 5, 6].map((n) => `Snake ${n}`),
  ...[1, 2, 3].map((n) => `Knight ${n}`),
  "Christmas",
  ...[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => `Gradient ${n}`),
  "RGB test", "Alternating",
  ...[1, 2, 3, 4, 5, 6].map((n) => `Twinkle ${n}`),
];

const byte = (): NumberSpec => ({ min: 0, max: 255, step: 1, unit: "level" });
const choices = (names: readonly string[]): ChoiceSpec => ({ options: names.map((label, value) => ({ value, label })) });

function channelDef(id: "backlight" | "rgblight" | "rgb_matrix", scheme: LightingScheme): LightingChannelDef {
  const legacy = scheme === "legacy";
  if (id === "backlight")
    return {
      id,
      label: "Backlight",
      scheme,
      channel: 1,
      values: [
        { key: "brightness", label: "Brightness", valueId: legacy ? 0x09 : 1, kind: "range", bytes: 1, spec: byte() },
        { key: "effect", label: "Breathing", valueId: legacy ? 0x0a : 2, kind: "toggle", bytes: 1 },
      ],
    };
  const effects = id === "rgblight" ? RGBLIGHT_EFFECTS : RGB_MATRIX_EFFECTS;
  return {
    id,
    label: id === "rgblight" ? "Underglow (RGB light)" : "RGB matrix",
    scheme,
    channel: id === "rgblight" ? 2 : 3,
    values: [
      { key: "brightness", label: "Brightness", valueId: legacy ? 0x80 : 1, kind: "range", bytes: 1, spec: byte() },
      { key: "effect", label: "Effect", valueId: legacy ? 0x81 : 2, kind: "choice", bytes: 1, choice: choices(effects) },
      { key: "speed", label: "Effect speed", valueId: legacy ? 0x82 : 3, kind: "range", bytes: 1, spec: byte() },
      { key: "color", label: "Colour", valueId: legacy ? 0x83 : 4, kind: "color", bytes: 2 },
    ],
  };
}

const CHANNEL_IDS: Record<number, "backlight" | "rgblight" | "rgb_matrix"> = { 1: "backlight", 2: "rgblight", 3: "rgb_matrix" };

/** Channels a VIA v3 custom menu object addresses, from its `content: [name, channel, valueId]` items. */
function channelsInMenu(menu: unknown, into: Set<number>) {
  if (Array.isArray(menu)) {
    if (menu.length === 3 && typeof menu[0] === "string" && typeof menu[1] === "number" && typeof menu[2] === "number") {
      if (menu[1] >= 1 && menu[1] <= 3) into.add(menu[1]);
      return;
    }
    for (const m of menu) channelsInMenu(m, into);
  } else if (menu && typeof menu === "object") {
    for (const v of Object.values(menu)) channelsInMenu(v, into);
  }
}

/**
 * The lighting channels of a board. `menus` / `lighting` come from its definition; `scheme` from its
 * protocol (VIA 11+ addresses by channel; older VIA and Vial use the legacy ids).
 */
export function lightingChannels(menus: readonly unknown[], lighting: string | null, scheme: LightingScheme): LightingChannelDef[] {
  const ids = new Set<number>();
  const name = (s: string) => {
    if (s.includes("backlight")) ids.add(1);
    if (s.includes("rgblight")) ids.add(2);
    if (s.includes("rgb_matrix")) ids.add(3);
  };
  for (const m of menus) {
    if (typeof m === "string") name(m);
    else channelsInMenu(m, ids);
  }
  if (lighting) name(lighting);
  // The legacy ids have no RGB-matrix channel.
  if (scheme === "legacy") ids.delete(3);
  return [...ids].sort().map((c) => channelDef(CHANNEL_IDS[c], scheme));
}

/** The panel's setting id for one value: "<channel id>.<key>". */
export const lightingSettingId = (ch: LightingChannelDef, v: LightingValueDef) => `${ch.id}.${v.key}`;
