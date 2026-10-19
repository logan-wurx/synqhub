// The colour wheel: hue around the disc, white at the centre, full colour at the rim (brightness is its own slider).
// Drag or click to pick; the arrow keys turn the hue (left / right) and the saturation (up / down). Pure UI.
import { useRef, type KeyboardEvent, type PointerEvent } from "react";
import type { Rgb } from "@/lib/lighting/govee/frames";
import { cn } from "@/lib/utils";

/** Hue (degrees, clockwise from the top: red, yellow on the right, ...) and saturation (0-1) of a colour. */
export function hueSat([r, g, b]: Rgb): { h: number; s: number } {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  if (max === 0 || d === 0) return { h: 0, s: 0 };
  const h = max === r ? ((g - b) / d + 6) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return { h: h * 60, s: d / max };
}

/** The full-brightness colour at a hue and saturation. */
export function fromHueSat(h: number, s: number): Rgb {
  const f = (n: number) => {
    const k = (n + h / 60) % 6;
    return Math.round(255 * (1 - s * Math.max(0, Math.min(k, 4 - k, 1))));
  };
  return [f(5), f(3), f(1)];
}

const DISC =
  "radial-gradient(circle closest-side, #fff, rgb(255 255 255 / 0)), conic-gradient(#f00, #ff0, #0f0, #0ff, #00f, #f0f, #f00)";

export function ColourWheel({
  value,
  onChange,
  onCommit,
  disabled,
  className,
}: {
  value: Rgb;
  /** Fires while dragging. */
  onChange: (rgb: Rgb) => void;
  /** Fires once when a drag or a key press ends. */
  onCommit?: (rgb: Rgb) => void;
  disabled?: boolean;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const last = useRef<Rgb>(value);
  const { h, s } = hueSat(value);

  const pick = (e: PointerEvent) => {
    const r = ref.current?.getBoundingClientRect();
    if (!r) return;
    const dx = e.clientX - (r.left + r.width / 2);
    const dy = e.clientY - (r.top + r.height / 2);
    const hue = ((Math.atan2(dx, -dy) * 180) / Math.PI + 360) % 360;
    const sat = Math.min(1, Math.hypot(dx, dy) / (r.width / 2));
    last.current = fromHueSat(hue, sat);
    onChange(last.current);
  };

  const key = (e: KeyboardEvent) => {
    const step = e.shiftKey ? 15 : 5;
    const next =
      e.key === "ArrowLeft" ? fromHueSat((h - step + 360) % 360, s || 1)
      : e.key === "ArrowRight" ? fromHueSat((h + step) % 360, s || 1)
      : e.key === "ArrowUp" ? fromHueSat(h, Math.min(1, s + step / 100))
      : e.key === "ArrowDown" ? fromHueSat(h, Math.max(0, s - step / 100))
      : null;
    if (!next) return;
    e.preventDefault();
    onChange(next);
    onCommit?.(next);
  };

  const rad = (h * Math.PI) / 180;
  return (
    <div
      ref={ref}
      role="slider"
      tabIndex={disabled ? -1 : 0}
      aria-label="Colour"
      aria-valuetext={`hue ${Math.round(h)} degrees, saturation ${Math.round(s * 100)}%`}
      aria-disabled={disabled}
      onPointerDown={(e) => {
        if (disabled) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        pick(e);
      }}
      onPointerMove={(e) => e.currentTarget.hasPointerCapture(e.pointerId) && pick(e)}
      onPointerUp={(e) => {
        if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
        e.currentTarget.releasePointerCapture(e.pointerId);
        onCommit?.(last.current);
      }}
      onKeyDown={key}
      className={cn(
        "relative aspect-square w-full touch-none rounded-full shadow-[inset_0_0_0_1px_rgb(255_255_255/0.12),0_18px_40px_-18px_rgb(0_0_0/0.9)] outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-4 focus-visible:ring-offset-background",
        disabled ? "cursor-not-allowed opacity-40 saturate-50" : "cursor-crosshair",
        className,
      )}
      style={{ background: DISC }}
    >
      <span
        aria-hidden="true"
        className="pointer-events-none absolute size-6 -translate-x-1/2 -translate-y-1/2 rounded-full ring-[3px] ring-white shadow-[0_2px_10px_rgb(0_0_0/0.55)]"
        style={{ left: `${50 + 50 * s * Math.sin(rad)}%`, top: `${50 - 50 * s * Math.cos(rad)}%`, background: `rgb(${value.join(" ")})` }}
      />
    </div>
  );
}
