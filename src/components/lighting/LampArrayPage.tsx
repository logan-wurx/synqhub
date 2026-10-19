// A Windows Dynamic Lighting device's page: its lamps drawn where the device says they are, one colour or a simple
// effect (breathe, rainbow, wave), live while this page is open and SYNQ is the window in front. Windows gives these
// lights only to the app in front; lighting them in the background is Windows' own job (Settings > Personalization >
// Dynamic Lighting), since a background controller has to be a packaged app and SYNQ isn't one. On the website the same
// page speaks the HID LampArray standard itself (src/lib/web/lamparrays.ts), while the page is in front.
import { useEffect, useRef, useState } from "react";
import { backend, isWeb, type Connected } from "@/lib/backend";
import { useKeptState } from "@/lib/keep";
import { EFFECTS, colorsAt, kindName, sameDevice, type Effect, type LampArrayInfo } from "@/lib/lighting/lamparray";
import type { Rgb } from "@/lib/lighting/govee/frames";
import { lampArrayId, useDeviceTab } from "@/lib/nav";
import { useWide } from "@/lib/viewport";
import { useWindowFocus } from "@/lib/controllers/use-link";
import { useLampArrays } from "@/lib/lighting/lamparrays";
import { Card, CardHeader, type Notice } from "@/components/ui/matte";
import { EmptyCard } from "@/components/keyboard/parts";
import { DeviceArt } from "@/components/devices/DeviceArt";
import { DeviceFrame, DeviceHeader, OverviewHero, StatusPill, TAB_BODY, TierBadge, type TabDef } from "@/components/devices/shell";
import { ColourPicker } from "./ColourPicker";
import { Segmented, css } from "./controls";

type Notify = (n: Omit<Notice, "id">, key?: string) => void;

/** What the page says, on the desktop (Windows' API) and on the website (the HID standard, straight from the browser). */
const WORDS = isWeb
  ? {
      lit: "Lit while this page is in front",
      paused: "Paused: this page isn't in front",
      detail: "The HID lighting standard Dynamic Lighting uses, straight from the browser: lit while this page is in front.",
      subtitle: "One colour or a simple effect, over the HID LampArray standard",
      gone: "The browser doesn't list it any more. Plug it back in, or add it again from the Lights page.",
      failed: "It didn't open",
      effect: "Runs here, while this page is open and in front; leaving the page gives the device its own effect back.",
      note: "If Dynamic Lighting is on for this device in Windows, Windows may paint over these colours: switch it off for this device in Settings, Personalization, Dynamic Lighting while you use this page.",
    }
  : {
      lit: "Lit while SYNQ is in front",
      paused: "Paused: SYNQ isn't in front",
      detail: "Windows' own lighting standard: SYNQ lights it while SYNQ is the window in front.",
      subtitle: "One colour or a simple effect, through Windows Dynamic Lighting",
      gone: "Windows doesn't list this device any more. Plug it back in; it shows up on the Devices home on its own.",
      failed: "Windows didn't open it",
      effect: "Runs here, while this page is open and SYNQ is in front; it stops when you leave.",
      note: "Windows lets only the app in front set these lights. To keep a colour or effect in the background, pick it in Settings, Personalization, Dynamic Lighting: a background app has to be a packaged Store-style app, and SYNQ isn't one.",
    };

const FPS = 20;
const SPEEDS = [
  { id: "1", label: "Slow" },
  { id: "2", label: "Normal" },
  { id: "3", label: "Fast" },
] as const;

/** Seconds since the effect started, ticking only while `on`. */
function useClock(on: boolean): number {
  const [t, setT] = useState(0);
  const at = useRef(0);
  useEffect(() => {
    if (!on) return;
    // Resumes from where it paused.
    const start = performance.now() - at.current * 1000;
    const id = setInterval(() => {
      at.current = (performance.now() - start) / 1000;
      setT(at.current);
    }, 1000 / FPS);
    return () => clearInterval(id);
  }, [on]);
  return t;
}

/** The lamps, drawn where the device puts them, in the colours they are being sent. */
function LampMap({ info, colours }: { info: LampArrayInfo; colours: readonly Rgb[] }) {
  const w = info.width || 1;
  const h = info.height || w / 3;
  return (
    <div className="relative mx-auto w-full max-w-[520px]" style={{ aspectRatio: `${w} / ${Math.max(h, w / 8)}` }} role="img" aria-label={`${info.lamps.length} lamps, drawn where the device puts them`}>
      {info.lamps.map((l, i) => {
        const c = css(colours[i] ?? [40, 40, 46]);
        return (
          <span
            key={i}
            className="absolute size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full"
            style={{ left: `${(l.x / w) * 100}%`, top: `${(Math.min(l.y, h) / Math.max(h, w / 8)) * 100}%`, background: c, boxShadow: `0 0 10px ${c}` }}
          />
        );
      })}
    </div>
  );
}

export function LampArrayPage({ devices, notify, family }: { devices: Connected[]; notify: Notify; family: string }) {
  const id = lampArrayId(family);
  const [info, setInfo] = useState<LampArrayInfo | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [colour, setColour] = useKeptState<Rgb>(`lamparray.colour`, [255, 42, 212]);
  const [effect, setEffect] = useKeptState<Effect>(`lamparray.effect`, "solid");
  const [speed, setSpeed] = useKeptState<"1" | "2" | "3">(`lamparray.speed`, "2");
  const focused = useWindowFocus();
  const wide = useWide();
  // The device watcher (shared with the Devices home) says when it is unplugged.
  const known = useLampArrays();
  const gone = known !== null && !known.some((d) => d.id === family);
  const listed = known?.find((d) => d.id === family);
  const live = focused && !!info && !problem && !gone;
  const t = useClock(live && effect !== "solid");
  const colours = info ? colorsAt(info, effect, colour, t, Number(speed)) : [];
  const failed = useRef(false);

  // Opened while the page is shown; read again whenever the window comes back to the front (Windows may have handed
  // the device to another app meanwhile).
  useEffect(() => {
    if (!focused) return;
    let live = true;
    backend
      .lampArrayInfo(family)
      .then((i) => live && (setInfo(i), setProblem(null)))
      .catch((e) => live && setProblem(e instanceof Error ? e.message : String(e)));
    return () => {
      live = false;
    };
  }, [family, focused]);
  useEffect(() => () => void backend.lampArrayClose(family), [family]);

  // Send what the map shows: once per change for one colour, every frame for an effect.
  useEffect(() => {
    if (!live || !info) return;
    const flat = effect === "solid" ? [...colour] : colours.flatMap((c) => [...c]);
    backend
      .lampArraySet(family, flat)
      .then(() => (failed.current = false))
      .catch((e) => {
        if (failed.current) return;
        failed.current = true;
        notify({ title: "Not lit", detail: e instanceof Error ? e.message : String(e), tone: "error" }, "lamparray");
      });
  }, [live, info, effect, colour, colours, family, notify]);

  const also = info ? devices.find((d) => sameDevice(info, d)) : undefined;
  const name = info?.name || "Dynamic Lighting device";
  const tabs: TabDef[] = [...(wide ? [] : [{ id: "overview", label: "Overview" }]), { id: "light", label: "Light" }];
  const [tab, setTab] = useDeviceTab(id, tabs.map((x) => x.id));
  const overview = (
    <>
      <OverviewHero
        art={info ? <LampMap info={info} colours={live ? colours : info.lamps.map(() => [38, 38, 44] as const)} /> : <DeviceArt spec={{ kind: "lamparray", name, lampKind: listed?.kind, vid: listed?.vid || null, pid: listed?.pid || null }} />}
        live={!!info}
        connection={info ? kindName(info.kind) : null}
        name={name}
        detail={info ? `${info.lamps.length} lamps. ${WORDS.detail}` : "Reading its lamps."}
        badges={<TierBadge tier="experimental" hint="Dynamic Lighting is Windows' own standard, but SYNQ hasn't been tried on this device." />}
      />
      {also && <p className="px-1 text-[12.5px] text-medium">SYNQ also lists it as {also.name}, with its own page.</p>}
    </>
  );

  return (
    <DeviceFrame
      aside={overview}
      header={
        <DeviceHeader
          id={id}
          name={name}
          pills={
            <>
              <StatusPill live={live}>{problem ? "Not answering" : !info ? "Reading" : focused ? WORDS.lit : WORDS.paused}</StatusPill>
              <TierBadge tier="experimental" />
            </>
          }
          subtitle={WORDS.subtitle}
          tabs={tabs}
          tab={tab}
          onTab={setTab}
        />
      }
    >
      <div key={tab} className={TAB_BODY} tabIndex={0}>
        {gone && <EmptyCard title="Not connected" text={WORDS.gone} />}
        {!gone && problem && !info && <EmptyCard title={WORDS.failed} text={problem} />}
        {tab === "overview" && overview}
        {tab === "light" && info && !gone && (
          <>
            {!info.enabled && (
              <Card innerClassName="px-6 py-4">
                <p className="text-[13px] text-high">Dynamic Lighting is off for this device</p>
                <p className="mt-1 text-[12.5px] text-medium">Turn it on in Settings, Personalization, Dynamic Lighting, then come back.</p>
              </Card>
            )}
            <Card innerClassName="pb-5">
              <CardHeader title="Colour" hint={effect === "rainbow" ? "Rainbow uses its own colours." : "The whole device in one colour, or the colour the effect moves."} />
              <div className="mt-4 px-5">
                <ColourPicker value={colour} disabled={effect === "rainbow"} onChange={(c) => setColour(c)} />
              </div>
            </Card>
            <Card innerClassName="pb-5">
              <CardHeader title="Effect" hint={WORDS.effect} />
              <div className="mt-4 flex flex-wrap items-center gap-4 px-5">
                <Segmented label="Effect" value={effect} options={EFFECTS} onChange={setEffect} />
                {effect !== "solid" && <Segmented label="Speed" value={speed} options={SPEEDS} onChange={setSpeed} />}
              </div>
            </Card>
            <p className="px-1 text-[12px] leading-relaxed text-medium">{WORDS.note}</p>
          </>
        )}
      </div>
    </DeviceFrame>
  );
}
