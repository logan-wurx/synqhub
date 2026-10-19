// The tester's pictures: a stick (live dot, trail, the circularity it has drawn), trigger bars, the buttons and the
// motion readout. Pure drawing from the states link.ts hands over: nothing here talks to a device.
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { CIRCLE_BINS } from "@/lib/controllers/analysis";
import type { PadButton, PadState, StickState } from "@/lib/controllers/parse";

/** A stick: its gate, the centre cross, the trail of the last moments, the live dot, and the circle it has drawn. */
export function StickView({ label, stick, trail, bins, raw, testId }: { label: string; stick: StickState | null; trail: readonly StickState[]; bins?: readonly number[] | null; raw?: StickState | null; testId?: string }) {
  const R = 70;
  const at = (s: StickState) => [80 + s.x * R, 80 + s.y * R] as const;
  const poly = bins?.some((b) => b > 0)
    ? bins
        .map((r, i) => {
          const a = ((i + 0.5) / CIRCLE_BINS) * 2 * Math.PI;
          const rr = r > 0 ? r : 0;
          return `${80 + Math.cos(a) * rr * R},${80 + Math.sin(a) * rr * R}`;
        })
        .join(" ")
    : null;
  return (
    <figure className="flex flex-col items-center gap-2" data-testid={testId}>
      <svg viewBox="0 0 160 160" className="size-[176px]" role="img" aria-label={`${label} position`}>
        <circle cx="80" cy="80" r={R} fill="rgb(255 255 255 / 0.02)" stroke="rgb(255 255 255 / 0.12)" strokeWidth="1" />
        <circle cx="80" cy="80" r={R * 0.5} fill="none" stroke="rgb(255 255 255 / 0.05)" strokeWidth="1" />
        <path d="M80 10V150M10 80H150" stroke="rgb(255 255 255 / 0.06)" strokeWidth="1" />
        {poly && <polygon points={poly} fill="color-mix(in srgb, var(--primary) 8%, transparent)" stroke="color-mix(in srgb, var(--primary) 55%, transparent)" strokeWidth="1.2" />}
        {trail.length > 1 && (
          <polyline points={trail.map((s) => at(s).join(",")).join(" ")} fill="none" stroke="rgb(240 235 230 / 0.25)" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
        )}
        {stick && <circle cx={at(stick)[0]} cy={at(stick)[1]} r="6" fill="var(--primary)" className="drop-shadow-[0_0_6px_var(--primary)]" />}
      </svg>
      <figcaption className="text-center">
        <p className="text-[12.5px] text-high">{label}</p>
        <p className="tabular text-[11.5px] text-medium">
          {stick ? `${stick.x.toFixed(3)}, ${stick.y.toFixed(3)}` : "–"}
          {raw ? ` · raw ${raw.x}, ${raw.y}` : ""}
        </p>
      </figcaption>
    </figure>
  );
}

/** A trigger's travel with its raw value. */
export function TriggerBar({ label, value, raw, bits }: { label: string; value: number; raw?: number; bits?: number }) {
  return (
    <div className="min-w-0 flex-1">
      <div className="flex items-baseline justify-between text-[12.5px]">
        <span className="text-high">{label}</span>
        <span className="tabular text-medium">
          {Math.round(value * 100)}%{raw !== undefined ? ` · ${raw}` : ""}
          {bits ? ` (${bits}-bit)` : ""}
        </span>
      </div>
      <div className="mt-2 h-2.5 overflow-hidden rounded-full bg-white/[0.05] ring-1 ring-white/[0.06]">
        <div className="h-full rounded-full bg-primary/80" style={{ width: `${Math.max(0, Math.min(1, value)) * 100}%` }} />
      </div>
    </div>
  );
}

const SONY: Partial<Record<PadButton, string>> = { a: "✕", b: "○", x: "□", y: "△", view: "Create", menu: "Options", guide: "PS", lb: "L1", rb: "R1", lt: "L2", rt: "R2", ls: "L3", rs: "R3", p1: "LB", p2: "RB" };
const NINTENDO: Partial<Record<PadButton, string>> = { a: "A", b: "B", x: "X", y: "Y", view: "−", menu: "+", guide: "HOME", share: "Capture", lb: "L", rb: "R", lt: "ZL", rt: "ZR", ls: "LS", rs: "RS" };
const XBOX: Partial<Record<PadButton, string>> = { a: "A", b: "B", x: "X", y: "Y", view: "View", menu: "Menu", guide: "Guide", share: "Share", lb: "LB", rb: "RB", lt: "LT", rt: "RT", ls: "LS", rs: "RS" };

const ORDER: readonly PadButton[] = ["a", "b", "x", "y", "lb", "rb", "lt", "rt", "ls", "rs", "view", "menu", "guide", "share", "dUp", "dDown", "dLeft", "dRight", "p1", "p2", "p3", "p4", "touchpad", "mic", "fnL", "fnR", "sl", "sr"];
const ARROWS: Partial<Record<PadButton, string>> = { dUp: "↑", dDown: "↓", dLeft: "←", dRight: "→", touchpad: "Pad", mic: "Mic", fnL: "Fn L", fnR: "Fn R", p1: "P1", p2: "P2", p3: "P3", p4: "P4", sl: "SL", sr: "SR" };

/** Every button the pad reports, lit while held. */
export function ButtonGrid({ state, style, seen }: { state: PadState | null; style: "sony" | "nintendo" | "xbox"; seen: ReadonlySet<string> }) {
  const names = style === "sony" ? SONY : style === "nintendo" ? NINTENDO : XBOX;
  const present = ORDER.filter((b) => state && b in state.buttons);
  return (
    <div className="flex flex-wrap gap-2" data-testid="pad-buttons">
      {present.map((b) => {
        const on = !!state?.buttons[b];
        return (
          <span
            key={b}
            className={cn(
              "inline-flex h-8 min-w-10 items-center justify-center rounded-small px-2.5 text-[12px] ring-1 transition-colors duration-75",
              on ? "bg-primary/25 text-high ring-primary/60" : seen.has(b) ? "bg-white/[0.05] text-high ring-white/[0.12]" : "bg-white/[0.02] text-medium ring-white/[0.06]",
            )}
            title={seen.has(b) ? "Pressed at least once" : "Not pressed yet"}
          >
            {names[b] ?? ARROWS[b] ?? b}
          </span>
        );
      })}
      {present.length === 0 && <span className="text-[12.5px] text-medium">Press any button.</span>}
    </div>
  );
}

/** Three numbers in a row, one per axis. */
export function AxisReadout({ label, unit, v }: { label: string; unit: string; v?: readonly [number, number, number] | null }) {
  return (
    <div className="rounded-control bg-white/[0.025] px-4 py-3 ring-1 ring-white/[0.06]">
      <p className="text-[11.5px] text-medium">{label}</p>
      <p className="tabular mt-1 text-[14px] text-high">{v ? v.map((x) => x.toFixed(unit === "g" ? 3 : 1)).join("  ") : "–"}</p>
      <p className="text-[11px] text-medium">x y z, {unit}</p>
    </div>
  );
}

/** A labelled figure. */
export function Figure({ label, value, note, testId }: { label: string; value: ReactNode; note?: ReactNode; testId?: string }) {
  return (
    <div className="min-w-0 rounded-control bg-white/[0.025] px-4 py-3.5 ring-1 ring-white/[0.06]" data-testid={testId}>
      <p className="text-[11.5px] text-medium">{label}</p>
      <p className="tabular mt-1.5 truncate text-[19px] leading-none text-high">{value}</p>
      {note && <p className="mt-1.5 text-[11.5px] text-medium">{note}</p>}
    </div>
  );
}

/** The plain button the tester uses for its measurements and tests. */
export function ActionButton({ children, onClick, busy, disabled, testId }: { children: ReactNode; onClick: () => void; busy?: boolean; disabled?: boolean; testId?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled || busy}
      data-testid={testId}
      className="inline-flex items-center gap-2 rounded-small bg-white/[0.05] px-3.5 py-1.5 text-[12.5px] text-high ring-1 ring-white/[0.1] transition-colors duration-300 hover:bg-white/[0.09] disabled:cursor-not-allowed disabled:opacity-50"
    >
      {busy && <span className="size-2 animate-pulse rounded-full bg-primary" />}
      {children}
    </button>
  );
}
