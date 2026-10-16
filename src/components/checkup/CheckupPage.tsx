// Gear Doctor: a guided, about-a-minute checkup of the connected gear (or one device). It only listens while a step
// asks for something; the report then gives each device a colour, what was found in plain words, and a "Fix it" for
// the problems one of the device's own settings can fix (run on the device's page through its guarded session, with
// Undo). Its own chunk: loaded when the checkup is opened.
import { useEffect, useMemo, useRef, useState } from "react";
import { motion } from "motion/react";
import { Check, Stethoscope, Warning, WarningOctagon } from "@phosphor-icons/react";
import { BackButton } from "@/components/devices/shell";
import { backend, isWeb, type Connected } from "@/lib/backend";
import { buildEntries } from "@/lib/device-model";
import { usePublishedNames } from "@/lib/device-names";
import { peekKept, useKeptState } from "@/lib/keep";
import { goHome, openDevice, useNav } from "@/lib/nav";
import { refreshSound, soundLabel, useSound } from "@/lib/sound";
import { openPad } from "@/lib/controllers/connect";
import { useWindowFocus } from "@/lib/controllers/use-link";
import { rawAvailable } from "@/lib/checkup/capture";
import { estimateSeconds, planSteps } from "@/lib/checkup/steps";
import { worst } from "@/lib/checkup/report";
import type { DeviceReport, Finding, Level } from "@/lib/checkup/types";
import { requestChange, resultKey, type AppliedResult } from "@/lib/feel/pending";
import { Card, Eyebrow, type Notice } from "@/components/ui/matte";
import { Pill } from "@/components/keyboard/parts";
import { DeviceArt, lightArt } from "@/components/devices/DeviceArt";
import { buildReports, gearOf, type Gear, type Recordings } from "./gear";
import { FindingRow, LEVEL_TONE, LevelPill, ProgressRing } from "./parts";
import { StepBody, type PadHandle } from "./runner";

interface RunState {
  /** The device checked, or null for all of them. */
  scope: string | null;
  phase: "intro" | "steps" | "report";
  reports: DeviceReport[];
  /** When the report was made. */
  at: number;
}

const RANK: Record<Level, number> = { good: 0, warn: 1, bad: 2 };
const RING_ICON = { good: Check, warn: Warning, bad: WarningOctagon } as const;

const WHAT: Record<Gear["entry"]["kind"], string> = {
  mouse: "clicks, polling and sensor",
  keyboard: "key presses and a held key",
  controller: "stick drift and circles",
  sound: "EQ engine and levels (nothing plays)",
  headset: "",
  monitor: "",
  webcam: "",
  // Lamps aren't part of the checkup (its list is built without them); the kind is named for completeness.
  light: "not checked",
  lamparray: "not checked",
  rgbhub: "not checked",
};

/** The same picture the Devices home shows, including the one picked for the sound output. */
function useArtSpec(e: Gear["entry"] | null | undefined) {
  const picture = soundLabel(useSound()).custom?.picture;
  if (e?.kind === "light") return lightArt(e.lamps?.[0]?.sku ?? "");
  return e ? { kind: e.kind, family: e.family, name: e.name, brand: e.brand, picture: e.kind === "sound" ? picture : undefined, vid: e.pad?.device.vid, pid: e.pad?.device.pid } : null;
}

function GearLine({ g }: { g: Gear }) {
  const e = g.entry;
  const art = useArtSpec(e);
  return (
    <li className="flex items-center gap-3.5 py-2.5">
      <span className="grid h-11 w-16 shrink-0 place-items-center">
        {art && <DeviceArt spec={art} className="max-h-11 max-w-16" />}
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-[13.5px] text-foreground">{e.name}</p>
        <p className="truncate text-[12px] text-muted-foreground">{e.kind === "mouse" && !rawAvailable() ? "clicks and motion" : WHAT[e.kind]}</p>
      </div>
    </li>
  );
}

function HeadIcon({ level }: { level: Level }) {
  const Icon = RING_ICON[level];
  return <Icon size={28} weight={level === "good" ? "bold" : "light"} className={LEVEL_TONE[level].text} aria-label={LEVEL_TONE[level].label} />;
}

function headline(reports: readonly DeviceReport[]): { level: Level; title: string; sub: string } {
  const issues = reports.flatMap((r) => r.findings.filter((f) => f.level !== "good"));
  const level = worst(reports.map((r) => r.level));
  const checked = reports.filter((r) => !r.skipped).length;
  if (!issues.length) return { level, title: "All good", sub: `${checked} ${checked === 1 ? "device" : "devices"} checked, nothing to fix.` };
  const fixable = issues.filter((f) => f.fix && !f.fix.blocked).length;
  return {
    level,
    title: `${issues.length} ${issues.length === 1 ? "thing" : "things"} to look at`,
    sub: fixable ? `${fixable} of them SYNQ can fix in one click, with Undo.` : "None of them is a setting SYNQ can change; what helps is said under each.",
  };
}

function ReportCard({ report, gear, onFix, onOpen }: { report: DeviceReport; gear: Gear | undefined; onFix: (f: Finding) => void; onOpen: (f: Finding) => void }) {
  const e = gear?.entry;
  const result = peekKept<AppliedResult | null>(resultKey(report.device), null);
  const fixedRef = result && !result.undone ? result.ref : undefined;
  const art = useArtSpec(e);
  const ordered = [...report.findings].sort((a, b) => RANK[b.level] - RANK[a.level]);
  return (
    <Card innerClassName="flex flex-col px-5 pb-4 pt-4">
      <div className="flex items-center gap-3.5">
        <span className="grid h-12 w-[72px] shrink-0 place-items-center">
          {art && <DeviceArt spec={art} className="max-h-12 max-w-[72px]" />}
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[15px] font-medium tracking-tight text-foreground">{report.name}</p>
          <p className="truncate text-[12px] text-muted-foreground">{report.checked.length ? `Checked ${report.checked.join(", ")}` : "Checked"}</p>
        </div>
        <LevelPill level={report.level} />
      </div>
      <ul className="mt-2 divide-y divide-white/[0.05]">
        {ordered.map((f) => (
          <FindingRow key={f.id} f={f} fixed={!!f.fix && fixedRef === `${report.device}:${f.id}`} onFix={() => onFix(f)} onOpen={() => onOpen(f)} />
        ))}
      </ul>
      {report.source && <p className="pt-2 text-[11px] text-muted-foreground/80">Timings from {report.source}.</p>}
    </Card>
  );
}

export function CheckupPage({ devices, notify }: { devices: Connected[]; notify: (n: Omit<Notice, "id">, key?: string) => void }) {
  const [nav] = useNav();
  const scope = nav.view === "checkup" ? nav.device : null;
  const published = usePublishedNames();
  const sound = useSound();
  const entries = useMemo(() => buildEntries(devices, published, isWeb ? "Sound and EQ" : soundLabel(sound).title), [devices, published, sound]);
  const gear = useMemo(() => gearOf(entries, devices, scope).filter((g) => !(isWeb && g.entry.kind === "sound")), [entries, devices, scope]);
  const [kept, setRun] = useKeptState<RunState | null>("checkup.run", null);
  // A run in the middle of its steps can't be picked up again (nothing was listening meanwhile): start over.
  const run = kept && kept.scope === scope && kept.phase !== "steps" ? kept : null;
  const [stepping, setStepping] = useState(false);
  const [index, setIndex] = useState(0);
  const [pads, setPads] = useState<PadHandle[]>([]);
  const [attempt, setAttempt] = useState(0);
  const rec = useRef<Recordings>({});
  const rawUsed = useRef(false);
  const focused = useWindowFocus();

  const scopeCounts = {
    mice: gear.filter((g) => g.entry.kind === "mouse").length,
    keyboards: gear.filter((g) => g.entry.kind === "keyboard").length,
    controllers: gear.filter((g) => g.entry.kind === "controller" && g.entry.pad?.identity.support !== "detect").length,
  };
  const steps = useMemo(() => planSteps(scopeCounts), [scopeCounts.mice, scopeCounts.keyboards, scopeCounts.controllers]); // eslint-disable-line react-hooks/exhaustive-deps
  const step = stepping ? steps[index] : undefined;
  const single = scope ? gear[0]?.entry : null;

  const closePads = (list: readonly PadHandle[]) => {
    for (const p of list) void p.link.close().catch(() => undefined);
  };
  // Leaving the page mid-run lets go of every controller.
  const padsRef = useRef(pads);
  padsRef.current = pads;
  useEffect(() => () => closePads(padsRef.current), []);

  const finish = async () => {
    setStepping(false);
    closePads(pads);
    setPads([]);
    if (gear.some((g) => g.entry.kind === "sound")) {
      const [status, eq] = await Promise.all([refreshSound().catch(() => null), backend.eqLoad().catch(() => null)]);
      rec.current.sound = { status, eq };
    }
    const reports = buildReports(gear, rec.current, rawUsed.current);
    setRun({ scope, phase: "report", reports, at: Date.now() });
  };

  const start = async () => {
    rec.current = {};
    rawUsed.current = false;
    const handles: PadHandle[] = [];
    for (const g of gear) {
      const p = g.entry.pad;
      if (g.entry.kind !== "controller" || !p || p.identity.support === "detect") continue;
      try {
        const link = await openPad(p.device, p.identity);
        handles.push({ id: g.entry.id, name: g.entry.name, link });
      } catch {
        // A pad that can't be opened (asleep, held by another app) is reported as not checked.
      }
    }
    setPads(handles);
    setIndex(0);
    setAttempt((a) => a + 1);
    setRun({ scope, phase: "steps", reports: [], at: Date.now() });
    if (!steps.length) return void finish();
    setStepping(true);
  };

  const next = () => {
    if (index + 1 >= steps.length) void finish();
    else setIndex(index + 1);
  };

  const done = (part: Recordings) => {
    Object.assign(rec.current, part);
    for (const v of Object.values(part)) if (v && typeof v === "object" && "raw" in v && v.raw) rawUsed.current = true;
    next();
  };

  const stop = () => {
    setStepping(false);
    closePads(pads);
    setPads([]);
    setRun(null);
  };

  const fix = (report: DeviceReport, f: Finding) => {
    if (!f.fix || f.fix.blocked) return;
    requestChange(f.fix.device, { kind: "fix", intent: f.fix.intent, label: f.fix.label, at: Date.now(), auto: true, ref: `${report.device}:${f.id}` });
    notify({ title: "Opening the device to fix it", detail: f.fix.label, tone: "info" }, "checkup");
    openDevice(f.fix.device);
  };

  const title = single ? `Check ${single.name}` : "Gear checkup";
  const secs = estimateSeconds(steps);
  const head = run?.phase === "report" ? headline(run.reports) : null;

  return (
    <div className="h-full overflow-y-auto select-none" data-slot="checkup">
      <div className="mx-auto flex min-h-full w-full max-w-[1500px] flex-col gap-6 px-8 pb-10 pt-5 [&>*]:shrink-0">
        <header>
          <BackButton onClick={() => (single ? openDevice(single.id) : goHome())}>{single ? single.name : "Gear"}</BackButton>
          <div className="mt-5">
            <Eyebrow>Checkup</Eyebrow>
            <h1 className="display-num mt-3 text-[clamp(48px,5.4vw,84px)] text-foreground">{title}</h1>
            <p className="mt-2 max-w-[640px] text-[13.5px] text-muted-foreground">
              {stepping
                ? "SYNQ is listening for this step only."
                : run?.phase === "report"
                  ? "Fix it changes one setting on the device's own page: backed up first, read back, with Undo."
                  : "About a minute. SYNQ only listens while a step asks for something, and changes nothing unless you press Fix it."}
            </p>
          </div>
        </header>

        {!stepping && run?.phase !== "report" && (
          <Card className="w-full max-w-[860px]" innerClassName="px-7 py-7">
            <div className="flex flex-col gap-6 min-[760px]:flex-row min-[760px]:items-center">
              <ProgressRing value={0} size={112}>
                <Stethoscope size={30} weight="light" className="text-primary" />
              </ProgressRing>
              <div className="min-w-0 flex-1">
                <p className="text-[17px] font-medium tracking-tight text-foreground">{steps.length ? `${steps.length} short ${steps.length === 1 ? "step" : "steps"}, about ${secs} seconds` : "A quick look, no steps"}</p>
                <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">
                  {steps.length ? "Each step says exactly what to do. Clicks, mouse movement and only the keys it shows are listened to; nothing is saved or sent." : "Read from what SYNQ already has. Nothing plays."}
                </p>
                <div className="mt-4 flex flex-wrap items-center gap-2.5">
                  <Pill primary onClick={() => void start()} disabled={!gear.length}>
                    Start checkup
                  </Pill>
                  <Pill onClick={() => (single ? openDevice(single.id) : goHome())}>Not now</Pill>
                </div>
              </div>
            </div>
            {gear.length > 0 ? (
              <ul className="mt-6 grid gap-x-6 border-t border-white/[0.05] pt-3 min-[760px]:grid-cols-2">
                {gear.map((g) => (
                  <GearLine key={g.entry.id} g={g} />
                ))}
              </ul>
            ) : (
              <p className="mt-6 border-t border-white/[0.05] pt-4 text-[13px] text-muted-foreground">Nothing to check: plug in a mouse, keyboard or controller.</p>
            )}
          </Card>
        )}

        {stepping && step && (
          <Card className="w-full max-w-[860px]" innerClassName="px-7 py-7">
            <div className="flex items-center gap-5">
              <ProgressRing value={index / steps.length} size={64} stroke={5}>
                <span className="tabular text-[13px] text-foreground">
                  {index + 1}/{steps.length}
                </span>
              </ProgressRing>
              <motion.div key={step.id} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.35, ease: [0.32, 0.72, 0, 1] }} className="min-w-0 flex-1">
                <p className="text-[21px] font-medium leading-tight tracking-[-0.01em] text-foreground">{step.title}</p>
                <p className="mt-1 text-[13px] text-muted-foreground">{step.hint}</p>
              </motion.div>
            </div>
            <div className="mt-7 grid min-h-[240px] place-items-center">
              {focused ? (
                <StepBody key={`${step.id}.${attempt}`} step={step} pads={pads} onDone={done} />
              ) : (
                <div className="max-w-[420px] text-center">
                  <p className="text-[15px] text-foreground">Paused</p>
                  <p className="mt-1 text-[12.5px] leading-relaxed text-muted-foreground">SYNQ stops listening while it isn't the focused window. Click here to carry on; this step starts again.</p>
                  <Pill className="mt-3" onClick={() => setAttempt((a) => a + 1)}>
                    Redo this step
                  </Pill>
                </div>
              )}
            </div>
            <div className="mt-6 flex items-center gap-2.5 border-t border-white/[0.06] pt-4">
              <Pill onClick={next}>Skip this step</Pill>
              <Pill className="ml-auto" onClick={stop}>
                Stop
              </Pill>
            </div>
          </Card>
        )}

        {!stepping && run?.phase === "report" && head && (
          <>
            <Card className="w-full max-w-[860px]" innerClassName="flex flex-wrap items-center gap-6 px-7 py-6">
              <ProgressRing value={1} size={88} stroke={6} color={LEVEL_TONE[head.level].stroke}>
                <HeadIcon level={head.level} />
              </ProgressRing>
              <div className="min-w-0 flex-1">
                <p className="text-[21px] font-medium tracking-[-0.01em] text-foreground">{head.title}</p>
                <p className="mt-1 text-[13px] text-muted-foreground">{head.sub}</p>
              </div>
              <div className="flex flex-wrap gap-2.5">
                <Pill onClick={() => void start()}>Run again</Pill>
                <Pill onClick={() => (single ? openDevice(single.id) : goHome())}>Done</Pill>
              </div>
            </Card>
            <div className="grid items-start gap-5" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(min(100%, 440px), 1fr))" }}>
              {run.reports.filter((r) => !r.skipped).map((r) => (
                <ReportCard
                  key={r.device}
                  report={r}
                  gear={gear.find((g) => g.entry.id === r.device)}
                  onFix={(f) => fix(r, f)}
                  onOpen={(f) => f.open && openDevice(f.open.device)}
                />
              ))}
            </div>
            {run.reports.some((r) => r.skipped) && (
              <div className="max-w-[860px] space-y-1.5 px-1">
                <p className="text-[12.5px] text-muted-foreground">Not checked</p>
                {run.reports
                  .filter((r) => r.skipped)
                  .map((r) => (
                    <p key={r.device} className="text-[12.5px] leading-relaxed text-muted-foreground/80">
                      <span className="text-foreground/90">{r.name}</span> · {r.skipped}
                    </p>
                  ))}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

