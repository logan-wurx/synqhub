// A controller's page: what it is and where its settings live (Overview), the live tester (Test, Polling), and the
// volatile tests of a Sony or Nintendo pad (Lights & rumble). Opening the page opens the pad for the tester (that is
// when a Bluetooth Sony pad or a Switch pad is switched to its full report); SYNQ lets go of it when its window
// loses focus, so a game that starts never finds the pad held, and opens it again when the window is back.
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { DownloadSimple } from "@phosphor-icons/react";
import { backend, isWeb, type Connected, type PadConflict } from "@/lib/backend";
import { controllerEntries } from "@/lib/device-model";
import { padId, useDeviceTab } from "@/lib/nav";
import { findHidDevice, openPad } from "@/lib/controllers/connect";
import type { PadLink } from "@/lib/controllers/link";
import { useWindowFocus } from "@/lib/controllers/use-link";
import { collectDiagnostics, diagnosticsName, diagnosticsText } from "@/lib/controllers/diagnostics";
import { summarize } from "@/lib/device-model";
import { Card, DetailRows, type Notice } from "@/components/ui/matte";
import { Banner } from "@/components/keyboard/parts";
import { DeviceArt } from "@/components/devices/DeviceArt";
import { DeviceFrame, DeviceHeader, OverviewHero, StatusPill, TAB_BODY, TierBadge, type TabDef } from "@/components/devices/shell";
import { EmptyCard } from "@/components/mouse/parts";
import { Gamepad } from "@/components/ui/silhouettes";
import { ActionButton } from "./parts";
import { LightsTab, PollingTab, TestTab } from "./tabs";
import { EdgeProfilesTab } from "./EdgeProfiles";
import { GamesirSettingsTab } from "./GamesirSettings";
import { EightBitDoSettingsTab } from "./EightBitDoSettings";
import { FlydigiSettingsTab } from "./FlydigiSettings";

type Notify = (n: Omit<Notice, "id">, key?: string) => void;

type Phase = { kind: "connecting" } | { kind: "ready"; link: PadLink } | { kind: "paused" } | { kind: "error"; message: string } | { kind: "detect" };

const SETTINGS_TEXT = {
  onboard: "On the pad itself: profiles it keeps without any app running.",
  volatile: "Nowhere: its lights and effects last until it reconnects.",
  host: "In software on the PC (Steam Input, your Xbox profile), not on the pad.",
  none: "It has no settings of its own.",
} as const;

const VIA_TEXT = { hid: "HID (SYNQ reads its reports)", xinput: "XInput (Windows' Xbox driver)", gamepad: "the browser's Gamepad API" } as const;

/** Saves the bundle: a file in SYNQ's data folder on the desktop, a download on the website. */
async function saveBundle(name: string, text: string): Promise<string> {
  if (isWeb) {
    const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
    const a = Object.assign(document.createElement("a"), { href: url, download: `${name}-diag.json` });
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    return `${name}-diag.json (downloaded)`;
  }
  return backend.padDiagnosticsSave(name, text);
}

export function ControllerPage({ devices, notify, family }: { devices: Connected[]; notify: Notify; family: string }) {
  const entries = useMemo(() => controllerEntries(devices), [devices]);
  const entry = entries.find((e) => e.family === family) ?? null;
  const identity = entry?.pad?.identity ?? null;
  const device = entry?.pad?.device ?? null;
  const focused = useWindowFocus();
  const [phase, setPhase] = useState<Phase>({ kind: "connecting" });
  const [conflicts, setConflicts] = useState<PadConflict[]>([]);
  const [saving, setSaving] = useState(false);
  const deviceKey = device ? `${device.vid}:${device.pid}:${device.pad?.slot ?? ""}` : "";

  // Open while the page is shown and the window is focused; let go on blur, on leaving, and when it's unplugged.
  useEffect(() => {
    if (!identity || !device) return;
    if (identity.support === "detect") {
      setPhase({ kind: "detect" });
      return;
    }
    if (!focused) {
      setPhase({ kind: "paused" });
      return;
    }
    let live = true;
    let opened: PadLink | null = null;
    setPhase({ kind: "connecting" });
    openPad(device, identity).then(
      (link) => {
        if (!live) {
          void link.close();
          return;
        }
        opened = link;
        setPhase({ kind: "ready", link });
      },
      (e) => live && setPhase({ kind: "error", message: String(e).replace(/^Error: /, "") }),
    );
    return () => {
      live = false;
      void opened?.close();
    };
    // deviceKey stands in for device and identity, which are new objects whenever the list refreshes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deviceKey, focused]);

  // Apps that also drive controllers (read once per visit; nothing is done to them).
  useEffect(() => {
    if (isWeb) return;
    let live = true;
    void backend.padsConflicts().then((c) => live && setConflicts(c), () => undefined);
    return () => {
      live = false;
    };
  }, [deviceKey]);

  const link = phase.kind === "ready" ? phase.link : null;
  const tabs: TabDef[] = [
    { id: "overview", label: "Overview" },
    ...(identity?.support === "detect" ? [] : [
      { id: "test", label: "Test" },
      { id: "polling", label: "Polling" },
    ]),
    ...(link?.tests ? [{ id: "lights", label: link.tests.lightbar || link.tests.playerLeds ? "Lights & rumble" : "Rumble" }] : []),
    ...(identity?.guard === "edge" && link?.hid ? [{ id: "profiles", label: "Profiles" }] : []),
    ...((identity?.guard.startsWith("gamesir-") || identity?.guard === "8bitdo" || identity?.guard === "flydigi") && link?.hid ? [{ id: "settings", label: "Settings" }] : []),
  ];
  const [tab, setTab] = useDeviceTab(padId(family), tabs.map((t) => t.id));

  if (!entry || !identity || !device) {
    return (
      <div className={TAB_BODY} tabIndex={0}>
        <EmptyCard title="Controller not found" text="It isn't plugged in any more. Plug it back in (cable, receiver or Bluetooth) and it shows up on the Devices home." art={<Gamepad className="h-full" />} />
      </div>
    );
  }

  const summary = summarize(entry, link ? { batteryPercent: link.info.battery?.percent ?? null, charging: link.info.battery?.charging } : null);
  const connection = summary.link ?? device.connection;
  const bluetooth = /bluetooth/i.test(device.connection);
  // Only Sony's and Nintendo's pads change their report mode when the tester opens them over Bluetooth.
  const modeNote = bluetooth && ["ds5", "edge", "ds4", "switch"].includes(identity.guard);
  const statusText = phase.kind === "ready" ? `Connected · ${connection}` : phase.kind === "connecting" ? "Connecting" : phase.kind === "paused" ? "Paused (window not focused)" : phase.kind === "detect" ? "Listed" : "Not connected";

  const saveDiagnostics = async () => {
    if (!link) return;
    setSaving(true);
    try {
      const descriptor = link.source.kind === "hid" ? ((await findHidDevice(device).catch(() => null))?.collections ?? null) : null;
      const bundle = await collectDiagnostics(link, device, JSON.parse(JSON.stringify(descriptor ?? null)), conflicts.map((c) => c.app));
      const where = await saveBundle(diagnosticsName(identity), diagnosticsText(bundle));
      notify({ tone: "ok", title: "Diagnostics saved", detail: where });
    } catch (e) {
      notify({ tone: "error", title: "Couldn't save diagnostics", detail: String(e).replace(/^Error: /, "") });
    } finally {
      setSaving(false);
    }
  };

  const overview = (
    <>
      <OverviewHero
        art={<DeviceArt spec={{ kind: "controller", family, name: identity.name, brand: identity.brand, vid: device.vid, pid: device.pid }} />}
        connection={connection}
        name={identity.name}
        live={phase.kind === "ready"}
        detail={identity.model?.guide ?? (identity.support === "detect" ? "SYNQ can name this controller here, nothing more yet." : "SYNQ's tester reads it; nothing is changed on the pad.")}
        badges={<TierBadge tier={summary.tier} hint={summary.tierHint} />}
      />
      <Card innerClassName="px-5 py-3">
        <DetailRows
          rows={[
            ["Maker", identity.brand || "Unknown"],
            ["Reached through", VIA_TEXT[identity.via]],
            ["Connection", `${device.connection}${identity.personality ? ` · ${identity.personality}` : ""}`],
            ["USB id", `${device.vid.toUpperCase()}:${device.pid.toUpperCase()}`],
            ...(link?.info.deviceType ? ([["Reports itself as", link.info.deviceType]] as [string, string][]) : []),
            ...(link?.info.firmware ? ([["Firmware", `${link.info.firmware}${link.info.build ? ` (built ${link.info.build})` : ""}`]] as [string, string][]) : []),
            ...(link?.info.hardware ? ([["Hardware", link.info.hardware]] as [string, string][]) : []),
            ...(link?.info.facts ?? []),
            ...(link?.info.battery ? ([["Battery", link.info.battery.text ?? (link.info.battery.percent !== null ? `${link.info.battery.percent}%${link.info.battery.charging ? " · charging" : ""}` : "–")]] as [string, string][]) : []),
            ...(link?.info.calibration ? ([["Stick calibration", link.info.calibration === "read" ? "Read from the pad (never written)" : "Not available"]] as [string, string][]) : []),
            ["Its settings live", SETTINGS_TEXT[identity.settings]],
            ...(identity.model?.tool ? ([["Configured with", identity.model.tool.url ? <a key="tool" className="underline decoration-white/20 underline-offset-2 hover:text-primary" href={identity.model.tool.url} target="_blank" rel="noreferrer">{identity.model.tool.name}</a> : identity.model.tool.name]] as [string, ReactNode][]) : []),
          ]}
        />
      </Card>
      {identity.mismatch && <Banner>{identity.mismatch}</Banner>}
      {modeNote && <Banner tone="info">Opening the tester switches this pad to its full report until it reconnects; an older game that reads the basic mode may need a reconnect.</Banner>}
      {conflicts.length > 0 && (
        <div className="flex flex-col gap-2" data-testid="pad-conflicts">
          {conflicts.map((c) => (
            <Banner key={c.id}>
              {c.app} is running: {c.note}
            </Banner>
          ))}
        </div>
      )}
    </>
  );

  const body = (() => {
    if (tab === "overview" || identity.support === "detect") return overview;
    if (phase.kind === "connecting") return <EmptyCard title="Opening the controller…" text="Reading what it is. Nothing is changed." art={<Gamepad className="h-full" />} />;
    if (phase.kind === "paused") return <EmptyCard title="Paused" text="SYNQ lets go of controllers while its window isn't focused, so a game never finds one held. Click back into SYNQ to go on." art={<Gamepad className="h-full" />} />;
    if (phase.kind === "error") return <EmptyCard title="Couldn't open the controller" text={phase.message} art={<Gamepad className="h-full" />} />;
    if (!link) return null;
    if (tab === "polling") return <PollingTab link={link} notify={notify} />;
    if (tab === "lights") return <LightsTab link={link} notify={notify} />;
    if (tab === "profiles") return <EdgeProfilesTab link={link} notify={notify} />;
    if (tab === "settings")
      return identity.guard === "8bitdo" ? <EightBitDoSettingsTab link={link} notify={notify} /> : identity.guard === "flydigi" ? <FlydigiSettingsTab link={link} notify={notify} /> : <GamesirSettingsTab link={link} notify={notify} />;
    return <TestTab link={link} notify={notify} />;
  })();

  return (
    <DeviceFrame
      header={
        <DeviceHeader
          id={padId(family)}
          name={identity.name}
          pills={
            <>
              <StatusPill live={phase.kind === "ready"}>{statusText}</StatusPill>
              <TierBadge tier={summary.tier} hint={summary.tierHint} />
            </>
          }
          subtitle={
            identity.brand
              ? `${identity.brand} · ${
                  identity.guard === "edge"
                    ? "live tester, lights and rumble tests, onboard profiles (experimental)"
                    : identity.guard.startsWith("gamesir-") || identity.guard === "8bitdo" || identity.guard === "flydigi"
                      ? `live tester${identity.guard === "gamesir-tarantula" ? "" : ", rumble test"}, ${identity.guard === "gamesir-cyclone2" || identity.guard === "gamesir-g7pro8k" || identity.guard === "gamesir-tarantula" ? "settings" : "onboard profiles"} (experimental)`
                      : identity.guard === "scuf"
                        ? "live tester, firmware and battery reads"
                        : identity.support === "basics"
                        ? "live tester, lights and rumble tests"
                        : identity.support === "detect"
                          ? "recognised by name only"
                          : "live tester and polling check"
                }`
              : undefined
          }
          actions={
            link && (
              <ActionButton testId="pad-save-diagnostics" busy={saving} onClick={() => void saveDiagnostics()}>
                <DownloadSimple size={13} /> Save diagnostics
              </ActionButton>
            )
          }
          tabs={tabs}
          tab={tab}
          onTab={setTab}
        />
      }
    >
      <div key={tab} className={TAB_BODY} tabIndex={0} data-testid={`pad-tab-${tab}`}>
        {body}
      </div>
    </DeviceFrame>
  );
}
