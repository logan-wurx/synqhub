// A change asked for elsewhere, on the device's own Overview: a checkup's "Fix it" or a pro's setup picked on the
// Devices home (src/lib/feel/pending.ts). It is resolved against what this device offers, runs through the panel's
// guarded session (Allow changes, a backup before the first write, every change read back) and then offers Undo,
// which puts back what the device held before with the same mapping. Loaded only when something is waiting.
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ArrowCounterClockwise, Check, Copy, Stethoscope, Trophy, Warning, X } from "@phosphor-icons/react";
import { Card } from "@/components/ui/matte";
import { Switch } from "@/components/ui/switch";
import { Pill } from "@/components/keyboard/parts";
import { describeKeyboard, describeMouse } from "@/lib/feel/devices";
import { mapKeyboard } from "@/lib/feel/keyboard";
import { mapMouse } from "@/lib/feel/mouse";
import { keyboardSummary, mouseSummary } from "@/lib/feel/profile";
import { fmtNum } from "@/lib/feel/units";
import type { KeyboardDevice, KeyboardFeel, MouseDevice, MouseFeel, Step } from "@/lib/feel/types";
import { AUTO_MS, usePending, useResult, type AppliedResult, type Before, type PendingRequest } from "@/lib/feel/pending";
import { fixRows, isResolved, resolveKeyboardFix, resolveMouseFix } from "@/lib/checkup/fix";
import { GAME_NAME, planProKeyboard, planProMouse } from "@/lib/pros/loadout";
import { proById } from "@/lib/pros/data";
import { goCheckupResults } from "@/lib/nav";
import type { FeelDevice } from "./FeelPanel";
import { ProDiff } from "./ProDiff";

type Device = MouseDevice | KeyboardDevice;

interface Prepared {
  title: string;
  /** Under the title: where the request came from. */
  sub: string;
  icon: "fix" | "pro";
  steps: Step[];
  /** Why nothing can be written (the fix doesn't apply here), said plainly. */
  blocked: string | null;
  /** One line for the result: "Debounce 2 ms → 8 ms". */
  summary: string;
  body: ReactNode;
  sens?: AppliedResult["sens"];
}

function prepare(dev: FeelDevice, device: Device, req: PendingRequest): Prepared {
  if (req.kind === "fix") {
    const r = dev.kind === "mouse" ? resolveMouseFix(req.intent, device as MouseDevice) : resolveKeyboardFix(req.intent, device as KeyboardDevice);
    if (!isResolved(r)) return { title: "Fix from your checkup", sub: req.label, icon: "fix", steps: [], blocked: r.reason, summary: "", body: null };
    const rows = fixRows(r.steps, device.now as Parameters<typeof fixRows>[1]);
    return {
      title: "Fix from your checkup",
      sub: req.label,
      icon: "fix",
      steps: r.steps,
      blocked: null,
      summary: r.label,
      body: (
        <ul className="divide-y divide-white/[0.05]">
          {rows.map((row) => (
            <li key={row.label} className="flex items-baseline gap-3 py-2 first:pt-0 last:pb-0">
              <span className="text-[12.5px] text-muted-foreground">{row.label}</span>
              <span className="tabular ml-auto text-[14px] text-muted-foreground">{row.from}</span>
              <span className="text-muted-foreground/80">→</span>
              <span className="tabular text-[14px] text-foreground">{row.to}</span>
            </li>
          ))}
        </ul>
      ),
    };
  }
  const pro = proById(req.pro);
  if (!pro) return { title: "A pro's setup", sub: "", icon: "pro", steps: [], blocked: "That pro isn't in this version's list.", summary: "", body: null };
  const title = `${pro.name}'s setup`;
  const sub = `${GAME_NAME[pro.game]} · ${pro.team}`;
  if (dev.kind === "mouse") {
    const m = planProMouse(pro, device as MouseDevice);
    return {
      title,
      sub,
      icon: "pro",
      steps: m.plan.steps,
      blocked: m.plan.nothingToDo && !m.plan.rows.some((r) => r.status === "same") ? "Nothing in this setup can be set on this mouse." : null,
      summary: m.plan.rows.filter((r) => (r.id === "dpi" || r.id === "polling") && r.to !== null).map((r) => r.to).join(" · "),
      body: <ProDiff pro={pro} mouse={{ device: device as MouseDevice, name: dev.name }} />,
      sens: m.sens !== null && m.dpi !== null && m.edpi !== null ? { game: pro.game, value: m.sens, edpi: m.edpi, dpi: m.dpi } : undefined,
    };
  }
  const plan = planProKeyboard(pro, device as KeyboardDevice);
  return {
    title,
    sub,
    icon: "pro",
    steps: plan?.steps ?? [],
    blocked: !plan ? `${pro.name}'s keyboard settings aren't published.` : plan.nothingToDo && !plan.rows.some((r) => r.status === "same") ? "Nothing in this setup can be set on this keyboard." : null,
    summary: plan ? plan.rows.filter((r) => r.to !== null).map((r) => `${r.label} ${r.to}`).join(" · ") : "",
    body: <ProDiff pro={pro} keyboard={{ device: device as KeyboardDevice, name: dev.name }} />,
  };
}

function describe(dev: FeelDevice): Device | null {
  return dev.kind === "mouse" ? describeMouse(dev.family, dev.view) : describeKeyboard(dev.family, dev.view);
}

/** The value to type in game, with a copy button. */
function SensToType({ sens }: { sens: NonNullable<AppliedResult["sens"]> }) {
  const [copied, setCopied] = useState(false);
  const text = fmtNum(sens.value);
  const copy = () => {
    void navigator.clipboard?.writeText(text).then(
      () => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1600);
      },
      () => undefined,
    );
  };
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-2xl bg-white/[0.03] px-4 py-3 ring-1 ring-white/[0.06]">
      <div className="min-w-0">
        <p className="text-[12px] text-muted-foreground">In {GAME_NAME[sens.game]}, set sensitivity to</p>
        <p className="tabular mt-0.5 text-[24px] font-medium leading-none tracking-tight text-foreground">{text}</p>
      </div>
      <button
        onClick={copy}
        className="flex h-8 items-center gap-1.5 rounded-full bg-white/[0.06] px-3 text-[12px] text-foreground ring-1 ring-white/[0.08] transition-colors hover:bg-white/[0.1]"
        aria-label={`Copy ${text}`}
      >
        {copied ? <Check size={13} className="text-emerald-300" /> : <Copy size={13} />}
        {copied ? "Copied" : "Copy"}
      </button>
      <p className="basis-full text-[11.5px] text-muted-foreground/80">
        eDPI {fmtNum(sens.edpi, 1)} at {fmtNum(sens.dpi)} DPI. SYNQ doesn't edit game files: type it in the game's settings.
      </p>
    </div>
  );
}

export function PendingPlan(dev: FeelDevice) {
  const [pending, setPending] = usePending(dev.id);
  const [result, setResult] = useResult(dev.id);
  const [busy, setBusy] = useState(false);
  const top = useRef<HTMLDivElement>(null);
  const device = useMemo(() => describe(dev), [dev]);
  const prepared = useMemo(() => (pending && device ? prepare(dev, device, pending) : null), [dev, device, pending]);
  const gateReason = !dev.gate.writable ? (dev.gate.reason ?? "This device can't be changed right now.") : prepared ? (dev.gate.check?.(prepared.steps) ?? null) : null;
  const ran = useRef<number | null>(null);

  useEffect(() => {
    top.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [pending?.at]);

  const apply = async () => {
    if (!pending || !prepared || !device) return;
    setBusy(true);
    const before: Before | null = device.now ? (dev.kind === "mouse" ? { kind: "mouse", feel: device.now as MouseFeel } : { kind: "keyboard", feel: device.now as KeyboardFeel }) : null;
    try {
      const r = await dev.apply(prepared.steps);
      if (r.ok) {
        setPending(null);
        setResult({
          kind: pending.kind,
          title: pending.kind === "fix" ? "Fixed" : `${prepared.title} is on your ${dev.name}`,
          detail: prepared.summary,
          before,
          sens: prepared.sens,
          fromCheckup: pending.kind === "fix",
          ...(pending.kind === "fix" && pending.ref ? { ref: pending.ref } : {}),
        });
        dev.notify({ title: pending.kind === "fix" ? "Fixed" : `${prepared.title} applied`, detail: `${prepared.summary}${dev.backup ?? true ? ", backed up first" : ""}`, tone: "ok" }, "pending");
      } else {
        dev.notify({ title: "Stopped part way", detail: `${r.done} of ${r.total} went through. ${r.error ?? ""}`.trim(), tone: "error" }, "pending");
      }
    } finally {
      setBusy(false);
    }
  };

  // A request made a moment ago with "Fix it" or "Apply" runs by itself once the device is read and writable.
  const canAuto = !!pending?.auto && Date.now() - (pending?.at ?? 0) < AUTO_MS && !!prepared && !prepared.blocked && prepared.steps.length > 0 && gateReason === null;
  useEffect(() => {
    if (!canAuto || !pending || ran.current === pending.at) return;
    ran.current = pending.at;
    void apply();
    // apply reads the latest props; the request's time keys the one run.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canAuto, pending?.at]);

  const undo = async () => {
    if (!result?.before || !device) return;
    setBusy(true);
    try {
      const plan = result.before.kind === "mouse" ? mapMouse(result.before.feel, device as MouseDevice) : mapKeyboard(result.before.feel, device as KeyboardDevice);
      const r = await dev.apply(plan.steps);
      if (r.ok) {
        setResult({ ...result, undone: true });
        dev.notify({ title: "Put back", detail: result.before.kind === "mouse" ? mouseSummary(result.before.feel) : keyboardSummary(result.before.feel), tone: "ok" }, "pending");
      } else {
        dev.notify({ title: "Undo stopped part way", detail: `${r.done} of ${r.total} went back. ${r.error ?? ""}`.trim(), tone: "error" }, "pending");
      }
    } finally {
      setBusy(false);
    }
  };

  if (result && !pending) {
    return (
      <div ref={top} data-slot="pending-result">
        <Card innerClassName="space-y-3.5 px-5 py-4">
          <div className="flex items-start gap-2.5">
            <span className="mt-0.5 grid size-6 shrink-0 place-items-center rounded-full bg-emerald-300/[0.12] text-emerald-300 ring-1 ring-emerald-300/25">
              {result.undone ? <ArrowCounterClockwise size={13} /> : <Check size={13} />}
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-[14px] font-medium tracking-tight text-foreground">{result.undone ? "Put back as it was" : result.title}</p>
              <p className="mt-0.5 text-[12.5px] text-muted-foreground">
                {result.undone ? "Your settings from before are back on the device." : `${result.detail}${dev.backup ?? true ? " · backed up first, read back" : ""}`}
              </p>
            </div>
            <button onClick={() => setResult(null)} aria-label="Close" className="grid size-7 shrink-0 place-items-center rounded-full text-muted-foreground/80 transition-colors hover:bg-white/[0.06] hover:text-foreground">
              <X size={13} />
            </button>
          </div>
          {result.sens && !result.undone && <SensToType sens={result.sens} />}
          <div className="flex flex-wrap items-center gap-2">
            {!result.undone && result.before && (
              <Pill onClick={() => void undo()} disabled={busy}>
                {busy ? "Putting back…" : "Undo"}
              </Pill>
            )}
            {result.fromCheckup && <Pill onClick={goCheckupResults}>Back to checkup results</Pill>}
            {!result.before && !result.undone && <p className="text-[11.5px] text-muted-foreground/80">SYNQ couldn't read the old values, so there's no Undo here; the backup has them.</p>}
          </div>
        </Card>
      </div>
    );
  }

  if (!pending) return null;
  const close = () => setPending(null);
  const Icon = prepared?.icon === "pro" ? Trophy : Stethoscope;
  const blocked = prepared?.blocked ?? null;

  return (
    <div ref={top} data-slot="pending-plan">
      <Card innerClassName="px-5 pb-5 pt-4">
        <div className="mb-3.5 flex items-center gap-2.5">
          <Icon size={15} weight="light" className="text-primary" />
          <h3 className="shrink-0 whitespace-nowrap text-[14px] font-medium tracking-tight text-foreground">{prepared?.title ?? "Waiting for the device"}</h3>
          <span className="ml-auto truncate text-[11.5px] text-muted-foreground">{prepared?.sub}</span>
        </div>
        {!device ? (
          <p className="text-[12.5px] text-muted-foreground">SYNQ is reading the {dev.kind} first.</p>
        ) : blocked ? (
          <p className="flex items-start gap-2 text-[12.5px] leading-relaxed text-muted-foreground">
            <Warning size={15} weight="light" className="mt-0.5 shrink-0 text-chart-3" />
            {blocked}
          </p>
        ) : (
          <div className="space-y-4">
            {prepared?.body}
            {gateReason && (
              <div className="rounded-2xl bg-chart-3/[0.06] px-4 py-3 text-[12.5px] leading-relaxed text-chart-3 ring-1 ring-chart-3/20">
                <div className="flex gap-2.5">
                  <Warning size={16} weight="light" className="mt-0.5 shrink-0" />
                  <span className="min-w-0 flex-1">{gateReason}</span>
                  {dev.gate.allow && <Switch checked={dev.gate.allow.on} onCheckedChange={dev.gate.allow.set} aria-label="Allow changes" />}
                </div>
              </div>
            )}
          </div>
        )}
        <div className="mt-4 flex flex-wrap items-center gap-2.5 border-t border-white/[0.06] pt-3">
          {!blocked && device && prepared && prepared.steps.length > 0 && (
            <Pill primary onClick={() => void apply()} disabled={busy || gateReason !== null}>
              {busy ? "Applying…" : prepared.icon === "fix" ? "Apply fix" : `Apply to ${dev.name}`}
            </Pill>
          )}
          {!blocked && device && prepared && prepared.steps.length === 0 && (
            <p className="flex items-center gap-2 text-[13px] text-muted-foreground">
              <Check size={15} className="shrink-0 text-emerald-300" /> Already set that way.
            </p>
          )}
          <Pill onClick={close} disabled={busy}>
            {blocked || prepared?.steps.length === 0 ? "Close" : "Not now"}
          </Pill>
          {!blocked && prepared && prepared.steps.length > 0 && gateReason === null && (
            <p className="text-[11.5px] text-muted-foreground/80">{dev.backup ?? true ? "Backed up first, each change read back; Undo puts yours back." : "The device confirms each change; Undo puts yours back."}</p>
          )}
        </div>
      </Card>
    </div>
  );
}
