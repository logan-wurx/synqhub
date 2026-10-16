// A pro's setup side by side with yours: what you run, what they run, and what your own mouse or keyboard will be
// set to (the nearest value it offers, with the in-game sens that keeps their eDPI at that DPI). Only shows; the
// device's page applies it.
import { cn } from "@/lib/utils";
import { useFeel } from "@/lib/feel/hooks";
import { cs2FromValorant, edpi, valorantFromCs2 } from "@/lib/feel/sens";
import { fmtMm, fmtNum, hzText } from "@/lib/feel/units";
import type { KeyboardDevice, MouseDevice, Row } from "@/lib/feel/types";
import { GAME_NAME, planProKeyboard, planProMouse, proEdpi, type Pro } from "@/lib/pros/loadout";

interface Line {
  label: string;
  you: string;
  pro: string;
  /** On the person's device; undefined when no device is given (the column is left out). */
  mine?: string;
  /** The device can't do the pro's value exactly. */
  nearest?: boolean;
  note?: string;
}

const dash = "—";
const statusNearest = (r: Row | undefined) => r?.status === "adjusted" || r?.status === "approximate";

export function ProDiff({ pro, mouse, keyboard, name }: { pro: Pro; mouse?: { device: MouseDevice | null; name: string }; keyboard?: { device: KeyboardDevice | null; name: string }; name?: string }) {
  const feel = useFeel();
  const saved = feel.profile?.sens ?? { cs2: null, valorant: null };
  const yourSens = pro.game === "cs2" ? (saved.cs2 ?? (saved.valorant ? cs2FromValorant(saved.valorant) : null)) : (saved.valorant ?? (saved.cs2 ? valorantFromCs2(saved.cs2) : null));
  const lines: Line[] = [];
  const target = mouse ?? keyboard;
  const showMine = !!target?.device;

  if (mouse) {
    const d = mouse.device;
    const now = d?.now ?? feel.profile?.mouse?.feel ?? null;
    const yourDpi = now && now.stages.length ? now.stages[Math.min(now.active, now.stages.length - 1)] : null;
    const m = d ? planProMouse(pro, d) : null;
    const dpiRow = m?.plan.rows.find((r) => r.id === "dpi");
    const pollRow = m?.plan.rows.find((r) => r.id === "polling");
    lines.push({ label: "DPI", you: yourDpi !== null ? fmtNum(yourDpi) : dash, pro: fmtNum(pro.dpi), mine: m ? (m.dpi !== null ? fmtNum(m.dpi) : "Can't set") : undefined, nearest: statusNearest(dpiRow), note: dpiRow?.note });
    lines.push({
      label: "Polling",
      you: now?.pollingHz ? hzText(now.pollingHz) : dash,
      pro: hzText(pro.pollingHz),
      mine: m ? (pollRow?.to ?? "Can't set") : undefined,
      nearest: statusNearest(pollRow),
      note: pollRow?.note,
    });
    lines.push({
      label: `${GAME_NAME[pro.game]} sens`,
      you: yourSens !== null ? fmtNum(yourSens) : dash,
      pro: fmtNum(pro.sens),
      mine: m ? (m.sens !== null ? fmtNum(m.sens) : dash) : undefined,
      nearest: !!m && m.sens !== null && m.sens !== pro.sens,
      note: m && m.sens !== null && m.sens !== pro.sens ? `Your mouse runs ${fmtNum(m.dpi ?? 0)} DPI, so this sens gives ${pro.name}'s eDPI.` : undefined,
    });
    lines.push({ label: "eDPI", you: yourDpi !== null && yourSens !== null ? fmtNum(edpi(yourDpi, yourSens), 1) : dash, pro: fmtNum(proEdpi(pro), 1), mine: m ? (m.edpi !== null ? fmtNum(m.edpi, 1) : dash) : undefined });
  }

  if (keyboard) {
    const d = keyboard.device;
    const now = d?.now ?? feel.profile?.keyboard?.feel ?? null;
    const plan = d ? planProKeyboard(pro, d) : null;
    const act = plan?.rows.find((r) => r.id === "actuation");
    const rt = plan?.rows.find((r) => r.id === "rtSensitivity") ?? plan?.rows.find((r) => r.id === "rapidTrigger");
    if (pro.actuationMm !== undefined) {
      lines.push({ label: "Actuation", you: now?.actuationMm != null ? `${fmtMm(now.actuationMm)} mm` : dash, pro: `${fmtMm(pro.actuationMm)} mm`, mine: d ? (act?.to ?? "Can't set") : undefined, nearest: statusNearest(act), note: act?.note });
    }
    if (pro.rtMm !== undefined) {
      const rtOff = !!now && now.rapidTrigger !== null && !now.rapidTrigger;
      const yourRt = rtOff ? "Off" : now?.rtPressMm != null ? `${fmtMm(now.rtPressMm)} mm` : dash;
      lines.push({ label: "Rapid trigger", you: yourRt, pro: `${fmtMm(pro.rtMm)} mm`, mine: d ? (rt?.to ?? "Can't set") : undefined, nearest: statusNearest(rt), note: rt?.note });
    }
  }

  const cols = showMine ? "grid-cols-[minmax(0,1.1fr)_repeat(3,minmax(0,1fr))]" : "grid-cols-[minmax(0,1.1fr)_repeat(2,minmax(0,1fr))]";
  return (
    <div data-slot="pro-diff" className="text-[13px]">
      <div className={cn("grid gap-x-3 border-b border-white/[0.06] pb-2 text-[11.5px] text-muted-foreground", cols)}>
        <span />
        <span>You</span>
        <span className="truncate text-foreground/90">{pro.name}</span>
        {showMine && (
          <span className="truncate" title={`On your ${name ?? target?.name ?? "gear"}`}>
            On yours
          </span>
        )}
      </div>
      <ul className="divide-y divide-white/[0.04]">
        {lines.map((l) => (
          <li key={l.label} className={cn("grid items-baseline gap-x-3 py-2", cols)} title={l.note}>
            <span className="truncate text-[12.5px] text-muted-foreground">{l.label}</span>
            <span className="tabular truncate text-muted-foreground">{l.you}</span>
            <span className="tabular truncate text-foreground">{l.pro}</span>
            {showMine && <span className={cn("tabular truncate", l.nearest ? "text-chart-3" : "text-foreground")}>{l.mine}</span>}
          </li>
        ))}
      </ul>
      {showMine && lines.some((l) => l.nearest) && <p className="mt-2 text-[11.5px] leading-relaxed text-muted-foreground/80">Amber: the nearest your gear offers, or the sens that keeps {pro.name}'s eDPI at your DPI.</p>}
    </div>
  );
}
