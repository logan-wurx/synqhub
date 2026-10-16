// The collapsible "Advanced" card at the bottom of every device panel. It shows the device's firmware and a
// link to the maker's own updater (SYNQ never flashes firmware), and unlocks the Advanced actions the
// device's driver really has: pairing, button / key changes, macros, switch calibration and a factory reset.
// Each action asks for its own confirmation (a tick; the word RESET for a reset), saves a backup first, and
// hands the driver a short-lived token (src/lib/advanced/core.ts). Actions the driver has no documented
// commands for are not offered; they are listed under "Not available" with the reason.
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { CaretDown, Warning } from "@phosphor-icons/react";
import { cn } from "@/lib/utils";
import { inTauri } from "@/lib/backend";
import { useKeptState } from "@/lib/keep";
import { Card, type Notice } from "@/components/ui/matte";
import { ADVANCED_SCOPES, type AdvancedScope } from "@/lib/advanced/core";
import { infoOnlyPanel } from "@/lib/advanced/panel";
import { splitVersion } from "@/lib/advanced/firmware";
import type {
  AdvancedPanel,
  ButtonsState,
  CalibrateProgress,
  KeymapAdvancedState,
  MacrosState,
  PairProgress,
} from "@/lib/advanced/types";

type Notify = (n: Omit<Notice, "id">, key?: string) => void;

const message = (e: unknown) => String(e).replace(/^Error: /, "");
const btn = "rounded-full bg-foreground px-3.5 py-1.5 text-[12.5px] font-medium text-background transition-opacity disabled:opacity-40";
const ghost = "rounded-full bg-white/[0.05] px-3.5 py-1.5 text-[12.5px] text-foreground ring-1 ring-white/[0.08] transition-colors hover:bg-white/[0.09] disabled:opacity-40";

const TITLES: Record<AdvancedScope, string> = {
  pair: "Pair with its receiver",
  remap: "Change buttons or keys",
  macros: "Macros",
  calibrate: "Calibrate switches",
  reset: "Factory reset",
};
const BLURBS: Record<AdvancedScope, string> = {
  pair: "Connect a wireless device to its receiver again, step by step.",
  remap: "Reassign what buttons or keys do. A backup is saved first, and Undo all puts everything back.",
  macros: "Write sequences the keyboard types for you. The other macros are left exactly as they are.",
  calibrate: "Teach the switches their full travel by pressing each one all the way down.",
  reset: "Put the device back to factory settings. Your settings are saved first so you can restore them.",
};

function openExternal(url: string) {
  if (inTauri) void import("@tauri-apps/plugin-opener").then((m) => m.openUrl(url));
  else window.open(url, "_blank", "noopener");
}

export function AdvancedCard({
  id,
  panel,
  lockedReason,
  onChanged,
  notify,
  hold = (p) => p,
  renderKeys,
}: {
  /** A key for this device, so what's open is remembered per device. */
  id: string;
  panel: AdvancedPanel;
  /** Why every action is shut (still read-only: "Allow changes" is off). */
  lockedReason?: string | null;
  /** Called after an action changed the device, so the panel reads it again. */
  onChanged?: () => void;
  notify: Notify;
  /** Wraps work in flight so the device session isn't closed under it. */
  hold?: <T>(p: Promise<T>) => Promise<T>;
  /** Keyboards: draws the board's keys so one can be picked. */
  renderKeys?: (o: { label: (index: number) => string; selected: number | null; onPick: (index: number) => void; indexes: readonly number[] }) => ReactNode;
}) {
  const [open, setOpen] = useKeptState(`adv.${id}.open`, false);
  const [unlocked, setUnlocked] = useKeptState(`adv.${id}.unlocked`, false);
  const [ack, setAck] = useState(false);
  const [which, setWhich] = useKeptState<AdvancedScope | null>(`adv.${id}.which`, null);
  const f = panel.features;
  const offered = ADVANCED_SCOPES.filter((s) => f[s].available && (s === "remap" ? panel.buttons || panel.keymap : s === "macros" ? panel.macros : panel[s === "pair" ? "pair" : s === "calibrate" ? "calibrate" : "reset"]));
  const hidden = ADVANCED_SCOPES.filter((s) => !offered.includes(s));

  return (
    <Card>
      <button onClick={() => setOpen(!open)} className="flex w-full items-center gap-3 px-5 py-4 text-left" aria-expanded={open}>
        <Warning size={18} weight="light" className="text-chart-3" />
        <span className="min-w-0 flex-1">
          <span className="block text-[14px] font-medium text-foreground">Advanced</span>
          <span className="block truncate text-[12.5px] text-muted-foreground">
            {offered.length ? `Firmware info, ${offered.map((s) => TITLES[s].toLowerCase()).join(", ")}` : "Firmware info and the maker's updater"}
          </span>
        </span>
        <CaretDown size={16} className={cn("text-muted-foreground transition-transform duration-500 ease-fluid", open && "rotate-180")} />
      </button>
      {open && (
        <div className="flex flex-col gap-5 px-5 pb-5">
          <Firmware panel={panel} />

          {offered.length > 0 && !unlocked && (
            <div className="rounded-2xl bg-chart-3/[0.05] px-4 py-3.5 ring-1 ring-chart-3/20">
              <p className="text-[13px] leading-relaxed text-chart-3">
                These actions change how your {panel.kind} behaves, and a factory reset wipes settings. SYNQ saves a backup before it changes anything and can put things back, but a mistake can still cost you a bit of setup.
              </p>
              {lockedReason ? (
                <p className="mt-2 text-[12.5px] text-muted-foreground">{lockedReason} Turn on "Allow changes" above first.</p>
              ) : (
                <div className="mt-3 flex flex-wrap items-center gap-3">
                  <label className="flex items-center gap-2 text-[12.5px] text-foreground">
                    <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} className="accent-[var(--primary)]" />I understand
                  </label>
                  <button className={btn} disabled={!ack} onClick={() => setUnlocked(true)}>
                    Unlock Advanced
                  </button>
                </div>
              )}
            </div>
          )}

          {offered.length > 0 && unlocked && (
            <div className="flex flex-col gap-2">
              {offered.map((s) => (
                <div key={s} className="rounded-2xl bg-white/[0.025] ring-1 ring-white/[0.06]">
                  <button onClick={() => setWhich(which === s ? null : s)} className="flex w-full items-center gap-3 px-4 py-3 text-left" aria-expanded={which === s}>
                    <span className="min-w-0 flex-1">
                      <span className="block text-[13.5px] text-foreground">{TITLES[s]}</span>
                      <span className="block text-[12px] text-muted-foreground">{BLURBS[s]}</span>
                    </span>
                    <CaretDown size={14} className={cn("text-muted-foreground transition-transform", which === s && "rotate-180")} />
                  </button>
                  {which === s && (
                    <div className="border-t border-white/[0.05] px-4 pb-4 pt-3">
                      <p className="mb-3 text-[11.5px] text-muted-foreground/80">Commands from {f[s].source}.</p>
                      {s === "pair" && panel.pair && <PairFlow api={panel.pair} {...{ hold, notify, onChanged }} />}
                      {s === "remap" && panel.buttons && <ButtonsFlow api={panel.buttons} {...{ hold, notify, onChanged }} />}
                      {s === "remap" && panel.keymap && <KeymapFlow api={panel.keymap} renderKeys={renderKeys} {...{ hold, notify, onChanged }} />}
                      {s === "macros" && panel.macros && <MacrosFlow api={panel.macros} {...{ hold, notify, onChanged }} />}
                      {s === "calibrate" && panel.calibrate && <CalibrateFlow api={panel.calibrate} {...{ hold, notify, onChanged }} />}
                      {s === "reset" && panel.reset && <ResetFlow api={panel.reset} {...{ hold, notify, onChanged }} />}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}

          {hidden.length > 0 && (
            <details className="text-[12.5px] text-muted-foreground">
              <summary className="cursor-pointer select-none hover:text-foreground">Not available on this {panel.kind}</summary>
              <ul className="mt-2 flex flex-col gap-1.5">
                {hidden.map((s) => (
                  <li key={s}>
                    <span className="text-foreground/80">{TITLES[s]}:</span> {f[s].why ?? "No documented commands."}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}
    </Card>
  );
}

type FlowProps = { hold: <T>(p: Promise<T>) => Promise<T>; notify: Notify; onChanged?: () => void };

function Firmware({ panel }: { panel: AdvancedPanel }) {
  const fw = panel.firmware;
  return (
    <div className="flex flex-wrap items-center gap-x-6 gap-y-2 rounded-2xl bg-white/[0.02] px-4 py-3 ring-1 ring-white/[0.05]">
      <div className="min-w-0 flex-1">
        <p className="text-[13px] text-foreground">Firmware</p>
        <p className="tabular text-[12.5px] text-muted-foreground">{fw.versions.length ? fw.versions.map((v) => (v.part === "Firmware" ? v.version : `${v.part} ${v.version}`)).join(" · ") : "This device didn't report a version."}</p>
        <p className="text-[12px] text-muted-foreground/80">
          {fw.latest ? `Newest known: ${fw.latest}.` : "SYNQ can't tell whether a newer version exists."} {fw.note}
        </p>
      </div>
      {fw.updater ? (
        <button className={ghost} onClick={() => openExternal(fw.updater!.url)} title={fw.updater.url}>
          Open {fw.updater.name}
        </button>
      ) : (
        <span className="text-[12px] text-muted-foreground">No official updater on record. Check the maker's website.</span>
      )}
    </div>
  );
}

function Tick({ checked, onChange, children }: { checked: boolean; onChange: (v: boolean) => void; children: ReactNode }) {
  return (
    <label className="flex items-start gap-2 text-[12.5px] leading-relaxed text-foreground">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="mt-0.5 accent-[var(--primary)]" />
      <span>{children}</span>
    </label>
  );
}

function Steps({ steps }: { steps: readonly string[] }) {
  return (
    <ol className="mb-3 list-decimal space-y-1 pl-5 text-[12.5px] text-muted-foreground">
      {steps.map((s) => (
        <li key={s}>{s}</li>
      ))}
    </ol>
  );
}

// ---- pairing

function PairFlow({ api, hold, notify, onChanged }: { api: NonNullable<AdvancedPanel["pair"]> } & FlowProps) {
  const [ack, setAck] = useState(false);
  const [p, setP] = useState<PairProgress | null>(null);
  const ctl = useRef<AbortController | null>(null);
  const running = p !== null && (p.phase === "starting" || p.phase === "waiting");
  useEffect(() => () => ctl.current?.abort(), []);
  const start = async () => {
    ctl.current = new AbortController();
    try {
      const done = await hold(api.run({ acknowledged: true }, setP, ctl.current.signal));
      if (done.phase === "paired") onChanged?.();
    } catch (e) {
      notify({ title: "Pairing didn't start", detail: message(e), tone: "error" }, "advanced");
      setP(null);
    }
  };
  return (
    <div>
      <Steps steps={api.steps} />
      <Tick checked={ack} onChange={setAck}>
        Start pairing now. The receiver listens for up to {api.timeoutSeconds} seconds, then stops by itself.
      </Tick>
      <div className="mt-3 flex items-center gap-3">
        {!running ? (
          <button className={btn} disabled={!ack} onClick={start}>
            Start pairing
          </button>
        ) : (
          <button className={ghost} onClick={() => ctl.current?.abort()}>
            Stop
          </button>
        )}
        {p && <span className={cn("text-[12.5px]", p.phase === "paired" ? "text-primary" : p.phase === "failed" || p.phase === "timeout" ? "text-destructive" : "text-muted-foreground")}>{p.message}</span>}
      </div>
    </div>
  );
}

// ---- mouse buttons

function ButtonsFlow({ api, hold, notify, onChanged }: { api: NonNullable<AdvancedPanel["buttons"]> } & FlowProps) {
  const [ack, setAck] = useState(false);
  const [st, setSt] = useState<ButtonsState | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async (work: () => Promise<ButtonsState | void>, ok?: string) => {
    setBusy(true);
    try {
      const next = await hold(work());
      if (next) setSt(next);
      if (ok) notify({ title: ok, tone: "ok" }, "advanced");
    } catch (e) {
      notify({ title: "Not changed", detail: message(e), tone: "error" }, "advanced");
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => () => void api.end().catch(() => undefined), [api]);
  if (!st)
    return (
      <div className="flex flex-col gap-3">
        <Tick checked={ack} onChange={setAck}>
          Save a backup of the buttons, then let me change them. The left button always stays left click.
        </Tick>
        <div>
          <button className={btn} disabled={!ack || busy} onClick={() => run(() => api.begin({ acknowledged: true }))}>
            Start button changes
          </button>
        </div>
      </div>
    );
  return (
    <div className="flex flex-col gap-2">
      {st.slots.map((s) => (
        <div key={s.id} className="flex items-center gap-3 text-[13px]">
          <span className="w-44 shrink-0 text-foreground">
            {s.label}
            {s.changed && <span className="ml-2 text-[11px] text-chart-3">changed</span>}
          </span>
          <select
            disabled={s.locked || busy}
            value={s.action ?? ""}
            title={s.lockedWhy}
            onChange={(e) => run(() => api.set(s.id, e.target.value), `${s.label}: ${s.choices.find((c) => c.id === e.target.value)?.label ?? ""}`)}
            className="h-8 min-w-44 rounded-full bg-white/[0.05] px-3 text-[12.5px] text-foreground ring-1 ring-white/[0.08] disabled:opacity-60"
          >
            {s.action === null && <option value="">{s.actionLabel}</option>}
            {s.choices.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </select>
          {s.locked && s.lockedWhy && <span className="text-[11.5px] text-muted-foreground">{s.lockedWhy}</span>}
        </div>
      ))}
      <div className="mt-2 flex items-center gap-3">
        <button className={ghost} disabled={busy || !st.slots.some((s) => s.changed)} onClick={() => run(() => api.undoAll(), "Buttons put back")}>
          Undo all
        </button>
        <button
          className={btn}
          disabled={busy}
          onClick={async () => {
            await api.end();
            setSt(null);
            setAck(false);
            onChanged?.();
          }}
        >
          Done
        </button>
        <span className="text-[11.5px] text-muted-foreground">Backup: {st.backupPath}</span>
      </div>
    </div>
  );
}

// ---- keyboard keys

function KeymapFlow({ api, hold, notify, onChanged, renderKeys }: { api: NonNullable<AdvancedPanel["keymap"]>; renderKeys: Parameters<typeof AdvancedCard>[0]["renderKeys"] } & FlowProps) {
  const [ack, setAck] = useState(false);
  const [st, setSt] = useState<KeymapAdvancedState | null>(null);
  const [layer, setLayer] = useState(0);
  const [key, setKey] = useState<number | null>(null);
  const [hexCode, setHexCode] = useState("");
  const [busy, setBusy] = useState(false);
  const run = async (work: () => Promise<KeymapAdvancedState>, ok?: string) => {
    setBusy(true);
    try {
      setSt(await hold(work()));
      if (ok) notify({ title: ok, tone: "ok" }, "advanced");
    } catch (e) {
      notify({ title: "Not changed", detail: message(e), tone: "error" }, "advanced");
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => () => void api.end().catch(() => undefined), [api]);
  if (!st)
    return (
      <div className="flex flex-col gap-3">
        <Tick checked={ack} onChange={setAck}>
          Save a backup of every key, then let me change them. Bootloader, reboot and reset keys are never offered, and the keyboard always keeps a way back.
        </Tick>
        <div>
          <button className={btn} disabled={!ack || busy} onClick={() => run(() => api.begin({ acknowledged: true }))}>
            Start key changes
          </button>
        </div>
      </div>
    );
  const codes = st.codes[layer] ?? {};
  const indexes = Object.keys(codes).map(Number);
  const groups = [...new Set(st.choices.map((c) => c.group))];
  const apply = (code: number) => key !== null && run(() => api.set(layer, key, code), `Layer ${layer}: ${api.label(codes[key] ?? 0) || "none"} → ${api.label(code) || "none"}`);
  const typed = /^0x[0-9a-f]{1,4}$/i.test(hexCode.trim()) ? parseInt(hexCode.trim().slice(2), 16) : null;
  const typedProblem = typed !== null && key !== null ? api.problem(layer, key, typed) : null;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-1.5">
        {Array.from({ length: st.layers }, (_, l) => (
          <button key={l} onClick={() => setLayer(l)} className={cn("rounded-full px-3 py-1 text-[12px] ring-1", l === layer ? "bg-primary text-primary-foreground ring-primary" : "bg-white/[0.04] text-muted-foreground ring-white/[0.07]")}>
            Layer {l}
            {st.changed[l]?.length ? ` · ${st.changed[l].length} changed` : ""}
          </button>
        ))}
      </div>
      {renderKeys?.({ label: (i) => api.label(codes[i] ?? 0), selected: key, onPick: setKey, indexes })}
      {key !== null ? (
        <div className="flex flex-col gap-2 rounded-2xl bg-white/[0.02] p-3 ring-1 ring-white/[0.05]">
          <p className="text-[12.5px] text-foreground">
            Key {key} on layer {layer}: <span className="text-muted-foreground">{api.label(codes[key] ?? 0) || "none"}</span>
          </p>
          <div className="flex max-h-40 flex-col gap-2 overflow-y-auto">
            {groups.map((g) => (
              <div key={g} className="flex flex-wrap items-center gap-1">
                <span className="w-20 shrink-0 text-[11px] text-muted-foreground">{g}</span>
                {st.choices
                  .filter((c) => c.group === g)
                  .map((c) => (
                    <button key={`${g}${c.code}`} disabled={busy} onClick={() => apply(c.code)} className="rounded-md bg-white/[0.05] px-2 py-0.5 text-[11.5px] text-foreground ring-1 ring-white/[0.07] hover:bg-white/[0.1]">
                      {c.label}
                    </button>
                  ))}
              </div>
            ))}
          </div>
          <div className="flex items-center gap-2">
            <input value={hexCode} onChange={(e) => setHexCode(e.target.value)} placeholder="or a key code, e.g. 0x5221" aria-label="Key code" className="h-8 w-48 rounded-full bg-white/[0.05] px-3 text-[12.5px] text-foreground ring-1 ring-white/[0.08]" />
            <button className={ghost} disabled={busy || typed === null || !!typedProblem} onClick={() => typed !== null && apply(typed)}>
              Set
            </button>
            {typedProblem && <span className="text-[11.5px] text-destructive">{typedProblem}</span>}
          </div>
        </div>
      ) : (
        <p className="text-[12.5px] text-muted-foreground">Pick a key above.</p>
      )}
      <div className="flex items-center gap-3">
        <button className={ghost} disabled={busy || !st.changed.some((c) => c.length)} onClick={() => run(() => api.undoAll(), "Keys put back")}>
          Undo all
        </button>
        <button
          className={btn}
          disabled={busy}
          onClick={async () => {
            await api.end();
            setSt(null);
            setAck(false);
            setKey(null);
            onChanged?.();
          }}
        >
          Done
        </button>
        <span className="truncate text-[11.5px] text-muted-foreground">Backup: {st.backupPath}</span>
      </div>
    </div>
  );
}

// ---- macros

function MacrosFlow({ api, hold, notify, onChanged }: { api: NonNullable<AdvancedPanel["macros"]> } & FlowProps) {
  const [ack, setAck] = useState(false);
  const [st, setSt] = useState<MacrosState | null>(null);
  const [drafts, setDrafts] = useState<Record<number, string>>({});
  const [busy, setBusy] = useState(false);
  const run = async (work: () => Promise<MacrosState>, ok?: string) => {
    setBusy(true);
    try {
      const next = await hold(work());
      setSt(next);
      setDrafts({});
      if (ok) notify({ title: ok, tone: "ok" }, "advanced");
    } catch (e) {
      notify({ title: "Not saved", detail: message(e), tone: "error" }, "advanced");
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => () => void api.end().catch(() => undefined), [api]);
  if (!st)
    return (
      <div className="flex flex-col gap-3">
        <Tick checked={ack} onChange={setAck}>
          Save a backup of the macros, then let me edit them. Macros I can't show are left alone.
        </Tick>
        <div>
          <button className={btn} disabled={!ack || busy} onClick={() => run(() => api.begin({ acknowledged: true }))}>
            Start macro changes
          </button>
        </div>
      </div>
    );
  return (
    <div className="flex flex-col gap-2">
      <p className="text-[11.5px] text-muted-foreground">
        Plain text types itself. {"{Enter}"} taps a key, {"{down Shift}"} / {"{up Shift}"} hold and release, {"{wait 100}"} waits 100 ms. {st.used} of {st.capacity} bytes used.
      </p>
      {st.slots.map((s) => {
        const draft = drafts[s.index] ?? s.text;
        const c = api.check(draft);
        return (
          <div key={s.index} className="flex items-center gap-2">
            <span className="tabular w-14 shrink-0 text-[12.5px] text-muted-foreground">Macro {s.index}</span>
            <input
              aria-label={`Macro ${s.index}`}
              disabled={!s.editable || busy}
              value={s.editable ? draft : "(has actions SYNQ can't show)"}
              onChange={(e) => setDrafts({ ...drafts, [s.index]: e.target.value })}
              className="h-8 min-w-0 flex-1 rounded-full bg-white/[0.05] px-3 text-[12.5px] text-foreground ring-1 ring-white/[0.08] disabled:opacity-60"
            />
            <span className={cn("w-28 shrink-0 truncate text-[11.5px]", c.error ? "text-destructive" : "text-muted-foreground")} title={c.error ?? ""}>
              {c.error ? "Not valid" : `${c.bytes} bytes`}
            </span>
            <button className={ghost} disabled={busy || !s.editable || drafts[s.index] === undefined || !!c.error} onClick={() => run(() => api.save(s.index, draft), `Macro ${s.index} saved`)}>
              Save
            </button>
          </div>
        );
      })}
      <div className="mt-2 flex items-center gap-3">
        <button className={ghost} disabled={busy} onClick={() => run(() => api.undoAll(), "Macros put back")}>
          Undo all
        </button>
        <button
          className={btn}
          disabled={busy}
          onClick={async () => {
            await api.end();
            setSt(null);
            setAck(false);
            onChanged?.();
          }}
        >
          Done
        </button>
        <span className="truncate text-[11.5px] text-muted-foreground">Backup: {st.backupPath}</span>
      </div>
    </div>
  );
}

// ---- calibration

function CalibrateFlow({ api, hold, notify, onChanged }: { api: NonNullable<AdvancedPanel["calibrate"]> } & FlowProps) {
  const [ack, setAck] = useState(false);
  const [p, setP] = useState<CalibrateProgress | null>(null);
  const ctl = useRef<AbortController | null>(null);
  const running = p !== null && (p.phase === "starting" || p.phase === "pressing" || p.phase === "saving");
  useEffect(() => () => ctl.current?.abort(), []);
  const start = async () => {
    ctl.current = new AbortController();
    try {
      const done = await hold(api.run({ acknowledged: true }, setP, ctl.current.signal));
      if (done.phase === "done") onChanged?.();
    } catch (e) {
      notify({ title: "Calibration didn't start", detail: message(e), tone: "error" }, "advanced");
      setP(null);
    }
  };
  const done = p?.targets.filter((t) => t.state === "done").length ?? 0;
  return (
    <div>
      <Steps steps={api.steps} />
      <p className="mb-3 text-[11.5px] text-muted-foreground">{api.restoreNote}</p>
      <Tick checked={ack} onChange={setAck}>
        Save a backup and start calibrating. I'll stop if anything looks wrong, and it times out after {Math.round(api.timeoutSeconds / 60)} minutes.
      </Tick>
      <div className="mt-3 flex items-center gap-3">
        {!running ? (
          <button className={btn} disabled={!ack} onClick={start}>
            Start calibration
          </button>
        ) : (
          <button className={ghost} onClick={() => ctl.current?.abort()}>
            Stop
          </button>
        )}
        {p && <span className={cn("text-[12.5px]", p.phase === "done" ? "text-primary" : p.phase === "failed" ? "text-destructive" : "text-muted-foreground")}>{p.message}</span>}
      </div>
      {p && p.targets.length > 0 && (
        <div className="mt-3">
          <div className="mb-2 h-1.5 overflow-hidden rounded-full bg-white/[0.06]">
            <div className="h-full rounded-full bg-primary transition-[width] duration-300" style={{ width: `${(done / p.targets.length) * 100}%` }} />
          </div>
          <div className="flex flex-wrap gap-1">
            {p.targets.map((t) => (
              <span key={t.id} className={cn("rounded-md px-1.5 py-0.5 text-[11px] ring-1", t.state === "done" ? "bg-primary/15 text-primary ring-primary/30" : t.state === "partial" ? "bg-chart-3/10 text-chart-3 ring-chart-3/25" : "bg-white/[0.03] text-muted-foreground ring-white/[0.06]")}>
                {t.label}
              </span>
            ))}
          </div>
          <p className="mt-1.5 text-[11.5px] text-muted-foreground">
            {done} of {p.targets.length} pressed fully{p.backupPath ? ` · backup: ${p.backupPath}` : ""}
          </p>
        </div>
      )}
    </div>
  );
}

// ---- factory reset

function ResetFlow({ api, hold, notify, onChanged }: { api: NonNullable<AdvancedPanel["reset"]> } & FlowProps) {
  const [ack, setAck] = useState(false);
  const [word, setWord] = useState("");
  const [busy, setBusy] = useState(false);
  const [path, setPath] = useState<string | null>(null);
  const [restoreAck, setRestoreAck] = useState(false);
  const go = async (work: () => Promise<void>, ok: string) => {
    setBusy(true);
    try {
      await hold(work());
      notify({ title: ok, tone: "ok" }, "advanced");
      onChanged?.();
    } catch (e) {
      notify({ title: "Not done", detail: message(e), tone: "error" }, "advanced");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex flex-col gap-3">
      <ul className="list-disc space-y-1 pl-5 text-[12.5px] text-muted-foreground">
        {api.wipes.map((w) => (
          <li key={w}>{w}</li>
        ))}
      </ul>
      <Tick checked={ack} onChange={setAck}>
        Save a full backup of my settings first, then reset.
      </Tick>
      <div className="flex flex-wrap items-center gap-3">
        <input value={word} onChange={(e) => setWord(e.target.value)} placeholder="Type RESET to confirm" aria-label="Type RESET to confirm" className="h-8 w-48 rounded-full bg-white/[0.05] px-3 text-[12.5px] text-foreground ring-1 ring-white/[0.08]" />
        <button
          className={cn(btn, "bg-destructive text-white")}
          disabled={!ack || word !== "RESET" || busy}
          onClick={() =>
            go(async () => {
              const r = await api.reset({ acknowledged: true, typed: word });
              setPath(r.backupPath);
              setWord("");
              setAck(false);
            }, "Reset done")
          }
        >
          Back up and reset
        </button>
      </div>
      {(path || api.canRestore()) && (
        <div className="rounded-2xl bg-white/[0.02] p-3 ring-1 ring-white/[0.05]">
          <p className="text-[12.5px] text-foreground">Your settings were saved{path ? ` to ${path}` : ""}.</p>
          <div className="mt-2 flex flex-wrap items-center gap-3">
            <Tick checked={restoreAck} onChange={setRestoreAck}>
              Put my saved settings back.
            </Tick>
            <button className={btn} disabled={!restoreAck || busy} onClick={() => go(() => api.restore({ acknowledged: true }), "Settings restored")}>
              Restore my settings
            </button>
          </div>
        </div>
      )}
    </div>
  );
}


/**
 * The card for a device SYNQ drives with hand-built code (the Logitech DEX, the ROG Falchion, the X68 HE):
 * its firmware and the maker's updater, and the reason none of the Advanced actions is offered yet.
 */
export function InfoAdvanced({ id, deviceName, kind, brand, firmware, why, notify }: { id: string; deviceName: string; kind: "mouse" | "keyboard"; brand: string; firmware: readonly string[]; why: string; notify: Notify }) {
  const key = firmware.join("|");
  const panel = useMemo(() => infoOnlyPanel({ deviceName, kind, brand, versions: firmware.map(splitVersion), why }), [deviceName, kind, brand, key, why]); // eslint-disable-line react-hooks/exhaustive-deps
  return <AdvancedCard id={id} panel={panel} notify={notify} />;
}
