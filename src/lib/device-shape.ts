// What a device without a picture is drawn as: a silhouette class for mice and the rest, a form factor for
// keyboards. Both come from what the device calls itself; nothing here touches a device. Pure.

export type ShapeClass =
  | "symmetric"
  | "ergonomic"
  | "small"
  | "receiver"
  | "headset"
  | "iem"
  | "gamepad"
  | "arcade"
  | "light"
  | "light-tv"
  | "light-bars"
  | "light-panels"
  | "light-lamp"
  | "light-bulb"
  | "hub"
  | "monitor"
  | "webcam"
  | "generic";

export interface ShapeQuery {
  kind?: "mouse" | "keyboard" | "audio" | "sound" | string;
  name?: string | null;
  brand?: string | null;
  connection?: string | null;
  /** A light's form, from its model's row ("strip", "tv", "bar", "panel", "floor-lamp"...). */
  form?: string | null;
  /** A Dynamic Lighting device: Windows' LampArrayKind. */
  lampKind?: number | null;
}

/**
 * A Dynamic Lighting device is drawn as what Windows says it is (LampArrayKind): a keyboard as a keyboard, a mouse as a
 * mouse, a controller as a pad, a headset as a headset, a PC case or peripheral as a hub-like box; scene lights,
 * furniture, art and anything else as a light. Not read yet (-1): a light.
 */
const LAMP_ARRAY_KIND: Readonly<Record<number, "keyboard" | "mouse" | "controller" | "headset" | "rgbhub">> = {
  1: "keyboard",
  2: "mouse",
  3: "controller",
  4: "rgbhub",
  7: "rgbhub",
  11: "headset",
};
export const lampArrayDrawnAs = (kind: number | null | undefined): "keyboard" | "mouse" | "controller" | "headset" | "rgbhub" | "light" => LAMP_ARRAY_KIND[kind ?? -1] ?? "light";

/** A light without a picture is drawn by its form: the coiled strip only for strips and neon rope. */
const LIGHT_FORM: Readonly<Record<string, ShapeClass>> = {
  strip: "light",
  neon: "light",
  tv: "light-tv",
  bar: "light-bars",
  panel: "light-panels",
  wall: "light-panels",
  "floor-lamp": "light-lamp",
  "table-lamp": "light-lamp",
};

const has = (s: string, re: RegExp) => re.test(s);

// Receivers, and the charging docks that enumerate as their own device (the MCHOSE MagDock): drawn alike.
const RECEIVER = /receiver|dongle|slipstream|unifying|\bbolt\b|dock\b|charging (base|stand|pad)/;
const SMALL = /\b(mini|small|compact|lite)\b/;
// Right-hand shapes with a thumb side, vertical mice, trackballs, thumb-grid mice. Symmetric: everything else.
const ERGONOMIC =
  /ergo|vertical|trackball|nape|mx master|mx anywhere|deathadder|basilisk|g502|g903|g900|g703|g403|g402|g604|g600|g602|naga|scimitar|ironclaw|darkstar|nightsword|kone|model d\b|model d 2|model d2|\bm65\b|rival (5|600|650)|sensei|a950|pro click|\bm690\b|spatha|gladius|chakram|strix impact|tuf gaming m/;
const IEM = /\biem\b|in-ear|earbud|earphone|\bdac\b|moondrop|7hz|fifine|tangzu|truthear/;
const ARCADE = /arcade|fight ?stick|fightpad|hitbox|leverless|novablade|\bstick\b|panthera|kitsune|octa\b/;
const HEADSET = /head(set|phone)|cloud|arctis|blackshark|barracuda|kraken|virtuoso|\bnova\b|astro/;

/**
 * The silhouette for a device with no picture. Mice: a USB receiver when that is what was detected, small
 * (mini / compact shells), ergonomic (see ERGONOMIC), otherwise symmetrical. The sound output is an IEM or a
 * headset by its name. Anything unknown is "generic".
 */
export function shapeClass(q: ShapeQuery): ShapeClass {
  const n = ` ${(q.name ?? "").toLowerCase()} `;
  const kind = q.kind ?? "";
  if (kind === "sound" || kind === "audio") return has(n, IEM) && !has(n, HEADSET) ? "iem" : "headset";
  if (kind === "headset") return "headset";
  if (kind === "monitor" || kind === "webcam") return kind;
  // Controllers: a fight stick or leverless board, else a gamepad.
  if (kind === "controller") return has(n, ARCADE) ? "arcade" : "gamepad";
  if (kind === "light") return LIGHT_FORM[q.form ?? ""] ?? "light-bulb";
  if (kind === "lamparray") {
    const as = lampArrayDrawnAs(q.lampKind);
    return as === "light" || as === "keyboard" ? "light" : shapeClass({ ...q, kind: as, lampKind: null });
  }
  if (kind === "rgbhub") return "hub";
  if (kind !== "mouse") return "generic";
  if (has(n, RECEIVER)) return "receiver";
  if (has(n, SMALL)) return "small";
  return has(n, ERGONOMIC) ? "ergonomic" : "symmetric";
}

export type KeyboardForm = "60" | "65" | "75" | "tkl" | "96" | "full";

// "80" / "87" / "88" in a name is a tenkeyless; 81 to 84 keys is a 75% (KT84, the numbers below).
const TKL = /\btkl\b|tenkeyless|ten keyless|(?<![0-9])8[07-9](?![0-9])|\bk8\b|\bq3\b|\bk4\b|g915 tkl|wooting one/;
const NINETYSIX = /ak980|ak98\b|\bf99\b|mini99|\bk98\b|(?<![0-9])980(?![0-9])/;
const FULL = /full[- ]?size|numpad|\bk100\b|\bk95\b|\bk70\b(?! (core )?tkl| pro tkl)|\bg815\b|\bg915\b(?! tkl)|\bg213\b|\bg512\b|\bg413\b|apex (pro|7|5|3)\b(?! (tkl|mini))/;
const SEVENTYFIVE = /\bazoth\b(?! 96)|\bq1\b|\bk2\b|\ba75\b|\bg75\b|\bfun75\b|\b75/;
const SIXTY = /\bmini\b|\b60\b|60he|babao|flux|\bg60\b|fun60/;

/**
 * The form factor to draw for a keyboard that has no layout of its own, from the numbers and words in its
 * name ("FUN60 Pro" 60%, "Apex Pro TKL" tenkeyless, "K100" full size). Unknown: 65%, the commonest
 * hall-effect board.
 */
export function keyboardForm(name: string | null | undefined): KeyboardForm {
  const n = ` ${(name ?? "").toLowerCase()} `;
  if (has(n, NINETYSIX)) return "96";
  if (has(n, TKL)) return "tkl";
  const num = n.match(/(?:^|[^0-9])(100|104|108|109|98|99|97|96|84|83|82|81|75|78|68|67|66|65|64|63|61|60|40|30)(?![0-9])/);
  if (num) {
    const v = Number(num[1]);
    if (v >= 100) return "full";
    if (v >= 96) return "96";
    if (v >= 75) return "75";
    if (v >= 65) return "65";
    // 63 / 64 keys is a 60% footprint with the arrows squeezed in (GK64, Looting63); 30 / 40% boards draw smallest.
    return "60";
  }
  if (has(n, FULL)) return "full";
  if (has(n, SEVENTYFIVE)) return "75";
  if (has(n, SIXTY)) return "60";
  return "65";
}
