// A USB RGB hub's page: what the hub says about itself (firmware; on NZXT, what is plugged into each channel), and one
// colour per channel once "Allow changes" is on. Every report passes the hub guard in the page and again in the bridge.
// Before the first change SYNQ keeps everything the hub reported; the hubs can't report the effect or colours they
// show, so Put back sends the colour SYNQ sent before the latest one, and the page says exactly that.
// A device SYNQ only names (the Corsair Nautilus LCD Cap) gets what it is and why SYNQ leaves it alone.
import { useEffect, useState } from "react";
import { ArrowCounterClockwise } from "@phosphor-icons/react";
import type { Connected } from "@/lib/backend";
import { useKeptState } from "@/lib/keep";
import { connectHub } from "@/lib/lighting/hidrgb/connect";
import { FAMILIES, LIANLI_LEDS_PER_FAN, findHub, findIdentifyOnly, ledsFor, maxLeds, type HubFacts, type HubModel } from "@/lib/lighting/hidrgb/protocol";
import type { HubSession } from "@/lib/lighting/hidrgb/session";
import type { Rgb } from "@/lib/lighting/govee/frames";
import { hubId, useDeviceTab } from "@/lib/nav";
import { useWide } from "@/lib/viewport";
import { Card, CardHeader, type Notice } from "@/components/ui/matte";
import { EmptyCard, SwitchRow } from "@/components/keyboard/parts";
import { DeviceArt } from "@/components/devices/DeviceArt";
import { DeviceFrame, DeviceHeader, OverviewHero, StatusPill, TAB_BODY, TierBadge, type TabDef } from "@/components/devices/shell";
import { ColourPicker } from "./ColourPicker";
import { Chip, SubHead, css } from "./controls";

type Notify = (n: Omit<Notice, "id">, key?: string) => void;


function LedCount({ m, value, onChange }: { m: HubModel; value: number; onChange: (n: number) => void }) {
  if (m.family === "lianli-sl")
    return (
      <div className="flex gap-1.5">
        {[1, 2, 3, 4].map((f) => (
          <Chip key={f} small on={value === f * LIANLI_LEDS_PER_FAN} onClick={() => onChange(f * LIANLI_LEDS_PER_FAN)}>
            {f} {f === 1 ? "fan" : "fans"}
          </Chip>
        ))}
      </div>
    );
  return (
    <label className="flex items-center gap-2 text-[12px] text-muted-foreground">
      LEDs
      <input
        type="number"
        min={1}
        max={maxLeds(m)}
        value={value}
        onChange={(e) => onChange(Math.max(1, Math.min(maxLeds(m), Math.round(Number(e.target.value) || 1))))}
        className="tabular w-16 rounded-lg bg-white/[0.04] px-2 py-1 text-[12.5px] text-foreground ring-1 ring-white/[0.08] focus:outline-none focus:ring-white/25"
      />
    </label>
  );
}

function IdentifyOnlyCard({ vid, pid }: { vid: string; pid: string }) {
  const only = findIdentifyOnly(vid, pid);
  return (
    <Card innerClassName="px-6 py-5">
      <p className="text-[14px] text-foreground">{only?.what ?? "A device SYNQ knows by name."}</p>
      <p className="mt-2 max-w-[560px] text-[12.5px] leading-relaxed text-muted-foreground">{only?.why}</p>
      <p className="tabular mt-3 text-[11.5px] text-muted-foreground/80">
        USB {vid.toUpperCase()}:{pid.toUpperCase()}
      </p>
    </Card>
  );
}

export function RgbHubPage({ devices, notify, family }: { devices: Connected[]; notify: Notify; family: string }) {
  const id = hubId(family);
  const [vid, pid] = family.split(":");
  const model = findHub(vid, pid);
  const device = devices.find((d) => d.kind === "rgbhub" && `${d.vid}:${d.pid}` === family);
  const [session, setSession] = useState<HubSession | null>(null);
  const [facts, setFacts] = useState<HubFacts>({ firmware: null, accessories: null });
  const [problem, setProblem] = useState<string | null>(null);
  const [allow, setAllow] = useKeptState<boolean>(`rgbhub.${family}.allow`, false);
  const [chosen, setChosen] = useKeptState<Record<number, number>>(`rgbhub.${family}.leds`, {});
  const [channels, setChannels] = useKeptState<number[]>(`rgbhub.${family}.channels`, [0]);
  const [colour, setColour] = useKeptState<Rgb>(`rgbhub.${family}.colour`, [255, 42, 212]);
  const [busy, setBusy] = useState(false);
  const wide = useWide();

  const present = !!device;
  useEffect(() => {
    if (!model || !present) return;
    let s: HubSession | null = null;
    let live = true;
    connectHub(family)
      .then(async (opened) => {
        s = opened;
        if (!opened || !live) return;
        setSession(opened);
        setFacts(await opened.identify());
      })
      .catch((e) => live && setProblem(e instanceof Error ? e.message : String(e)));
    return () => {
      live = false;
      void s?.close();
    };
  }, [family, model, present]);

  useEffect(() => session?.setAllowChanges(allow), [session, allow]);

  const [, redraw] = useState(0);
  const send = async (c: Rgb | null) => {
    if (!session || !model) return;
    setBusy(true);
    try {
      for (const ch of channels.filter((x) => x < model.channels)) {
        if (c) {
          await session.setChannel(ch, c, ledsFor(model, facts, chosen, ch));
          continue;
        }
        // Put back: the wheel shows the colour that went back out.
        const before = session.previous(ch);
        if (before && (await session.putBack(ch))) setColour(before.rgb);
      }
      redraw((n) => n + 1);
    } catch (e) {
      notify({ title: "Not sent", detail: e instanceof Error ? e.message : String(e), tone: "error" }, "rgbhub");
    } finally {
      setBusy(false);
    }
  };

  const name = model?.name ?? findIdentifyOnly(vid, pid)?.name ?? device?.name ?? "RGB device";
  const brand = model ? FAMILIES[model.family].brand : "";
  const tabs: TabDef[] = [...(wide ? [] : [{ id: "overview", label: "Overview" }]), { id: "light", label: model ? "Light" : "About" }];
  const [tab, setTab] = useDeviceTab(id, tabs.map((t) => t.id));
  const overview = (
    <OverviewHero
      art={<DeviceArt spec={{ kind: "rgbhub", family, name, brand, vid, pid }} />}
      live={!!device}
      connection="USB"
      name={name}
      detail={model ? `${model.channels} ${model.channels === 1 ? "channel" : "channels"}${facts.firmware ? ` · firmware ${facts.firmware}` : ""}. One colour per channel, from the protocol OpenRGB documents.` : "SYNQ names it and sends it nothing."}
      badges={model ? <TierBadge tier="experimental" hint="From OpenRGB's protocol notes; SYNQ hasn't been tried on this hub." /> : <TierBadge tier="read-only" />}
    />
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
              <StatusPill live={!!device}>{device ? "Connected · USB" : "Not connected"}</StatusPill>
              <TierBadge tier={model ? "experimental" : "read-only"} />
            </>
          }
          subtitle={model ? "One colour per channel" : "Known, not driven"}
          tabs={tabs}
          tab={tab}
          onTab={setTab}
        />
      }
    >
      <div key={tab} className={TAB_BODY} tabIndex={0}>
        {!device && <EmptyCard title="Not connected" text="Plug the hub in; it shows up here on its own." />}
        {device && tab === "overview" && overview}
        {device && tab === "light" && !model && <IdentifyOnlyCard vid={vid} pid={pid} />}
        {device && tab === "light" && model && (
          <>
            {problem && <EmptyCard title="The hub didn't answer" text={problem} />}
            <Card innerClassName="px-5 py-2">
              <SwitchRow
                title="Allow changes"
                hint={`SYNQ hasn't been tried on this hub. With this on, a colour goes out when you let go of the wheel or pick a swatch. SYNQ can't read the ${model.family === "corsair-node" ? "effect" : "colours"} it replaces; Put back sets the colour it sent before the last one.`}
                checked={allow}
                onChange={setAllow}
              />
            </Card>
            <Card innerClassName="pb-4">
              <CardHeader title="Channels" hint={model.family === "nzxt-hue2" ? "What the hub reports on each channel; pick the ones the colour goes to." : "The hub can't say what is plugged in: set each channel's LEDs (fans) to match."} />
              <div className="divide-y divide-white/[0.05] px-5">
                {Array.from({ length: model.channels }, (_, ch) => {
                  const items = facts.accessories?.find((a) => a.channel === ch)?.items ?? [];
                  const sent = session?.sent.get(ch)?.slice(-1)[0];
                  return (
                    <div key={ch} className="flex flex-wrap items-center gap-3 py-2.5">
                      <Chip on={channels.includes(ch)} onClick={() => setChannels(channels.includes(ch) ? channels.filter((x) => x !== ch) : [...channels, ch].sort())}>
                        Channel {ch + 1}
                      </Chip>
                      <span className="min-w-0 flex-1 truncate text-[12.5px] text-muted-foreground">{items.length ? items.map((i) => i.name).join(", ") : model.family === "nzxt-hue2" ? "Nothing reported" : ""}</span>
                      {sent && <span className="size-3.5 shrink-0 rounded-full ring-1 ring-white/20" style={{ background: css(sent.rgb) }} title="Last sent" />}
                      <LedCount m={model} value={ledsFor(model, facts, chosen, ch)} onChange={(n) => setChosen({ ...chosen, [ch]: n })} />
                    </div>
                  );
                })}
              </div>
            </Card>
            <Card innerClassName="pb-5">
              <CardHeader title="Colour" hint="The hub keeps it with no app running." />
              <div className="mt-4 px-5">
                <ColourPicker
                  value={colour}
                  disabled={!allow || busy || !session}
                  caption={allow ? "Sent when you let go" : "Allow changes to send it"}
                  onChange={(c, done) => {
                    setColour(c);
                    if (done) void send(c);
                  }}
                />
              </div>
            </Card>
            {allow && session && channels.some((ch) => session.previous(ch)) && (
              <button onClick={() => void send(null)} disabled={busy} className="flex items-center gap-1.5 self-start px-1 text-[12.5px] text-muted-foreground transition-colors hover:text-foreground">
                <ArrowCounterClockwise size={13} /> Put back the colour sent before the last one
              </button>
            )}
            <SubHead>About this hub</SubHead>
            <p className="px-1 text-[12px] leading-relaxed text-muted-foreground/80">
              Before the first change SYNQ keeps everything the hub reported{session?.backup ? `, in ${session.backup}` : ""}. It never sends fan or pump speeds, effects, firmware or setup
              commands.
            </p>
          </>
        )}
      </div>
    </DeviceFrame>
  );
}
