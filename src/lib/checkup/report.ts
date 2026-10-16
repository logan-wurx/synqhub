// Turns what the checkup measured into a report per device: a colour, a plain sentence per finding with its
// numbers, and either a "Fix it" (one of the settings the device's panel already writes) or honest advice when
// SYNQ can't fix it. Every colour comes from src/lib/checkup/thresholds.ts. Pure.
import type { PadState } from "../controllers/parse.ts";
import type { EngineStatus, EqSnapshot } from "../backend.ts";
import type { KeyboardDevice, MouseDevice } from "../feel/types.ts";
import { hzText } from "../feel/units.ts";
import { channelLevels } from "./audio.ts";
import { stickChecks } from "./controller.ts";
import { intentLabel, type FixIntent } from "./fix.ts";
import { holdStats, keyLabel, keyStats, phantomKeys } from "./keyboard.ts";
import { clickStats, motionStats, restStats } from "./mouse.ts";
import { AUDIO, CLICKS, HOLD, KEYS, MOTION, STICKS } from "./thresholds.ts";
import type { ButtonEvent, DeviceReport, Finding, KeyEvent, Level, MotionReport, MouseSource } from "./types.ts";

const RANK: Record<Level, number> = { good: 0, warn: 1, bad: 2 };
export const worst = (levels: readonly Level[]): Level => levels.reduce<Level>((a, b) => (RANK[b] > RANK[a] ? b : a), "good");

const ms = (n: number) => `${Math.round(n)} ms`;
const range = (xs: readonly number[]) => {
  const lo = Math.round(Math.min(...xs));
  const hi = Math.round(Math.max(...xs));
  return lo === hi ? `${lo} ms` : `${lo}-${hi} ms`;
};
const pct = (n: number) => `${n < 10 ? Math.round(n * 10) / 10 : Math.round(n)}%`;
const times = (n: number) => (n === 1 ? "once" : n === 2 ? "twice" : `${n} times`);
const list = (xs: readonly string[]) => (xs.length < 2 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);

/** A device the checkup looked at, with what its panel already knows about it. */
export interface Subject {
  /** Navigation id (`mouse:atk`). */
  id: string;
  name: string;
  /** Why changes can't be written to it at all (its tier is read-only); null when they can, or it isn't known yet. */
  blocked: string | null;
}

function fixFor(s: Subject, intent: FixIntent, label?: string): Finding["fix"] {
  return { device: s.id, intent, label: label ?? intentLabel(intent), ...(s.blocked ? { blocked: s.blocked } : {}) };
}

function report(s: Subject, kind: DeviceReport["kind"], findings: Finding[], checked: string[], source?: string): DeviceReport {
  return { device: s.id, name: s.name, kind, level: worst(findings.map((f) => f.level)), findings, checked, ...(source ? { source } : {}) };
}

export interface MouseSubject extends Subject {
  wireless: boolean;
  /** What its panel read (src/lib/feel/devices.ts); null when it hasn't been opened yet. */
  device: MouseDevice | null;
  /** Before its panel has read it: whether its driver has a debounce / polling setting at all (null: depends on the model). */
  known?: { debounce: boolean | null; polling: boolean | null };
}

export interface MouseMeasure {
  source: MouseSource;
  /** Windows held the motion reports back (it merges them for a listener in the background): their timing isn't the mouse's. */
  throttled?: boolean;
  clicks: ButtonEvent[];
  motion: MotionReport[];
  rest: MotionReport[];
}

const WIRELESS_ADVICE = "Keep the receiver close and in sight of the mouse: on the extension cable at the front of the desk if it came with one, away from USB 3 ports, the PC's back panel and the Wi-Fi router. A low battery makes it worse.";
const PORT_ADVICE = "Plug it straight into a port on the back of the PC, not a hub, a monitor's ports or the front panel.";

export function mouseReport(s: MouseSubject, m: MouseMeasure): DeviceReport {
  const findings: Finding[] = [];
  const checked: string[] = [];
  // Held-back reports say nothing about the mouse's polling: such a run is judged like the window's own events, and
  // its rate isn't given at all.
  const raw = m.source === "raw" && !m.throttled;

  const c = clickStats(m.clicks, 0);
  if (c.presses >= CLICKS.minPresses) {
    checked.push("clicks");
    if (c.bounces > 0) {
      const want = Math.ceil(Math.max(...c.gaps) + CLICKS.debounceMarginMs);
      const canSet = s.device ? (s.device.target.debounce?.options.length ?? 0) > 0 : (s.known?.debounce ?? true);
      findings.push({
        id: "clicks.bounce",
        level: c.bounces >= CLICKS.badCount ? "bad" : "warn",
        title: `The left button clicked twice on its own${c.bounces > 1 ? `, ${times(c.bounces)}` : ""}`,
        detail: `${c.bounces} of ${c.presses} presses came back ${range(c.gaps)} after you let go. No finger is that quick: it's the switch bouncing.`,
        ...(canSet ? { fix: fixFor(s, { kind: "debounce", atLeastMs: Math.max(want, 2) }) } : {}),
        advice: canSet
          ? "A longer debounce hides the bounce. If it keeps coming back, the switch is wearing out or has dust in it."
          : "The switch is wearing out or has dust in it. This mouse has no debounce setting to hide it; a switch cleaning or replacement cures it.",
      });
    }
  }

  const mo = motionStats(m.motion);
  const setHz = s.device?.now?.pollingHz ?? null;
  const canPoll = s.device ? (s.device.target.polling?.options.length ?? 0) > 0 : (s.known?.polling ?? true);
  const pollFix = (atMostHz: number) => (canPoll ? fixFor(s, { kind: "polling", atMostHz }) : undefined);
  if (mo) {
    checked.push(raw ? "polling" : "motion");
    let pollingFixed = false;
    if (raw && mo.dropouts > 0 && (mo.dropPct >= MOTION.dropWarnPct || mo.dropouts >= MOTION.dropWarnCount)) {
      const lower = s.wireless && setHz !== null && setHz > MOTION.wirelessSafeHz;
      const fix = lower ? pollFix(MOTION.wirelessSafeHz) : undefined;
      pollingFixed = !!fix;
      findings.push({
        id: "polling.dropouts",
        level: mo.dropPct >= MOTION.dropBadPct ? "bad" : "warn",
        title: s.wireless ? "The wireless link drops reports" : "Reports go missing",
        detail: `${mo.dropouts} ${mo.dropouts === 1 ? "gap" : "gaps"} of up to ${ms(mo.longestDropMs)} in ${(mo.movingMs / 1000).toFixed(1)} s of fast motion (${pct(mo.dropPct)} of the time).`,
        ...(fix ? { fix } : {}),
        advice: s.wireless ? `${lower ? `Rates above ${hzText(MOTION.wirelessSafeHz)} need a strong link. ` : ""}${WIRELESS_ADVICE}` : `A worn cable or a loose port does this. ${PORT_ADVICE}`,
      });
    }
    if (raw && setHz !== null && mo.hz !== null && mo.nominalHz !== null && mo.hz < MOTION.slowShare * setHz) {
      const fix = !pollingFixed && (s.device?.target.polling?.options ?? []).includes(mo.nominalHz) ? pollFix(mo.nominalHz) : undefined;
      pollingFixed ||= !!fix;
      findings.push({
        id: "polling.slow",
        level: "warn",
        title: `Runs at about ${hzText(mo.nominalHz)}, not the ${hzText(setHz)} it's set to`,
        detail: `It sent ${Math.round(mo.hz)} reports a second while it moved fast.`,
        ...(fix ? { fix: { ...fix, label: `Set polling to ${hzText(mo.nominalHz)}, what it reaches` } } : {}),
        advice: s.wireless ? `High rates often need the maker's 4K or 8K receiver. ${WIRELESS_ADVICE}` : PORT_ADVICE,
      });
    }
    if (raw && mo.unevenCv !== null && mo.unevenCv > MOTION.unevenCv) {
      const fix = !pollingFixed && setHz !== null && setHz > MOTION.stableHz ? pollFix(MOTION.stableHz) : undefined;
      findings.push({
        id: "polling.uneven",
        level: "warn",
        title: "Polling is uneven on this port",
        detail: `The number of reports per moment of motion varied by ${pct(mo.unevenCv * 100)}; a steady link varies by a few percent.`,
        ...(fix ? { fix } : {}),
        advice: s.wireless ? WIRELESS_ADVICE : PORT_ADVICE,
      });
    }
    if (raw && mo.jumps > 0) {
      checked.push("sensor");
      findings.push({
        id: "sensor.jumps",
        level: mo.jumps >= 3 ? "bad" : "warn",
        title: `The sensor jumped ${times(mo.jumps)}`,
        detail: `${mo.jumps === 1 ? "One report was" : `${mo.jumps} reports were`} many times bigger than the ones around ${mo.jumps === 1 ? "it" : "them"} during the circles.`,
        advice: "Clean the sensor window and the pad. Glossy, glass or busy patterned surfaces can do this too.",
      });
    } else if (raw) checked.push("sensor");
  }

  const r = restStats(m.rest);
  if (r.moved) {
    findings.push({
      id: "rest.moved",
      level: "warn",
      title: "The pointer moved while you weren't touching it",
      detail: `${r.reports} motion reports (${r.counts} counts) during the hands-off seconds.`,
      advice: "Dust or a shiny spot under the sensor can do this. If you bumped the desk, run the checkup again.",
    });
  }

  if (mo?.hz && !m.throttled && !findings.some((f) => f.id.startsWith("polling"))) {
    const steady = raw ? `steady at about ${hzText(mo.nominalHz ?? mo.hz)}` : `about ${hzText(mo.nominalHz ?? mo.hz)} (measured in the window, rough)`;
    findings.push({ id: "polling.ok", level: "good", title: `Polling ${steady}`, detail: `${mo.reports} motion reports, no gaps worth mentioning.` });
  }
  if (c.presses >= CLICKS.minPresses && c.bounces === 0) {
    findings.push({ id: "clicks.ok", level: "good", title: `${c.presses} clean clicks`, detail: c.paceMs ? `At your pace of one every ${ms(c.paceMs)}, none came back on its own.` : "None came back on its own." });
  }
  return report(s, "mouse", findings, checked, raw ? "Raw Input" : "the window's own events");
}

export interface KeyboardSubject extends Subject {
  device: KeyboardDevice | null;
}

export interface KeyboardMeasure {
  /** The key step: events and when it ended. */
  keys: KeyEvent[];
  keysEnd: number;
  /** Codes the key step asked for. */
  asked: readonly string[];
  hold: KeyEvent[];
  holdEnd: number;
  rest: KeyEvent[];
}

export function keyboardReport(s: KeyboardSubject, m: KeyboardMeasure): DeviceReport {
  const findings: Finding[] = [];
  const checked: string[] = [];
  const target = s.device?.target ?? null;
  const analog = !!target && (target.actuation !== null || target.rtSensitivity !== null);
  const rtOn = analog && !!s.device?.now?.rapidTrigger;
  const rtNow = s.device?.now?.rtPressMm ?? null;
  const rtWant = Math.max(HOLD.rtSafeMm, rtNow !== null ? rtNow * HOLD.rtFactor : 0);
  const rtFix = rtOn && target?.rtSensitivity ? fixFor(s, { kind: "rtSensitivity", atLeastMm: rtWant }) : undefined;
  const flickerAdvice = rtOn
    ? "Rapid trigger is set finer than a finger can hold still, so tiny movements count as letting go. A coarser setting keeps it fast without the flicker."
    : analog
      ? "On a magnetic board this usually means the key needs recalibrating in its maker's app (SYNQ never calibrates)."
      : "The switch is chattering: worn or dirty. Blow it out with air, or swap the switch if the board is hot-swap.";

  const stats = keyStats(m.keys, m.keysEnd);
  const pressed = m.asked.filter((c) => (stats.get(c)?.presses ?? 0) > 0);
  if (pressed.length) checked.push("keys");
  const bouncing = [...stats.entries()].filter(([, v]) => v.bounces > 0);
  if (bouncing.length) {
    const total = bouncing.reduce((a, [, v]) => a + v.bounces, 0);
    const names = bouncing.map(([k]) => keyLabel(k));
    findings.push({
      id: "keys.bounce",
      level: total >= KEYS.badCount ? "bad" : "warn",
      title: `${list(names)} fired twice from one press`,
      detail: `${total} quick re-${total === 1 ? "press" : "presses"}, ${range(bouncing.flatMap(([, v]) => v.gaps))} after letting go.`,
      ...(rtFix ? { fix: rtFix } : {}),
      advice: flickerAdvice,
    });
  }
  const stuck = [...stats.entries()].filter(([, v]) => v.stuck).map(([k]) => keyLabel(k));
  if (stuck.length) {
    findings.push({
      id: "keys.stuck",
      level: "bad",
      title: `${list(stuck)} stayed down after you let go`,
      detail: "The keyboard never said the key came back up.",
      advice: analog ? "On a magnetic board this usually means the key needs recalibrating in its maker's app." : "Check for something under the keycap, or a sticky switch.",
    });
  }
  const missing = m.asked.filter((c) => !(stats.get(c)?.presses ?? 0));
  if (missing.length && pressed.length) {
    findings.push({
      id: "keys.missing",
      level: "warn",
      title: `${list(missing.map(keyLabel))} never registered`,
      detail: `${pressed.length} of ${m.asked.length} keys came through.`,
      advice: "If you pressed it, try it in a text box. A key that stays silent needs its switch or socket looked at.",
    });
  }

  const h = holdStats(m.hold);
  if (h.pressed) {
    checked.push("hold");
    if (h.toggles > 0) {
      // The same cause as keys firing twice: said (and fixed) once.
      const twice = findings.some((f) => f.id === "keys.bounce");
      findings.push({
        id: "hold.flicker",
        level: h.toggles >= HOLD.badToggles ? "bad" : "warn",
        title: `${keyLabel(HOLD.code)} let go by itself ${times(h.toggles)} while you held it`,
        detail: `${h.toggles} ${h.toggles === 1 ? "release" : "releases"} in ${(h.spanMs / 1000).toFixed(1)} s of holding.${twice ? " Same cause as above." : ""}`,
        ...(rtFix && !twice ? { fix: rtFix } : {}),
        ...(twice ? {} : { advice: flickerAdvice }),
      });
    }
  }

  const ghost = phantomKeys(m.rest);
  if (ghost.length) {
    findings.push({
      id: "rest.keys",
      level: "warn",
      title: `${list(ghost.map(keyLabel))} pressed while nobody typed`,
      detail: "During the hands-off seconds.",
      advice: analog ? "A magnetic key that triggers on its own needs recalibrating in its maker's app, or a less sensitive actuation point." : "If you didn't touch it, the switch may be shorting. Run the checkup again to be sure.",
    });
  }

  if (pressed.length && !findings.length) {
    findings.push({ id: "keys.ok", level: "good", title: "Every key pressed once and let go cleanly", detail: `${pressed.length} keys, ${h.pressed ? "a steady hold, " : ""}no double presses.` });
  }
  return report(s, "keyboard", findings, checked);
}

export interface ControllerMeasure {
  rest: PadState[];
  spin: PadState[];
}

export function controllerReport(s: Subject, m: ControllerMeasure | null): DeviceReport {
  const findings: Finding[] = [];
  const checked: string[] = [];
  if (!m) return report(s, "controller", findings, checked);
  for (const st of stickChecks(m.rest, m.spin)) {
    const d = st.drift;
    if (d) {
      if (!checked.includes("drift")) checked.push("drift");
      if (d.magnitude >= STICKS.driftWarn) {
        const dz = Math.ceil((d.magnitude + STICKS.deadzoneMargin) * 100);
        findings.push({
          id: `drift.${st.label}`,
          level: d.magnitude >= STICKS.driftBad ? "bad" : "warn",
          title: `The ${st.label.toLowerCase()} drifts`,
          detail: `Left alone it sits ${pct(d.magnitude * 100)} off centre.`,
          advice: `Set an inner dead zone of at least ${dz}% in your games. Drift that grows over time is a worn stick module; a can of contact cleaner or a new module fixes it.`,
        });
      }
    }
    const r = st.round;
    if (r && r.covered >= STICKS.minBins) {
      if (!checked.includes("circularity")) checked.push("circularity");
      if (r.errorPct >= STICKS.roundWarnPct) {
        findings.push({
          id: `round.${st.label}`,
          level: r.errorPct >= STICKS.roundBadPct ? "bad" : "warn",
          title: `The ${st.label.toLowerCase()}'s circle is ${pct(r.errorPct)} off round`,
          detail: `Measured over ${r.covered} of 72 directions while you spun it.`,
          advice: "Some sticks are made that way. On a pad that used to be round, recalibrate it in the maker's app.",
        });
      }
    }
  }
  if (checked.length && !findings.length) findings.push({ id: "sticks.ok", level: "good", title: "Sticks centre and circle cleanly", detail: "No drift at rest, round at the edge." });
  return report(s, "controller", findings, checked);
}

const ENGINE_TITLE: Partial<Record<EngineStatus["state"], [Level, string]>> = {
  missing: ["bad", "The EQ engine isn't set up"],
  notOnOutput: ["warn", "The EQ engine isn't on this output"],
  disabled: ["warn", "The EQ is turned off"],
  broken: ["bad", "The EQ engine needs a repair"],
  noOutput: ["bad", "No sound output found"],
};

export function soundReport(s: Subject, status: EngineStatus | null, eq: EqSnapshot | null): DeviceReport {
  const findings: Finding[] = [];
  const checked: string[] = [];
  const open = { label: "Open Sound", device: s.id };
  if (status) {
    checked.push("engine");
    const t = ENGINE_TITLE[status.state];
    if (t) findings.push({ id: `engine.${status.state}`, level: t[0], title: t[1], detail: status.summary, open });
    for (const p of [...status.problems, ...(status.defaultOutput?.issues ?? [])]) {
      if (findings.some((f) => f.id === `issue.${p.code}`)) continue;
      findings.push({ id: `issue.${p.code}`, level: p.blocking ? "bad" : "warn", title: p.message, detail: p.blocking ? "This stops the EQ from playing." : "This may get in the EQ's way.", open });
    }
  }
  if (eq) {
    checked.push("levels");
    if (!eq.bypassed && eq.peakDb > AUDIO.clipDb + 0.05) {
      const over = Math.round(eq.peakDb * 10) / 10;
      findings.push({
        id: "eq.clip",
        level: "warn",
        title: "The EQ can clip on loud parts",
        detail: `It boosts up to +${over} dB after the preamp.`,
        advice: `Lower the preamp by ${over} dB on the Sound page (SYNQ never changes your EQ by itself).`,
        open,
      });
    }
    const bal = channelLevels(eq.advanced).balanceDb;
    if (bal !== null && Math.abs(bal) >= AUDIO.balanceWarnDb) {
      const db = Math.round(Math.abs(bal) * 10) / 10;
      findings.push({
        id: "eq.balance",
        level: Math.abs(bal) >= AUDIO.balanceBadDb ? "bad" : "warn",
        title: `${bal > 0 ? "Left" : "Right"} is ${db} dB louder than ${bal > 0 ? "right" : "left"}`,
        detail: "Set by Channel lines in your EQ config.",
        advice: "If that isn't on purpose for your ears, check the Channel and Preamp lines in the EQ's advanced text.",
        open,
      });
    }
  }
  if (checked.length && !findings.length) {
    const where = status?.defaultOutput?.title;
    findings.push({ id: "sound.ok", level: "good", title: where ? `The EQ is running on ${where}` : "The EQ is running", detail: "No clipping, both channels level." });
  }
  return report(s, "sound", findings, checked);
}
