// A webcam's page: its controls over UVC (exposure, focus, white balance, zoom, pan and tilt, brightness, contrast,
// saturation, power line frequency), read freely and changed only with "Allow changes", a backup of every value first
// and a read-back after. The live preview runs only after "Show preview", only while this page is open and SYNQ is
// the window in front; nothing is recorded or kept.
import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowCounterClockwise, VideoCamera } from "@phosphor-icons/react";
import { backend, type Connected } from "@/lib/backend";
import { useKeptState } from "@/lib/keep";
import { useDeviceTab, webcamId } from "@/lib/nav";
import { useWide } from "@/lib/viewport";
import { useWindowFocus } from "@/lib/controllers/use-link";
import { UVC, onStep, uvcLabel, type CamControl } from "@/lib/displays/uvc";
import { Card, CardHeader, type Notice } from "@/components/ui/matte";
import { Chip, EmptyCard, Pill, SwitchRow } from "@/components/keyboard/parts";
import { Switch } from "@/components/ui/switch";
import { DeviceArt } from "@/components/devices/DeviceArt";
import { DeviceFrame, DeviceHeader, OverviewHero, StatusPill, TAB_BODY, TierBadge, type TabDef } from "@/components/devices/shell";
import { LevelSlider } from "./parts";

type Notify = (n: Omit<Notice, "id">, key?: string) => void;

/** The live picture: started by the person, stopped on leaving the page or when SYNQ isn't in front. */
function Preview({ name }: { name: string }) {
  const [on, setOn] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const video = useRef<HTMLVideoElement>(null);
  const focused = useWindowFocus();
  const live = on && focused;

  useEffect(() => {
    if (!live) return;
    let stream: MediaStream | null = null;
    let stopped = false;
    (async () => {
      try {
        const find = async () => (await navigator.mediaDevices.enumerateDevices()).find((d) => d.kind === "videoinput" && d.label && name && d.label.toLowerCase().includes(name.toLowerCase().slice(0, 12)));
        let dev = await find();
        if (!dev) {
          // Labels come only once the browser may use a camera: ask once, then pick this one.
          const first = await navigator.mediaDevices.getUserMedia({ video: true });
          first.getTracks().forEach((t) => t.stop());
          dev = await find();
        }
        stream = await navigator.mediaDevices.getUserMedia({ video: dev ? { deviceId: { exact: dev.deviceId } } : true });
        if (stopped) return stream.getTracks().forEach((t) => t.stop());
        if (video.current) video.current.srcObject = stream;
      } catch (e) {
        setProblem(e instanceof Error ? e.message : String(e));
        setOn(false);
      }
    })();
    return () => {
      stopped = true;
      stream?.getTracks().forEach((t) => t.stop());
      if (video.current) video.current.srcObject = null;
    };
  }, [live, name]);

  return (
    <Card innerClassName="overflow-hidden p-3">
      <div className="relative grid aspect-video w-full place-items-center overflow-hidden rounded-[1.1rem] bg-black/60 ring-1 ring-white/[0.06]">
        {on ? (
          <video ref={video} autoPlay playsInline muted className="h-full w-full object-cover" aria-label="Live preview" />
        ) : (
          <div className="px-6 text-center">
            <VideoCamera size={28} weight="light" className="mx-auto text-muted-foreground" />
            <p className="mt-2 text-[12.5px] leading-relaxed text-muted-foreground">The preview runs only while you have it on, on this page. Nothing is recorded or kept.</p>
          </div>
        )}
        {on && !focused && <p className="absolute inset-x-0 bottom-3 text-center text-[12px] text-muted-foreground">Paused while SYNQ isn't in front</p>}
      </div>
      <div className="mt-3 flex items-center gap-2 px-1">
        <Pill primary={!on} onClick={() => setOn(!on)}>
          {on ? "Hide preview" : "Show preview"}
        </Pill>
        {problem && <span className="truncate text-[11.5px] text-chart-3">{problem}</span>}
      </div>
    </Card>
  );
}

export function WebcamPage({ devices, notify, family }: { devices: Connected[]; notify: Notify; family: string }) {
  const id = webcamId(family);
  const device = devices.find((d) => d.kind === "webcam" && `${d.vid}:${d.pid}` === family.split("~")[0]);
  const path = device?.path ?? null;
  const [controls, setControls] = useKeptState<CamControl[] | null>(`webcam.${family}.view`, null);
  const [backup, setBackup] = useKeptState<CamControl[] | null>(`webcam.${family}.backup`, null);
  const [allow, setAllow] = useKeptState<boolean>(`webcam.${family}.allow`, false);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const wide = useWide();

  const read = useCallback(async () => {
    if (!path) return;
    try {
      setControls(await backend.webcamControls(path));
      setProblem(null);
    } catch (e) {
      setProblem(e instanceof Error ? e.message : String(e));
    }
  }, [path, setControls]);

  useEffect(() => {
    void read();
  }, [read]);

  const set = async (cid: string, value: number, auto: boolean): Promise<void> => {
    if (!path || !controls) return;
    setBusy(true);
    try {
      if (!backup) {
        await backend.displayBackupSave(`webcam-${family.replace(/[^a-z0-9]/gi, "-")}`, JSON.stringify({ webcam: device?.name, controls }));
        setBackup(controls);
      }
      const r = await backend.webcamSet(path, cid, value, auto);
      setControls((cs) => (cs ?? []).map((c) => (c.id === cid ? r : c)));
    } catch (e) {
      notify({ title: "Not changed", detail: e instanceof Error ? e.message : String(e), tone: "error" }, "webcam");
    } finally {
      setBusy(false);
    }
  };

  const putBack = async () => {
    if (!backup || !controls) return;
    for (const b of backup) {
      const now = controls.find((c) => c.id === b.id);
      if (now && (now.auto !== b.auto || (!b.auto && now.value !== b.value))) await set(b.id, b.value, b.auto);
    }
    notify({ title: "Put back", detail: "The camera's controls are as they were before SYNQ's first change.", tone: "ok" }, "webcam");
  };

  const tabs: TabDef[] = [...(wide ? [] : [{ id: "overview", label: "Overview" }]), { id: "controls", label: "Controls" }];
  const [tab, setTab] = useDeviceTab(id, tabs.map((t) => t.id));
  const name = device?.name ?? "Webcam";
  const disabled = !allow || busy;
  const overview = (
    <>
      <OverviewHero
        art={<DeviceArt spec={{ kind: "webcam", family, name, vid: device?.vid, pid: device?.pid }} />}
        live={!!controls}
        connection="USB"
        name={name}
        detail="Its own controls over UVC. The preview is yours to turn on."
        badges={<TierBadge tier="experimental" hint="UVC is the webcams' standard way to be set, but SYNQ hasn't been tried on this one." />}
      />
      <Preview name={name} />
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
              <StatusPill live={!!controls}>{path ? (controls ? "Connected · USB" : problem ? "Not answering" : "Reading") : "Not connected"}</StatusPill>
              <TierBadge tier="experimental" />
            </>
          }
          subtitle="Exposure, focus, white balance and the rest of its own controls"
          tabs={tabs}
          tab={tab}
          onTab={setTab}
        />
      }
    >
      <div key={tab} className={TAB_BODY} tabIndex={0}>
        {!path && <EmptyCard title="Not connected" text="Plug the webcam in; it shows up here on its own." />}
        {path && tab === "overview" && overview}
        {path && tab === "controls" && (
          <>
            {problem && !controls && (
              <Card innerClassName="px-6 py-5">
                <p className="text-[14px] text-foreground">The camera didn't answer</p>
                <p className="mt-1 text-[12.5px] text-muted-foreground">{problem}</p>
                <Pill className="mt-3" onClick={() => void read()}>
                  Try again
                </Pill>
              </Card>
            )}
            {controls && (
              <>
                <Card innerClassName="px-5 py-2">
                  <SwitchRow title="Allow changes" hint="SYNQ hasn't been tried on this camera. With this on, it saves every value first and reads each change back." checked={allow} onChange={setAllow} />
                </Card>
                <Card>
                  <CardHeader title="Camera controls" hint="Sent when you let go of a slider. Auto hands the control back to the camera." />
                  <div className="divide-y divide-white/[0.05] px-5 pb-3">
                    {UVC.map((spec) => {
                      const c = controls.find((x) => x.id === spec.id);
                      if (!c) return null;
                      if (spec.labels) {
                        return (
                          <div key={spec.id} className="py-2.5">
                            <p className="text-[13px] text-foreground">{spec.label}</p>
                            <div className="mt-2 flex flex-wrap gap-1.5">
                              {Array.from({ length: c.max - c.min + 1 }, (_, i) => c.min + i).map((v) => (
                                <Chip key={v} on={c.value === v} disabled={disabled} onClick={() => void set(spec.id, v, false)}>
                                  {uvcLabel(spec, v)}
                                </Chip>
                              ))}
                            </div>
                          </div>
                        );
                      }
                      return (
                        <div key={spec.id} className="flex items-end gap-4">
                          <div className="min-w-0 flex-1">
                            <LevelSlider
                              label={spec.label}
                              value={c.value}
                              min={c.min}
                              max={c.max}
                              step={c.step > 0 ? c.step : 1}
                              disabled={disabled || c.auto}
                              format={(v) => (c.auto ? "Auto" : uvcLabel(spec, onStep(c, v)))}
                              onCommit={(v) => void set(spec.id, onStep(c, v), false)}
                            />
                          </div>
                          {c.canAuto && (
                            <label className="flex shrink-0 items-center gap-2 pb-3 text-[12px] text-muted-foreground">
                              Auto
                              <Switch checked={c.auto} onCheckedChange={(on) => void set(spec.id, c.value, on)} disabled={disabled} aria-label={`${spec.label} auto`} />
                            </label>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </Card>
                {backup && (
                  <button onClick={() => void putBack()} disabled={busy} className="flex items-center gap-1.5 self-start px-1 text-[12.5px] text-muted-foreground transition-colors hover:text-foreground">
                    <ArrowCounterClockwise size={13} /> Put the camera back as it was
                  </button>
                )}
                <p className="px-1 text-[11.5px] leading-relaxed text-muted-foreground/80">SYNQ sends only these standard UVC controls: no maker extension units, no factory defaults.</p>
              </>
            )}
          </>
        )}
      </div>
    </DeviceFrame>
  );
}
