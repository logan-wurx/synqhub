import { Suspense, lazy, startTransition, useCallback, useEffect, useRef, useState } from "react";
import { GameController, GearSix, Lightbulb, Monitor, SquaresFour } from "@phosphor-icons/react";
import { backend, inTauri, isWeb, liveHardware, type Connected } from "@/lib/backend";
import { isActive, onActivityChange } from "@/lib/activity";
import { devicePageClosed } from "@/lib/trim";
import { photoGallery, withPreviewDevices } from "@/lib/device-names";
import { mouseFamilies } from "@/lib/mouse-family";
import { keyboardFamilies } from "@/lib/kb/probe";
import { refreshMice } from "@/lib/mouse-probe";
import { refreshPads } from "@/lib/controllers/probe";
import { useLamps } from "@/lib/lighting/lamps";
import { useNetLights } from "@/lib/lighting/net/lights";
import { goDisplays, goGames, goHome, goLights, goSettings, keyboardId, mouseId, sectionOfDevice, SOUND_ID, useNav } from "@/lib/nav";
import { useKeptState } from "@/lib/keep";
import { NoticeStack, type Notice } from "@/components/ui/matte";
import { AmbientLight, DOCK_SPACE, Dock } from "@/components/ui/ambient";
import { EqPage } from "@/components/eq/EqPage";
import { DevicesHome } from "@/components/devices/DevicesHome";
import { HelperChip } from "@/components/settings/HelperChip";
import { useWelcomeOpen } from "@/lib/welcome";
import { PageBoundary } from "@/components/ui/error-boundary";
import { WebHelperChip, WebSoundPage } from "@/components/web/lazy";

// The Mouse and Keyboard pages (and their device drivers) load the first time they're wanted:
// hovering or focusing their card starts the download, so opening them stays instant.
const loadMouse = () => import("@/components/mouse/MousePage");
const loadKeyboard = () => import("@/components/keyboard/KeyboardPage");
const loadController = () => import("@/components/controller/ControllerPage");
const loadLight = () => import("@/components/lighting/LightPage");
const loadHeadset = () => import("@/components/headset/HeadsetPage");
const loadMonitor = () => import("@/components/display/MonitorPage");
const loadWebcam = () => import("@/components/display/WebcamPage");
const loadLampArray = () => import("@/components/lighting/LampArrayPage");
const loadHub = () => import("@/components/lighting/RgbHubPage");
const MousePage = lazy(() => loadMouse().then((m) => ({ default: m.MousePage })));
const KeyboardPage = lazy(() => loadKeyboard().then((m) => ({ default: m.KeyboardPage })));
const ControllerPage = lazy(() => loadController().then((m) => ({ default: m.ControllerPage })));
const LightPage = lazy(() => loadLight().then((m) => ({ default: m.LightPage })));
const HeadsetPage = lazy(() => loadHeadset().then((m) => ({ default: m.HeadsetPage })));
const MonitorPage = lazy(() => loadMonitor().then((m) => ({ default: m.MonitorPage })));
const WebcamPage = lazy(() => loadWebcam().then((m) => ({ default: m.WebcamPage })));
const LampArrayPage = lazy(() => loadLampArray().then((m) => ({ default: m.LampArrayPage })));
const RgbHubPage = lazy(() => loadHub().then((m) => ({ default: m.RgbHubPage })));
const SettingsPage = lazy(() => import("@/components/settings/SettingsPage").then((m) => ({ default: m.SettingsPage })));
// The gear checkup (Gear Doctor): its own chunk, loaded when it's opened.
const CheckupPage = lazy(() => import("@/components/checkup/CheckupPage").then((m) => ({ default: m.CheckupPage })));
// Games (SYNQ Helper's per-game profiles) is a desktop page: recording a profile needs the app's bridge.
const GamesPage = typeof __ONBOARD_WEB__ !== "undefined" && __ONBOARD_WEB__ === true ? null : lazy(() => import("@/components/games/GamesPage").then((m) => ({ default: m.GamesPage })));

const Welcome = lazy(() => import("@/components/welcome/Welcome").then((m) => ({ default: m.Welcome })));
// `?shot` in the browser preview leaves the "Preview" note out, for screenshots (the README's).
const SCREENSHOT = typeof location !== "undefined" && new URLSearchParams(location.search).has("shot");
const PRELOAD: Partial<Record<string, () => Promise<unknown>>> = { mouse: loadMouse, keyboard: loadKeyboard, controller: loadController, light: loadLight, headset: loadHeadset, monitor: loadMonitor, webcam: loadWebcam, lamparray: loadLampArray, rgbhub: loadHub };

const WEB = typeof __ONBOARD_WEB__ !== "undefined" && __ONBOARD_WEB__ === true;
const NOTICE_MS = { ok: 4500, info: 4000, error: 9000 } as const;
/** Device list refresh where there are no plug and unplug notifications (not Windows): while the window is focused, and while it's shown but in the background. Minimized: none. */
const DEVICE_POLL_MS = 8000;
const DEVICE_POLL_IDLE_MS = 30000;
const ACCENT_KEY = "onboard.accent";
/** Set once the accent has been read since the room light became the default. */
const ROOM_DEFAULT_KEY = "onboard.accent.room";

function readAccent(): string {
  try {
    const kept = localStorage.getItem(ACCENT_KEY);
    const first = !localStorage.getItem(ROOM_DEFAULT_KEY);
    localStorage.setItem(ROOM_DEFAULT_KEY, "1");
    // Violet was the default before the room light: kept from then, it moves to the room light once. Picked again
    // after that, it stays.
    return !kept || (kept === "iris" && first) ? "room" : kept;
  } catch {
    return "room";
  }
}

export default function App() {
  const [nav] = useNav();
  const [welcome] = useWelcomeOpen();
  const [accent, setAccent] = useState(readAccent);
  const [devices, setDevices] = useState<Connected[]>([]);
  const [notices, setNotices] = useState<Notice[]>([]);
  const nextId = useRef(1);
  const keyed = useRef(new Map<string, number>());
  /** The device list has come in at least once (the first state of `devices` is just empty). */
  const listed = useRef(false);
  const timers = useRef(new Map<number, number>());

  useEffect(() => {
    document.documentElement.dataset.accent = accent;
    try {
      localStorage.setItem(ACCENT_KEY, accent);
    } catch {
      /* preference only */
    }
  }, [accent]);

  const dismiss = useCallback((id: number) => {
    setNotices((n) => n.filter((x) => x.id !== id));
    window.clearTimeout(timers.current.get(id));
    timers.current.delete(id);
    for (const [k, v] of keyed.current) if (v === id) keyed.current.delete(k);
  }, []);

  /** Shows a notice; one with the same key replaces the last instead of stacking. */
  const notify = useCallback(
    (n: Omit<Notice, "id">, key?: string) => {
      const old = key ? keyed.current.get(key) : undefined;
      if (old !== undefined) dismiss(old);
      const id = nextId.current++;
      if (key) keyed.current.set(key, id);
      setNotices((list) => [...list.slice(-2), { ...n, id }]);
      timers.current.set(id, window.setTimeout(() => dismiss(id), NOTICE_MS[n.tone]));
    },
    [dismiss],
  );

  useEffect(() => {
    // Only a changed list re-renders the app; an unchanged poll costs nothing on screen.
    let last: string | null = null;
    const take = (list: Connected[]) => {
      const key = JSON.stringify(list);
      if (key === last) return;
      last = key;
      const hadPad = xinput;
      xinput = list.some((d) => d.pad?.via === "xinput");
      if (xinput !== hadPad) schedule();
      // A mouse found through OpenMouse's table is shown once its driver claims it; that check (and
      // the driver download) happens only when the list changes and such a candidate is in it.
      if (!list.some((d) => d.generic) || photoGallery()) return setDevices(list);
      void import("@/lib/generic-mice")
        .then((m) => m.confirmGeneric(list))
        .then((confirmed) => key === last && setDevices(confirmed));
    };
    const poll = () =>
      backend.devicesList().then(
        (list) => {
          listed.current = true;
          take(withPreviewDevices(list));
        },
        () => take([]),
      );
    let timer = 0;
    // On Windows the bridge says when a device arrives or leaves ("devices-changed"), so there is no timer; elsewhere
    // (Linux, the website without a chooser event, the preview) the list is polled.
    // An XInput pad's battery comes only with the list (XInput has no event for it): with one listed, the list is still
    // read every 30 s while the window is shown.
    let pushed = false;
    let xinput = false;
    const schedule = () => {
      window.clearInterval(timer);
      const every = pushed ? (xinput ? DEVICE_POLL_IDLE_MS : 0) : isActive() ? DEVICE_POLL_MS : DEVICE_POLL_IDLE_MS;
      timer = document.hidden || !every ? 0 : window.setInterval(poll, every);
    };
    let offPush = () => {};
    if (inTauri)
      void Promise.all([import("@tauri-apps/api/core"), import("@tauri-apps/api/event")]).then(async ([core, event]) => {
        const off = await event.listen("devices-changed", () => void poll());
        offPush = off;
        if (await core.invoke<boolean>("hotplug_watch").catch(() => false)) {
          pushed = true;
          schedule();
        }
      });
    // The website: a device being plugged in, removed or just added in the chooser refreshes the list at once.
    let offHid = () => {};
    if (WEB) void import("@/lib/web/hid").then((m) => (offHid = m.onHidChange(poll)));
    let wasHidden = document.hidden;
    const off = onActivityChange(() => {
      // Coming back (focused, or un-minimized): check at once, as before on focus.
      if (!document.hidden && (isActive() || wasHidden)) poll();
      wasHidden = document.hidden;
      schedule();
    });
    // The preview can pretend a device was plugged in later (`?arrive`, then `#arrived`).
    if (!liveHardware) window.addEventListener("hashchange", poll);
    poll();
    schedule();
    return () => {
      window.clearInterval(timer);
      off();
      offPush();
      offHid();
      window.removeEventListener("hashchange", poll);
    };
  }, []);

  const select = (id: string) => {
    // A transition keeps the current page on screen until a page that's still loading is ready.
    startTransition(() => (id === "settings" ? goSettings() : id === "games" ? goGames() : id === "lights" ? goLights() : id === "displays" ? goDisplays() : goHome()));
  };

  // Leaving a device page: once its leftovers are collected, the memory goes back (src/lib/trim.ts).
  // The Sound page, the home and Settings aren't device pages that hold a session.
  const onDevicePage = nav.view === "device" && nav.device !== SOUND_ID;
  const firstNav = useRef(true);
  useEffect(() => {
    if (firstNav.current) {
      firstNav.current = false;
      return;
    }
    devicePageClosed(!onDevicePage);
  }, [onDevicePage]);

  // With several mice listed, ask each for a quick read-only reply so the Devices home and the Mouse
  // page can tell the one in use from a receiver whose mouse is off. Only when the list of mice
  // changes: no timer. One mouse needs no check.
  const miceKey = mouseFamilies(devices).join();
  useEffect(() => {
    void refreshMice(devices, { force: true });
    // miceKey stands in for `devices`, which is a new array whenever any device changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [miceKey]);

  // Controllers: a receiver whose pad is off is asked once (read only) so the home can grey it out. Only when the list
  // of controllers changes.
  const padsKey = devices
    .filter((d) => d.kind === "controller")
    .map((d) => `${d.vid}:${d.pid}`)
    .join();
  useEffect(() => {
    void refreshPads(devices);
    // padsKey stands in for `devices`, which is a new array whenever any device changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [padsKey]);

  // "Keep your feel" keeps a list of the mice and keyboards it has seen, so a new one can be offered the saved
  // feel (src/lib/feel/store.ts). Only when the list changes, and not on the empty list before the first reply.
  const feelIds = [...mouseFamilies(devices).map((f) => mouseId(f)), ...keyboardFamilies(devices).map((f) => keyboardId(f))];
  const feelKey = feelIds.join();
  useEffect(() => {
    if (!listed.current) return;
    const present = feelIds.map((id) => ({ id, kind: id.startsWith("mouse:") ? ("mouse" as const) : ("keyboard" as const), name: id }));
    void import("@/lib/feel/persist").then((m) => m.feelStore.observe(present));
    // feelKey stands in for feelIds, which is a new array every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [feelKey]);

  const nMice = mouseFamilies(devices).length;
  const nKeys = keyboardFamilies(devices).length;
  const nPads = devices.filter((d) => d.kind === "controller").length;
  // Lights as last found (the Bluetooth scan and the Wi-Fi discovery run only on the Devices home and a light's page).
  const nLamps = useLamps().length + useNetLights().length;
  // A headset shows up once per HID collection, so it is counted by its USB id; a monitor or webcam by its path.
  const count = (kind: Connected["kind"], key: (d: Connected) => string | null | undefined) => new Set(devices.filter((d) => d.kind === kind).map(key)).size;
  const nHeadsets = count("headset", (d) => `${d.vid}:${d.pid}`);
  const nMonitors = count("monitor", (d) => d.path);
  const nWebcams = count("webcam", (d) => d.path);
  // The Devices tab counts what you hold and hear; lights and monitors have their own tabs (and lines).
  const nGear = nMice + nKeys + nPads + nHeadsets + nWebcams;
  const parts = [
    nMice && `${nMice} ${nMice === 1 ? "mouse" : "mice"}`,
    nKeys && `${nKeys} keyboard${nKeys === 1 ? "" : "s"}`,
    nPads && `${nPads} controller${nPads === 1 ? "" : "s"}`,
    nHeadsets && `${nHeadsets} headset${nHeadsets === 1 ? "" : "s"}`,
    nWebcams && `${nWebcams} webcam${nWebcams === 1 ? "" : "s"}`,
  ].filter(Boolean);
  // The Lights page's own count once it has drawn (lamps are scanned only there); until then, the lamps heard.
  const [lightsCount] = useKeptState<number | null>("lights.count", null);
  const nLights = lightsCount ?? nLamps;
  const lightsHint = nLights ? `${nLights} light${nLights === 1 ? "" : "s"}` : isWeb ? "Govee over Bluetooth" : "Govee, Hue and more";
  const monitorNames = devices.filter((d) => d.kind === "monitor").map((d) => d.name);
  const displaysHint = nMonitors === 1 ? (monitorNames[0] ?? "1 monitor") : nMonitors ? `${nMonitors} monitors` : "Monitors";
  // Two kinds fit the rail ("2 mice · 1 keyboard"); more read as one count, the same one the Devices home shows (it counts the sound output too).
  // The Devices home's own count once it has drawn (it sees every source); until then, what is counted here.
  const [homeCount, setHomeCount] = useKeptState<number | null>("home.connected", null);
  // A device came or went while another page is shown: the home's count is stale until it draws again.
  const onHome = nav.view === "devices";
  const lastGear = useRef(nGear);
  useEffect(() => {
    if (lastGear.current === nGear) return;
    lastGear.current = nGear;
    if (!onHome) setHomeCount(null);
  }, [nGear, onHome, setHomeCount]);
  const hint = !nGear ? (isWeb ? "Add a device" : "Sound output") : parts.length <= 2 ? parts.join(" · ") : `${homeCount ?? nGear + (isWeb ? 0 : 1)} connected`;
  const device = nav.view === "device" ? nav.device : null;
  const mouseFamily = device?.startsWith("mouse:") ? device.slice(6) : null;
  const keyboardFamily = device?.startsWith("kb:") ? device.slice(3) : null;
  const padFamily = device?.startsWith("pad:") ? device.slice(4) : null;
  const headsetFamily = device?.startsWith("hs:") ? device.slice(3) : null;
  const monitorFamily = device?.startsWith("mon:") ? device.slice(4) : null;
  const webcamFamily = device?.startsWith("cam:") ? device.slice(4) : null;
  const lampArrayFamily = device?.startsWith("dl:") ? device.slice(3) : null;
  const hubFamily = device?.startsWith("rgb:") ? device.slice(4) : null;
  const lamp = device?.startsWith("light:") ? device.slice(6) : null;

  return (
    <div className="relative h-full">
      <AmbientLight />
      {!inTauri && !isWeb && !SCREENSHOT && (
        <p className="fixed right-4 top-3 z-40 rounded-full bg-black/60 px-3 py-1 text-[11.5px] text-chart-3 ring-1 ring-chart-3/25">Preview: nothing is saved</p>
      )}
      {/* The Sound page stays mounted (hidden while another page is shown): it holds the EQ, which must
          never be reloaded under an edit. The home, Settings and the Mouse and Keyboard pages are
          mounted only while shown, so their DOM, layout and pictures go when you leave them; what you
          were doing on a device is kept (src/lib/keep.ts) and its session stays open for a short while
          (src/lib/device-session.ts), so coming back looks exactly as you left it. */}
      <main className={`relative h-full min-w-0 ${DOCK_SPACE}`}>
        {/* Mounted from the start, so a page that's still loading keeps the current one on screen. */}
        <Suspense fallback={null}>
          {isWeb ? (
            device === SOUND_ID && (
              <div className="h-full">
                <PageBoundary name="Sound">
                  <WebSoundPage notify={notify} />
                </PageBoundary>
              </div>
            )
          ) : (
            <div className={device === SOUND_ID ? "h-full" : "hidden"}>
              <PageBoundary name="Sound">
                <EqPage notify={notify} />
              </PageBoundary>
            </div>
          )}
          {(nav.view === "devices" || nav.view === "lights" || nav.view === "displays") && (
            <div className="h-full">
              <PageBoundary name="Devices">
                <DevicesHome key={nav.view} section={nav.view} devices={devices} onIntent={(kind) => void PRELOAD[kind]?.()} notify={notify} />
              </PageBoundary>
            </div>
          )}
          {nav.view === "checkup" && (
            <div className="h-full">
              <PageBoundary name="Checkup">
                <CheckupPage devices={devices} notify={notify} />
              </PageBoundary>
            </div>
          )}
          {nav.view === "settings" && (
            <div className="h-full">
              <PageBoundary name="Settings">
                <SettingsPage accent={accent} onAccent={setAccent} notify={notify} />
              </PageBoundary>
            </div>
          )}
          {nav.view === "games" && GamesPage && (
            <div className="h-full">
              <PageBoundary name="Games">
                <GamesPage devices={devices} notify={notify} />
              </PageBoundary>
            </div>
          )}
          {mouseFamily && (
            <div className="h-full">
              <PageBoundary name="Mouse">
                <MousePage devices={devices} notify={notify} visible family={mouseFamily} />
              </PageBoundary>
            </div>
          )}
          {keyboardFamily && (
            <div className="h-full">
              <PageBoundary name="Keyboard">
                <KeyboardPage devices={devices} notify={notify} visible family={keyboardFamily} />
              </PageBoundary>
            </div>
          )}
          {padFamily && (
            <div className="h-full">
              <PageBoundary name="Controller">
                <ControllerPage devices={devices} notify={notify} family={padFamily} />
              </PageBoundary>
            </div>
          )}
          {lamp && (
            <div className="h-full">
              <PageBoundary name="Lamp">
                <LightPage key={lamp} id={lamp} notify={notify} devices={devices} />
              </PageBoundary>
            </div>
          )}
          {headsetFamily && (
            <div className="h-full">
              <PageBoundary name="Headset">
                <HeadsetPage devices={devices} notify={notify} family={headsetFamily} />
              </PageBoundary>
            </div>
          )}
          {monitorFamily && (
            <div className="h-full">
              <PageBoundary name="Monitor">
                <MonitorPage devices={devices} notify={notify} family={monitorFamily} />
              </PageBoundary>
            </div>
          )}
          {webcamFamily && (
            <div className="h-full">
              <PageBoundary name="Webcam">
                <WebcamPage devices={devices} notify={notify} family={webcamFamily} />
              </PageBoundary>
            </div>
          )}
          {lampArrayFamily && (
            <div className="h-full">
              <PageBoundary name="Dynamic Lighting">
                <LampArrayPage key={lampArrayFamily} devices={devices} notify={notify} family={lampArrayFamily} />
              </PageBoundary>
            </div>
          )}
          {hubFamily && (
            <div className="h-full">
              <PageBoundary name="RGB hub">
                <RgbHubPage key={hubFamily} devices={devices} notify={notify} family={hubFamily} />
              </PageBoundary>
            </div>
          )}
        </Suspense>
      </main>
      <Dock
        active={nav.view === "device" && nav.device ? sectionOfDevice(nav.device) : nav.view === "checkup" ? "devices" : nav.view}
        onSelect={select}
        items={[
          { id: "devices", label: "Gear", hint, icon: SquaresFour },
          { id: "lights", label: "Lights", hint: lightsHint, icon: Lightbulb },
          { id: "displays", label: "Displays", hint: displaysHint, icon: Monitor },
          // Game profiles switch on the running game: the desktop app's (or SYNQ Helper's) job, not a web page's.
          ...(isWeb ? [] : [{ id: "games", label: "Games", hint: "Profiles per game", icon: GameController }]),
          { id: "settings", label: "Settings", hint: "Accent, about, licenses", icon: GearSix, iconOnly: true },
        ]}
        extra={isWeb ? <WebHelperChip onOpen={() => startTransition(goSettings)} /> : <HelperChip />}
      />
      {welcome && (
        <Suspense fallback={null}>
          <Welcome accent={accent} onAccent={setAccent} notify={notify} />
        </Suspense>
      )}
      <NoticeStack notices={notices} onDismiss={dismiss} />
    </div>
  );
}
