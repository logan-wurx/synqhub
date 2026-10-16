// The tester's tabs, shared by the Controller page (a listed pad) and the browser-only Gamepad tester: what the pad
// reports right now and the figures from short measurements (Test), the polling rate (Polling), and the volatile tests
// a Sony or Nintendo pad takes on a click (Lights & rumble).
import { useState } from "react";
import { cn } from "@/lib/utils";
import { Card, CardHeader } from "@/components/ui/matte";
import { Banner } from "@/components/keyboard/parts";
import type { Notice } from "@/components/ui/matte";
import { PARSED_GUARDS, type PadLink, type MeasureResult } from "@/lib/controllers/link";
import type { PadIdentity } from "@/lib/controllers/identify";
import { chatter, circularity, deadzones, drift, gyroBias, pollingStats, resolution, sampleLimited, triggerStats, type Circularity, type Deadzones, type Drift, type PollingStats, type Resolution, type TriggerStats } from "@/lib/controllers/analysis";
import { useLiveState } from "@/lib/controllers/use-link";
import { ActionButton, AxisReadout, ButtonGrid, Figure, StickView, TriggerBar } from "./parts";

type Notify = (n: Omit<Notice, "id">, key?: string) => void;

const pct = (v: number, d = 1) => `${(v * 100).toFixed(d)}%`;
const styleOf = (id: PadIdentity): "sony" | "nintendo" | "xbox" => (id.brand === "Sony" || id.kind.startsWith("ps") ? "sony" : id.brand === "Nintendo" || id.kind.startsWith("switch") || id.kind === "joycon" ? "nintendo" : "xbox");

interface StickFigures {
  drift?: (Drift | null)[];
  circle?: Circularity[];
  dead?: (Deadzones | null)[];
  res?: (Resolution | null)[];
  triggers?: (TriggerStats | null)[];
  gyro?: ReturnType<typeof gyroBias>;
  chatter?: Record<string, number>;
}

/** Live sticks, triggers, buttons and motion, with the stick and trigger checks. */
export function TestTab({ link, notify }: { link: PadLink; notify: Notify }) {
  const live = useLiveState(link);
  const [busy, setBusy] = useState<string | null>(null);
  const [fig, setFig] = useState<StickFigures>({});
  const s = live.state;
  const sticks = s?.sticks.length ?? link.identity.caps.sticks;

  const run = async (what: string, seconds: number, take: (m: MeasureResult) => StickFigures) => {
    setBusy(what);
    try {
      const m = await link.measure(seconds);
      const add = take(m);
      add.chatter = { ...(fig.chatter ?? {}), ...chatter(m.states) };
      setFig((f) => ({ ...f, ...add }));
    } catch (e) {
      notify({ tone: "error", title: "Couldn't measure", detail: String(e).replace(/^Error: /, "") });
    } finally {
      setBusy(null);
    }
  };
  const perStick = <T,>(m: MeasureResult, f: (xs: { x: number; y: number }[]) => T): T[] => Array.from({ length: sticks }, (_, i) => f(m.states.map((st) => st.sticks[i]).filter(Boolean)));

  return (
    <>
      {!s && link.source.kind === "hid" && !PARSED_GUARDS.includes(link.identity.guard) && (
        <Banner tone="info">SYNQ doesn't read this pad's report layout yet: it times its reports (Polling) and saves them for diagnostics. Its sticks and buttons show here once it's one SYNQ parses.</Banner>
      )}
      <Card innerClassName="px-5 pb-5">
        <CardHeader title="Sticks" hint={live.rate ? `${live.rate} reports in the last second (${link.source.label}).` : "Move the sticks."} />
        <div className="mt-4 flex flex-wrap items-start justify-center gap-10">
          {Array.from({ length: Math.max(1, sticks) }, (_, i) => (
            <StickView key={i} testId={`pad-stick-${i}`} label={sticks === 1 ? "Stick" : i === 0 ? "Left stick" : "Right stick"} stick={s?.sticks[i] ?? null} raw={s?.sticksRaw?.[i] ?? null} trail={live.trails[i] ?? []} bins={fig.circle?.[i]?.bins ?? null} />
          ))}
        </div>
        <div className="mt-5 flex flex-wrap gap-2">
          <ActionButton testId="pad-measure-drift" busy={busy === "drift"} disabled={!!busy} onClick={() => run("drift", 2, (m) => ({ drift: perStick(m, drift), gyro: gyroBias(m.states.flatMap((st) => (st.gyro ? [st.gyro] : []))) }))}>
            Drift (2 s, hands off)
          </ActionButton>
          <ActionButton testId="pad-measure-circle" busy={busy === "circle"} disabled={!!busy} onClick={() => run("circle", 4, (m) => ({ circle: perStick(m, circularity), res: perStick(m, () => null).map((_, i) => resolution(m.states.flatMap((st) => (st.sticksRaw?.[i] ? [st.sticksRaw[i]] : [])))) }))}>
            Circularity (spin each stick, 4 s)
          </ActionButton>
          <ActionButton testId="pad-measure-dead" busy={busy === "dead"} disabled={!!busy} onClick={() => run("dead", 4, (m) => ({ dead: perStick(m, deadzones) }))}>
            Deadzones (push slowly from centre to edge, 4 s)
          </ActionButton>
        </div>
        {(fig.drift || fig.circle || fig.dead) && (
          <div className="mt-4 grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(170px, 1fr))" }} data-testid="pad-stick-figures">
            {fig.drift?.map((d, i) => d && <Figure key={`d${i}`} label={`${i ? "Right" : "Left"} drift`} value={pct(d.magnitude, 2)} note={`noise ${pct(d.noise, 2)} · ${d.samples} readings`} />)}
            {fig.circle?.map((c, i) => <Figure key={`c${i}`} label={`${i ? "Right" : "Left"} circularity error`} value={c.covered ? `${c.errorPct.toFixed(1)}%` : "spin it"} note={`${c.covered}/72 directions · ${c.outerPct.toFixed(0)}% at the edge`} />)}
            {fig.res?.map((r, i) => r && r.distinct[0] > 1 && <Figure key={`r${i}`} label={`${i ? "Right" : "Left"} resolution`} value={`${r.bits[0].toFixed(1)} / ${r.bits[1].toFixed(1)} bits`} note={`${r.distinct[0]} × ${r.distinct[1]} values seen`} />)}
            {fig.dead?.map((d, i) => d && <Figure key={`z${i}`} label={`${i ? "Right" : "Left"} deadzone`} value={`${pct(d.inner)} in · ${pct(d.outer, 0)} out`} note={d.jumps ? "the output jumps when it leaves centre (anti-deadzone)" : "starts from centre"} />)}
          </div>
        )}
      </Card>

      {link.identity.caps.triggers !== null && (
        <Card innerClassName="px-5 pb-5">
          <CardHeader title="Triggers" hint="Press each one all the way, then let go." />
          <div className="mt-4 flex flex-wrap gap-6">
            <TriggerBar label="Left" value={s?.triggers[0] ?? 0} raw={s?.triggersRaw?.[0]} bits={s?.triggerBits} />
            <TriggerBar label="Right" value={s?.triggers[1] ?? 0} raw={s?.triggersRaw?.[1]} bits={s?.triggerBits} />
          </div>
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <ActionButton
              testId="pad-measure-triggers"
              busy={busy === "triggers"}
              disabled={!!busy}
              onClick={() => run("triggers", 3, (m) => ({ triggers: [0, 1].map((i) => triggerStats(m.states.flatMap((st) => (st.triggersRaw ? [st.triggersRaw[i]] : [Math.round((st.triggers[i] ?? 0) * 255)])), s?.triggerBits)) }))}
            >
              Trigger range (press both fully, 3 s)
            </ActionButton>
            {fig.triggers?.map(
              (t, i) =>
                t && (
                  <span key={i} className="tabular text-[12.5px] text-muted-foreground">
                    {i ? "Right" : "Left"}: {t.min} – {t.max}, {t.steps} steps{t.hair ? " (digital: only rest and full)" : ""}
                  </span>
                ),
            )}
          </div>
        </Card>
      )}

      <Card innerClassName="px-5 pb-5">
        <CardHeader title="Buttons" hint="Lit while held; a button stays outlined once it has been pressed." />
        <div className="mt-4">
          <ButtonGrid state={s} style={styleOf(link.identity)} seen={live.seen} />
        </div>
        {fig.chatter && Object.keys(fig.chatter).length > 0 && (
          <p className="mt-3 text-[12.5px] text-chart-3">Chatter (pressed again within 5 ms of a release): {Object.entries(fig.chatter).map(([b, n]) => `${b} ×${n}`).join(", ")}</p>
        )}
      </Card>

      {(s?.gyro || link.identity.caps.gyro) && (
        <Card innerClassName="px-5 pb-5">
          <CardHeader title="Motion" hint={link.source.kind === "hid" ? "Gyro and accelerometer as the pad reports them (nominal scale)." : "This pad's motion sensors aren't readable this way."} />
          <div className="mt-4 grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))" }}>
            <AxisReadout label="Gyro" unit="°/s" v={s?.gyro} />
            <AxisReadout label="Accelerometer" unit="g" v={s?.accel} />
            {fig.gyro && <Figure label="Gyro bias at rest" value={fig.gyro.bias.map((b) => b.toFixed(2)).join("  ")} note={`noise ${fig.gyro.noise.map((n) => n.toFixed(2)).join(" ")} °/s`} />}
          </div>
        </Card>
      )}
    </>
  );
}

/** The polling rate, Gamepadla's way, labelled with what it was measured through. */
export function PollingTab({ link, notify }: { link: PadLink; notify: Notify }) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ stats: PollingStats | null; sampleHz: number | null; count: number } | null>(null);
  const measure = async () => {
    setBusy(true);
    try {
      const m = await link.measure(5);
      setResult({ stats: pollingStats(m.times), sampleHz: m.sampleHz, count: m.times.length });
    } catch (e) {
      notify({ tone: "error", title: "Couldn't measure", detail: String(e).replace(/^Error: /, "") });
    } finally {
      setBusy(false);
    }
  };
  const st = result?.stats;
  const limited = st ? sampleLimited(st.hz, result?.sampleHz ?? null) : false;
  return (
    <>
      <Card innerClassName="px-5 pb-5">
        <CardHeader title="Polling rate" hint={`Measured through ${link.source.label}.`} />
        <p className="mt-3 max-w-2xl text-[13px] leading-relaxed text-muted-foreground">
          Keep a stick moving in circles for the 5 seconds: many pads only send a report when something changes. The figure is the median time between reports;
          the first 200 ms and any pause over 50 ms are left out.
        </p>
        <div className="mt-4 flex items-center gap-3">
          <ActionButton testId="pad-measure-polling" busy={busy} onClick={() => void measure()}>
            {busy ? "Measuring… keep moving" : "Measure (5 s)"}
          </ActionButton>
          {result && !st && <span className="text-[12.5px] text-muted-foreground">Not enough reports ({result.count}): move a stick the whole time and try again.</span>}
        </div>
        {st && (
          <div className="mt-5 grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))" }} data-testid="pad-polling">
            <Figure label="Polling (median)" value={`${limited ? "≥ " : ""}${Math.round(st.hz)} Hz`} note={`${st.medianMs.toFixed(3)} ms`} testId="pad-polling-hz" />
            <Figure label="Mean" value={`${Math.round(st.meanHz)} Hz`} />
            <Figure label="1st – 99th percentile" value={`${st.p1Ms.toFixed(2)}–${st.p99Ms.toFixed(2)}`} note="ms between reports" />
            <Figure label="Jitter" value={`${st.jitterMs.toFixed(3)} ms`} note="standard deviation" />
            <Figure label="Intervals" value={String(st.count)} note={`${st.dropped} left out`} />
          </div>
        )}
        {limited && <p className="mt-3 text-[12.5px] text-chart-3">This is as fast as XInput was sampled: the pad may report faster.</p>}
        {link.source.maxHz && <p className="mt-3 text-[12.5px] text-muted-foreground">The browser's Gamepad API samples about {link.source.maxHz} times a second, so faster pads read as about {link.source.maxHz} Hz here.</p>}
        <p className="mt-4 text-[11.5px] text-muted-foreground/80">Method: Gamepadla's polling test (gamepadla.com, MIT).</p>
      </Card>
    </>
  );
}

const SWATCHES: readonly { name: string; rgb: [number, number, number] }[] = [
  { name: "Violet", rgb: [139, 92, 246] },
  { name: "Red", rgb: [255, 40, 40] },
  { name: "Green", rgb: [40, 220, 90] },
  { name: "Blue", rgb: [40, 110, 255] },
  { name: "White", rgb: [255, 255, 255] },
  { name: "Off", rgb: [0, 0, 0] },
];

/** The volatile tests (Sony and Nintendo pads, through HID): sent only on a click, gone when the pad reconnects. */
export function LightsTab({ link, notify }: { link: PadLink; notify: Notify }) {
  const t = link.tests;
  const [busy, setBusy] = useState<string | null>(null);
  if (!t) return null;
  const go = async (what: string, f: () => Promise<void>) => {
    setBusy(what);
    try {
      await f();
    } catch (e) {
      notify({ tone: "error", title: what, detail: String(e).replace(/^Error: /, "") });
    } finally {
      setBusy(null);
    }
  };
  return (
    <>
      <Banner tone="info">Nothing here stays on the pad: it lasts until the pad reconnects or a game sets its own. The rumble test stops by itself within a second.</Banner>
      <Card innerClassName="px-5 pb-5">
        <CardHeader title="Rumble" hint="One short pulse on both motors." />
        <div className="mt-4">
          <ActionButton testId="pad-test-rumble" busy={busy === "Rumble"} disabled={!!busy} onClick={() => void go("Rumble", () => t.rumble())}>
            Test rumble
          </ActionButton>
        </div>
      </Card>
      {t.lightbar && (
        <Card innerClassName="px-5 pb-5">
          <CardHeader title="Lightbar" />
          <div className="mt-4 flex flex-wrap gap-2">
            {SWATCHES.map((c) => (
              <button
                key={c.name}
                type="button"
                disabled={!!busy}
                onClick={() => void go("Lightbar", () => t.lightbar!(...c.rgb))}
                className="inline-flex items-center gap-2 rounded-full bg-white/[0.04] px-3 py-1.5 text-[12.5px] text-foreground ring-1 ring-white/[0.1] hover:bg-white/[0.08] disabled:opacity-50"
              >
                <span className="size-3 rounded-full ring-1 ring-white/20" style={{ background: `rgb(${c.rgb.join(" ")})` }} />
                {c.name}
              </button>
            ))}
            {t.releaseLeds && (
              <ActionButton disabled={!!busy} onClick={() => void go("Lights", () => t.releaseLeds!())}>
                Give the lights back to the system
              </ActionButton>
            )}
          </div>
        </Card>
      )}
      {t.playerLeds && (
        <Card innerClassName="px-5 pb-5">
          <CardHeader title="Player lights" />
          <div className="mt-4 flex flex-wrap gap-2">
            {(t.kind === "ds5" ? [0x04, 0x0a, 0x15, 0x1b, 0x1f, 0] : [0x01, 0x03, 0x07, 0x0f, 0]).map((p, i) => (
              <button
                key={p}
                type="button"
                disabled={!!busy}
                onClick={() => void go("Player lights", () => t.playerLeds!(t.kind === "ds5" ? p | (p ? 0x20 : 0) : p))}
                className={cn("rounded-full bg-white/[0.04] px-3 py-1.5 text-[12.5px] ring-1 ring-white/[0.1] hover:bg-white/[0.08] disabled:opacity-50", p ? "text-foreground" : "text-muted-foreground")}
              >
                {p ? `Player ${i + 1}` : "Off"}
              </button>
            ))}
          </div>
        </Card>
      )}
      {t.micLed && (
        <Card innerClassName="px-5 pb-5">
          <CardHeader title="Mic light" />
          <div className="mt-4 flex gap-2">
            {(["Off", "On", "Pulse"] as const).map((label, mode) => (
              <ActionButton key={label} disabled={!!busy} onClick={() => void go("Mic light", () => t.micLed!(mode as 0 | 1 | 2))}>
                {label}
              </ActionButton>
            ))}
          </div>
        </Card>
      )}
      {t.triggers && (
        <Card innerClassName="px-5 pb-5">
          <CardHeader title="Adaptive triggers" hint="SDL's test effects. Pull the triggers to feel them; Off clears them." />
          <div className="mt-4 flex gap-2">
            <ActionButton testId="pad-test-trigger" disabled={!!busy} onClick={() => void go("Triggers", () => t.triggers!("resistance"))}>
              Resistance
            </ActionButton>
            <ActionButton disabled={!!busy} onClick={() => void go("Triggers", () => t.triggers!("vibration"))}>
              Vibration
            </ActionButton>
            <ActionButton disabled={!!busy} onClick={() => void go("Triggers", () => t.triggers!("off"))}>
              Off
            </ActionButton>
          </div>
        </Card>
      )}
      {t.homeLight && (
        <Card innerClassName="px-5 pb-5">
          <CardHeader title="HOME button light" />
          <div className="mt-4 flex gap-2">
            {(
              [
                ["Off", 0],
                ["Dim", 4],
                ["Full", 15],
              ] as const
            ).map(([label, v]) => (
              <ActionButton key={label} disabled={!!busy} onClick={() => void go("HOME light", () => t.homeLight!(v))}>
                {label}
              </ActionButton>
            ))}
          </div>
        </Card>
      )}
    </>
  );
}
