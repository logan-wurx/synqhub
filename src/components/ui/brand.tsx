// SYNQ's brand pieces (branding/synq): the mark (two links, the second in the current accent), the word, the app tile,
// and the text-free "plug it in" drawings, whose accent details follow the accent too.
import plugMouse from "@/assets/brand/plug-in-mouse.svg?raw";
import plugKeyboard from "@/assets/brand/plug-in-keyboard.svg?raw";
import plugAudio from "@/assets/brand/plug-in-audio.svg?raw";
import { cn } from "@/lib/utils";
import { MARK_LINKS, MARK_VIEWBOX, WORDMARK, WORDMARK_VIEWBOX } from "./synq-logo.generated";

// Renders resized to over twice the height they're shown at (168-200 px), so the WebView decodes
// about a fifth of the pixels and they stay sharp at 200% Windows scaling. The full-size files stay
// alongside. The IEM and keyboard copies are lossless: lossy WebP's half-resolution colour smeared
// their saturated edges at this size. The mouse copy compares clean as lossy.
export { default as deviceMouse } from "@/assets/brand/device-mouse-h540.webp";
export { default as deviceKeyboard } from "@/assets/brand/device-keyboard-h400.webp";
export { default as deviceIems } from "@/assets/brand/device-iems-h400.webp";
// Friend's gear: the MAGIC-REFINER X68 HE and the Logitech PRO X SUPERLIGHT 2 (full-size files).
export { default as deviceKeyboardX68 } from "@/assets/brand/device-keyboard-x68he.webp";
export { default as deviceMouseSuperlight2 } from "@/assets/brand/device-mouse-superlight2.webp";

/**
 * The ATK X1 V2 Air+ render. Drop `src/assets/brand/device-mouse-atk-x1.webp` in (same framing as
 * device-mouse.webp: transparent background, mouse facing up) and it's used; until then, null.
 */
const atkRender = import.meta.glob<string>("../../assets/brand/device-mouse-atk-x1.webp", { eager: true, import: "default" });
export const deviceMouseAtk: string | null = Object.values(atkRender)[0] ?? null;

/**
 * Per-model renders for mice on the generic (OpenMouse) panel. Drop a file named
 * `src/assets/brand/models/<brand>-<model>.webp` (lower case, words joined by dashes, same framing
 * as device-mouse.webp), e.g. `razer-viper-v3-pro.webp`, and that model shows it; until then the
 * panel draws MouseOutline. Only the file's URL is bundled here, not the picture.
 */
const modelRenders = import.meta.glob<string>("../../assets/brand/models/*.webp", { eager: true, query: "?url", import: "default" });
const renderSlug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
export function modelRender(brand: string, model: string): string | null {
  const name = renderSlug(model.toLowerCase().startsWith(brand.toLowerCase()) ? model : `${brand} ${model}`);
  return modelRenders[`../../assets/brand/models/${name}.webp`] ?? null;
}

/** Stand-in for a mouse render: the mouse from the brand kit's plug-in drawing, without the cable. */
export function MouseOutline({ className }: { className?: string }) {
  return (
    <svg viewBox="236 160 157 246" className={cn("pointer-events-none", className)} aria-hidden="true">
      <g fill="none" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
        <path
          d="M251 239C251 197 278 174 314 174C352 174 378 202 378 244V329C378 369 348 391 314 391C277 391 251 365 251 329Z M314 175V247 M253 253H376"
          stroke="rgb(231 231 239 / 0.55)"
        />
        <rect x="306" y="201" width="16" height="34" rx="8" stroke="var(--primary)" />
      </g>
    </svg>
  );
}

/** Stand-in for a keyboard render: a 65% board drawn in the same line style as MouseOutline. */
export function KeyboardOutline({ className }: { className?: string }) {
  const rows = [14, 13, 12, 11];
  return (
    <svg viewBox="0 0 320 130" className={cn("pointer-events-none", className)} aria-hidden="true">
      <g fill="none" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" stroke="rgb(231 231 239 / 0.5)">
        <rect x="6" y="6" width="308" height="118" rx="16" />
        {rows.map((n, r) =>
          Array.from({ length: n }, (_, i) => {
            const w = (284 - (n - 1) * 5) / n;
            return <rect key={`${r}-${i}`} x={18 + i * (w + 5) + (r % 2 ? 4 : 0)} y={18 + r * 22} width={Math.max(8, w - (r % 2 ? 8 / n : 0))} height="16" rx="4" strokeWidth="1.8" />;
          }),
        )}
        <rect x="70" y="106" width="150" height="12" rx="4" stroke="var(--primary)" strokeWidth="1.8" />
      </g>
    </svg>
  );
}

/** Stand-in for the sound output: headphones in the same line style. */
export function SoundOutline({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 200 180" className={cn("pointer-events-none", className)} aria-hidden="true">
      <g fill="none" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" stroke="rgb(231 231 239 / 0.55)">
        <path d="M30 108V96a70 70 0 0 1 140 0v12" />
        <rect x="20" y="104" width="34" height="56" rx="14" />
        <rect x="146" y="104" width="34" height="56" rx="14" />
        <path d="M82 96c7 7 29 7 36 0M72 80c14 12 42 12 56 0" stroke="var(--primary)" />
      </g>
    </svg>
  );
}

/** The plug-in drawings' accent colour, swapped for the live accent. */
const BRAND_VIOLET = "#8B5CF6";
/** SYNQ's colour, the room light's sunset orange (branding/synq/build.py): the app icon's tile. */
export const SYNQ_ORANGE = "#FF5E3A";

/** SYNQ's mark: two links. The second takes the accent (the room light's colour by default) unless `mono`. */
export function Mark({ size = 20, className, mono }: { size?: number; className?: string; mono?: boolean }) {
  return (
    <svg viewBox={MARK_VIEWBOX} width={size} height={size} className={className} aria-hidden="true">
      <path d={MARK_LINKS[0]} fill="currentColor" />
      <path d={MARK_LINKS[1]} fill={mono ? "currentColor" : "var(--primary)"} />
    </svg>
  );
}

/** The word "synq" from the logo, in the text colour; `height` in pixels. */
export function Wordmark({ height = 18, className }: { height?: number; className?: string }) {
  const [, , w, h] = WORDMARK_VIEWBOX.split(" ").map(Number);
  return (
    <svg viewBox={WORDMARK_VIEWBOX} height={height} width={(height * w) / h} className={className} aria-hidden="true">
      <path d={WORDMARK} fill="currentColor" />
    </svg>
  );
}

/** The app icon as a live element: the orange tile with the mark in white. */
export function AppTile({ size = 32 }: { size?: number }) {
  return (
    <span className="grid shrink-0 place-items-center text-white" style={{ width: size, height: size, borderRadius: size * 0.22, background: SYNQ_ORANGE }}>
      <Mark size={size * 0.64} mono />
    </span>
  );
}

const PLUG = { mouse: plugMouse, keyboard: plugKeyboard, audio: plugAudio } as const;

/** Text-free connection drawing; its violet details follow the accent. */
export function PlugIn({ kind, className }: { kind: keyof typeof PLUG; className?: string }) {
  const svg = PLUG[kind].split(BRAND_VIOLET).join("var(--primary)").replace("<svg ", '<svg width="100%" height="100%" ');
  return <div className={cn("pointer-events-none", className)} aria-hidden="true" dangerouslySetInnerHTML={{ __html: svg }} />;
}
