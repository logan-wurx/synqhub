// Keyboard page: shows whichever supported keyboard is plugged in (a switcher when there are two,
// a neutral "plug in your keyboard" when there are none).
//   - ROG Falchion Ace HFX ZywOo: configured over its own HID channel (no Armoury Crate, no Gear
//     Link). Edits show at once, go out in short batches and are saved to the keyboard's active
//     profile; see src/lib/keyboard.ts for what is sent.
//   - MAGIC-REFINER X68 HE: X68Panel.tsx / src/lib/x68he.ts.
import { InfoAdvanced } from "@/components/advanced";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { forgetKept, peekKept, useKeptDraft, useKeptRef, useKeptScroll, useKeptState } from "@/lib/keep";
import { endSession, track, useSessionHold } from "@/lib/device-session";
import NumberFlow from "@number-flow/react";
import { ArrowRight, ArrowsLeftRight, Minus, Plus, X } from "@phosphor-icons/react";
import { cn, hzText } from "@/lib/utils";
import { isWeb, type Connected } from "@/lib/backend";
import {
  EFFECTS,
  LIMITS,
  POLLING_RATES,
  REMAP_TARGETS,
  connectKeyboard,
  keyLabel,
  type BatchResult,
  type Effect,
  type KeyboardSession,
  type KeyboardView,
  type ProfileSettings,
} from "@/lib/keyboard";
import type { PollingRateHz, Rgb } from "@/lib/keyboard-protocol";
import { Card, CardHeader, DetailRows, Eyebrow, type Notice } from "@/components/ui/matte";
import { BackButton, DeviceFrame, DeviceHeader, OverviewHero, ReconnectButton, StatusPill, StatusStrip, TAB_BODY, TierBadge, type TabDef } from "@/components/devices/shell";
import { KeyBoard, MmSlider, ModeSwitch, SelectionBar, rowsLayout, type MapKey, type MapLayout } from "@/components/devices/keymap";
import { AdvancedKeysFlow, SOCD_LEGALITY, type AdvFlow, type AdvType } from "@/components/devices/advkeys";
import { goHome, keyboardId, KEYBOARD_TABS_LEGACY, useDeviceTab } from "@/lib/nav";
import { useWide } from "@/lib/viewport";
import { GlassRadio, RockerSwitch } from "@/components/uiverse";
import { NumberField } from "@/components/ui/number-field";
import { Switch } from "@/components/ui/switch";
import { EqBarSlider } from "@/components/ui/eq-bar-slider";
import { deviceKeyboard } from "@/components/ui/brand";
import { DeviceArt } from "@/components/devices/DeviceArt";
import { FALCHION_ROWS, UNITS } from "./layout";
import { Banner, Chip, EmptyCard, KeyboardSwitcher, Pill, StepButton, SwitchRow, type KeyboardModel } from "./parts";
import { X68Panel } from "./X68Panel";
import { GenericKeyboard } from "./GenericKeyboard";
import { kbHost } from "@/lib/kb/confirm";
import { keyboardFamilies, keyboardFamilyOf, keyboardSessionKey, refreshKeyboards, useKeyboardAnswers } from "@/lib/kb/probe";
import { decideEarly, orderFamilies, type Answer } from "@/lib/mouse-order";
import { BOOTLOADER_NOTE } from "@/lib/bootloader-ids";
import { FeelCard, FeelOffer, type FeelDevice } from "@/components/feel/FeelPanel";
import { driveFalchion, type ApplyOutcome } from "@/lib/feel/drive";
import { feelStore } from "@/lib/feel/persist";
import type { Step } from "@/lib/feel/types";
import { isIllumipcHex } from "@/lib/illumipc/ids";

type Notify = (n: Omit<Notice, "id">, key?: string) => void;
type Phase = { kind: "connecting" } | { kind: "missing" } | { kind: "error"; message: string } | { kind: "ready" };
type Mode = "actuation" | "rapid" | "speedTap" | "remap";

const LIVE_REFRESH_MS = 10000;
const mm = (units: number) => (units / 10).toFixed(1);
const toUnits = (mmValue: number) => Math.round(mmValue * 10);
const clampUnits = (u: number, r: { min: number; max: number }) => Math.max(r.min, Math.min(r.max, u));
const rateLabel = (hz: number) => `${hz / 1000}K`;
const names = (keys: number[]) => keys.map(keyLabel).join(", ");
const errText = (e: unknown) => String(e).replace(/^Error: /, "");

const MODEL_OF = (d: Connected): KeyboardModel | null =>
  d.kind !== "keyboard" ? null : d.vid === "0b05" && d.pid === "1d1d" ? "falchion" : isIllumipcHex(d.vid, d.pid) ? "x68" : null;
const MODEL_LABEL: Record<string, string> = { falchion: "Falchion Ace HFX" };

/** The keyboard picked by hand last time (only a click in the switcher writes this). */
const PICKED_KEY = "onboard.keyboard";
const readPicked = (): KeyboardModel | null => {
  try {
    return localStorage.getItem(PICKED_KEY) || null;
  } catch {
    return null;
  }
};
const shortName = (name: string | undefined) => (name ?? "Keyboard").replace(/\s+(Keyboard|Dongle|Receiver)$/i, "");

/**
 * Shows one keyboard at a time: whichever is plugged in, or the one picked in the switcher when
 * several are. The Falchion and the X68 HE have their own panels; every other keyboard a driver
 * claims (VIA / Vial, OpenMouse keyboards) gets the generic panel (GenericKeyboard.tsx). Panels exist
 * only while their keyboard is connected. Only the panel on screen is mounted; its connection and
 * what was being edited are kept (src/lib/keep.ts, src/lib/device-session.ts), so switching never
 * drops either. With several keyboards and at least one generic one, the page first asks each generic
 * one for a quick read-only reply (src/lib/kb/probe.ts) and opens on the one that answers, as the
 * Mouse page does. A keyboard in firmware-update mode is only named in a note.
 */
export function KeyboardPage({ devices, notify, visible, family }: { devices: Connected[]; notify: Notify; visible: boolean; /** The keyboard opened from the Devices home. */ family?: KeyboardModel }) {
  const [picked, setPickedState] = useKeptState<KeyboardModel | null>("keyboard.picked", readPicked);
  const setPicked = useCallback(
    (family: KeyboardModel) => {
      setPickedState(family);
      try {
        localStorage.setItem(PICKED_KEY, family);
      } catch {
        // Storage can be unavailable; the pick then lasts for this session only.
      }
    },
    [setPickedState],
  );
  const answers = useKeyboardAnswers();
  const present = keyboardFamilies(devices);
  const presentKey = present.join();
  const seen = useKeptRef<string[]>("keyboard.seen", []);
  const updating = devices.filter((d) => d.kind === "keyboard" && d.bootloader);
  const [order, setOrder] = useState<KeyboardModel[]>([]);
  const stable = [...order.filter((f) => present.includes(f)), ...present.filter((f) => !order.includes(f))];
  const needsCheck = present.length > 1 && present.some((f) => f.startsWith("kb:"));
  const [decided, setDecided] = useState(!needsCheck || !!family);
  useEffect(() => {
    if (decided) return;
    if (!needsCheck) return setDecided(true);
    let alive = true;
    let done = false;
    const heard = new Map<KeyboardModel, Answer>();
    const decide = () => {
      if (!alive || done) return;
      const pick = decideEarly(present, heard, readPicked(), peekKept<KeyboardModel | null>("keyboard.picked", null));
      if (!pick) return;
      done = true;
      setOrder(orderFamilies(present, heard));
      setPickedState(pick);
      setDecided(true);
    };
    void refreshKeyboards(devices, (family, answer) => {
      heard.set(family, answer);
      decide();
    }).then(decide);
    return () => {
      alive = false;
    };
    // presentKey stands in for `present`/`devices`, which are new arrays every render.
  }, [presentKey, decided]);
  useEffect(() => {
    if (decided && present.length && (!picked || !present.includes(picked))) setPickedState(stable[0]);
    // A keyboard that went away: close its session now and forget its panel, as unmounting the
    // panel used to, so it starts fresh when it's plugged back in.
    for (const family of new Set(["falchion", "x68", ...seen.current])) {
      if (present.includes(family)) continue;
      const key = keyboardSessionKey(family);
      endSession(key);
      forgetKept(`${key}.`);
    }
    seen.current = present;
    // presentKey stands in for `present`, which is a new array every render.
  }, [presentKey, picked, decided]);
  const note = updating.length ? <Banner>{updating.map((d) => d.name).join(", ")}: {BOOTLOADER_NOTE}</Banner> : null;
  if (!present.length || !decided || (family && !present.includes(family))) {
    return (
      <div className="flex h-full flex-col gap-5 overflow-y-auto px-8 pb-10 pt-7 [&>*]:shrink-0">
        <header>
          <BackButton onClick={goHome}>Gear</BackButton>
          <div className="mt-5" />
          <Eyebrow>{present.length ? "Connecting" : "Not connected"}</Eyebrow>
          <h1 className="mt-3 text-[34px] font-semibold leading-[1.05] tracking-[-0.035em] text-foreground">Keyboard</h1>
          <p className="mt-2 text-[13.5px] text-muted-foreground">{present.length ? `${present.length} keyboards are plugged in.` : family ? "This keyboard isn't plugged in any more." : isWeb ? "SYNQ shows the keyboard you added in this browser." : "SYNQ shows the keyboard that's plugged into this PC."}</p>
        </header>
        {note}
        {present.length ? (
          <EmptyCard title="Looking for your keyboard…" text="Checking which one answers. This takes a second." />
        ) : (
          <EmptyCard title="Plug in your keyboard" text="Connect it with its USB cable. SYNQ finds it as soon as it's there." plug />
        )}
      </div>
    );
  }
  const shown: KeyboardModel = family && present.includes(family) ? family : picked && present.includes(picked) ? picked : stable[0];
  // The illumipc family ("x68") is the X68 HE or any of the other boards that driver speaks to: named by the device list.
  const label = (f: KeyboardModel) => {
    const name = devices.find((d) => keyboardFamilyOf(d) === f)?.name;
    return MODEL_LABEL[f] ?? (f === "x68" && /X68/i.test(name ?? "") ? "X68 HE" : shortName(name));
  };
  const artOf = (id: KeyboardModel) => {
    const d = devices.find((x) => keyboardFamilyOf(x) === id);
    return { kind: "keyboard" as const, family: id, name: label(id), brand: d?.brand, vid: d?.vid, pid: d?.pid };
  };
  const switcher =
    present.length > 1 && !family ? <KeyboardSwitcher options={stable.map((id) => ({ id, label: label(id), quiet: answers.get(id) === "quiet", art: artOf(id) }))} value={shown} onChange={setPicked} /> : null;
  const panel =
    shown === "falchion" ? (
      <FalchionPanel devices={devices} notify={notify} visible={visible} switcher={switcher} />
    ) : shown === "x68" ? (
      <X68Panel devices={devices} notify={notify} visible={visible} switcher={switcher} />
    ) : (
      // Keyed by keyboard, so each one has its own panel state.
      <GenericKeyboard key={shown} id={shown.slice(3)} devices={devices} getHost={kbHost} notify={notify} visible={visible} switcher={switcher} />
    );
  if (!note) return <div className="h-full">{panel}</div>;
  return (
    <div className="flex h-full flex-col">
      <div className="px-8 pt-5">{note}</div>
      <div className="min-h-0 flex-1">{panel}</div>
    </div>
  );
}

/** Kept-state names of the Falchion panel (see src/lib/keep.ts). */
const FAL = "keyboard.falchion";

function FalchionPanel({ devices, notify, visible, switcher }: { devices: Connected[]; notify: Notify; visible: boolean; switcher: ReactNode }) {
  const session = useKeptRef<KeyboardSession | null>(`${FAL}.session`, null);
  const unsubscribe = useKeptRef<(() => void) | null>(`${FAL}.unsubscribe`, null);
  const [phase, setPhase] = useKeptState<Phase>(`${FAL}.phase`, { kind: "connecting" });
  const [view, setView] = useKeptState<KeyboardView | null>(`${FAL}.view`, null);
  const [selected, setSelected] = useKeptState<number[]>(`${FAL}.selected`, []);
  const mapRef = useRef<HTMLDivElement>(null);
  /** The connect in flight, and why the last quiet one failed (see `quiet` below). */
  const connecting = useKeptRef<Promise<boolean> | null>(`${FAL}.connecting`, null);
  const quietError = useKeptRef<string | null>(`${FAL}.quietError`, null);

  const detected = devices.find((d) => MODEL_OF(d) === "falchion");
  const attachKey = detected ? `${detected.vid}:${detected.pid}` : "";

  const drop = async () => {
    unsubscribe.current?.();
    unsubscribe.current = null;
    const s = session.current;
    session.current = null;
    await s?.close().catch(() => undefined);
  };

  /**
   * `quiet`: reopening after the idle close (src/lib/device-session.ts). The last view stays on
   * screen while it reconnects, and if the keyboard doesn't answer the panel stays as it was, with
   * the error kept for the next change, as an open session that lost the keyboard would behave.
   */
  const connect = useCallback(
    (quiet = false): Promise<boolean> => {
      const work = (async () => {
        if (!quiet) setPhase({ kind: "connecting" });
        await drop();
        try {
          const s = await connectKeyboard();
          if (!s) {
            if (quiet) quietError.current = "The keyboard isn't plugged in. Connect the Falchion with its USB cable.";
            else setPhase({ kind: "missing" });
            return false;
          }
          session.current = s;
          quietError.current = null;
          unsubscribe.current = s.subscribe(setView);
          setView(s.view);
          setPhase({ kind: "ready" });
          return true;
        } catch (e) {
          const message = errText(e);
          const text = /no answer|timed? ?out/i.test(message) ? "The keyboard didn't answer. Unplug it, plug it back in, then press Reconnect." : message;
          if (quiet) quietError.current = text;
          else setPhase({ kind: "error", message: text });
          return false;
        }
      })();
      connecting.current = work;
      void work.finally(() => {
        if (connecting.current === work) connecting.current = null;
      });
      return track(FAL, work);
    },
    // drop only reads kept refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [setPhase, setView],
  );

  // Connect the first time the page is shown, and again when the keyboard is plugged or unplugged.
  const connectedFor = useKeptRef<string | null>(`${FAL}.connectedFor`, null);
  const resumeFor = useKeptRef<string | null>(`${FAL}.resumeFor`, null);
  useEffect(() => {
    if (!visible || connectedFor.current === attachKey) return;
    const quiet = resumeFor.current === attachKey;
    resumeFor.current = null;
    connectedFor.current = attachKey;
    void connect(quiet).then((ok) => {
      // Try again quietly the next time the panel is shown.
      if (!ok && quiet && connectedFor.current === attachKey) {
        connectedFor.current = null;
        resumeFor.current = attachKey;
      }
    });
  }, [attachKey, visible, connect, connectedFor, resumeFor]);

  // The session stays open while the panel is away (a batch in flight still goes out) and closes
  // after a short idle.
  useSessionHold(FAL, async () => {
    if (!session.current) return;
    resumeFor.current = connectedFor.current;
    connectedFor.current = null;
    await drop();
  });

  /** The open session, reopening it first after the idle close; null (with a notice) if it can't. */
  const live = async (): Promise<KeyboardSession | null> => {
    if (!session.current && phase.kind === "ready") {
      await (connecting.current ?? connect(true));
      if (!session.current) {
        notify({ title: "Not saved", detail: quietError.current ?? "The keyboard didn't answer.", tone: "error" }, "keyboard");
        return null;
      }
    }
    return session.current;
  };

  // The keyboard reports its profile, rapid-trigger switch and Speed Tap itself: keep those fresh.
  useEffect(() => {
    if (!visible || phase.kind !== "ready") return;
    let inFlight = false;
    const tick = () => {
      const s = session.current;
      if (!s || inFlight || !document.hasFocus()) return;
      inFlight = true;
      s.refresh()
        .catch(() => undefined)
        .finally(() => (inFlight = false));
    };
    const t = window.setInterval(tick, LIVE_REFRESH_MS);
    window.addEventListener("focus", tick);
    return () => {
      window.clearInterval(t);
      window.removeEventListener("focus", tick);
    };
  }, [visible, phase.kind]);

  const done = useCallback(
    (r: BatchResult) => {
      if (r.reports) {
        notify({ title: r.label, detail: `Saved to the keyboard · confirmed in ${r.echoMs} ms`, tone: "ok" }, "keyboard");
        void feelStore.noteConfigured("keyboard", keyboardId("falchion"));
      }
    },
    [notify],
  );
  const failed = useCallback((e: unknown) => notify({ title: "Not saved", detail: errText(e), tone: "error" }, "keyboard"), [notify]);

  const save = useCallback(
    (label: string, change: (s: ProfileSettings) => void) => {
      const s = session.current;
      if (s) track(FAL, s.update(label, change)).then(done, failed);
      else void live().then((r) => r && track(FAL, r.update(label, change)).then(done, failed));
    },
    // live only reads kept refs and the phase.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [done, failed, phase.kind],
  );

  const s = view?.settings;
  const ready = phase.kind === "ready" && view && s;

  const wide = useWide();
  const asideOn = wide && ready;
  const tabs: TabDef[] = [
    ...(asideOn ? [] : [{ id: "overview", label: "Overview" }]),
    { id: "keys", label: "Keys" },
    { id: "advkeys", label: "Advanced Keys" },
    { id: "remap", label: "Remap & Lighting" },
    { id: "advanced", label: "Advanced" },
  ];
  const [tab, pickTab] = useDeviceTab(keyboardId("falchion"), tabs.map((t) => t.id), KEYBOARD_TABS_LEGACY);
  const goTab = (t: string) => {
    setSelected([]);
    pickTab(t);
  };
  const body = useKeptScroll(`${FAL}.scroll.${tab}`);
  const [keysMode, setKeysMode] = useKeptState<"actuation" | "rapid">(`${FAL}.keysMode`, "actuation");
  const mode: Mode = tab === "keys" ? keysMode : tab === "remap" ? "remap" : tab === "advkeys" ? "speedTap" : "actuation";
  const [flow, setFlow] = useKeptState<AdvFlow | null>(`${FAL}.advFlow`, null);

  const baseLayout = useMemo(
    () => rowsLayout(FALCHION_ROWS, UNITS, (k) => ({ id: k.index, label: k.label, locked: k.locked, title: keyLabel(k.index) })),
    [],
  );
  const mapLayout = useMemo<MapLayout>(() => {
    const marks = s ? marksFor(mode, s) : new Map<number, Mark>();
    return { ...baseLayout, keys: baseLayout.keys.map((k) => ({ ...k, mark: marks.get(k.id) as MapKey["mark"] })) };
  }, [baseLayout, mode, s]);
  const selectable = useMemo(() => baseLayout.keys.filter((k) => !k.locked).map((k) => k.id), [baseLayout]);

  const mapCard = (title: string, hint: string, inspector: ReactNode, opts: { multi?: boolean; extra?: ReactNode; right?: ReactNode } = {}) => (
    <div ref={mapRef}>
      <Card>
        <CardHeader title={title} hint={hint} right={opts.right} />
        <div className="px-5 pb-5 pt-4">
          <KeyBoard layout={mapLayout} selected={selected} onSelect={setSelected} multi={opts.multi ?? true} label={title} />
          <SelectionBar
            count={selected.length}
            names={names(selected)}
            onSelectAll={opts.multi === false ? undefined : () => setSelected(selectable)}
            onDiscard={() => setSelected([])}
            extra={opts.extra}
          >
            {inspector}
          </SelectionBar>
        </div>
      </Card>
    </div>
  );
  const keysSwitch = (
    <ModeSwitch
      label="Key map shows"
      value={keysMode}
      onChange={(m) => {
        setKeysMode(m);
        setSelected([]);
      }}
      options={[
        { id: "actuation", label: "Actuation" },
        { id: "rapid", label: "Rapid trigger" },
      ]}
    />
  );
  const focusMap = () => mapRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });

  /** "Keep your feel": a plan's steps as one edit of the profile; the session batches, saves and checks the echo. */
  const applyFeel = async (steps: Step[]): Promise<ApplyOutcome<unknown>> => {
    const stop = (error: string): ApplyOutcome<unknown> => ({ ok: false, done: 0, total: steps.length, error, view: null });
    if (!session.current && phase.kind === "ready") {
      await (connecting.current ?? connect(true));
      if (!session.current) return stop(quietError.current ?? "The keyboard didn't answer.");
    }
    const live = session.current;
    if (!live) return stop("The keyboard isn't connected.");
    const r = await track(FAL, driveFalchion(live, steps));
    if (r.ok) void feelStore.noteConfigured("keyboard", keyboardId("falchion"));
    return r;
  };
  const feel: FeelDevice | undefined = ready
    ? {
        id: keyboardId("falchion"),
        kind: "keyboard",
        family: "falchion",
        name: "Falchion Ace HFX",
        brand: "ASUS ROG",
        view,
        notify,
        apply: applyFeel,
        backup: false,
        gate: { writable: view.link === "ok", reason: "The keyboard is reconnecting. Try again in a moment." },
      }
    : undefined;

  const overview = ready ? (
              <>
                {feel && <FeelOffer {...feel} />}
                <OverviewHero
                  art={<DeviceArt spec={{ kind: "keyboard", family: "falchion", name: "Falchion Ace HFX" }} />}
                  live
                  connection="Wired"
                  name={view.info.name.replace(/ Edition$/, "")}
                  detail={`USB · Profile ${view.info.profile} of ${view.info.profiles}. Everything you change is saved to that profile on the keyboard.`}
                />
                <StatusStrip
                  stats={[
                    { label: "Type", value: "Hall effect", note: "HFX magnetic switches" },
                    { label: "Actuation", value: `${mm(s.actuation)} mm`, note: Object.keys(s.keys).length ? `${Object.keys(s.keys).length} keys differ` : "Every key the same" },
                    {
                      label: "Rapid trigger",
                      value: s.rapidTrigger.enabled && s.rapidTrigger.keys.length ? `On · ${s.rapidTrigger.keys.length} keys` : "Off",
                      note: view.rapidTriggerSwitch ? undefined : "Keyboard switch is off",
                    },
                    { label: "Sensitivity", value: s.rapidTrigger.independent ? `${mm(s.rapidTrigger.press)} / ${mm(s.rapidTrigger.release)} mm` : `${mm(s.rapidTrigger.sensitivity)} mm` },
                    { label: "Profile", value: `${view.info.profile} of ${view.info.profiles}` },
                  ]}
                />
                {feel && <FeelCard {...feel} />}
                <Card innerClassName="px-6 py-4">
                  <DetailRows
                    rows={[
                      ["Firmware", <span className="tabular">{view.info.firmware || "—"}</span>],
                      ["Polling rate", <span className="tabular">{hzText(s.pollingHz)}</span>],
                      ["Connection", "USB cable"],
                    ]}
                  />
                </Card>
              </>
  ) : null;

  return (
    <DeviceFrame
      aside={overview}
      header={
      <DeviceHeader
        id={keyboardId("falchion")}
        name={ready ? view.info.name.replace(/ Edition$/, "") : "Keyboard"}
        subtitle={ready ? `Changes are saved to Profile ${view.info.profile} on the keyboard, so they work without any app running.` : (detected?.name ?? "Keyboard")}
        pills={
          <>
            <StatusPill live={!!ready}>
              {ready
                ? view.link === "ok"
                  ? view.busy
                    ? "Saving"
                    : `USB · Profile ${view.info.profile}`
                  : "Reconnecting"
                : phase.kind === "connecting"
                  ? "Connecting"
                  : "Not connected"}
            </StatusPill>
            {ready && <TierBadge tier="verified" />}
          </>
        }
        actions={
          <>
            {switcher}
            <ReconnectButton onClick={() => void connect()} />
          </>
        }
        tabs={tabs}
        tab={tab}
        onTab={goTab}
      />
      }
    >
      <div key={tab} ref={body} className={TAB_BODY} tabIndex={0}>
        {phase.kind === "connecting" && <EmptyCard title="Looking for your keyboard…" text="This takes a second." image={deviceKeyboard} pulse />}
        {phase.kind === "missing" && (
          <EmptyCard title="Plug it in" text="Connect the Falchion with its USB cable. SYNQ finds it as soon as it's there." plug />
        )}
        {phase.kind === "error" && <EmptyCard title="Couldn't talk to the keyboard" text={phase.message} plug />}
        {phase.kind === "ready" && view?.link === "lost" && (
          <EmptyCard title="The keyboard went away" text="It stopped answering. Check the cable, then press Reconnect." plug />
        )}

        {ready && view.link !== "lost" && (
          <>
            {view.link === "reconnecting" && <Banner>The keyboard dropped off USB for a moment. Waiting for it to come back…</Banner>}
            {view.rapidTriggerSwitch === false && s.rapidTrigger.enabled && s.rapidTrigger.keys.length > 0 && (
              <Banner>
                Rapid trigger is switched off on the keyboard itself, so these settings wait until it's back on. Turn it on with the keyboard's rapid-trigger
                shortcut; SYNQ can't flip that switch.
              </Banner>
            )}
            {view.source === "assumed" && (
              <Banner>
                SYNQ hasn't saved anything to Profile {view.info.profile} yet, and the keyboard can't report these values, so they're a starting guess. Anything
                you change here is written for real.
              </Banner>
            )}

            {tab === "overview" && overview}

            {tab === "keys" && (
              <>
                {keysMode === "actuation"
                  ? mapCard(
                      "Actuation, key by key",
                      "Every key shows its actuation point in mm. Tinted keys have their own. Select keys to change them together.",
                      <ActuationInspector s={s} selected={selected} save={save} onClear={() => setSelected([])} />,
                      {
                        right: keysSwitch,
                        extra:
                          Object.keys(s.keys).length > 0 ? (
                            <Pill onClick={() => save("Every key back on the global values", (d) => void (d.keys = {}))}>Reset all keys</Pill>
                          ) : undefined,
                      },
                    )
                  : mapCard(
                      "Rapid trigger, key by key",
                      "Tinted keys use rapid trigger and show their sensitivity in mm. Select keys to turn it on or off for them.",
                      <RapidInspector s={s} selected={selected} save={save} />,
                      { right: keysSwitch },
                    )}
                {keysMode === "actuation" ? (
                  <ActuationCard s={s} save={save} onKeys={focusMap} />
                ) : (
                  <RapidTriggerCard s={s} keyboardSwitch={view.rapidTriggerSwitch} save={save} onKeys={focusMap} />
                )}
              </>
            )}

            {tab === "advkeys" && (
              <AdvancedKeysFlow
                types={FAL_ADV_TYPES}
                active={
                  s.speedTap.enabled
                    ? [
                        {
                          id: "speedtap",
                          typeId: "snap",
                          title: `Snap tap: ${keyLabel(s.speedTap.key1)} and ${keyLabel(s.speedTap.key2)}`,
                          detail: "When both are held, the last one pressed wins",
                          legality: SOCD_LEGALITY,
                          onRemove: () => save("Speed Tap off", (d) => void (d.speedTap.enabled = false)),
                        },
                      ]
                    : []
                }
                max={1}
                canWrite
                slotsNote="The Falchion keeps one snap-tap pair."
                flow={flow}
                setFlow={setFlow}
                layout={mapLayout}
                keyNames={names}
                setup={null}
                review={
                  <p className="text-[13px] text-foreground">
                    <span className="text-muted-foreground">Keys: </span>
                    {flow ? names(flow.keys) : ""}
                    <span className="mt-1 block text-[12.5px] text-muted-foreground">When both are held, the last one you pressed wins.</span>
                  </p>
                }
                canSave
                onSave={() => {
                  if (!flow || flow.keys.length !== 2) return;
                  const [k1, k2] = flow.keys;
                  save(`Snap tap on: ${names(flow.keys)}`, (d) => {
                    d.speedTap.key1 = k1;
                    d.speedTap.key2 = k2;
                    d.speedTap.enabled = true;
                  });
                  setFlow(null);
                }}
              />
            )}

            {tab === "remap" && (
              <>
                {mapCard("Remap", "Click a key to change what it sends. Tinted keys already send something else. Fn can't be remapped.", <RemapInspector s={s} selected={selected} save={save} />, { multi: false })}
                {selected.length === 0 && <RemapList s={s} save={save} />}
                <LightingCard s={s} save={save} />
              </>
            )}

            {tab === "advanced" && (
              <>
                <PollingCard
                  s={s}
                  busy={view.busy}
                  onApply={(hz) => {
                    void live().then((r) => r && track(FAL, r.setPolling(hz)).then(done, failed));
                  }}
                />
                <InfoAdvanced
                  id="falchion"
                  deviceName={view.info.name}
                  kind="keyboard"
                  brand="ASUS"
                  firmware={view.info.firmware ? [`Firmware ${view.info.firmware}`] : []}
                  why="The Falchion ZywOo has its own panel and keeps its remaps there; ASUS's calibration, pairing and reset commands aren't unlocked for it."
                  notify={notify}
                />
                <p className="px-1 text-[12px] leading-relaxed text-muted-foreground/80">
                  The keyboard reports its profile, firmware, rapid-trigger switch and Speed Tap state. Everything else is SYNQ's copy of what was last saved to
                  it{view.source === "capture" ? ", starting from the settings Gear Link left on it" : ""}. Every report SYNQ sends is logged {isWeb ? "in this browser" : "in its data folder"}.
                </p>
              </>
            )}
          </>
        )}
      </div>
    </DeviceFrame>
  );
}

const FAL_ADV_TYPES: AdvType[] = [
  {
    id: "snap",
    title: "Snap tap",
    blurb: "Two opposite keys, like A and D. When both are held the last one you pressed wins, so a strafe turns around at once.",
    icon: ArrowsLeftRight,
    pick: 2,
    steps: ["Pick the two keys", "Set it up", "Review"],
    legality: SOCD_LEGALITY,
  },
];


// ---------------------------------------------------------------------------------------------
// Global actuation and dead zones
// ---------------------------------------------------------------------------------------------

type Save = (label: string, change: (s: ProfileSettings) => void) => void;

const ACTUATION_PRESETS = [5, 10, 15, 20];

function ActuationCard({ s, save, onKeys }: { s: ProfileSettings; save: Save; onKeys: () => void }) {
  const overrides = Object.keys(s.keys).length;
  const setActuation = (u: number) => {
    const v = clampUnits(u, LIMITS.actuation);
    if (v !== s.actuation) save(`Actuation set to ${mm(v)} mm`, (d) => void (d.actuation = v));
  };
  return (
    <Card innerClassName="relative flex gap-6 px-6 pb-6 pt-5">
      <div className="min-w-0 flex-1">
        <p className="text-[13px] text-muted-foreground">Actuation point</p>
        <div className="mt-3 flex items-baseline gap-3">
          <NumberFlow
            value={s.actuation / 10}
            format={{ minimumFractionDigits: 1, maximumFractionDigits: 1 }}
            className="tabular text-[86px] font-medium leading-none tracking-[-0.06em] text-foreground [text-shadow:0_0_28px_color-mix(in_srgb,var(--primary)_30%,transparent)]"
          />
          <span className="text-[18px] text-muted-foreground">mm</span>
        </div>
        <p className="mt-1 text-[12.5px] text-muted-foreground">How far a key goes down before it registers. Lower is faster, higher forgives a resting finger.</p>
        <div className="mt-5 flex flex-wrap items-center gap-2">
          <StepButton label="0.1 mm higher" onClick={() => setActuation(s.actuation - 1)} disabled={s.actuation <= LIMITS.actuation.min}>
            <Minus size={12} />
          </StepButton>
          <StepButton label="0.1 mm deeper" onClick={() => setActuation(s.actuation + 1)} disabled={s.actuation >= LIMITS.actuation.max}>
            <Plus size={12} />
          </StepButton>
          <span className="mx-1 h-5 w-px bg-white/[0.08]" />
          {ACTUATION_PRESETS.map((u) => (
            <Chip key={u} numeric on={u === s.actuation} onClick={() => setActuation(u)}>
              {mm(u)}
            </Chip>
          ))}
        </div>
        <div className="mt-5 grid max-w-[340px] grid-cols-2 gap-3">
          <MmField
            label="Top dead zone"
            units={s.top}
            range={LIMITS.deadZone}
            onCommit={(v) => v !== s.top && save(`Top dead zone set to ${mm(v)} mm`, (d) => void (d.top = v))}
          />
          <MmField
            label="Bottom dead zone"
            units={s.bottom}
            range={LIMITS.deadZone}
            onCommit={(v) => v !== s.bottom && save(`Bottom dead zone set to ${mm(v)} mm`, (d) => void (d.bottom = v))}
          />
        </div>
        <button onClick={onKeys} className="mt-4 flex items-center gap-1.5 text-[12.5px] text-muted-foreground transition-colors hover:text-foreground">
          {overrides === 0 ? "Set keys individually" : overrides === 1 ? "1 key has its own value" : `${overrides} keys have their own values`}
          <ArrowRight size={12} />
        </button>
      </div>
      <TravelGauge s={s} />
    </Card>
  );
}

/** Key travel from rest (top) to bottom-out, with the dead zones and the actuation point. */
function TravelGauge({ s }: { s: ProfileSettings }) {
  const H = 236;
  const max = LIMITS.actuation.max;
  const y = (u: number) => (u / max) * H;
  return (
    <div className="flex shrink-0 select-none gap-2.5 pt-1" aria-hidden="true">
      <div className="flex flex-col justify-between py-[1px] text-right text-[10.5px] text-muted-foreground/80 tabular" style={{ height: H }}>
        {[0, 1, 2, 3, 4].map((v) => (
          <span key={v} className="leading-none">
            {v}
          </span>
        ))}
      </div>
      <div className="relative w-9 overflow-hidden rounded-full bg-black/40 ring-1 ring-white/[0.06] shadow-[inset_0_2px_6px_rgb(0_0_0/0.6)]" style={{ height: H }}>
        <div className="absolute inset-x-0 top-0 bg-white/[0.06] transition-all duration-500 ease-fluid" style={{ height: y(s.top) }} />
        <div className="absolute inset-x-0 bottom-0 bg-white/[0.06] transition-all duration-500 ease-fluid" style={{ height: y(s.bottom) }} />
        {Object.values(s.keys).map((o, i) => (
          <div key={i} className="absolute inset-x-2 h-px bg-white/30 transition-all duration-500 ease-fluid" style={{ top: y(o.actuation) }} />
        ))}
        <div
          className="absolute inset-x-0 h-[3px] -translate-y-1/2 bg-primary shadow-[0_0_12px_var(--primary)] transition-all duration-500 ease-fluid"
          style={{ top: y(s.actuation) }}
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Rapid trigger
// ---------------------------------------------------------------------------------------------

function RapidTriggerCard({ s, keyboardSwitch, save, onKeys }: { s: ProfileSettings; keyboardSwitch: boolean; save: Save; onKeys: () => void }) {
  const rt = s.rapidTrigger;
  const lit = rt.enabled && rt.keys.length > 0;
  return (
    <Card innerClassName="flex flex-col px-6 pb-5 pt-5">
      <div className="flex items-start gap-5">
        <RockerSwitch
          width={58}
          checked={rt.enabled}
          label="Rapid trigger"
          onChange={(on) => save(on ? "Rapid trigger on" : "Rapid trigger off", (d) => void (d.rapidTrigger.enabled = on))}
        />
        <div className="min-w-0 flex-1 pt-1">
          <p className="text-[15px] font-medium text-foreground">Rapid trigger</p>
          <p className="mt-1 text-[12.5px] leading-relaxed text-muted-foreground">
            {lit ? `On for ${names(rt.keys)}` : rt.enabled ? "On, but no keys picked yet" : "Off for every key"}
          </p>
          <p className="mt-2 flex items-center gap-1.5 text-[11.5px] text-muted-foreground">
            <span className={cn("size-1.5 rounded-full", keyboardSwitch ? "bg-primary shadow-[0_0_8px_var(--primary)]" : "bg-white/20")} />
            Keyboard switch {keyboardSwitch ? "on" : "off"}
          </p>
        </div>
      </div>
      <div className="mt-4 divide-y divide-white/[0.05]">
        <SwitchRow
          title="Separate press and release"
          hint="Different distances for re-pressing and releasing."
          checked={rt.independent}
          onChange={(on) => save(on ? "Press and release now separate" : "One sensitivity for press and release", (d) => void (d.rapidTrigger.independent = on))}
        />
        <SwitchRow
          title="Continuous"
          hint="Stays active all the way up instead of resetting at the top."
          checked={rt.continuous}
          onChange={(on) => save(on ? "Continuous rapid trigger on" : "Continuous rapid trigger off", (d) => void (d.rapidTrigger.continuous = on))}
        />
      </div>
      <div className="mt-3 grid grid-cols-2 gap-3">
        {rt.independent ? (
          <>
            <MmField
              label="Press"
              units={rt.press}
              range={LIMITS.rapidTrigger}
              onCommit={(v) => v !== rt.press && save(`Rapid trigger press set to ${mm(v)} mm`, (d) => void (d.rapidTrigger.press = v))}
            />
            <MmField
              label="Release"
              units={rt.release}
              range={LIMITS.rapidTrigger}
              onCommit={(v) => v !== rt.release && save(`Rapid trigger release set to ${mm(v)} mm`, (d) => void (d.rapidTrigger.release = v))}
            />
          </>
        ) : (
          <MmField
            label="Sensitivity"
            units={rt.sensitivity}
            range={LIMITS.rapidTrigger}
            onCommit={(v) => v !== rt.sensitivity && save(`Rapid trigger set to ${mm(v)} mm`, (d) => void (d.rapidTrigger.sensitivity = v))}
          />
        )}
      </div>
      <button onClick={onKeys} className="mt-4 flex items-center gap-1.5 self-start text-[12.5px] text-muted-foreground transition-colors hover:text-foreground">
        Choose keys <ArrowRight size={12} />
      </button>
    </Card>
  );
}

// ---------------------------------------------------------------------------------------------
// Key map
// ---------------------------------------------------------------------------------------------

interface Mark {
  /** Lit: the setting is on for this key. Dim: set but switched off. None: the default. */
  tone?: "lit" | "dim";
  text?: string;
}

/** Every key a person can tune (Fn can't be). */
const TUNABLE = FALCHION_ROWS.flat().filter((k) => !k.locked);

/** What each key shows on the map for this tab: its current value, so the map reads like a settings sheet. */
function marksFor(mode: Mode, s: ProfileSettings): Map<number, Mark> {
  const m = new Map<number, Mark>();
  if (mode === "actuation") {
    for (const k of TUNABLE) {
      const o = s.keys[k.index];
      m.set(k.index, o ? { tone: "lit", text: mm(o.actuation) } : { text: mm(s.actuation) });
    }
  } else if (mode === "rapid") {
    const rt = s.rapidTrigger;
    // Own sensitivity in short form so it fits a 1u key: ".1/.2" (press/release) or ".2".
    const short = (u: number) => mm(u).replace(/^0/, "");
    for (const k of TUNABLE) {
      if (!rt.keys.includes(k.index)) {
        m.set(k.index, { text: "off" });
        continue;
      }
      const c = rt.custom[k.index];
      const own = c ? (rt.independent ? `${short(c.press)}/${short(c.release)}` : short(c.sensitivity)) : rt.independent ? `${short(rt.press)}/${short(rt.release)}` : short(rt.sensitivity);
      m.set(k.index, { tone: rt.enabled ? "lit" : "dim", text: own });
    }
  } else if (mode === "speedTap") {
    const st = s.speedTap;
    m.set(st.key1, { tone: st.enabled ? "lit" : "dim", text: "1" });
    m.set(st.key2, { tone: st.enabled ? "lit" : "dim", text: "2" });
  } else {
    for (const [k, t] of Object.entries(s.remaps)) m.set(Number(k), { tone: "lit", text: `→ ${keyLabel(t)}` });
  }
  return m;
}

// ---------------------------------------------------------------------------------------------
// Controls under the key map (what to do with the selected keys, per tab)
// ---------------------------------------------------------------------------------------------

function ActuationInspector({ s, selected, save, onClear }: { s: ProfileSettings; selected: number[]; save: Save; onClear: () => void }) {
  const first = selected.map((k) => s.keys[k]).find(Boolean);
  const seed = first ?? { actuation: s.actuation, top: s.top, bottom: s.bottom };
  const seedKey = `${selected.join()}|${seed.actuation}|${seed.top}|${seed.bottom}`;
  const [draft, setDraft] = useKeptDraft(`${FAL}.actuationDraft`, seed, seedKey);
  const withOwn = selected.filter((k) => s.keys[k]);

  return (
    <div className="flex flex-wrap items-end gap-5">
      <MmSlider
        label="Actuation"
        value={draft.actuation / 10}
        min={LIMITS.actuation.min / 10}
        max={LIMITS.actuation.max / 10}
        step={0.1}
        onChange={(v) => setDraft({ ...draft, actuation: clampUnits(toUnits(v), LIMITS.actuation) })}
        className="w-[280px]"
      />
      <MmField label="Top dead zone" units={draft.top} range={LIMITS.deadZone} onCommit={(v) => setDraft({ ...draft, top: v })} className="w-[110px]" />
      <MmField label="Bottom dead zone" units={draft.bottom} range={LIMITS.deadZone} onCommit={(v) => setDraft({ ...draft, bottom: v })} className="w-[110px]" />
      <div className="flex gap-2">
        {withOwn.length > 0 && (
          <Pill
            onClick={() => {
              save(`${names(withOwn)} back on the global values`, (d) => withOwn.forEach((k) => delete d.keys[k]));
              onClear();
            }}
          >
            Use global
          </Pill>
        )}
        <Pill primary onClick={() => save(`${names(selected)} set to ${mm(draft.actuation)} mm`, (d) => selected.forEach((k) => (d.keys[k] = { ...draft })))}>
          Set for {selected.length === 1 ? keyLabel(selected[0]) : `${selected.length} keys`}
        </Pill>
      </div>
    </div>
  );
}

function RapidInspector({ s, selected, save }: { s: ProfileSettings; selected: number[]; save: Save }) {
  const rt = s.rapidTrigger;
  const inGroup = selected.filter((k) => rt.keys.includes(k));
  const outGroup = selected.filter((k) => !rt.keys.includes(k));
  const own = inGroup.length > 0 && inGroup.every((k) => rt.custom[k]);
  const c = inGroup.map((k) => rt.custom[k]).find(Boolean) ?? { sensitivity: rt.sensitivity, press: rt.press, release: rt.release };
  const setCustom = (patch: Partial<typeof c>) =>
    save(`Rapid trigger for ${names(inGroup)} updated`, (d) => inGroup.forEach((k) => (d.rapidTrigger.custom[k] = { ...c, ...d.rapidTrigger.custom[k], ...patch })));

  return (
    <div className="flex flex-wrap items-end gap-4">
      {inGroup.length > 0 && (
        <label className="flex items-center gap-2.5 self-center text-[12.5px] text-muted-foreground">
          <Switch
            checked={own}
            aria-label="Own sensitivity"
            onCheckedChange={(on) =>
              save(on ? `${names(inGroup)} get their own sensitivity` : `${names(inGroup)} follow the group again`, (d) =>
                inGroup.forEach((k) => {
                  if (on) d.rapidTrigger.custom[k] = { ...c };
                  else delete d.rapidTrigger.custom[k];
                }),
              )
            }
          />
          Own sensitivity
        </label>
      )}
      {own &&
        (rt.independent ? (
          <>
            <MmField label="Press" units={c.press} range={LIMITS.rapidTrigger} onCommit={(v) => v !== c.press && setCustom({ press: v })} className="w-[100px]" />
            <MmField label="Release" units={c.release} range={LIMITS.rapidTrigger} onCommit={(v) => v !== c.release && setCustom({ release: v })} className="w-[100px]" />
          </>
        ) : (
          <MmField label="Sensitivity" units={c.sensitivity} range={LIMITS.rapidTrigger} onCommit={(v) => v !== c.sensitivity && setCustom({ sensitivity: v })} className="w-[100px]" />
        ))}
      <div className="flex gap-2">
        {inGroup.length > 0 && (
          <Pill
            onClick={() =>
              save(`Rapid trigger off for ${names(inGroup)}`, (d) => {
                d.rapidTrigger.keys = d.rapidTrigger.keys.filter((k) => !inGroup.includes(k));
                inGroup.forEach((k) => delete d.rapidTrigger.custom[k]);
              })
            }
          >
            Turn off{outGroup.length > 0 ? ` for ${inGroup.length === 1 ? keyLabel(inGroup[0]) : `${inGroup.length} keys`}` : ""}
          </Pill>
        )}
        {outGroup.length > 0 && (
          <Pill primary onClick={() => save(`Rapid trigger on for ${names(outGroup)}`, (d) => void d.rapidTrigger.keys.push(...outGroup))}>
            Turn on for {outGroup.length === 1 ? keyLabel(outGroup[0]) : `${outGroup.length} keys`}
          </Pill>
        )}
      </div>
    </div>
  );
}

/** The remaps that exist now, as chips, for when no key is picked. */
function RemapList({ s, save }: { s: ProfileSettings; save: Save }) {
  const remaps = Object.entries(s.remaps).map(([k, t]) => [Number(k), t] as const);
  return (
    <div className="flex flex-wrap items-center gap-2 px-1">
      {remaps.length === 0 && <p className="text-[13px] text-muted-foreground">Every key sends what it says on it.</p>}
      {remaps.map(([k, t]) => (
        <span key={k} className="flex items-center gap-2 rounded-full bg-primary/[0.1] py-1 pl-3 pr-1 text-[12.5px] text-foreground ring-1 ring-primary/30">
          {keyLabel(k)} <ArrowRight size={11} className="text-muted-foreground" /> {keyLabel(t)}
          <button
            onClick={() => save(`${keyLabel(k)} back to default`, (d) => void delete d.remaps[k])}
            className="grid size-5 place-items-center rounded-full text-muted-foreground hover:bg-white/[0.08] hover:text-foreground"
            aria-label={`Reset ${keyLabel(k)}`}
          >
            <X size={11} />
          </button>
        </span>
      ))}
    </div>
  );
}

function RemapInspector({ s, selected, save }: { s: ProfileSettings; selected: number[]; save: Save }) {
  const src = selected[0];
  if (src === undefined) return null;
  const target = s.remaps[src] ?? src;
  return (
    <div className="flex items-center gap-3">
      <p className="text-[13px] text-foreground">{keyLabel(src)} sends</p>
      <select
        value={target}
        onChange={(e) => {
          const t = Number(e.target.value);
          save(t === src ? `${keyLabel(src)} back to default` : `${keyLabel(src)} now sends ${keyLabel(t)}`, (d) => {
            if (t === src) delete d.remaps[src];
            else d.remaps[src] = t;
          });
        }}
        className="h-9 rounded-xl bg-white/[0.04] px-3 text-[13px] text-foreground outline-none ring-1 ring-white/[0.08] focus:ring-primary/60"
      >
        {REMAP_TARGETS.map((t) => (
          <option key={t.index} value={t.index}>
            {t.index === src ? `${t.label} (default)` : t.label}
          </option>
        ))}
      </select>
      {target !== src && (
        <Pill className="ml-auto" onClick={() => save(`${keyLabel(src)} back to default`, (d) => void delete d.remaps[src])}>
          Back to default
        </Pill>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Lighting, Speed Tap, polling
// ---------------------------------------------------------------------------------------------

const toHex = (c: Rgb) => `#${[c.r, c.g, c.b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
const fromHex = (h: string): Rgb => ({ r: parseInt(h.slice(1, 3), 16), g: parseInt(h.slice(3, 5), 16), b: parseInt(h.slice(5, 7), 16) });

function LightingCard({ s, save }: { s: ProfileSettings; save: Save }) {
  const l = s.lighting;
  const meta = EFFECTS.find((e) => e.id === l.effect) ?? EFFECTS[0];
  const look = l.looks[l.effect];
  const [brightness, setBrightness] = useState(l.brightness);
  useEffect(() => setBrightness(l.brightness), [l.brightness]);
  const colorCount = meta.colors === 0 ? 0 : look.singleColor || meta.colors === 1 ? 1 : 2;
  const colors = Array.from({ length: colorCount }, (_, i) => look.colors[i] ?? look.colors[0] ?? { r: 255, g: 255, b: 255 });

  const setColor = (i: number, c: Rgb) =>
    save("Lighting colour changed", (d) => {
      const lk = d.lighting.looks[d.lighting.effect];
      const next = [...colors];
      next[i] = c;
      lk.colors = next;
    });

  return (
    <Card>
      <CardHeader title="Lighting" hint="Speed stays at each effect's normal pace." />
      <div className="px-5 pb-5 pt-4">
        <div className="flex flex-wrap gap-2">
          {EFFECTS.map((e) => (
            <Chip key={e.id} on={e.id === l.effect} onClick={() => e.id !== l.effect && save(`Lighting set to ${e.label}`, (d) => void (d.lighting.effect = e.id as Effect))}>
              {e.label}
            </Chip>
          ))}
        </div>

        <div className="mt-5 flex items-center gap-4">
          <span className="w-20 shrink-0 text-[12.5px] text-muted-foreground">Brightness</span>
          <EqBarSlider
            value={brightness}
            min={0}
            max={100}
            step={1}
            unit="%"
            signed={false}
            aria-label="Brightness"
            onChange={setBrightness}
            onCommit={(v) => v !== l.brightness && save(`Brightness set to ${v}%`, (d) => void (d.lighting.brightness = v))}
          />
          <span className="tabular w-11 shrink-0 text-right text-[13px] text-foreground">{brightness}%</span>
        </div>

        <div className="mt-5 flex min-h-[40px] flex-wrap items-center gap-4">
          <span className="w-20 shrink-0 text-[12.5px] text-muted-foreground">Colours</span>
          {colorCount === 0 ? (
            <span className="text-[12.5px] text-muted-foreground">{meta.label} runs through its own colours.</span>
          ) : (
            <>
              {colors.map((c, i) => (
                <label
                  key={i}
                  className="relative size-9 cursor-pointer overflow-hidden rounded-full ring-1 ring-white/20 transition-transform duration-300 ease-fluid hover:scale-105"
                  style={{ background: toHex(c), boxShadow: `0 0 18px -4px ${toHex(c)}` }}
                  title={`Colour ${i + 1}`}
                >
                  <input type="color" value={toHex(c)} onChange={(e) => setColor(i, fromHex(e.target.value))} className="absolute inset-0 cursor-pointer opacity-0" />
                </label>
              ))}
              {meta.colors === 2 && (
                <div className="ml-auto">
                  <GlassRadio<"one" | "two">
                    value={look.singleColor ? "one" : "two"}
                    onChange={(v) =>
                      save(v === "one" ? "One lighting colour" : "Two lighting colours", (d) => {
                        const lk = d.lighting.looks[d.lighting.effect];
                        lk.singleColor = v === "one";
                        if (!lk.singleColor && lk.colors.length < 2) lk.colors = [lk.colors[0] ?? { r: 255, g: 0, b: 0 }, { r: 255, g: 0, b: 255 }];
                      })
                    }
                    options={[
                      { value: "one", label: "One" },
                      { value: "two", label: "Two" },
                    ]}
                  />
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </Card>
  );
}

function PollingCard({ s, busy, onApply }: { s: ProfileSettings; busy: boolean; onApply: (hz: PollingRateHz) => void }) {
  const [pending, setPending] = useKeptDraft<PollingRateHz | null>(`${FAL}.pollingPending`, null, String(s.pollingHz));
  const shown = pending ?? s.pollingHz;
  return (
    <Card>
      <CardHeader title="Polling rate" hint="How often the keyboard reports to the PC." />
      <div className="px-5 pb-5 pt-4">
        <GlassRadio<string>
          value={String(shown)}
          onChange={(v) => setPending(Number(v) === s.pollingHz ? null : (Number(v) as PollingRateHz))}
          options={POLLING_RATES.map((hz) => ({ value: String(hz), label: rateLabel(hz), hint: "Hz" }))}
        />
        {pending !== null && (
          <div className="mt-3 rounded-2xl bg-chart-3/[0.06] px-4 py-3 text-[12.5px] leading-relaxed text-chart-3 ring-1 ring-chart-3/20">
            The keyboard may disconnect for a second while it switches, and keys won't type until it's back. SYNQ waits for it and reconnects.
            <div className="mt-2.5 flex gap-2">
              <button
                disabled={busy}
                onClick={() => onApply(pending)}
                className="rounded-full bg-chart-3 px-3 py-1 text-[12px] font-medium text-black disabled:opacity-50"
              >
                Switch to {rateLabel(pending)}
              </button>
              <button onClick={() => setPending(null)} className="rounded-full px-3 py-1 text-[12px] text-chart-3/90 ring-1 ring-chart-3/30 hover:bg-chart-3/10">
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------------------------
// Small pieces
// ---------------------------------------------------------------------------------------------

/** A NumberField in millimetres that keeps its own text while editing and reports 0.1 mm units. */
function MmField({
  label,
  units,
  range,
  onCommit,
  className,
}: {
  label: string;
  units: number;
  range: { min: number; max: number };
  onCommit: (units: number) => void;
  className?: string;
}) {
  const [value, setValue] = useState(units / 10);
  useEffect(() => setValue(units / 10), [units]);
  return (
    <NumberField
      label={label}
      value={value}
      min={range.min / 10}
      max={range.max / 10}
      step={0.1}
      smallStep={0.1}
      largeStep={0.5}
      decimals={1}
      unit="mm"
      onChange={setValue}
      onCommit={(v) => onCommit(clampUnits(toUnits(v), range))}
      className={className}
    />
  );
}
