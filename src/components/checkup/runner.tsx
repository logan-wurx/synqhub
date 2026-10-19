// One step of the checkup at a time: it shows what to do, listens for exactly that step (the window's own events, the
// desktop's Raw Input for the mouse, the tester's link for controllers) and hands what it recorded to the page. A step
// stops listening the moment it ends or the page leaves.
import { useEffect, useRef, useState, type JSX } from "react";
import type { PadLink } from "@/lib/controllers/link";
import type { PadState, StickState } from "@/lib/controllers/parse";
import { listenDom, sampleRaw, stopRaw } from "@/lib/checkup/capture";
import type { RawMouseRun } from "@/lib/checkup/raw";
import type { StepDef } from "@/lib/checkup/steps";
import { HOLD, KEYS } from "@/lib/checkup/thresholds";
import { StickView } from "@/components/controller/parts";
import type { Recordings } from "./gear";
import { CircleGuide, ClickPad, Countdown, HoldKey, KeyRow } from "./parts";

export interface PadHandle {
  id: string;
  name: string;
  link: PadLink;
}

interface StepProps {
  step: StepDef;
  pads: readonly PadHandle[];
  onDone: (rec: Recordings) => void;
}

/** Milliseconds since `from` (null: not started), refreshed every animation frame while `on`. */
function useElapsed(from: number | null): number {
  const [now, setNow] = useState(() => performance.now());
  useEffect(() => {
    if (from === null) return;
    let frame = 0;
    const tick = () => {
      setNow(performance.now());
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [from]);
  return from === null ? 0 : Math.max(0, now - from);
}

const READY_S = 3;

/** Hands off: a short count-in, then everything is listened to for a couple of seconds. */
function RestStep({ step, pads, onDone }: StepProps) {
  const [mounted] = useState(() => performance.now());
  const [listenAt, setListenAt] = useState<number | null>(null);
  const sinceMount = useElapsed(mounted);
  const sinceListen = useElapsed(listenAt);
  const seconds = step.seconds ?? 2;
  useEffect(() => {
    const t = window.setTimeout(() => setListenAt(performance.now()), READY_S * 1000);
    return () => window.clearTimeout(t);
  }, []);
  useEffect(() => {
    if (listenAt === null) return;
    let live = true;
    const dom = listenDom({});
    const raw = sampleRaw(seconds + 0.2, true);
    const padRuns = pads.map((p) =>
      p.link.measure(seconds).then(
        (r) => [p.id, r.states] as const,
        () => [p.id, [] as PadState[]] as const,
      ),
    );
    const timer = window.setTimeout(() => {
      const cap = dom.stop();
      void Promise.all([raw, ...padRuns]).then(([r, ...ps]) => {
        if (live) onDone({ rest: { motion: cap.motion, keys: cap.keys, raw: r as RawMouseRun | null, pads: Object.fromEntries(ps as (readonly [string, PadState[]])[]) } });
      });
    }, seconds * 1000);
    return () => {
      live = false;
      window.clearTimeout(timer);
      dom.stop();
      stopRaw();
    };
    // One listening run per step; the handlers are stable for its life.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listenAt]);
  return listenAt === null ? <Countdown total={READY_S} left={READY_S - sinceMount / 1000} label="starting" /> : <Countdown total={seconds} left={seconds - sinceListen / 1000} label="listening" />;
}

/** Clicks: counted live here; the timings come from Raw Input where there is one. */
function ClicksStep({ step, onDone }: StepProps) {
  const target = step.target ?? 30;
  const [count, setCount] = useState(0);
  useEffect(() => {
    let done = false;
    let n = 0;
    const raw = sampleRaw(step.limitSeconds ?? 40, false);
    const finish = () => {
      if (done) return;
      done = true;
      const cap = dom.stop();
      stopRaw();
      void raw.then((r) => onDone({ clicks: { buttons: cap.buttons, raw: r } }));
    };
    const dom = listenDom({
      clicks: true,
      onButton: (e) => {
        if (e.button !== 0 || !e.down || done) return;
        n++;
        setCount(n);
        // A moment for the last release (and any bounce after it) to arrive.
        if (n >= target) window.setTimeout(finish, 350);
      },
    });
    const limit = window.setTimeout(finish, (step.limitSeconds ?? 40) * 1000);
    return () => {
      window.clearTimeout(limit);
      if (!done) {
        done = true;
        dom.stop();
        stopRaw();
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return <ClickPad count={Math.min(count, target)} target={target} />;
}

/** Circles: the timer starts with the first movement. */
function CirclesStep({ step, onDone }: StepProps) {
  const seconds = step.seconds ?? 4;
  const [startAt, setStartAt] = useState<number | null>(null);
  const since = useElapsed(startAt);
  useEffect(() => {
    let done = false;
    let started = false;
    let raw: Promise<RawMouseRun | null> = Promise.resolve(null);
    let timer = 0;
    const dom = listenDom({
      onMotion: () => {
        if (started) return;
        started = true;
        setStartAt(performance.now());
        raw = sampleRaw(seconds + 0.3, true);
        timer = window.setTimeout(() => {
          done = true;
          const cap = dom.stop();
          void raw.then((r) => onDone({ circles: { motion: cap.motion, raw: r } }));
        }, seconds * 1000);
      },
    });
    return () => {
      window.clearTimeout(timer);
      if (!done) {
        dom.stop();
        stopRaw();
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return startAt === null ? <CircleGuide moving={false} /> : (
    <div className="flex items-center gap-8">
      <CircleGuide moving />
      <Countdown total={seconds} left={seconds - since / 1000} />
    </div>
  );
}

/** Keys: each one lights once it has gone down and come back up. */
function KeysStep({ step, onDone }: StepProps) {
  const [done, setDone] = useState<ReadonlySet<string>>(new Set());
  const [down, setDown] = useState<ReadonlySet<string>>(new Set());
  const finishRef = useRef<() => void>(() => undefined);
  useEffect(() => {
    let finished = false;
    const seen = new Set<string>();
    const held = new Set<string>();
    let timer = 0;
    const finish = () => {
      if (finished) return;
      finished = true;
      const cap = dom.stop();
      onDone({ keys: { keys: cap.keys, end: performance.now() } });
    };
    finishRef.current = finish;
    const dom = listenDom({
      keys: KEYS.codes,
      onKey: (e) => {
        if (!KEYS.codes.includes(e.code) || e.repeat) return;
        if (e.down) held.add(e.code);
        else {
          held.delete(e.code);
          seen.add(e.code);
        }
        setDown(new Set(held));
        setDone(new Set(seen));
        window.clearTimeout(timer);
        if (seen.size >= KEYS.codes.length && held.size === 0) timer = window.setTimeout(finish, KEYS.stuckAfterMs + 100);
      },
    });
    const limit = window.setTimeout(finish, (step.limitSeconds ?? 30) * 1000);
    return () => {
      window.clearTimeout(timer);
      window.clearTimeout(limit);
      if (!finished) {
        finished = true;
        dom.stop();
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <div className="flex flex-col items-center gap-5">
      <KeyRow codes={KEYS.codes} done={done} down={down} />
      <p className="text-[12px] text-medium">
        <span className="tabular">{done.size}</span> of {KEYS.codes.length}
        {done.size > 0 && done.size < KEYS.codes.length && (
          <>
            {" · "}
            <button onClick={() => finishRef.current()} className="text-high underline-offset-4 hover:underline">
              One won't light? Go on
            </button>
          </>
        )}
      </p>
    </div>
  );
}

/** Hold: the key fills while it's down; the step ends once it has been held long enough and let go. */
function HoldStep({ onDone }: StepProps) {
  const [firstDown, setFirstDown] = useState<number | null>(null);
  const [isDown, setIsDown] = useState(false);
  const since = useElapsed(firstDown);
  useEffect(() => {
    let finished = false;
    let first: number | null = null;
    let timer = 0;
    const finish = () => {
      if (finished) return;
      finished = true;
      const cap = dom.stop();
      onDone({ hold: { keys: cap.keys, end: performance.now() } });
    };
    const dom = listenDom({
      keys: [HOLD.code],
      onKey: (e) => {
        if (e.code !== HOLD.code || e.repeat) return;
        if (e.down) {
          if (first === null) {
            first = e.t;
            setFirstDown(performance.now());
            timer = window.setTimeout(finish, 8000);
          }
          setIsDown(true);
        } else {
          setIsDown(false);
          if (first !== null && e.t - first >= HOLD.seconds * 1000) {
            window.clearTimeout(timer);
            timer = window.setTimeout(finish, 400);
          }
        }
      },
    });
    return () => {
      window.clearTimeout(timer);
      if (!finished) {
        finished = true;
        dom.stop();
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return <HoldKey code={HOLD.code} progress={since / (HOLD.seconds * 1000)} down={isDown} />;
}

/** Sticks: live pictures; the measurement starts when a stick first moves well off centre. */
function SticksStep({ step, pads, onDone }: StepProps) {
  const seconds = step.seconds ?? 5;
  const [states, setStates] = useState<Record<string, PadState>>({});
  const [startAt, setStartAt] = useState<number | null>(null);
  const trails = useRef<Record<string, StickState[][]>>({});
  const since = useElapsed(startAt);
  useEffect(() => {
    let started = false;
    let live = true;
    let frame = 0;
    const latest: Record<string, PadState> = {};
    const offs = pads.map((p) =>
      p.link.onState((s) => {
        latest[p.id] = s;
        const t = (trails.current[p.id] ??= [[], []]);
        s.sticks.slice(0, 2).forEach((st, i) => {
          t[i].push(st);
          if (t[i].length > 64) t[i].shift();
        });
        if (!started && s.sticks.some((st) => Math.hypot(st.x, st.y) > 0.5)) {
          started = true;
          setStartAt(performance.now());
          void Promise.all(
            pads.map((q) =>
              q.link.measure(seconds).then(
                (r) => [q.id, r.states] as const,
                () => [q.id, [] as PadState[]] as const,
              ),
            ),
          ).then((runs) => live && onDone({ sticks: { pads: Object.fromEntries(runs) } }));
        }
      }),
    );
    const paint = () => {
      setStates({ ...latest });
      frame = requestAnimationFrame(paint);
    };
    frame = requestAnimationFrame(paint);
    return () => {
      live = false;
      cancelAnimationFrame(frame);
      for (const off of offs) off();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  if (!pads.length) return <p className="text-[13px] text-medium">No controller could be listened to.</p>;
  return (
    <div className="flex flex-wrap items-center justify-center gap-6">
      {pads.slice(0, 2).map((p) => (
        <div key={p.id} className="flex gap-2">
          {[0, 1].map((i) => (
            <StickView key={i} label={pads.length > 1 ? `${p.name} · ${i ? "right" : "left"}` : i ? "Right stick" : "Left stick"} stick={states[p.id]?.sticks[i] ?? null} trail={trails.current[p.id]?.[i] ?? []} />
          ))}
        </div>
      ))}
      {startAt !== null && <Countdown total={seconds} left={seconds - since / 1000} />}
    </div>
  );
}

const STEPS: Record<StepDef["id"], (p: StepProps) => JSX.Element> = {
  rest: RestStep,
  clicks: ClicksStep,
  circles: CirclesStep,
  keys: KeysStep,
  hold: HoldStep,
  sticks: SticksStep,
};

export function StepBody(props: StepProps) {
  const Body = STEPS[props.step.id];
  return <Body {...props} />;
}
