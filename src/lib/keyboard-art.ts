// The key positions to draw for a keyboard that has no photo: the board's real layout when the app holds one (the
// X68 HE family, the Sonix boards), otherwise SYNQ's drawing of the form factor its name points to. The heavy
// tables are imported on demand, so a home page with a photographed keyboard never loads them.
import { keyboardForm } from "./device-shape.ts";
import { formGeometry, geometryFromRects, type RenderGeometry } from "./keyboard-geometry.ts";
import { usbKey } from "./device-images.ts";

export interface KeyboardArtQuery {
  vid?: string | null;
  pid?: string | null;
  name?: string | null;
}

const SONIX_VIDS = new Set(["0c45"]);
const cache = new Map<string, Promise<RenderGeometry>>();

/** Geometry for a keyboard (cached per id + name). Never rejects: the form-factor drawing is the last resort. */
export function keyboardGeometry(q: KeyboardArtQuery): Promise<RenderGeometry> {
  const id = usbKey(q.vid, q.pid) ?? "";
  const key = `${id}|${q.name ?? ""}`;
  let p = cache.get(key);
  if (!p) cache.set(key, (p = build(q, id).catch(() => formGeometry(keyboardForm(q.name)))));
  return p;
}

async function build(q: KeyboardArtQuery, id: string): Promise<RenderGeometry> {
  const fallback = () => formGeometry(keyboardForm(q.name));
  if (id === "2e3c:c365") {
    const { X68_LAYOUTS } = await import("./x68he-layout.ts");
    const l = X68_LAYOUTS.ansi ?? Object.values(X68_LAYOUTS)[0];
    return (l && geometryFromRects(l.keys)) ?? fallback();
  }
  if (id && SONIX_VIDS.has(id.slice(0, 4))) {
    const { detectSonix } = await import("./kb/fcc/sonix-devices.ts");
    const d = detectSonix(parseInt(id.slice(0, 4), 16), parseInt(id.slice(5), 16), q.name ?? "");
    const g = d.model && d.certain ? geometryFromRects(d.model.keys) : null;
    if (g) return g;
  }
  return fallback();
}
