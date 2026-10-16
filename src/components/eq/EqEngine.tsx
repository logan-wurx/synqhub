// The Sound page's view of the EQ engine (Equalizer APO under the hood on Windows, PipeWire's filter-chain
// on Linux): a status chip, a banner with one button when it can't play, and a details panel (outputs, undo,
// credits).
import { useEffect, useState, type ReactNode } from "react";
import { ArrowCounterClockwise, CaretDown, Warning, X } from "@phosphor-icons/react";
import { cn } from "@/lib/utils";
import type { EngineStatus } from "@/lib/backend";
import { Card } from "@/components/ui/matte";
import { openLink } from "@/lib/open-link";

export type EngineAction = { kind: "install" } | { kind: "setup"; output: string } | { kind: "undo" };

/** Linux: the engine is PipeWire's (the status says so). */
const onPipewire = (s: EngineStatus | null) => s?.backend === "pipewire";

/** Pill in the page header: "EQ engine: on · fifine output". Lit only while it runs. */
export function EngineChip({ status, open, onClick }: { status: EngineStatus | null; open: boolean; onClick: () => void }) {
  const on = status?.state === "active";
  return (
    <button
      onClick={onClick}
      aria-expanded={open}
      className="inline-flex items-center gap-2 rounded-full bg-white/[0.04] py-1 pl-2.5 pr-2.5 text-[12px] text-muted-foreground ring-1 ring-white/[0.06] transition-colors duration-300 ease-fluid hover:bg-white/[0.07] hover:text-foreground"
    >
      <span className={cn("size-1.5 rounded-full", !status ? "bg-white/15" : on ? "bg-primary shadow-[0_0_8px_var(--primary)]" : "bg-chart-3")} />
      <span>EQ engine: {status ? status.summary : "checking…"}</span>
      <CaretDown size={11} className={cn("transition-transform duration-300 ease-fluid", open && "rotate-180")} />
    </button>
  );
}

export function Banner({
  tone,
  children,
  action,
}: {
  tone: "warn" | "bad";
  children: ReactNode;
  action?: { label: string; busy?: boolean; onClick: () => void };
}) {
  return (
    <div
      className={cn(
        "flex items-center gap-3 rounded-2xl px-4 py-3 text-[13px] leading-relaxed ring-1",
        tone === "warn" ? "bg-chart-3/[0.06] text-chart-3 ring-chart-3/20" : "bg-destructive/[0.07] text-destructive ring-destructive/25",
      )}
    >
      <Warning size={18} weight="light" className="shrink-0" />
      <span className="flex-1">{children}</span>
      {action && (
        <button
          onClick={action.onClick}
          disabled={action.busy}
          className="shrink-0 rounded-full bg-foreground px-3.5 py-1.5 text-[12.5px] font-medium text-background transition-transform duration-300 ease-fluid active:scale-[0.97] disabled:opacity-50"
        >
          {action.busy ? "Working…" : action.label}
        </button>
      )}
    </div>
  );
}

/** One banner for whatever keeps the EQ from playing on the current output, with one button. */
export function EngineBanner({
  status,
  switched,
  busy,
  onAction,
}: {
  status: EngineStatus | null;
  switched: boolean;
  busy: boolean;
  onAction: (a: EngineAction) => void;
}) {
  if (!status || status.state === "active") return null;
  if (onPipewire(status)) return <PipewireBanner status={status} switched={switched} busy={busy} onAction={onAction} />;
  const d = status.defaultOutput;
  const prompt = "Windows asks for permission once, and your sound restarts for a moment.";
  switch (status.state) {
    case "missing":
      return (
        <Banner tone="warn" action={{ label: "Set it up", busy, onClick: () => onAction({ kind: "install" }) }}>
          The EQ engine isn't on this PC yet, so your EQ can't play. {prompt}
        </Banner>
      );
    case "notOnOutput": {
      if (!d) return null;
      const lead = switched ? `Your sound switched to ${d.name}.` : `Your sound is playing through ${d.name}.`;
      if (!d.canAdd) {
        return <Banner tone="warn">{lead} Windows doesn't allow sound effects on that output, so the EQ can't run there.</Banner>;
      }
      const elsewhere = status.outputs.filter((o) => o.engine).map((o) => o.short);
      return (
        <Banner tone="warn" action={{ label: "Set it up", busy, onClick: () => onAction({ kind: "setup", output: d.id }) }}>
          {lead} The EQ engine isn't on it{elsewhere.length ? ` (it's on ${elsewhere.join(", ")})` : ""}, so you're hearing it without your EQ.
        </Banner>
      );
    }
    case "disabled":
    case "broken": {
      const why =
        status.state === "disabled"
          ? `Windows has "Audio enhancements" turned off for ${d?.name ?? "this output"}, so it skips the EQ.`
          : (status.problems.find((p) => p.blocking)?.message ?? "Something keeps Windows from running the EQ.");
      return (
        <Banner tone="bad" action={d ? { label: "Fix it", busy, onClick: () => onAction({ kind: "setup", output: d.id }) } : undefined}>
          {why} {prompt}
        </Banner>
      );
    }
    case "noOutput":
      return <Banner tone="warn">No sound output is connected, so there's nothing to EQ right now.</Banner>;
  }
}

/** Linux: the same banner in PipeWire's terms. Setting up restarts the sound once; moving the EQ to another
 * output doesn't. No password is ever asked for. */
function PipewireBanner({ status, switched, busy, onAction }: { status: EngineStatus; switched: boolean; busy: boolean; onAction: (a: EngineAction) => void }) {
  const d = status.defaultOutput;
  const pw = status.pipewire;
  const restart = !pw?.filterLoaded;
  const prompt = restart ? "Your sound restarts for a moment." : "Nothing restarts.";
  switch (status.state) {
    case "missing":
      return <Banner tone="warn">{status.problems[0]?.message ?? "SYNQ's EQ runs inside PipeWire, and PipeWire isn't playing your sound here."}</Banner>;
    case "notOnOutput": {
      if (!d) return null;
      const lead = switched ? `Your sound switched to ${d.title}.` : `Your sound is playing through ${d.title}.`;
      const why = pw?.filterLoaded ? "SYNQ EQ isn't in front of it" : "SYNQ's EQ isn't set up yet";
      return (
        <Banner tone="warn" action={{ label: "Set it up", busy, onClick: () => onAction({ kind: "setup", output: d.id }) }}>
          {lead} {why}, so you're hearing it without your EQ. {prompt}
        </Banner>
      );
    }
    case "disabled":
    case "broken": {
      const blocking = status.problems.find((p) => p.blocking);
      const label = blocking?.code === "reloadNeeded" || blocking?.code === "notLoaded" ? "Restart sound" : "Fix it";
      // Set up again on the output you hear (or the EQ's own); with neither known, on PipeWire's default.
      const output = d?.id ?? pw?.target ?? null;
      const fix: EngineAction = output ? { kind: "setup", output } : { kind: "install" };
      return (
        <Banner tone="bad" action={{ label, busy, onClick: () => onAction(fix) }}>
          {blocking?.message ?? "Something keeps PipeWire from playing your EQ."} {label === "Restart sound" ? "Your sound restarts for a moment." : prompt}
        </Banner>
      );
    }
    case "noOutput":
      return <Banner tone="warn">No sound output is connected, so there's nothing to EQ right now.</Banner>;
  }
}

const SOURCE_URL = "https://sourceforge.net/projects/equalizerapo/";
const PIPEWIRE_URL = "https://pipewire.org/";


/** Outputs, undo and credits. Opens from the chip. */
export function EnginePanel({
  status,
  busy,
  onAction,
  onClose,
}: {
  status: EngineStatus;
  busy: boolean;
  onAction: (a: EngineAction) => void;
  onClose: () => void;
}) {
  const [license, setLicense] = useState(false);
  const warnings = status.problems.filter((p) => !p.blocking);
  const outputs = status.outputs.filter((o) => o.state !== "notPresent");
  if (onPipewire(status)) return <PipewirePanel status={status} busy={busy} onAction={onAction} onClose={onClose} />;
  return (
    <Card innerClassName="p-5">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h3 className="text-[14px] font-medium tracking-tight text-foreground">EQ engine</h3>
          <p className="mt-0.5 max-w-[620px] text-[12.5px] leading-relaxed text-muted-foreground">
            It runs inside Windows' own sound system, so nothing extra runs in the background. SYNQ installs it, puts it on your
            outputs and fixes it. Your EQ plays on every output that has it.
          </p>
        </div>
        <button onClick={onClose} aria-label="Close" className="rounded-full p-1.5 text-muted-foreground transition-colors hover:bg-white/[0.06] hover:text-foreground">
          <X size={15} />
        </button>
      </div>

      {status.installed && outputs.length > 0 && (
        <ul className="mt-4 divide-y divide-white/[0.05]">
          {outputs.map((o) => (
            <li key={o.id} className="flex items-center gap-3 py-2 text-[13px]">
              <span className={cn("size-1.5 shrink-0 rounded-full", o.engine ? "bg-primary shadow-[0_0_8px_var(--primary)]" : "bg-white/15")} />
              <span className="min-w-0 flex-1 truncate text-foreground">
                {o.name}
                {o.isDefault && <span className="ml-2 text-[11.5px] text-muted-foreground">playing now</span>}
              </span>
              <span className="text-[12px] text-muted-foreground">
                {o.engine ? (o.enhancementsDisabled ? "EQ blocked" : "EQ on") : o.state === "unplugged" ? "Unplugged" : o.state === "disabled" ? "Turned off" : "No EQ"}
              </span>
              {!o.engine && o.canAdd && (
                <button
                  disabled={busy}
                  onClick={() => onAction({ kind: "setup", output: o.id })}
                  className="rounded-full px-3 py-1 text-[12.5px] text-foreground ring-1 ring-white/10 transition-colors hover:bg-white/[0.06] disabled:opacity-40"
                >
                  Add
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      {warnings.length > 0 && (
        <ul className="mt-3 space-y-1 text-[12.5px] text-chart-3">
          {warnings.map((w) => (
            <li key={w.code}>{w.message}</li>
          ))}
        </ul>
      )}
      {status.inputsWithEngine.length > 0 && (
        <p className="mt-3 text-[12px] text-muted-foreground/80">Also on: {status.inputsWithEngine.join(", ")} (SYNQ leaves inputs alone).</p>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-white/[0.05] pt-3 text-[12px] text-muted-foreground">
        {status.canUndo && (
          <button
            disabled={busy}
            onClick={() => onAction({ kind: "undo" })}
            className="flex items-center gap-1.5 rounded-full px-3 py-1 text-[12.5px] text-foreground ring-1 ring-white/10 transition-colors hover:bg-white/[0.06] disabled:opacity-40"
          >
            <ArrowCounterClockwise size={13} /> Undo the last engine change
          </button>
        )}
        <span className="flex-1">
          EQ engine: Equalizer APO{status.version ? ` ${status.version}` : ""} by Jonas Thedering, free software under the GPL 2.0.
        </span>
        <button onClick={() => setLicense(true)} className="underline decoration-white/20 underline-offset-2 hover:text-foreground">
          License
        </button>
        <button onClick={() => openLink(SOURCE_URL)} className="underline decoration-white/20 underline-offset-2 hover:text-foreground">
          Source
        </button>
      </div>
      {license && <LicenseDialog onClose={() => setLicense(false)} />}
    </Card>
  );
}

/** Linux: outputs (the EQ plays into one of them at a time), undo, and what the engine is. */
function PipewirePanel({ status, busy, onAction, onClose }: { status: EngineStatus; busy: boolean; onAction: (a: EngineAction) => void; onClose: () => void }) {
  const pw = status.pipewire;
  const warnings = status.problems.filter((p) => !p.blocking);
  return (
    <Card innerClassName="p-5">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h3 className="text-[14px] font-medium tracking-tight text-foreground">EQ engine</h3>
          <p className="mt-0.5 max-w-[620px] text-[12.5px] leading-relaxed text-muted-foreground">
            It runs inside PipeWire, your desktop's sound system: a sound output called "SYNQ EQ" that plays into the output you pick, so nothing
            extra runs in the background. SYNQ writes its PipeWire config and makes it your default output; moving it to another output is
            instant.
          </p>
        </div>
        <button onClick={onClose} aria-label="Close" className="rounded-full p-1.5 text-muted-foreground transition-colors hover:bg-white/[0.06] hover:text-foreground">
          <X size={15} />
        </button>
      </div>

      {status.outputs.length > 0 && (
        <ul className="mt-4 divide-y divide-white/[0.05]">
          {status.outputs.map((o) => (
            <li key={o.id} className="flex items-center gap-3 py-2 text-[13px]">
              <span className={cn("size-1.5 shrink-0 rounded-full", o.engine ? "bg-primary shadow-[0_0_8px_var(--primary)]" : "bg-white/15")} />
              <span className="min-w-0 flex-1 truncate text-foreground">
                {o.title}
                {o.isDefault && <span className="ml-2 text-[11.5px] text-muted-foreground">playing now</span>}
              </span>
              <span className="text-[12px] text-muted-foreground">{o.engine ? "EQ on" : "No EQ"}</span>
              {!o.engine && (
                <button
                  disabled={busy}
                  onClick={() => onAction({ kind: "setup", output: o.id })}
                  className="rounded-full px-3 py-1 text-[12.5px] text-foreground ring-1 ring-white/10 transition-colors hover:bg-white/[0.06] disabled:opacity-40"
                >
                  Use
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      {warnings.length > 0 && (
        <ul className="mt-3 space-y-1 text-[12.5px] text-chart-3">
          {warnings.map((w) => (
            <li key={w.code}>{w.message}</li>
          ))}
        </ul>
      )}
      {pw?.configWritten && <p className="mt-3 break-all text-[12px] text-muted-foreground/80">Config: {pw.configPath}</p>}

      <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-white/[0.05] pt-3 text-[12px] text-muted-foreground">
        {status.canUndo && (
          <button
            disabled={busy}
            onClick={() => onAction({ kind: "undo" })}
            className="flex items-center gap-1.5 rounded-full px-3 py-1 text-[12.5px] text-foreground ring-1 ring-white/10 transition-colors hover:bg-white/[0.06] disabled:opacity-40"
          >
            <ArrowCounterClockwise size={13} /> Remove SYNQ's EQ
          </button>
        )}
        <span className="flex-1">
          EQ engine: PipeWire{pw?.version ? ` ${pw.version}` : ""} (its filter-chain and built-in biquad filters), part of your system. Nothing is bundled or
          installed.
        </span>
        <button onClick={() => openLink(PIPEWIRE_URL)} className="underline decoration-white/20 underline-offset-2 hover:text-foreground">
          About PipeWire
        </button>
      </div>
    </Card>
  );
}

/** The engine's license text, loaded only when opened. */
export function LicenseDialog({ onClose }: { onClose: () => void }) {
  const [text, setText] = useState<string | null>(null);
  useEffect(() => {
    void import("@/assets/licenses/equalizer-apo-GPL-2.0.txt?raw").then((m) => setText(m.default));
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-10 backdrop-blur-sm" onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} className="w-full max-w-[720px]">
        <Card innerClassName="flex max-h-[78vh] flex-col p-5">
          <div className="flex items-center justify-between pb-3">
            <h3 className="text-[14px] font-medium text-foreground">Equalizer APO license (GNU GPL 2.0)</h3>
            <button onClick={onClose} aria-label="Close" className="rounded-full p-1.5 text-muted-foreground transition-colors hover:bg-white/[0.06] hover:text-foreground">
              <X size={15} />
            </button>
          </div>
          <pre className="min-h-0 flex-1 overflow-y-auto whitespace-pre-wrap font-sans text-[12px] leading-relaxed text-muted-foreground">{text ?? "Loading…"}</pre>
        </Card>
      </div>
    </div>
  );
}
