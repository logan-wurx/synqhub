// "Keep your feel" on a device's Overview, in two pieces the panels place themselves:
//   FeelOffer  the calm "New mouse. Match your setup?" banner, which becomes the preview of the plan
//              (old -> new values) with an Apply button. Also what "Copy my feel here" opens.
//   FeelCard   the saved feel in a line, "Save as my feel" and "Copy my feel here"; `compact`, the same as one quiet
//              line inside the device's top card (its two actions as small text buttons).
// They read the device's kept view (what its panel already read) and never ask the device anything. Apply
// is the panel's own function: it goes through the same guarded session as a hand-made change, which
// backs up first, honours "Allow changes" and reads every change back.
import { Suspense, lazy, useEffect, useMemo, useRef, useState } from "react";
import { Check, Sparkle } from "@phosphor-icons/react";
import { Card } from "@/components/ui/matte";
import type { Notice } from "@/components/ui/matte";
import { Pill } from "@/components/keyboard/parts";
import { useKeptState } from "@/lib/keep";
import { describeKeyboard, describeMouse } from "@/lib/feel/devices";
import type { ApplyOutcome } from "@/lib/feel/drive";
import { openKey, useFeel } from "@/lib/feel/hooks";
import { mapKeyboard } from "@/lib/feel/keyboard";
import { mapMouse } from "@/lib/feel/mouse";
import { feelStore } from "@/lib/feel/persist";
import { keyboardSummary, mouseSummary } from "@/lib/feel/profile";
import { isOffered, type DeviceKind } from "@/lib/feel/store";
import { usePending, useResult } from "@/lib/feel/pending";
import type { KeyboardDevice, KeyboardFeel, MouseDevice, MouseFeel, Plan, Step } from "@/lib/feel/types";
import { OfferBanner } from "./parts";
import { PlanPreview, type FeelGate } from "./PlanPreview";

// A change waiting from a checkup's "Fix it" or a pro's setup: its own chunk, loaded only when one is waiting.
const PendingPlan = lazy(() => import("./PendingPlan").then((m) => ({ default: m.PendingPlan })));

export interface FeelDevice {
  /** The navigation id (`mouse:atk`, `kb:falchion`). */
  id: string;
  kind: DeviceKind;
  /** `logitech`, `atk`, `om:<vid>:<pid>`, `falchion`, `x68`, `kb:<vid>:<pid>`. */
  family: string;
  name: string;
  brand?: string;
  /** The view the panel keeps. */
  view: unknown;
  gate: FeelGate;
  /** Runs the steps through the panel's guarded session. */
  apply: (steps: Step[]) => Promise<ApplyOutcome<unknown>>;
  /** The session saves a backup of the device before its first change (the default). The Falchion keeps its own copy instead. */
  backup?: boolean;
  notify: (n: Omit<Notice, "id">, key?: string) => void;
}

const noun = (k: DeviceKind) => (k === "mouse" ? "mouse" : "keyboard");

function useFeelFor(dev: FeelDevice) {
  const feel = useFeel();
  const [open, setOpen] = useKeptState<boolean>(openKey(dev.id), false);
  const device = useMemo(() => (dev.kind === "mouse" ? describeMouse(dev.family, dev.view) : describeKeyboard(dev.family, dev.view)), [dev.kind, dev.family, dev.view]);
  const part = dev.kind === "mouse" ? feel.profile?.mouse : feel.profile?.keyboard;
  const sens = feel.profile?.sens;
  const plan: Plan | null = useMemo(() => {
    if (!device || !part) return null;
    return dev.kind === "mouse" ? mapMouse(part.feel as MouseFeel, device as MouseDevice, sens) : mapKeyboard(part.feel as KeyboardFeel, device as KeyboardDevice);
  }, [dev.kind, device, part, sens]);
  return { feel, open, setOpen, device, part, plan };
}

/** "14 Oct", or "today". */
function when(t: number): string {
  if (!t) return "";
  const d = new Date(t);
  return d.toDateString() === new Date().toDateString() ? "today" : d.toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

// ---------------------------------------------------------------------------------------------
// The offer
// ---------------------------------------------------------------------------------------------

/** The top of a device's Overview: a change waiting for this device, or else the saved feel's offer. */
export function FeelOffer(dev: FeelDevice) {
  const [pending] = usePending(dev.id);
  const [result] = useResult(dev.id);
  if (pending || result) {
    return (
      <Suspense fallback={null}>
        <PendingPlan {...dev} />
      </Suspense>
    );
  }
  return <SavedFeelOffer {...dev} />;
}

function SavedFeelOffer(dev: FeelDevice) {
  const { feel, open, setOpen, part, plan } = useFeelFor(dev);
  const [busy, setBusy] = useState(false);
  const top = useRef<HTMLDivElement>(null);
  const offered = isOffered(feel, { id: dev.id, kind: dev.kind, name: dev.name });
  const wasOpen = useRef(open);
  // Opening it from "Copy my feel here" further down brings the preview into view.
  useEffect(() => {
    if (open && !wasOpen.current) top.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    wasOpen.current = open;
  }, [open]);

  if (!part || !plan || !(open || offered)) return null;

  const close = () => {
    setOpen(false);
    void feelStore.markSeen(dev.id);
  };

  const apply = async () => {
    setBusy(true);
    try {
      const r = await dev.apply(plan.steps);
      if (r.ok) {
        setOpen(false);
        void feelStore.markSeen(dev.id);
        dev.notify({ title: `Your feel is on ${dev.name}`, detail: `${r.done} ${r.done === 1 ? "change" : "changes"} saved to the ${noun(dev.kind)}${dev.backup === false ? "" : ", backed up first"}`, tone: "ok" }, "feel");
      } else {
        dev.notify({ title: "Stopped part way", detail: `${r.done} of ${r.total} went through. ${r.error ?? ""}`.trim(), tone: "error" }, "feel");
      }
    } finally {
      setBusy(false);
    }
  };

  if (!open) {
    return (
      <div ref={top}>
        <OfferBanner
          title={`New ${noun(dev.kind)}. Match your setup?`}
          detail={`${dev.kind === "mouse" ? mouseSummary(part.feel as MouseFeel) : keyboardSummary(part.feel as KeyboardFeel)} · from the ${part.from.name}`}
          primary="Preview"
          onPrimary={() => setOpen(true)}
          onDismiss={close}
        />
      </div>
    );
  }

  return (
    <div ref={top} data-slot="feel-preview">
      <Card innerClassName="px-5 pb-5 pt-4">
        <div className="mb-3.5 flex items-center gap-2.5">
          <Sparkle size={16} weight="light" className="text-primary" />
          <h3 className="shrink-0 whitespace-nowrap text-[14px] font-medium tracking-tight text-high">Match your setup</h3>
          <span className="ml-auto truncate text-[11.5px] text-medium">your {noun(dev.kind)} feel, from the {part.from.name}</span>
        </div>
        <PlanPreview
          plan={plan}
          name={dev.name}
          sens={feel.profile?.sens ?? { cs2: null, valorant: null }}
          onSens={(s) => void feelStore.setSens(s)}
          gate={dev.gate}
          safety={dev.backup === false ? "The keyboard confirms each change." : undefined}
          busy={busy}
          onApply={() => void apply()}
          onClose={close}
        />
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// The card
// ---------------------------------------------------------------------------------------------

export function FeelCard({ compact = false, ...dev }: FeelDevice & { compact?: boolean }) {
  const { feel, open, setOpen, device, part, plan } = useFeelFor(dev);
  const now = device?.now ?? null;
  const summary = part ? (dev.kind === "mouse" ? mouseSummary(part.feel as MouseFeel) : keyboardSummary(part.feel as KeyboardFeel)) : null;
  const isSource = part?.from.deviceId === dev.id;
  // "Nothing to write" is either a device that already has it, or one that has none of it to set.
  const matches = !!part && !!plan && plan.nothingToDo && plan.rows.some((r) => r.status === "same");
  const nothingApplies = !!part && !!plan && plan.nothingToDo && !matches;

  const save = async () => {
    if (!now) return;
    if (dev.kind === "mouse") await feelStore.saveFrom("mouse", now as MouseFeel, { deviceId: dev.id, name: dev.name, brand: dev.brand });
    else await feelStore.saveFrom("keyboard", now as KeyboardFeel, { deviceId: dev.id, name: dev.name, brand: dev.brand });
    dev.notify({ title: "Saved as your feel", detail: `${dev.name}: ${dev.kind === "mouse" ? mouseSummary(now as MouseFeel) : keyboardSummary(now as KeyboardFeel)}`, tone: "ok" }, "feel");
  };

  if (compact) {
    const text = part && summary
      ? `${matches ? (isSource ? "This is your feel" : plan!.differences.length ? "As close to your feel as it goes" : "Matches your feel") : nothingApplies ? "Your feel doesn't apply here" : "Your feel"}: ${summary}, from the ${part.from.name}`
      : `Save this ${noun(dev.kind)}'s settings as your feel: a new one, from any brand, matches it in one click.`;
    const link = "shrink-0 rounded-small px-2.5 py-1 font-medium text-high ring-1 ring-white/[0.1] transition-colors duration-300 ease-fluid hover:bg-white/[0.07] disabled:text-faint";
    return (
      <div data-slot="feel-card" role="group" aria-label="Keep your feel" className="flex min-w-0 items-center gap-2.5 text-[12.5px]">
        {matches ? <Check size={12} className="shrink-0 text-primary" aria-hidden="true" /> : <Sparkle size={12} className="shrink-0 text-medium" aria-hidden="true" />}
        <span className="min-w-0 truncate text-medium" title={text}>
          {text}
        </span>
        {!matches && (
          <button type="button" onClick={() => void save()} disabled={!now} className={link}>
            Save as my feel
          </button>
        )}
        {part && !matches && !nothingApplies && plan && (
          <button type="button" onClick={() => setOpen(!open)} className={link}>
            {open ? "Hide preview" : "Copy my feel here"}
          </button>
        )}
        {feel.saveError && <span className="shrink-0 text-destructive">Couldn't keep it: {feel.saveError}</span>}
      </div>
    );
  }

  return (
    <section data-slot="feel-card" aria-label="Keep your feel">
      <p className="label-caps mb-3 px-1">Keep your feel</p>
      <div className="panel flex flex-wrap items-center gap-x-8 gap-y-4 rounded-card px-6 py-5">
        {part && summary ? (
          <div className="flex min-w-0 flex-1 basis-[320px] items-start gap-3">
            {matches && <Check size={16} weight="light" className="mt-0.5 shrink-0 text-primary" />}
            <div className="min-w-0">
              <p className="text-[15px] font-medium leading-snug text-high">
                {matches ? (isSource ? "This is your feel." : plan!.differences.length ? `Matched as closely as this ${noun(dev.kind)} allows.` : "This matches your feel.") : nothingApplies ? `Nothing in your feel can be set on this ${noun(dev.kind)}.` : `Your ${noun(dev.kind)} feel`}
              </p>
              <p className="mt-1 text-[13px] leading-relaxed text-medium">
                {summary} · from the {part.from.name}
                {part.from.savedAt ? `, saved ${when(part.from.savedAt)}` : ""}
              </p>
            </div>
          </div>
        ) : (
          <p className="min-w-0 flex-1 basis-[320px] text-[14px] leading-relaxed text-medium">
            Save this {noun(dev.kind)}'s settings once. When you get a new {noun(dev.kind)}, from any brand, SYNQ matches them in one click.
          </p>
        )}
        <div className="flex flex-wrap items-center gap-2">
          {!matches && (
            <Pill onClick={() => void save()} disabled={!now} primary={!part}>
              Save as my feel
            </Pill>
          )}
          {part && !matches && !nothingApplies && plan && (
            <Pill onClick={() => setOpen(!open)}>
              {open ? "Hide preview" : "Copy my feel here"}
            </Pill>
          )}
        </div>
        {feel.saveError && <p className="w-full text-[12px] text-destructive">Couldn't keep your feel on this PC: {feel.saveError}</p>}
        {!now && <p className="w-full text-[12px] text-medium">SYNQ hasn't read this {noun(dev.kind)}'s settings yet.</p>}
      </div>
    </section>
  );
}
