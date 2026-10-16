// Live key travel for the Actuation tab: one bar per pressed key, filling as the key goes down, with a
// line at that key's actuation point. It listens only while this component is mounted, which is only
// while the tab is on screen; the source also pauses itself when the window is hidden (live.ts).
// Read-only: nothing is sent to the keyboard.
import { useEffect, useState } from "react";
import type { LiveFrame } from "@/lib/kb/analogsense/live";
import { cn } from "@/lib/utils";

/** What the panel hands in: the AnalogLive object of src/lib/kb/analogsense/live.ts, or anything shaped like it. */
export interface LiveSource {
  start(onFrame: (f: LiveFrame) => void): Promise<void>;
  stop(): Promise<void>;
}

const HID_NAMES: Record<number, string> = {
  0x28: "Enter",
  0x29: "Esc",
  0x2a: "Bksp",
  0x2b: "Tab",
  0x2c: "Space",
  0x2d: "-",
  0x2e: "=",
  0x2f: "[",
  0x30: "]",
  0x31: "\\",
  0x33: ";",
  0x34: "'",
  0x35: "`",
  0x36: ",",
  0x37: ".",
  0x38: "/",
  0x39: "Caps",
  0x4f: "→",
  0x50: "←",
  0x51: "↓",
  0x52: "↑",
  0xe0: "Ctrl",
  0xe1: "Shift",
  0xe2: "Alt",
  0xe3: "Win",
  0xe5: "Shift",
  0x409: "Fn",
};

/** A short name for a HID usage (a scancode in a depth frame). */
export function scancodeName(code: number): string {
  if (code >= 0x04 && code <= 0x1d) return String.fromCharCode(65 + code - 0x04);
  if (code >= 0x1e && code <= 0x26) return String(code - 0x1d);
  if (code === 0x27) return "0";
  if (code >= 0x3a && code <= 0x45) return `F${code - 0x39}`;
  return HID_NAMES[code] ?? `0x${code.toString(16)}`;
}

const TRACK = 132;
const MAX_BARS = 10;

export function LiveTravel({
  open,
  travelMm,
  actuationMm,
  nameOf = scancodeName,
}: {
  /** Makes the source; must be stable between renders (the effect restarts when it changes). */
  open: () => LiveSource | null;
  /** The deepest a key goes. */
  travelMm: number;
  /** The actuation point of the key with this scancode, in mm (null: not known). */
  actuationMm: (scancode: number) => number | null;
  nameOf?: (scancode: number) => string;
}) {
  const [frame, setFrame] = useState<LiveFrame | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const src = open();
    if (!src) return;
    let alive = true;
    src.start((f) => alive && setFrame(f)).catch((e) => alive && setError(String(e).replace(/^Error: /, "")));
    return () => {
      alive = false;
      void src.stop().catch(() => undefined);
    };
  }, [open]);

  const pressed = frame ? [...frame.depth.entries()].filter(([, d]) => d > 0.01).sort((a, b) => a[0] - b[0]).slice(0, MAX_BARS) : [];

  return (
    <div className="px-5 pb-5 pt-4">
      {error ? (
        <p className="py-6 text-[13px] text-destructive">Live travel stopped: {error}</p>
      ) : (
        <div className="relative flex items-end gap-3 overflow-hidden rounded-2xl bg-black/35 px-4 pb-3 pt-4 ring-1 ring-white/[0.05]" style={{ minHeight: TRACK + 52 }} aria-live="off">
          {pressed.length === 0 && (
            <p className="absolute inset-0 grid place-items-center text-[12.5px] text-muted-foreground/80">Press a key to see how far it goes down.</p>
          )}
          {pressed.map(([code, depth]) => {
            const act = actuationMm(code);
            const mm = depth * travelMm;
            const hit = act !== null && mm >= act;
            return (
              <div key={code} className="flex w-12 flex-col items-center gap-1.5">
                <div className="relative w-7 overflow-hidden rounded-full bg-white/[0.05] ring-1 ring-white/[0.06]" style={{ height: TRACK }}>
                  <div
                    className={cn("absolute inset-x-0 top-0 rounded-b-full", hit ? "bg-primary shadow-[0_0_14px_var(--primary)]" : "bg-white/25")}
                    style={{ height: `${Math.min(100, depth * 100)}%` }}
                  />
                  {act !== null && (
                    <div className="absolute inset-x-0 h-[2px] -translate-y-1/2 bg-foreground/80" style={{ top: `${Math.min(100, (act / travelMm) * 100)}%` }} title={`Actuation ${act.toFixed(2)} mm`} />
                  )}
                </div>
                <span className="text-[12px] text-foreground">{nameOf(code)}</span>
                <span className="tabular text-[10.5px] text-muted-foreground">{mm.toFixed(2)}</span>
              </div>
            );
          })}
        </div>
      )}
      <p className="mt-2.5 text-[11.5px] text-muted-foreground/80">Live while this tab is open. The bright bar means the key passed its actuation line.</p>
    </div>
  );
}
