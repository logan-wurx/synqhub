// A Wi-Fi light's page (wave L3): pairing where the maker asks for it (Hue's link button, Nanoleaf's power-button hold,
// each a guided step with a countdown), then the light's colour, white and brightness. The light is asked what it shows
// when the page opens and after each burst of changes; every message passes the network guard here and in the bridge
// (src/lib/lighting/net). The page never looks for lights by itself: Find lights does. First-time Wi-Fi setup stays
// in the maker's app, and the page says which; Yeelight also needs LAN Control switched on in its own app.
import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import type { Rgb } from "@/lib/lighting/govee/frames";
import { NET_BRANDS, type NetDevice } from "@/lib/lighting/net/brands";
import { NetLightController, wantsPairing } from "@/lib/lighting/net/control";
import { hasScenes } from "@/lib/lighting/net/scenes";
import { forgetNetLight, netSend, pairNetLight } from "@/lib/lighting/net/link";
import { forgotten, paired, useNetFinding, useNetLights, useNetLooked } from "@/lib/lighting/net/lights";
import { netKey, netModel as modelName } from "@/lib/lighting/models";
import { useLightingKeep } from "@/lib/lighting/saved";
import { useKeptState } from "@/lib/keep";
import { LIGHT_TABS_LEGACY, lightId, openDevice, useDeviceTab } from "@/lib/nav";
import { useWide } from "@/lib/viewport";
import { summarize } from "@/lib/device-model";
import { Card, CardHeader, type Notice } from "@/components/ui/matte";
import { DeviceFrame, DeviceHeader, StatusPill, StatusStrip, TAB_BODY, TierBadge, type TabDef } from "@/components/devices/shell";
import { BRUSHES, LampStage } from "./LampStage";
import { LightTab } from "./LightTab";
import { PowerButton } from "./controls";
import { FindLights } from "./FindLights";
import { NetScenesTab } from "./NetScenesTab";
import { DeviceArt, netLightArt } from "@/components/devices/DeviceArt";

type Notify = (n: Omit<Notice, "id">, key?: string) => void;
type Phase = "looking" | "missing" | "pair" | "empty" | "bridge" | "connecting" | "ready" | "failed";

// One page: the colour and the light's own scenes together.
const TABS: TabDef[] = [{ id: "light", label: "Light" }];
const noStore = () => () => {};
const noView = () => null;

/** How each brand's lights are drawn on the stage (a Yeelight or Elgato strip as a strip; the rest as one glow). */
const KIND: Record<NetDevice["brand"], string> = { hue: "light", nanoleaf: "panel", elgato: "panel", twinkly: "string", wiz: "light", yeelight: "light", lifx: "light" };
const kindOf = (d: NetDevice) => (/strip|stripe/i.test(d.model) ? "strip" : KIND[d.brand]);

/** The word over the light while SYNQ isn't lighting it. */
const STAGE: Record<Phase, string | null> = { looking: "Looking…", missing: "Not found", pair: "Not paired", empty: "No lights", bridge: "Paired", connecting: "Connecting…", ready: null, failed: "Not connected" };

const PILL: Record<Phase, string> = {
  looking: "Looking for it",
  missing: "Not on the network",
  pair: "Needs pairing",
  empty: "No lights yet",
  bridge: "Paired",
  connecting: "Connecting",
  ready: "Connected · Wi-Fi",
  failed: "Not connected",
};

export function NetLightPage({ id, notify }: { id: string; notify: Notify }) {
  const lights = useNetLights();
  const looked = useNetLooked();
  const finding = useNetFinding();
  const device = lights.find((d) => netKey(d) === id) ?? null;
  const brand = device ? NET_BRANDS[device.brand] : null;
  // A light that turned SYNQ away (its key was removed on the bridge) asks to be paired again.
  const [repair, setRepair] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [failed, setFailed] = useState<string | null>(null);
  const needsPairing = !!device && (!device.paired || repair);
  const bridgeOnly = !!device && device.brand === "hue" && !device.sub;
  // A Hue bridge's page once it is paired: its lights, each with a page of its own.
  const behind = device ? [] : lights.filter((d) => d.sub && netKey({ brand: d.brand, id: d.id }) === id);

  // The light is opened (asked what it shows) when the page has one to drive, and again on "Try again".
  const key = device && !needsPairing && !bridgeOnly ? `${netKey(device)}#${attempt}` : null;
  const [control, setControl] = useState<NetLightController | null>(null);
  const notifyRef = useRef(notify);
  notifyRef.current = notify;
  useEffect(() => {
    setControl(null);
    setFailed(null);
    if (!key || !device) return;
    const c = new NetLightController(device, netSend);
    let live = true;
    const said = (why: string) => {
      if (!live) return;
      if (wantsPairing(why)) setRepair(true);
      else setFailed(why);
    };
    c.onError = (why) => {
      if (wantsPairing(why)) setRepair(true);
      else notifyRef.current({ tone: "error", title: "The light didn't take that", detail: why }, "net-light-write");
    };
    c.refresh().then(
      () => live && setControl(c),
      (e: unknown) => said(e instanceof Error ? e.message : String(e)),
    );
    return () => {
      live = false;
      void c.close();
    };
  }, [key]); // the device behind a key doesn't change
  const view = useSyncExternalStore(control?.subscribe ?? noStore, control?.getView ?? noView);

  const phase: Phase = behind.length ? "bridge" : !device ? (finding ? "looking" : "missing") : needsPairing ? "pair" : bridgeOnly ? "empty" : failed ? "failed" : control && view ? "ready" : "connecting";
  const live = phase === "ready" && control && view ? { control, view } : null;
  // Scenes for the lights that have them (a Hue light, a Nanoleaf controller), once reached.
  const tabs = live && device && hasScenes(device) ? TABS : TABS.slice(0, 1);
  const [tab, setTab] = useDeviceTab(lightId(id), tabs.map((x) => x.id), LIGHT_TABS_LEGACY);
  const onError = useCallback((why: string) => notifyRef.current({ tone: "error", title: "The light didn't take that", detail: why }, "net-light-write"), []);

  const keep = useLightingKeep();
  const [brush, setBrush] = useKeptState<Rgb>(`light.${id}.brush`, [255, 42, 212]);
  const brushes = [...new Set([...BRUSHES, ...keep.recent, ...keep.saved])].slice(0, 22);
  const wide = useWide();
  const name = device?.name ?? (behind.length ? "Hue Bridge" : "Wi-Fi light");
  const summary = summarize({ id: lightId(id), kind: "light", family: id, name, brand: brand?.maker ?? "", connection: "Wi-Fi", viewKey: null, net: device ?? undefined }, null);

  // A Hue bridge isn't a light: its page shows the bridge (its own picture) rather than a light to paint.
  const bridgePage = device ? device.brand === "hue" && !device.sub : behind.length > 0;
  const stage = (className: string) =>
    bridgePage ? (
      <Card className={className} innerClassName="grid h-full place-items-center p-10">
        <DeviceArt spec={netLightArt({ brand: "hue", model: device?.model ?? "BSB002" })} className="max-h-[55%] max-w-[75%]" />
      </Card>
    ) : (
      <LampStage
        className={className}
        view={view}
        segments={1}
        kind={device ? kindOf(device) : "light"}
        brush={brush}
        onBrush={setBrush}
        brushes={brushes}
        onPaint={null}
        status={phase === "ready" && view?.power === false ? "Off" : STAGE[phase]}
      />
    );

  const body = live ? (
    <>
      <LightTab control={live.control} view={live.view} compact={!!device} />
      {device && <NetScenesTab device={device} onError={onError} onRecalled={() => void live.control.refresh().catch(() => {})} fill />}
      {device && (
        <AboutCard
          device={device}
          onForgot={() => {
            forgotten(device);
            // A Hue light's key is its bridge's: forgetting it takes the page back to the bridge.
            if (device.sub) openDevice(lightId(netKey({ brand: device.brand, id: device.id })));
          }}
        />
      )}
    </>
  ) : (
    <PhaseCard
      phase={phase}
      device={device}
      behind={behind}
      failed={failed}
      looked={looked}
      onPaired={() => {
        setRepair(false);
        setAttempt((n) => n + 1);
        if (device) void paired(device);
      }}
      onRetry={() => setAttempt((n) => n + 1)}
    />
  );

  return (
    <DeviceFrame
      header={
        <DeviceHeader
          id={lightId(id)}
          name={name}
          pills={
            <>
              <StatusPill live={phase === "ready"}>{PILL[phase]}</StatusPill>
              <TierBadge tier={summary.tier} hint={summary.tierHint} />
            </>
          }
          subtitle={device ? `${brand?.maker} · ${device.model} · ${device.host}` : undefined}
          actions={live && <PowerButton on={live.view.power !== false} onClick={() => live.control.setPower(live.view.power === false)} />}
          tabs={tabs}
          tab={tab}
          onTab={setTab}
        />
      }
      aside={
        <>
          {stage("h-[clamp(420px,calc(100vh-360px),720px)]")}
          {live && (
            <StatusStrip
              stats={[
                { label: "Power", value: live.view.power === null ? "–" : live.view.power ? "On" : "Off" },
                { label: "Brightness", value: live.view.brightness === null ? "–" : `${live.view.brightness}%` },
                { label: "Showing", value: live.view.mode === "white" ? `White ${live.view.kelvin ?? ""} K` : live.view.mode === "colour" ? "Colour" : "–" },
                { label: "Address", value: device?.host ?? "–" },
              ]}
            />
          )}
        </>
      }
    >
      <div className={TAB_BODY} tabIndex={0} data-testid="net-light-page">
        {wide ? (
          body
        ) : (
          <div className="grid grow grid-cols-[minmax(240px,300px)_minmax(0,1fr)] gap-5">
            {stage("sticky top-0 min-h-[380px] max-h-[calc(100dvh-280px)]")}
            <div className="flex min-w-0 flex-col gap-5">{body}</div>
          </div>
        )}
      </div>
    </DeviceFrame>
  );
}

/** How long the maker leaves pairing open after its physical step, and how often SYNQ asks within it. */
const PAIR_WINDOW_S = 30;
const PAIR_EVERY_MS = 2000;

/** Yeelight's one step SYNQ can't take, said plainly. */
const YEELIGHT_LAN =
  "Yeelight lights take commands from your network only after LAN Control is switched on for each one in Yeelight's own app. It is a one-time step, and the only one SYNQ can't do for you.";

/** Where the light came from, where its Wi-Fi is set up, and forgetting a pairing. */
function AboutCard({ device, onForgot }: { device: NetDevice; onForgot: () => void }) {
  const b = NET_BRANDS[device.brand];
  const keyed = b.pairing === "button";
  return (
    <Card innerClassName="pb-5">
      <CardHeader title="This light" hint={`${b.maker} ${modelName(device)}, reached on your network at ${device.host}. Nothing goes through ${b.maker}'s cloud or an account.`} />
      <div className="mt-3 flex flex-col items-start gap-3 px-5 text-[12.5px] leading-relaxed text-medium">
        <p>{b.setup} SYNQ never changes a light's Wi-Fi.</p>
        {device.brand === "yeelight" && <p>{YEELIGHT_LAN}</p>}
        {keyed && (
          <button
            type="button"
            onClick={() => void forgetNetLight(device.brand, device.id).then(onForgot, () => {})}
            className="mt-1 rounded-small bg-white/[0.04] px-3.5 py-1 text-[12.5px] text-medium ring-1 ring-white/[0.08] transition-colors hover:bg-white/[0.08] hover:text-high"
          >
            Forget pairing
          </button>
        )}
      </div>
    </Card>
  );
}

/**
 * Pairing as a guided step: the person does the maker's physical step (Hue's link button, Nanoleaf's power-button hold)
 * and SYNQ asks for a key every 2 s for the 30 s the maker leaves pairing open, with the time left on screen.
 */
function PairCard({ device, onPaired }: { device: NetDevice; onPaired: () => void }) {
  const b = NET_BRANDS[device.brand];
  const hue = device.brand === "hue";
  const [run, setRun] = useState(0);
  const [left, setLeft] = useState<number | null>(null);
  const [why, setWhy] = useState<string | null>(null);
  const done = useRef(onPaired);
  done.current = onPaired;
  useEffect(() => {
    if (!run) return;
    let live = true;
    const end = Date.now() + PAIR_WINDOW_S * 1000;
    setLeft(PAIR_WINDOW_S);
    const tick = setInterval(() => setLeft(Math.max(0, Math.ceil((end - Date.now()) / 1000))), 250);
    void (async () => {
      while (live && Date.now() < end) {
        try {
          await pairNetLight(device.brand, device.id);
          if (live) done.current();
          return;
        } catch {
          await new Promise((r) => setTimeout(r, PAIR_EVERY_MS));
        }
      }
      if (!live) return;
      setLeft(null);
      setWhy(hue ? "The bridge didn't let SYNQ in: its button wasn't pressed in time. Try again." : "The controller didn't let SYNQ in: hold its power button until the lights flash, then try again.");
    })();
    return () => {
      live = false;
      clearInterval(tick);
    };
  }, [run, device.brand, device.id, hue]);
  const running = left !== null;
  return (
    <Card innerClassName="flex flex-col items-start px-7 py-7">
      <p className="text-[17px] font-medium text-high">Pair with {device.name}</p>
      <ol className="mt-3 flex max-w-xl list-decimal flex-col gap-1.5 pl-4 text-[13.5px] leading-relaxed text-medium">
        <li>Press Pair below.</li>
        <li className={cn(running && "text-high")}>{b.pairingSteps}</li>
        <li>SYNQ asks for a key while pairing is open. The key stays on this PC, with SYNQ's bridge only.</li>
      </ol>
      {why && !running && <p className="mt-3 text-[12.5px] text-destructive">{why}</p>}
      <div className="mt-5 flex items-center gap-3">
        <button
          type="button"
          onClick={() => {
            setWhy(null);
            if (running) {
              setLeft(null);
              setRun(0);
            } else setRun((n) => n + 1);
          }}
          data-testid="net-pair"
          className="rounded-small bg-primary/[0.15] px-4 py-1.5 text-[13px] text-high ring-1 ring-primary/40 transition-colors hover:bg-primary/[0.22]"
        >
          {running ? "Cancel" : "Pair"}
        </button>
        {running && (
          <span className="text-[13px] tabular-nums text-medium" aria-live="polite">
            {hue ? "Press the bridge's button now" : "Hold the power button now"} · {left} s
          </span>
        )}
      </div>
    </Card>
  );
}

function PhaseCard({
  phase,
  device,
  behind,
  failed,
  looked,
  onPaired,
  onRetry,
}: {
  phase: Phase;
  device: NetDevice | null;
  behind: readonly NetDevice[];
  failed: string | null;
  looked: boolean;
  onPaired: () => void;
  onRetry: () => void;
}) {
  const b = device ? NET_BRANDS[device.brand] : null;
  const card = (title: string, text: ReactNode, extra?: ReactNode) => (
    <Card innerClassName="flex flex-col items-start px-7 py-7">
      <p className="text-[17px] font-medium text-high">{title}</p>
      <div className="mt-2 max-w-xl text-[13.5px] leading-relaxed text-medium">{text}</div>
      {extra}
    </Card>
  );
  if (phase === "looking") return card("Looking for lights…", "SYNQ is asking your network which lights are there. It takes a second or two.");
  if (phase === "missing")
    return card(
      looked ? "The light isn't on the network" : "Find the light first",
      looked
        ? "SYNQ didn't find it this time. Check that it is switched on and on the same network as this PC (a guest network keeps lights apart), then find lights again."
        : "SYNQ looks for Wi-Fi lights only when you ask, for a few seconds.",
      <FindLights className="mt-5" />,
    );
  if (phase === "pair" && device) return <PairCard device={device} onPaired={onPaired} />;
  if (phase === "connecting") return card(`Connecting to ${device?.name ?? "the light"}…`, "Nothing on the light changes until you change something here.");
  if (phase === "empty") return card("No lights on this bridge yet", `${b?.setup ?? ""} Then find lights again: each light gets a card of its own.`, <FindLights className="mt-5" />);
  if (phase === "bridge")
    return card(
      "Paired with the Hue Bridge",
      "Each of its lights now has a card of its own on the Devices home.",
      <div className="mt-5 flex flex-wrap gap-2">
        {behind.map((d) => (
          <button
            key={netKey(d)}
            type="button"
            onClick={() => openDevice(lightId(netKey(d)))}
            className="rounded-small bg-white/[0.04] px-3 py-1 text-[12.5px] text-medium ring-1 ring-white/[0.08] transition-colors hover:bg-white/[0.08] hover:text-high"
          >
            {d.name}
          </button>
        ))}
      </div>,
    );
  return card(
    `Can't reach ${device?.name ?? "the light"}`,
    <>
      <p>{device?.brand === "yeelight" ? YEELIGHT_LAN : "It answered Find lights but not SYNQ. It may have just been switched off, or the network may be keeping it apart from this PC."}</p>
      {failed && <p className="mt-2 text-[11.5px] text-medium">{failed}</p>}
    </>,
    <button type="button" onClick={onRetry} className="mt-5 rounded-small bg-white/[0.06] px-4 py-1.5 text-[13px] text-high ring-1 ring-white/[0.1] transition-colors hover:bg-white/[0.1]">
      Try again
    </button>,
  );
}
