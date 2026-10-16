// "Find lights": the only way SYNQ looks for Wi-Fi lights (src/lib/lighting/net/lights.ts), as a button (the Lights
// view, a Wi-Fi light's page) or as the quiet tile at the end of the Devices home. The first time, it says what it does
// and that Windows may ask about network access, before it asks the network anything.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { CircleNotch, WifiHigh } from "@phosphor-icons/react";
import { findLights, useNetFinding } from "@/lib/lighting/net/lights";
import { useKeptState } from "@/lib/keep";
import { cn } from "@/lib/utils";

/** The shared part: the first-time note, the find itself, and "none found" for a few seconds after. */
function useFind() {
  const finding = useNetFinding();
  const [told, setTold] = useKeptState<boolean>("lights.find.told", false);
  const [asking, setAsking] = useState(false);
  const [none, setNone] = useState(false);
  useEffect(() => {
    if (!none) return;
    const t = setTimeout(() => setNone(false), 4000);
    return () => clearTimeout(t);
  }, [none]);
  const find = () => {
    setAsking(false);
    setTold(true);
    void findLights().then((n) => setNone(n === 0));
  };
  return { finding, none, asking, setAsking, press: () => (told ? find() : setAsking((a) => !a)), find };
}

/** The note before the first find, under whatever opened it; it closes on a click elsewhere. */
function Note({ open, onFind, onClose, up, className, children }: { open: boolean; onFind: () => void; onClose: () => void; up?: boolean; className?: string; children: ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => !box.current?.contains(e.target as Node) && onClose();
    document.addEventListener("pointerdown", away);
    return () => document.removeEventListener("pointerdown", away);
  }, [open, onClose]);
  return (
    <div ref={box} className={cn("relative", className)}>
      {children}
      {open && (
        <div role="dialog" aria-label="Find lights" data-state="open" className={cn("absolute left-0 z-30 w-[340px] max-w-[calc(100vw-48px)] rounded-2xl bg-[#141418] p-4 text-[12.5px] leading-relaxed text-muted-foreground shadow-[0_18px_40px_-12px_rgb(0_0_0/0.8)] ring-1 ring-white/[0.1]", up ? "bottom-[calc(100%+8px)]" : "top-[calc(100%+8px)]")}>
          <p className="text-[13.5px] font-medium text-foreground">Find Wi-Fi lights</p>
          <p className="mt-1.5">SYNQ asks the devices on your home network which of them are lights, for a few seconds, only now. Nothing goes to the internet.</p>
          <p className="mt-1.5">Windows may ask whether SYNQ can use your network. SYNQ never changes your firewall settings.</p>
          <div className="mt-3 flex justify-end gap-2">
            <button type="button" onClick={onClose} className="rounded-full px-3 py-1 text-[12.5px] text-muted-foreground hover:text-foreground">
              Not now
            </button>
            <button type="button" onClick={onFind} data-testid="find-lights-go" className="rounded-full bg-primary/[0.15] px-3.5 py-1 text-[12.5px] text-foreground ring-1 ring-primary/40 hover:bg-primary/[0.22]">
              Find lights
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export function FindLights({ className }: { className?: string }) {
  const f = useFind();
  return (
    <Note open={f.asking} onFind={f.find} onClose={() => f.setAsking(false)} className={className}>
      <button
        type="button"
        disabled={f.finding}
        onClick={f.press}
        title="Ask your home network for Wi-Fi lights (Hue, Nanoleaf, LIFX, WiZ, Elgato, Twinkly, Yeelight) for a few seconds"
        data-testid="find-lights"
        className="group flex h-9 items-center gap-2 rounded-full bg-white/[0.05] pl-4 pr-1.5 text-[13px] text-foreground ring-1 ring-white/[0.08] transition-colors hover:bg-white/[0.08] disabled:cursor-wait"
      >
        {f.finding ? "Finding lights…" : f.none ? "No Wi-Fi lights found" : "Find lights"}
        <span className="grid size-6 place-items-center rounded-full bg-white/[0.08] text-primary">
          {f.finding ? <CircleNotch size={13} className="animate-spin" /> : <WifiHigh size={13} />}
        </span>
      </button>
    </Note>
  );
}

/** The Devices home's quiet tile at the end of the grid (the All and Lights views only). */
export function FindLightsTile() {
  const f = useFind();
  return (
    <Note open={f.asking} onFind={f.find} onClose={() => f.setAsking(false)} up className="h-full">
      <button
        type="button"
        disabled={f.finding}
        onClick={f.press}
        data-testid="find-lights-tile"
        className="flex h-full min-h-[160px] w-full flex-col items-center justify-center gap-1.5 rounded-[1.6rem] border border-dashed border-white/[0.12] p-5 text-muted-foreground transition-colors hover:border-white/[0.2] hover:text-foreground disabled:cursor-wait"
      >
        {f.finding ? <CircleNotch size={20} className="animate-spin" /> : <WifiHigh size={20} />}
        <span className="text-[13px]">{f.finding ? "Finding lights…" : f.none ? "No Wi-Fi lights found" : "Find Wi-Fi lights"}</span>
        <span className="text-[11.5px] text-muted-foreground/80">Hue, Nanoleaf, Elgato and more</span>
      </button>
    </Note>
  );
}
