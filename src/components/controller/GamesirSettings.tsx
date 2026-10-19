// GameSir's settings (wave C2): the Cyclone 2, the G7 Pro 8K PC and the Tarantula Pro 8K. The four profiles as the pad
// keeps them, an editor for one (vibration, report rate, dead zones, stick shape, the Cyclone's curve presets, button
// remaps to gamepad buttons) and the lighting. Experimental: changes go out only while "Allow changes" is on, after a
// full backup, and each is read back. A setting GameSir's own app put on a keyboard key, a macro or a drawn curve is
// shown and kept as it is: SYNQ only writes what it could put back.
import { useEffect, useMemo, useReducer, useState } from "react";
import { PencilSimple } from "@phosphor-icons/react";
import { cn } from "@/lib/utils";
import { backend } from "@/lib/backend";
import { Card, CardHeader, ToggleCard, type Notice } from "@/components/ui/matte";
import { Banner } from "@/components/keyboard/parts";
import type { PadLink } from "@/lib/controllers/link";
import { GAMESIR_GUARDS } from "@/lib/controllers/guard";
import {
  G7_8K_LIGHT_MODES,
  GAMESIR_CURVES,
  GAMESIR_MAPS,
  GAMESIR_TARGETS,
  LIGHT_BANK,
  curvePreset,
  deadzoneBytes,
  deadzoneValues,
  fieldBytes,
  gamesirAccepts,
  remapBytes,
  remapTarget,
  type Field,
  type GamesirModel,
} from "@/lib/controllers/gamesir";
import { GamesirSession, type GamesirChange } from "@/lib/controllers/gamesir-session";
import { ActionButton } from "./parts";

type Notify = (n: Omit<Notice, "id">, key?: string) => void;
const err = (e: unknown) => String(e).replace(/^(Gamesir)?(Refused)?Error: /, "");
const PROFILES = [1, 2, 3, 4] as const;
const select = "rounded-small bg-white/[0.04] px-2 py-1.5 text-[13px] text-high ring-1 ring-white/[0.1]";
const panel = "rounded-control bg-white/[0.02] p-3.5 ring-1 ring-white/[0.06]";

/** What a remap record holds, in words. */
function targetName(bytes: readonly number[]): string {
  const t = remapTarget(bytes);
  if (t === null) return "Default";
  return GAMESIR_TARGETS.find((x) => x.code === t)?.name ?? `code 0x${t.toString(16)}`;
}

function Kept({ what }: { what: string }) {
  return <span className="text-[12px] text-medium">{what} (set in GameSir's app; kept)</span>;
}

function Slider({ label, value, onChange, disabled }: { label: string; value: number; onChange: (v: number) => void; disabled?: boolean }) {
  return (
    <label className="mt-2 block text-[12px] text-medium">
      {label} <span className="tabular text-high">{Number.isInteger(value) ? value : value.toFixed(1)}%</span>
      <input type="range" min={0} max={100} step={1} value={value} disabled={disabled} onChange={(e) => onChange(Number(e.target.value))} className="mt-1 w-full accent-[var(--primary)]" />
    </label>
  );
}

export function GamesirSettingsTab({ link, notify }: { link: PadLink; notify: Notify }) {
  const model = GAMESIR_GUARDS[link.identity.guard] as GamesirModel;
  const map = GAMESIR_MAPS[model];
  const [allow, setAllow] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [profile, setProfile] = useState(1);
  const [draft, setDraft] = useState<Map<string, number[]>>(new Map());
  const [, redraw] = useReducer((x: number) => x + 1, 0);
  const allowRef = useMemo(() => ({ on: false }), []);
  allowRef.on = allow;
  const session = useMemo(
    () => (link.hid ? new GamesirSession({ device: link.hid, model, save: (prefix, json) => backend.padBackupSave(prefix, json), allowWrites: () => allowRef.on }) : null),
    [link, model, allowRef],
  );

  useEffect(() => {
    if (!session) return;
    let live = true;
    session.read().then(
      () => {
        if (!live) return;
        setProfile(session.active);
        setReady(true);
      },
      (e) => live && setProblem(err(e)),
    );
    return () => {
      live = false;
    };
  }, [session]);

  if (!session) return <Banner>GameSir settings are read through the pad's HID settings channel.</Banner>;
  if (problem) return <Banner>{problem}</Banner>;
  if (!ready) return <Banner tone="info">Reading the four profiles and the lighting…</Banner>;

  const fields = session.fields;
  const field = (name: string) => fields.find((f) => f.name === name);
  const image = (bank: number) => session.images.get(bank) ?? new Uint8Array(0);
  const key = (bank: number, f: Field) => `${bank}:${f.name}`;
  const value = (bank: number, f: Field) => draft.get(key(bank, f)) ?? fieldBytes(image(bank), f);
  const editable = (bank: number, f: Field) => gamesirAccepts(model, f, fieldBytes(image(bank), f));
  const put = (bank: number, f: Field, bytes: number[]) =>
    setDraft((d) => {
      const next = new Map(d);
      const same = bytes.every((v, i) => v === image(bank)[f.at + i]);
      if (same) next.delete(key(bank, f));
      else next.set(key(bank, f), bytes);
      return next;
    });
  const changesOf = (bank: number): GamesirChange[] => fields.filter((f) => draft.has(key(bank, f))).map((f) => ({ field: f, bytes: draft.get(key(bank, f))! }));
  const run = async (what: string, f: () => Promise<string | void>) => {
    setBusy(what);
    try {
      const extra = await f();
      notify({ tone: "ok", title: what, detail: [extra, session.backup ? `Read back from the pad. Backup: ${session.backup.where}` : "Read back from the pad."].filter(Boolean).join(" ") });
    } catch (e) {
      notify({ tone: "error", title: `${what} didn't go through`, detail: err(e) });
    } finally {
      setBusy(null);
      redraw();
    }
  };
  const save = (bank: number) =>
    run(bank === LIGHT_BANK ? "Lighting saved" : `Profile ${bank} saved`, async () => {
      const r = await session.write(bank, changesOf(bank));
      setDraft((d) => new Map([...d].filter(([k]) => !k.startsWith(`${bank}:`))));
      if (r.reconnecting) return "The pad is reconnecting at its new report rate: open it again to check the rate in Polling.";
      if (r.rateChanged) return "The report rate changed; some pads reconnect when it does.";
    });

  const summary = (p: number) => {
    const rate = field("report rate");
    const hz = rate ? map.pollRates[fieldBytes(image(p), rate)[0]] : undefined;
    const remapped = fields.filter((f) => f.kind === "remap" && remapTarget(fieldBytes(image(p), f)) !== null).length;
    return [hz ? `${hz} Hz` : null, remapped ? `${remapped} remapped` : "no remaps"].filter(Boolean).join(" · ");
  };

  const bank = profile;
  const pending = changesOf(bank).length;
  const lightPending = changesOf(LIGHT_BANK).length;
  const vib = field("vibration");
  const rate = field("report rate");
  const sticks = [
    { name: "Left stick", traj: field("left stick trajectory"), dz: field("left stick dead zone"), curve: field("left stick curve") },
    { name: "Right stick", traj: field("right stick trajectory"), dz: field("right stick dead zone"), curve: field("right stick curve") },
  ];
  const triggers = [
    { name: "LT", dz: field("LT dead zone"), curve: field("LT curve") },
    { name: "RT", dz: field("RT dead zone"), curve: field("RT curve") },
  ];
  const remaps = fields.filter((f) => f.kind === "remap");

  const curveSelect = (f: Field | undefined) => {
    if (!f) return null;
    const bytes = value(bank, f);
    const preset = curvePreset(bytes);
    if (!editable(bank, f)) return <Kept what="A drawn curve" />;
    return (
      <label className="mt-2 flex items-center justify-between gap-2 text-[12px] text-medium">
        Curve
        <select value={preset} onChange={(e) => put(bank, f, [...GAMESIR_CURVES[Number(e.target.value)].block])} className={select}>
          {GAMESIR_CURVES.map((c, i) => (
            <option key={c.name} value={i}>
              {c.name}
            </option>
          ))}
        </select>
      </label>
    );
  };
  const deadzone = (f: Field | undefined, labels: [string, string]) => {
    if (!f) return null;
    if (!editable(bank, f)) return <Kept what="Dead zones" />;
    const v = deadzoneValues(f, value(bank, f));
    const set = (i: number, x: number) => put(bank, f, deadzoneBytes(f, v.map((y, j) => (j === i ? x : y))));
    return (
      <>
        <Slider label={labels[0]} value={v[0]} onChange={(x) => set(0, Math.min(x, v[1]))} />
        <Slider label={labels[1]} value={v[1]} onChange={(x) => set(1, Math.max(x, v[0]))} />
      </>
    );
  };

  return (
    // Two columns on a wide window: the note, the switch and the profiles on the left, the one being edited on the right.
    <div className="grid items-start gap-4 min-[1200px]:grid-cols-[320px_minmax(0,1fr)]">
      <div className="flex min-w-0 flex-col gap-4">
          <Banner tone="info">
            Experimental: built from open-source GameSir tools (MIT) and not yet tried by SYNQ on a real {map.name}. Nothing is written until you turn on Allow changes; SYNQ then keeps a
            backup of all four profiles and the lighting first, and reads every change back. Settings GameSir's own app put on keyboard keys, macros or drawn curves are kept as they are.
          </Banner>
          <Card innerClassName="px-2 py-1">
            <ToggleCard icon={PencilSimple} title="Allow changes" status={allow ? "On: Save writes to the pad (after a backup)" : "Off: SYNQ only reads the settings"} checked={allow} onCheckedChange={setAllow} />
          </Card>
          <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))" }} data-testid="gamesir-profiles">
            {PROFILES.map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => setProfile(p)}
                data-testid={`gamesir-profile-${p}`}
                className={cn("min-w-0 rounded-control px-4 py-3.5 text-left ring-1 transition-colors duration-300", p === profile ? "bg-primary/[0.08] ring-primary/40" : "bg-white/[0.025] ring-white/[0.06] hover:bg-white/[0.045]")}
              >
                <p className="text-[11.5px] text-medium">{p === session.active ? "In use now" : "Stored"}</p>
                <p className="mt-1 text-[15px] text-high">Profile {p}</p>
                <p className="mt-1 truncate text-[11.5px] text-medium">{summary(p)}</p>
              </button>
            ))}
          </div>
      </div>
      <div className="flex min-w-0 flex-col gap-4">
          <Card innerClassName="px-5 pb-5">
            <CardHeader title={`Profile ${bank}${bank === session.active ? " (in use now)" : ""}`} hint={bank === session.active ? "Changes are made here first; Save writes them to the pad." : "Saving switches the pad to this profile for the write, then back."} />
            <div className="mt-4 grid gap-5" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))" }}>
              {vib && (
                <div className={panel}>
                  <p className="text-[13px] text-high">Vibration</p>
                  {editable(bank, vib) ? (
                    (["Left motor", "Right motor"] as const).map((label, i) => (
                      <Slider key={label} label={label} value={value(bank, vib)[i]} onChange={(x) => put(bank, vib, value(bank, vib).map((y, j) => (j === i ? x : y)))} />
                    ))
                  ) : (
                    <Kept what="Vibration" />
                  )}
                </div>
              )}
              {rate && (
                <div className={panel}>
                  <p className="text-[13px] text-high">Report rate</p>
                  <select value={value(bank, rate)[0]} onChange={(e) => put(bank, rate, [Number(e.target.value)])} className={cn(select, "mt-2 w-full")} disabled={!editable(bank, rate)}>
                    {map.pollRates.map((hz, code) => (
                      <option key={hz} value={code}>
                        {hz} Hz
                      </option>
                    ))}
                  </select>
                  <p className="mt-2 text-[11.5px] text-medium">Some pads reconnect when this changes.</p>
                </div>
              )}
            </div>

            <div className="mt-5 grid gap-5" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))" }}>
              {sticks.map((s) => (
                <div key={s.name} className={panel}>
                  <p className="text-[13px] text-high">{s.name}</p>
                  {s.traj && (
                    <label className="mt-2 flex items-center justify-between gap-2 text-[12px] text-medium">
                      Shape
                      <select value={value(bank, s.traj)[0]} onChange={(e) => put(bank, s.traj!, [Number(e.target.value)])} className={select} disabled={!editable(bank, s.traj)}>
                        <option value={0}>Circle</option>
                        <option value={1}>Raw</option>
                      </select>
                    </label>
                  )}
                  {deadzone(s.dz, ["Dead zone", "Full at"])}
                  {curveSelect(s.curve)}
                </div>
              ))}
              {triggers.map((t) => (
                <div key={t.name} className={panel}>
                  <p className="text-[13px] text-high">{t.name}</p>
                  {deadzone(t.dz, ["Starts at", "Full at"])}
                  {curveSelect(t.curve)}
                </div>
              ))}
            </div>

            <p className="mt-5 text-[13px] text-high">Buttons</p>
            <div className="mt-2 grid gap-2" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(190px, 1fr))" }}>
              {remaps.map((f) => {
                const bytes = value(bank, f);
                const t = remapTarget(bytes);
                return (
                  <label key={f.name} className="flex items-center justify-between gap-2 rounded-small bg-white/[0.02] px-3 py-2 text-[12.5px] ring-1 ring-white/[0.06]">
                    <span className="text-medium">{f.name.replace(/ remap$/, "")}</span>
                    {editable(bank, f) ? (
                      <select value={t === null ? "" : String(t)} onChange={(e) => put(bank, f, remapBytes(e.target.value === "" ? null : Number(e.target.value)))} className={cn("rounded-tight bg-transparent text-right", t !== null ? "text-primary" : "text-high")}>
                        <option value="">Default</option>
                        {GAMESIR_TARGETS.map((x) => (
                          <option key={x.code} value={x.code}>
                            {x.name}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <Kept what={targetName(bytes)} />
                    )}
                  </label>
                );
              })}
            </div>

            <div className="mt-5 flex flex-wrap items-center gap-2">
              <ActionButton testId="gamesir-save" disabled={!allow || !pending || !!busy} busy={busy === `Profile ${bank} saved`} onClick={() => void save(bank)}>
                Save to profile {bank}
                {pending ? ` (${pending})` : ""}
              </ActionButton>
              {pending > 0 && (
                <ActionButton disabled={!!busy} onClick={() => setDraft((d) => new Map([...d].filter(([k]) => !k.startsWith(`${bank}:`))))}>
                  Undo edits
                </ActionButton>
              )}
              {session.backup && (
                <ActionButton
                  disabled={!allow || !!busy}
                  busy={busy === "Backup put back"}
                  onClick={() =>
                    void run("Backup put back", async () => {
                      const r = await session.restore(session.backup!.data);
                      setDraft(new Map());
                      return r.kept.length ? `Left as they are: ${r.kept.join(", ")}.` : undefined;
                    })
                  }
                >
                  Put the backup back
                </ActionButton>
              )}
              {!allow && <span className="text-[12px] text-medium">Turn on Allow changes to write.</span>}
            </div>
          </Card>

          {map.light && (
            <Card innerClassName="px-5 pb-5">
              <CardHeader title="Lighting" hint="Kept by the pad for every profile." />
              <div className="mt-4 flex flex-wrap items-end gap-4">
                {map.light.kind === "slot" &&
                  (() => {
                    const f = field("lighting effect")!;
                    const v = value(LIGHT_BANK, f)[0];
                    return editable(LIGHT_BANK, f) ? (
                      <div className="flex flex-wrap gap-2" data-testid="gamesir-light">
                        {[0, 1, 2, 3].map((slot) => (
                          <button
                            key={slot}
                            type="button"
                            onClick={() => put(LIGHT_BANK, f, [slot])}
                            className={cn("rounded-full px-3 py-1.5 text-[12.5px] ring-1", slot === v ? "bg-primary/[0.12] text-high ring-primary/40" : "bg-white/[0.04] text-medium ring-white/[0.1] hover:bg-white/[0.08]")}
                          >
                            Effect {slot + 1}
                          </button>
                        ))}
                      </div>
                    ) : (
                      <Kept what="Lighting effect" />
                    );
                  })()}
                {map.light.kind === "mode" &&
                  (() => {
                    const mode = field("lighting mode")!;
                    const bright = field("lighting brightness")!;
                    return (
                      <div className="grid w-full gap-3" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))" }} data-testid="gamesir-light">
                        {editable(LIGHT_BANK, mode) ? (
                          <label className="flex items-center justify-between gap-2 text-[12.5px] text-medium">
                            Mode
                            <select value={value(LIGHT_BANK, mode)[0]} onChange={(e) => put(LIGHT_BANK, mode, [Number(e.target.value)])} className={select}>
                              {G7_8K_LIGHT_MODES.map((l) => (
                                <option key={l.code} value={l.code}>
                                  {l.name}
                                </option>
                              ))}
                            </select>
                          </label>
                        ) : (
                          <Kept what="Lighting mode" />
                        )}
                        {editable(LIGHT_BANK, bright) ? <Slider label="Brightness" value={value(LIGHT_BANK, bright)[0]} onChange={(x) => put(LIGHT_BANK, bright, [x])} /> : <Kept what="Brightness" />}
                      </div>
                    );
                  })()}
              </div>
              <div className="mt-4 flex flex-wrap items-center gap-2">
                <ActionButton testId="gamesir-light-save" disabled={!allow || !lightPending || !!busy} busy={busy === "Lighting saved"} onClick={() => void save(LIGHT_BANK)}>
                  Save lighting
                </ActionButton>
              </div>
            </Card>
          )}
          {session.firmware && <p className="px-1 text-[12px] text-medium">Firmware {session.firmware.controller}{session.firmware.dongle ? ` · receiver ${session.firmware.dongle}` : ""}</p>}
      </div>
    </div>
  );
}
