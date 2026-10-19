// A monitor's page: what its EDID says, and over DDC/CI its brightness, contrast, colour preset and gains, speaker
// volume and input. Reads are free; a change needs "Allow changes", saves a backup of every value first and is read
// back by the bridge. Switching the input blanks this screen, so it asks first and switches back by itself after
// 15 seconds unless kept. Factory resets, power and anything not on the list are never sent.
import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowCounterClockwise, CaretDown, Warning } from "@phosphor-icons/react";
import { backend, type Connected } from "@/lib/backend";
import { useKeptState } from "@/lib/keep";
import { monitorId, useDeviceTab } from "@/lib/nav";
import { INPUT_CODE, READ_ONLY, VCP, listed, valueName, type Caps, type Reading, type VcpId } from "@/lib/displays/vcp";
import { Card, CardHeader, type Notice } from "@/components/ui/matte";
import { Chip, EmptyCard, Pill, SwitchRow } from "@/components/keyboard/parts";
import { DeviceArt } from "@/components/devices/DeviceArt";
import { DeviceFrame, DeviceHeader, OverviewStrip, StatusPill, TAB_BODY, TierBadge, type TabDef } from "@/components/devices/shell";
import { LevelSlider } from "./parts";

type Notify = (n: Omit<Notice, "id">, key?: string) => void;
const REVERT_S = 15;
const code = (id: VcpId) => VCP.find((s) => s.id === id)!.code;
const EMPTY: View = { caps: null, values: {}, backup: null };

interface View {
  caps: Caps | null;
  values: Record<number, Reading>;
  /** What every allowlisted code held before SYNQ's first change. */
  backup: Record<number, number> | null;
}

export function MonitorPage({ devices, notify, family }: { devices: Connected[]; notify: Notify; family: string }) {
  const id = monitorId(family);
  const device = devices.find((d) => d.kind === "monitor" && `${d.vid}:${d.pid}` === family.split("~")[0]);
  const path = device?.path ?? null;
  // The Devices home's card keeps this key too (null until this page has read the monitor).
  const [kept, setKept] = useKeptState<View | null>(`monitor.${family}.view`, null);
  const view = kept ?? EMPTY;
  const setView = useCallback((f: (v: View) => View) => setKept((v) => f(v ?? EMPTY)), [setKept]);
  const [allow, setAllow] = useKeptState<boolean>(`monitor.${family}.allow`, false);
  const [phase, setPhase] = useState<"reading" | "ready" | "noddc" | "missing">(path ? "reading" : "missing");
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [ask, setAsk] = useState<number | null>(null);
  const [revert, setRevert] = useState<{ from: number; to: number; left: number } | null>(null);

  const read = useCallback(async () => {
    if (!path) return setPhase("missing");
    setPhase("reading");
    try {
      const caps = await backend.monitorCaps(path);
      const codes = [...VCP.map((s) => s.code), ...READ_ONLY].filter((c) => listed(caps, c));
      const readings = await backend.monitorRead(path, codes);
      setView((v) => ({ ...v, caps, values: Object.fromEntries(readings.map((r) => [r.code, r])) }));
      setPhase("ready");
    } catch (e) {
      setProblem(e instanceof Error ? e.message : String(e));
      setPhase("noddc");
    }
  }, [path, setView]);

  useEffect(() => {
    void read();
  }, [read]);

  const write = async (c: number, value: number, confirm = false): Promise<boolean> => {
    if (!path || !view.caps) return false;
    setBusy(true);
    try {
      if (!view.backup) {
        const backup = Object.fromEntries(Object.values(view.values).map((r) => [r.code, r.value]));
        await backend.displayBackupSave(`monitor-${family.replace(/[^a-z0-9]/gi, "-")}`, JSON.stringify({ monitor: device?.name, caps: view.caps, values: backup }));
        setView((v) => ({ ...v, backup }));
      }
      const r = await backend.monitorWrite(path, c, value, confirm);
      setView((v) => ({ ...v, values: { ...v.values, [c]: r } }));
      return true;
    } catch (e) {
      notify({ title: "Not changed", detail: e instanceof Error ? e.message : String(e), tone: "error" }, "monitor");
      return false;
    } finally {
      setBusy(false);
    }
  };

  // The input switch: back to where it was after REVERT_S seconds unless kept.
  const revertRef = useRef(revert);
  revertRef.current = revert;
  useEffect(() => {
    if (!revert) return;
    if (revert.left <= 0) {
      void write(INPUT_CODE, revert.from, true).then((ok) => ok && notify({ title: "Switched back", detail: `Input ${valueName(INPUT_CODE, revert.from)}`, tone: "info" }, "monitor"));
      setRevert(null);
      return;
    }
    const t = window.setTimeout(() => setRevert((r) => (r ? { ...r, left: r.left - 1 } : r)), 1000);
    return () => window.clearTimeout(t);
    // write and notify are stable for the countdown's life.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revert]);

  const switchInput = async (to: number) => {
    const from = view.values[INPUT_CODE]?.value;
    setAsk(null);
    if (from === undefined) return;
    if (await write(INPUT_CODE, to, true)) setRevert({ from, to, left: REVERT_S });
  };

  const putBack = async () => {
    if (!view.backup) return;
    for (const [c, value] of Object.entries(view.backup)) {
      const n = Number(c);
      if (n === INPUT_CODE || READ_ONLY.includes(n) || !VCP.some((s) => s.code === n)) continue;
      if (view.values[n]?.value !== value) await write(n, value);
    }
    notify({ title: "Put back", detail: "Every picture setting is as it was before SYNQ's first change.", tone: "ok" }, "monitor");
  };

  // One page: the monitor and what it reports on top, its picture and input right under it.
  const tabs: TabDef[] = [{ id: "overview", label: "Overview" }];
  const [tab, setTab] = useDeviceTab(id, tabs.map((t) => t.id), { picture: "overview" });
  const name = device?.name ?? "Monitor";
  const brand = { aus: "ASUS", del: "Dell", gsm: "LG", sam: "Samsung", aoc: "AOC", bnq: "BenQ", acr: "Acer", msi: "MSI" }[device?.vid ?? ""] ?? device?.vid.toUpperCase() ?? "";
  const v = (c: number) => view.values[c] ?? null;
  const disabled = !allow || busy || !!revert;
  const caps = view.caps;
  const has = (c: number) => !!caps && !!listed(caps, c) && !!v(c);

  const art = <DeviceArt spec={{ kind: "monitor", family, name: `${brand} ${name}`, brand, vid: device?.vid, pid: device?.pid }} />;
  const overview = (
    <>
      <OverviewStrip
        art={art}
        live={phase === "ready"}
        connection={null}
        detail={phase === "noddc" ? "Named from its EDID; it didn't answer over DDC/CI." : `${brand} · brightness, contrast, colour and input over DDC/CI.`}
        badges={<TierBadge tier="experimental" hint="DDC/CI is the monitors' standard way to be set, but SYNQ hasn't been tried on this one." />}
        stats={
          phase === "ready"
            ? [
                { label: "Brightness", value: v(code("brightness"))?.value ?? "—" },
                { label: "Contrast", value: v(code("contrast"))?.value ?? "—" },
                { label: "Input", value: v(INPUT_CODE) ? valueName(INPUT_CODE, v(INPUT_CODE)!.value) : "—" },
                { label: "DDC/CI", value: caps?.mccs ? `MCCS ${caps.mccs}` : "On" },
              ]
            : []
        }
      />
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
              <StatusPill live={phase === "ready"}>{phase === "ready" ? "DDC/CI answers" : phase === "reading" ? "Reading" : phase === "missing" ? "Not connected" : "DDC/CI off"}</StatusPill>
              <TierBadge tier="experimental" />
            </>
          }
          subtitle={`${brand} · the picture and the input over DDC/CI`}
          tabs={tabs}
          tab={tab}
          onTab={setTab}
        />
      }
    >
      <div key={tab} className={TAB_BODY} tabIndex={0}>
        {phase === "missing" && <EmptyCard title="Not connected" text="Connect the monitor; it shows up here on its own." />}
        {phase === "reading" && <EmptyCard title="Asking the monitor…" text="DDC/CI answers slowly on some monitors; this takes a second or two." />}
        {phase === "noddc" && (
          <Card innerClassName="px-6 py-5">
            <p className="flex items-center gap-2 text-[15px] text-high">
              <Warning size={16} weight="light" className="text-chart-3" /> The monitor didn't answer over DDC/CI
            </p>
            <p className="mt-2 max-w-[620px] text-[13px] leading-relaxed text-medium">
              Most monitors have DDC/CI in their own menu (on ASUS: System Setup, DDC/CI). Turn it on there, then try again. Some docks, KVM switches and adapters don't pass it through.
            </p>
            {problem && <p className="mt-2 text-[11.5px] text-medium">{problem}</p>}
            <Pill className="mt-4" onClick={() => void read()}>
              Try again
            </Pill>
          </Card>
        )}
        {phase === "ready" && tab === "overview" && overview}
        {phase === "ready" && tab === "overview" && caps && (
          <>
            {/* The picture on the left; on the right, Allow changes, the input and the way back. */}
            <div className="grid items-start gap-4 min-[1280px]:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)]">
              <div className="flex min-w-0 flex-col gap-4">
                <Card>
                  <CardHeader title="Picture" hint="Sent when you let go of a slider; the monitor keeps it." />
                  <div className="px-5 pb-3">
                    {(["brightness", "contrast"] as const).map((k) =>
                      has(code(k)) ? <LevelSlider key={k} label={k === "brightness" ? "Brightness" : "Contrast"} value={v(code(k))!.value} min={0} max={v(code(k))!.max} disabled={disabled} onCommit={(x) => void write(code(k), x)} /> : null,
                    )}
                    {has(code("colorPreset")) && (
                      <div className="py-2.5">
                        <p className="text-[13px] text-high">Colour preset</p>
                        <div className="mt-2 flex flex-wrap gap-1.5">
                          {listed(caps, code("colorPreset"))!.map((p) => (
                            <Chip key={p} on={v(code("colorPreset"))?.value === p} disabled={disabled} onClick={() => void write(code("colorPreset"), p)}>
                              {valueName(code("colorPreset"), p)}
                            </Chip>
                          ))}
                        </div>
                      </div>
                    )}
                    {has(code("redGain")) && (
                      <details className="group py-2.5">
                        <summary className="flex cursor-pointer list-none items-center gap-1.5 text-[13px] text-medium transition-colors hover:text-high [&::-webkit-details-marker]:hidden">
                          Colour balance (red, green, blue)
                          <CaretDown size={12} className="transition-transform duration-300 ease-fluid group-open:rotate-180" />
                        </summary>
                        {(["redGain", "greenGain", "blueGain"] as const).map((k) =>
                          has(code(k)) ? <LevelSlider key={k} label={VCP.find((s) => s.id === k)!.label} value={v(code(k))!.value} min={0} max={v(code(k))!.max} disabled={disabled} onCommit={(x) => void write(code(k), x)} /> : null,
                        )}
                      </details>
                    )}
                    {has(code("volume")) && <LevelSlider label="Speaker volume" value={v(code("volume"))!.value} min={0} max={v(code("volume"))!.max} disabled={disabled} onCommit={(x) => void write(code("volume"), x)} />}
                  </div>
                </Card>
              </div>
              <div className="flex min-w-0 flex-col gap-4">
                <Card innerClassName="px-5 py-2">
                  <SwitchRow title="Allow changes" hint="SYNQ hasn't been tried on this monitor. With this on, it saves every value first and reads each change back." checked={allow} onChange={setAllow} />
                </Card>
                {revert && (
                  <div className="rounded-control bg-chart-3/[0.07] px-5 py-4 ring-1 ring-chart-3/25">
                    <p className="text-[14px] text-high">Keep {valueName(INPUT_CODE, revert.to)}?</p>
                    <p className="mt-1 text-[12.5px] text-medium">Switching back to {valueName(INPUT_CODE, revert.from)} in {revert.left} s.</p>
                    <div className="mt-3 flex gap-2">
                      <Pill primary onClick={() => setRevert(null)}>
                        Keep it
                      </Pill>
                      <Pill onClick={() => setRevert((r) => (r ? { ...r, left: 0 } : r))}>Switch back now</Pill>
                    </div>
                  </div>
                )}
                {has(INPUT_CODE) && (
                  <Card>
                    <CardHeader title="Input" hint="Switching blanks this screen if nothing is on that input; SYNQ switches back after 15 seconds unless you keep it." />
                    <div className="px-5 pb-4 pt-3">
                      <div className="flex flex-wrap gap-1.5">
                        {listed(caps, INPUT_CODE)!.map((p) => (
                          <Chip key={p} on={v(INPUT_CODE)?.value === p} disabled={disabled} onClick={() => p !== v(INPUT_CODE)?.value && setAsk(p)}>
                            {valueName(INPUT_CODE, p)}
                          </Chip>
                        ))}
                      </div>
                      {ask !== null && (
                        <div className="mt-3 flex flex-wrap items-center gap-2 rounded-control bg-white/[0.03] px-4 py-3 ring-1 ring-white/[0.07]">
                          <p className="min-w-0 flex-1 text-[12.5px] text-medium">Switch to {valueName(INPUT_CODE, ask)}? This screen may go dark until it switches back.</p>
                          <Pill primary onClick={() => void switchInput(ask)}>
                            Switch
                          </Pill>
                          <Pill onClick={() => setAsk(null)}>Cancel</Pill>
                        </div>
                      )}
                    </div>
                  </Card>
                )}
                {view.backup && (
                  <button onClick={() => void putBack()} disabled={busy} className="flex items-center gap-1.5 self-start px-1 text-[12.5px] text-medium transition-colors hover:text-high">
                    <ArrowCounterClockwise size={12} /> Put the picture back as it was
                  </button>
                )}
                <p className="px-1 text-[11.5px] leading-relaxed text-medium">SYNQ never sends a factory reset, a power command or a maker's own codes to a monitor.</p>
              </div>
            </div>
          </>
        )}
      </div>
    </DeviceFrame>
  );
}
