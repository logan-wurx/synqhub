// The preview of a plan: what each setting is in your feel and what this device will be set to (old -> new),
// what couldn't be matched exactly, the in-game sensitivity to use when the DPI had to change, and the
// Apply button. It only shows a plan; running it is the device panel's job (src/components/feel/FeelPanel.tsx).
import { ArrowRight, Check, Warning } from "@phosphor-icons/react";
import { cn } from "@/lib/utils";
import { Switch } from "@/components/ui/switch";
import { Pill } from "@/components/keyboard/parts";
import { GAME_LABEL, type Game } from "@/lib/feel/sens";
import { fmtNum } from "@/lib/feel/units";
import type { GameSens, Plan, Row, RowStatus, SensAdvice, SensLine } from "@/lib/feel/types";
import { NumInput } from "./parts";

const STATUS: Record<RowStatus, { label: string; tone: string }> = {
  exact: { label: "Exact", tone: "text-primary" },
  same: { label: "Already set", tone: "text-medium" },
  adjusted: { label: "Nearest", tone: "text-chart-3" },
  approximate: { label: "Approximate", tone: "text-chart-3" },
  unavailable: { label: "Not available", tone: "text-medium" },
};

export interface FeelGate {
  /** Changes can be sent to this device right now. */
  writable: boolean;
  /** Why not, when they can't. */
  reason: string | null;
  /** The device's own "Allow changes" switch, for devices SYNQ hasn't been tried on. */
  allow?: { on: boolean; set: (on: boolean) => void };
  /** Some settings can be locked while others aren't: why this plan's steps can't all be written, if so. */
  check?: (steps: Plan["steps"]) => string | null;
}

export function PlanRows({ rows }: { rows: readonly Row[] }) {
  return (
    <ul className="divide-y divide-white/[0.05]">
      {rows.map((r) => {
        const s = STATUS[r.status];
        return (
          <li key={r.id} className="py-2.5 first:pt-0 last:pb-0" title={r.note}>
            <div className="flex items-baseline gap-2">
              <span className="text-[12.5px] text-medium">{r.label}</span>
              <span className={cn("ml-auto text-[10.5px] font-medium uppercase tracking-[0.12em]", s.tone)}>{s.label}</span>
            </div>
            <div className="mt-1 flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-[14px]">
              <span className="tabular text-medium">{r.from}</span>
              <ArrowRight size={12} className="self-center text-medium" aria-label="becomes" />
              {r.to === null ? (
                <span className="text-medium">Not available on this device</span>
              ) : (
                <span className={cn("tabular", r.status === "same" ? "text-medium" : "text-high")}>{r.to}</span>
              )}
              {r.now && <span className="tabular ml-auto text-[11.5px] text-medium">now {r.now}</span>}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

const DOT: Record<string, string> = { adjusted: "bg-chart-3", approximate: "bg-chart-3", dropped: "bg-chart-3" };

/** The differences in words: each setting that moved, and one line for everything this device doesn't have. */
export function Differences({ plan }: { plan: Plan }) {
  if (!plan.differences.length) return null;
  const moved = plan.differences.filter((d) => d.kind !== "unavailable");
  const missing = plan.differences.filter((d) => d.kind === "unavailable");
  return (
    <div>
      <p className="text-[12.5px] text-medium">What's different</p>
      <ul className="mt-2 space-y-1.5">
        {moved.map((d, i) => (
          <li key={i} className="flex gap-2.5 text-[12.5px] leading-relaxed text-medium">
            <span className={cn("mt-[7px] size-1.5 shrink-0 rounded-full", DOT[d.kind])} aria-hidden="true" />
            <span>
              <span className="text-high">{d.label}.</span> {d.reason}
            </span>
          </li>
        ))}
        {missing.length > 0 && (
          <li className="flex gap-2.5 text-[12.5px] leading-relaxed text-medium">
            <span className="mt-[7px] size-1.5 shrink-0 rounded-full bg-white/25" aria-hidden="true" />
            <span>
              <span className="text-high">Not available on this device:</span> {missing.map((d) => `${d.label} (${d.wanted})`).join(", ")}.
            </span>
          </li>
        )}
      </ul>
    </div>
  );
}

function SensRow({ game, line }: { game: Game; line: SensLine }) {
  return (
    <div className="grid grid-cols-[72px_1fr] items-baseline gap-x-3 py-1.5">
      <span className="text-[12.5px] text-medium">{GAME_LABEL[game]}</span>
      <div>
        <span className="tabular text-[15px] text-medium">{fmtNum(line.old)}</span>
        <ArrowRight size={12} className="mx-2 inline text-medium" aria-label="becomes" />
        <span className="tabular text-[17px] font-medium text-high">{fmtNum(line.next)}</span>
        <span className="ml-3 text-[11.5px] text-medium">
          eDPI {fmtNum(line.oldEdpi, 1)} to {fmtNum(line.newEdpi, 1)}
          {line.derived ? " · worked out from the other game" : ""}
        </span>
      </div>
    </div>
  );
}

/** What to set in the game after the DPI changed (or that nothing changes). */
export function SensBlock({ advice, sens, onSens }: { advice: SensAdvice; sens: GameSens; onSens?: (s: GameSens) => void }) {
  if (advice.exact) {
    return (
      <p className="flex items-center gap-2 text-[12.5px] text-medium">
        <Check size={12} className="text-primary" />
        Same DPI ({fmtNum(advice.newDpi)}), so your in-game sensitivity stays as it is.
      </p>
    );
  }
  return (
    <div>
      <p className="text-[12.5px] leading-relaxed text-medium">
        This mouse can't do exactly {fmtNum(advice.oldDpi)} DPI and runs <span className="tabular text-high">{fmtNum(advice.newDpi)}</span>. To keep your aim, set your sensitivity to your old one x {fmtNum(advice.oldDpi)} / {fmtNum(advice.newDpi)} (x {fmtNum(advice.factor, 4)}).
      </p>
      {advice.cs2 || advice.valorant ? (
        <div className="mt-2 divide-y divide-white/[0.04]">
          {advice.cs2 && <SensRow game="cs2" line={advice.cs2} />}
          {advice.valorant && <SensRow game="valorant" line={advice.valorant} />}
        </div>
      ) : (
        onSens && (
          <div className="mt-3 flex flex-wrap items-end gap-3">
            <NumInput label="Your CS2 sens" value={sens.cs2} placeholder="0.55" onCommit={(v) => onSens({ ...sens, cs2: v })} />
            <NumInput label="Your Valorant sens" value={sens.valorant} placeholder="0.173" onCommit={(v) => onSens({ ...sens, valorant: v })} />
            <p className="pb-2 text-[11.5px] text-medium">Type one and the new value shows here.</p>
          </div>
        )
      )}
    </div>
  );
}

/** The whole preview with its Apply button. */
export function PlanPreview({
  plan,
  name,
  sens,
  onSens,
  gate,
  safety = "Backed up first, and each change is read back.",
  busy,
  onApply,
  onClose,
}: {
  plan: Plan;
  /** The device's name, for the button. */
  name: string;
  sens: GameSens;
  onSens: (s: GameSens) => void;
  gate: FeelGate;
  /** One line under the buttons about what protects the device. */
  safety?: string;
  busy: boolean;
  onApply: () => void;
  onClose: () => void;
}) {
  const reason = !gate.writable ? (gate.reason ?? "This device can't be changed right now.") : (gate.check?.(plan.steps) ?? null);
  // A device with nothing to write needs no permission to write it.
  const blocked = reason !== null && !plan.nothingToDo;
  const changing = plan.rows.filter((r) => r.status === "exact" || r.status === "adjusted" || r.status === "approximate");
  const already = plan.rows.filter((r) => r.status === "same");
  return (
    <div className="space-y-4">
      {changing.length > 0 && <PlanRows rows={changing} />}
      {already.length > 0 && (
        <p className="flex items-start gap-2 text-[12.5px] leading-relaxed text-medium">
          <Check size={12} className="mt-0.5 shrink-0 text-primary" />
          <span>Already set: {already.map((r) => r.label).join(", ")}.</span>
        </p>
      )}
      <Differences plan={plan} />
      {plan.sens && <SensBlock advice={plan.sens} sens={sens} onSens={onSens} />}
      {blocked && (
        <div className="rounded-control bg-chart-3/[0.06] px-4 py-3 text-[12.5px] leading-relaxed text-chart-3 ring-1 ring-chart-3/20">
          <div className="flex gap-2.5">
            <Warning size={16} weight="light" className="mt-0.5 shrink-0" />
            <span className="min-w-0 flex-1">{reason}</span>
            {gate.allow && <Switch checked={gate.allow.on} onCheckedChange={gate.allow.set} aria-label="Allow changes" />}
          </div>
          {gate.allow && <p className="mt-1.5 pl-[26px] text-medium">Allow changes: SYNQ saves a backup before the first one and checks each by reading it back.</p>}
        </div>
      )}
      {/* Stays at the bottom of the column while the preview is longer than the window. */}
      <div className="sticky bottom-0 z-10 -mx-5 -mb-5 flex flex-wrap items-center gap-2.5 rounded-b-[17px] border-t border-white/[0.06] bg-[#161311]/95 px-5 pb-5 pt-3 backdrop-blur">
        {plan.nothingToDo ? (
          <p className="flex items-center gap-2 text-[13px] text-medium">
            {already.length > 0 ? (
              <>
                <Check size={14} className="shrink-0 text-primary" /> This device already matches your feel.
              </>
            ) : (
              "Nothing in your feel can be set on this device."
            )}
          </p>
        ) : (
          <Pill primary onClick={onApply} disabled={busy || blocked}>
            {busy ? "Applying…" : `Apply to ${name}`}
          </Pill>
        )}
        <Pill onClick={onClose} disabled={busy}>
          {plan.nothingToDo ? "Close" : "Not now"}
        </Pill>
        {!plan.nothingToDo && !blocked && <p className="text-[11.5px] text-medium">{safety}</p>}
      </div>
    </div>
  );
}
