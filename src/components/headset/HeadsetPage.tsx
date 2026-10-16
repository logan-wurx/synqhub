// A gaming headset's page: battery, charging and the chat-mix dial read from the headset, and its own settings
// (sidetone, auto-off, lights, mic light, volume limiter, the headset's EQ presets) behind "Allow changes". Every
// headset here is experimental: the protocol is HeadsetControl's, SYNQ hasn't been tried on one. Most of these
// settings can't be read back, so the page shows SYNQ's copy of what it set.
import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowClockwise, Info } from "@phosphor-icons/react";
import type { Connected } from "@/lib/backend";
import { useKeptState } from "@/lib/keep";
import { headsetId, useDeviceTab } from "@/lib/nav";
import { useWide } from "@/lib/viewport";
import { useSessionHold } from "@/lib/device-session";
import { connectHeadset } from "@/lib/headsets/connect";
import { findHeadset, SOURCE, type SettingId, type SettingSpec, type Status } from "@/lib/headsets/protocol";
import type { HeadsetSession } from "@/lib/headsets/session";
import { Card, CardHeader, type Notice } from "@/components/ui/matte";
import { Chip, EmptyCard, Select, SwitchRow } from "@/components/keyboard/parts";
import { BatteryRing } from "@/components/mouse/parts";
import { DeviceArt } from "@/components/devices/DeviceArt";
import { DeviceFrame, DeviceHeader, OverviewHero, StatusPill, StatusStrip, TAB_BODY, TierBadge, type TabDef } from "@/components/devices/shell";

type Notify = (n: Omit<Notice, "id">, key?: string) => void;

interface View extends Status {
  /** SYNQ's copy of each setting it set. */
  values: Partial<Record<SettingId, number>>;
}

const sessions = new Map<string, HeadsetSession>();

function valueText(s: SettingSpec, v: number): string {
  return s.labels?.[v] ?? `${v}${s.unit ? ` ${s.unit}` : ""}`;
}

function SettingRow({ s, value, disabled, busy, onSet }: { s: SettingSpec; value: number | null; disabled: boolean; busy: boolean; onSet: (v: number) => void }) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 py-3">
      <div className="min-w-[140px] flex-1">
        <p className="text-[13.5px] text-foreground">{s.label}</p>
        <p className="text-[11.5px] text-muted-foreground">{value === null ? "Not set from SYNQ yet" : `SYNQ set ${valueText(s, value)}`}</p>
      </div>
      {s.values.length <= 6 ? (
        <div className="flex flex-wrap gap-1.5">
          {s.values.map((v) => (
            <Chip key={v} on={value === v} disabled={disabled || busy} onClick={() => onSet(v)}>
              {valueText(s, v)}
            </Chip>
          ))}
        </div>
      ) : (
        <Select
          label={s.label}
          value={value === null ? "" : String(value)}
          onChange={(v) => v !== "" && onSet(Number(v))}
          groups={[{ options: [...(value === null ? [{ value: "", label: "Pick one" }] : []), ...s.values.map((v) => ({ value: String(v), label: valueText(s, v) }))] }]}
          className={disabled || busy ? "pointer-events-none opacity-40" : undefined}
        />
      )}
    </div>
  );
}

export function HeadsetPage({ devices, notify, family }: { devices: Connected[]; notify: Notify; family: string }) {
  const id = headsetId(family);
  const [vid, pid] = family.split(":");
  const model = findHeadset(vid, pid);
  const listed = devices.some((d) => d.kind === "headset" && `${d.vid}:${d.pid}` === family);
  const [view, setView] = useKeptState<View | null>(`headset.${family}.view`, null);
  const [allow, setAllow] = useKeptState<boolean>(`headset.${family}.allow`, false);
  const [phase, setPhase] = useState<"connecting" | "ready" | "missing" | "error">("connecting");
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const session = useRef<HeadsetSession | null>(sessions.get(family) ?? null);
  const wide = useWide();

  useSessionHold(`headset.${family}`, async () => {
    const s = sessions.get(family);
    sessions.delete(family);
    session.current = null;
    await s?.close();
  });

  const read = useCallback(async () => {
    const s = session.current;
    if (!s) return;
    try {
      const st = await s.refresh();
      setView({ ...st, values: s.values });
    } catch (e) {
      setProblem(e instanceof Error ? e.message : String(e));
    }
  }, [setView]);

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const s = session.current ?? (await connectHeadset(family));
        if (!live) return;
        if (!s) return setPhase("missing");
        sessions.set(family, s);
        session.current = s;
        s.setAllowChanges(allow);
        setPhase("ready");
        await read();
      } catch (e) {
        if (live) {
          setPhase("error");
          setProblem(e instanceof Error ? e.message : String(e));
        }
      }
    })();
    return () => {
      live = false;
    };
    // Connect once per headset; `allow` is applied by its own effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [family]);

  useEffect(() => session.current?.setAllowChanges(allow), [allow]);

  const set = async (sid: SettingId, value: number) => {
    const s = session.current;
    if (!s) return;
    setBusy(true);
    try {
      const r = await s.set(sid, value);
      setView((v) => ({ ...(v ?? { connected: true, battery: null, charging: null }), values: s.values }));
      const spec = s.settings().find((x) => x.id === sid)!;
      notify({ title: `${spec.label}: ${valueText(spec, value)}`, detail: r.confirmed ? "Read back from the headset" : `Sent; the headset can't report it, so SYNQ keeps a copy${s.backupPath ? ", backed up first" : ""}`, tone: "ok" }, "headset");
    } catch (e) {
      notify({ title: "Not changed", detail: e instanceof Error ? e.message : String(e), tone: "error" }, "headset");
    } finally {
      setBusy(false);
    }
  };

  const tabs: TabDef[] = [...(wide ? [] : [{ id: "overview", label: "Overview" }]), { id: "settings", label: "Settings" }];
  const [tab, setTab] = useDeviceTab(id, tabs.map((t) => t.id));
  const name = model ? model.name : "Headset";
  const brand = { "1038": "SteelSeries", "046d": "Logitech", "03f0": "HyperX" }[vid] ?? "";
  const connected = phase === "ready" && !!view?.connected;
  const stats = [
    { label: "Battery", value: view?.battery != null ? `${view.battery}%` : "—", note: view?.estimated ? "estimated from its voltage" : undefined },
    { label: "Charging", value: view?.charging == null ? "—" : view.charging ? "Yes" : "No" },
    ...(view?.chatmix ? [{ label: "Chat mix", value: `${view.chatmix.game} / ${view.chatmix.chat}`, note: "game / chat %" }] : []),
  ];
  const art = <DeviceArt spec={{ kind: "headset", family, name: `${brand} ${name}`, brand, vid, pid }} />;
  const overview = (
    <>
      <OverviewHero
        art={art}
        live={connected}
        connection="Wireless"
        name={name}
        detail={phase === "ready" && view && !view.connected ? "The receiver answers, but the headset is off or out of range." : `${brand} · battery and chat-mix read straight from the headset.`}
        badges={<TierBadge tier="experimental" hint="Built from HeadsetControl's open protocol; SYNQ hasn't been tried on one yet." />}
      />
      <StatusStrip stats={stats} />
      <Card innerClassName="flex items-center gap-5 px-6 py-5">
        <BatteryRing percent={view?.battery ?? null} charging={!!view?.charging} />
        <div className="min-w-0 flex-1">
          <p className="text-[13px] text-muted-foreground">Battery</p>
          <p className="mt-1 text-[15px] text-foreground">{view?.battery != null ? `${view.battery}%${view.charging ? ", charging" : ""}` : connected ? "The headset didn't say" : "Not read yet"}</p>
          <button onClick={() => void read()} className="mt-2 inline-flex items-center gap-1.5 text-[12px] text-muted-foreground transition-colors hover:text-foreground">
            <ArrowClockwise size={12} /> Read again
          </button>
        </div>
      </Card>
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
              <StatusPill live={connected}>{phase === "connecting" ? "Connecting" : connected ? "Connected · Wireless" : listed ? "Headset off" : "Not connected"}</StatusPill>
              <TierBadge tier="experimental" />
            </>
          }
          subtitle={`${brand} · battery, chat-mix and its own settings`}
          tabs={tabs}
          tab={tab}
          onTab={setTab}
        />
      }
    >
      <div key={tab} className={TAB_BODY} tabIndex={0}>
        {phase === "missing" && <EmptyCard title="Plug it in" text="Connect the headset's receiver or cable; it shows up here on its own." plug />}
        {phase === "error" && <EmptyCard title="Couldn't talk to the headset" text={problem ?? "Something went wrong opening it."} plug />}
        {phase === "connecting" && <EmptyCard title="Looking for your headset…" text="This takes a second." />}
        {phase === "ready" && tab === "overview" && overview}
        {phase === "ready" && tab === "settings" && session.current && (
          <>
            <Card innerClassName="px-5 py-2">
              <SwitchRow
                title="Allow changes"
                hint="SYNQ hasn't been tried on this headset. With this on, it saves a copy of what it knows first and sends only the settings below."
                checked={allow}
                onChange={setAllow}
              />
            </Card>
            <Card>
              <CardHeader title="Headset settings" hint="Stored in the headset. It can't report most of them back, so this shows what SYNQ set." />
              <div className="divide-y divide-white/[0.05] px-5 pb-3 pt-1">
                {session.current.settings().map((s) => (
                  <SettingRow key={s.id} s={s} value={view?.values[s.id] ?? null} disabled={!allow} busy={busy} onSet={(v) => void set(s.id, v)} />
                ))}
              </div>
            </Card>
            <p className="flex items-start gap-2 px-1 text-[11.5px] leading-relaxed text-muted-foreground/80">
              <Info size={13} className="mt-0.5 shrink-0" />
              <span title={SOURCE}>The protocol comes from HeadsetControl (GPL-3.0). SYNQ never sends firmware, pairing or reset commands to a headset.</span>
            </p>
          </>
        )}
      </div>
    </DeviceFrame>
  );
}
