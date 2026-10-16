// A Flydigi Apex 4's four profile slots (wave C3), in D-input mode: title, stick curves and dead zones, vibration on
// or off, the gamepad key map. Experimental: changes go out only while "Allow changes" is on, after a full backup;
// Save writes the slot and saves it to the pad's flash (nothing is saved otherwise), then reads it back. Macros,
// turbo and keyboard mappings set in Space Station are kept as they are.
import { useEffect, useMemo, useState } from "react";
import { PencilSimple } from "@phosphor-icons/react";
import { cn } from "@/lib/utils";
import { backend } from "@/lib/backend";
import { Card, CardHeader, ToggleCard, type Notice } from "@/components/ui/matte";
import { Banner } from "@/components/keyboard/parts";
import type { PadLink } from "@/lib/controllers/link";
import { FD_CURVES, FD_IDENTITY, FD_KEYS, checkFlydigiEdit, fdEditable, type FdProfile } from "@/lib/controllers/flydigi";
import { FlydigiSession } from "@/lib/controllers/flydigi-session";
import { ActionButton } from "./parts";

type Notify = (n: Omit<Notice, "id">, key?: string) => void;
const err = (e: unknown) => String(e).replace(/^(Fd)?(Refused)?Error: /, "");
const copy = (p: FdProfile): FdProfile => ({ ...p, keys: [...p.keys], turbo: [...p.turbo], sticks: [{ ...p.sticks[0] }, { ...p.sticks[1] }] });
const panel = "rounded-2xl bg-white/[0.02] p-3.5 ring-1 ring-white/[0.06]";
const keyName = (t: number, own: number) => (t === FD_IDENTITY || t === own ? "Own function" : (FD_KEYS.find((k) => k.id === t)?.name ?? `0x${t.toString(16)}`));

export function FlydigiSettingsTab({ link, notify }: { link: PadLink; notify: Notify }) {
  const [allow, setAllow] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [slot, setSlot] = useState(0);
  const [edit, setEdit] = useState<FdProfile | null>(null);
  const allowRef = useMemo(() => ({ on: false }), []);
  allowRef.on = allow;
  const session = useMemo(() => (link.hid ? new FlydigiSession({ device: link.hid, save: (prefix, json) => backend.padBackupSave(prefix, json), allowWrites: () => allowRef.on }) : null), [link, allowRef]);

  useEffect(() => {
    if (!session) return;
    let live = true;
    session.read().then(
      () => {
        if (!live) return;
        setEdit(copy(session.profiles[0]));
        setReady(true);
      },
      (e) => live && setProblem(err(e)),
    );
    return () => {
      live = false;
      session.close();
    };
  }, [session]);

  if (!session) return <Banner>The Flydigi's settings are read through its D-input config channel.</Banner>;
  if (problem) return <Banner>{problem}</Banner>;
  if (!ready || !edit) return <Banner tone="info">Reading the four profile slots…</Banner>;

  const profiles = session.profiles;
  const pick = (s: number) => {
    setSlot(s);
    setEdit(copy(profiles[s]));
  };
  const set = (f: (p: FdProfile) => void) =>
    setEdit((cur) => {
      if (!cur) return cur;
      const next = copy(cur);
      f(next);
      return next;
    });
  const run = async (what: string, f: () => Promise<unknown>) => {
    setBusy(what);
    try {
      await f();
      setEdit(copy(session.profiles[slot]));
      notify({ tone: "ok", title: what, detail: session.backup ? `Saved to the pad's flash and read back. Backup: ${session.backup.where}` : "Saved to the pad's flash and read back." });
    } catch (e) {
      notify({ tone: "error", title: `${what} didn't go through`, detail: err(e) });
    } finally {
      setBusy(null);
    }
  };
  const invalid = checkFlydigiEdit(edit);
  const info = session.info!;

  return (
    <>
      <Banner tone="info">
        Experimental: built from an open-source Apex 4 app (MIT) and not yet tried by SYNQ on a real pad. Nothing is written until you turn on Allow changes; SYNQ then keeps a backup of
        all four slots first, saves a slot to the pad's flash only when you press Save, and reads it back. Macros, turbo and keyboard mappings from Space Station are kept.
      </Banner>
      {!session.writable && <Banner>This Flydigi (device id {info.deviceId}) is read here only: SYNQ writes to the Apex 4 its source was checked on (device id 84).</Banner>}
      <Card innerClassName="px-2 py-1">
        <ToggleCard icon={PencilSimple} title="Allow changes" status={allow ? "On: Save writes a slot and saves it on the pad (after a backup)" : "Off: SYNQ only reads the slots"} checked={allow} onCheckedChange={setAllow} />
      </Card>
      <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))" }} data-testid="fd-slots">
        {profiles.map((p) => (
          <button
            key={p.slot}
            type="button"
            onClick={() => pick(p.slot)}
            data-testid={`fd-slot-${p.slot}`}
            className={cn("min-w-0 rounded-2xl px-4 py-3.5 text-left ring-1 transition-colors duration-300", p.slot === slot ? "bg-primary/[0.08] ring-primary/40" : "bg-white/[0.025] ring-white/[0.06] hover:bg-white/[0.045]")}
          >
            <p className="text-[11.5px] text-muted-foreground">Slot {p.slot + 1}</p>
            <p className="mt-1 truncate text-[15px] text-foreground">{p.title || `Slot ${p.slot + 1}`}</p>
            <p className="mt-1 truncate text-[11.5px] text-muted-foreground/90">
              {p.keys.filter((k, i) => i < 24 && k !== FD_IDENTITY && k !== i).length} remapped · vibration {p.vibration ? "on" : "off"}
            </p>
          </button>
        ))}
      </div>

      <Card innerClassName="px-5 pb-5">
        <CardHeader title={edit.title || `Slot ${slot + 1}`} hint="Changes are made here first; Save writes the slot, saves it on the pad and reads it back." />
        <label className="mt-4 block max-w-sm">
          <span className="text-[12.5px] text-muted-foreground">Title</span>
          <input value={edit.title} maxLength={10} onChange={(e) => set((p) => (p.title = e.target.value))} className="mt-1.5 w-full rounded-xl bg-white/[0.04] px-3 py-2 text-[13.5px] text-foreground ring-1 ring-white/[0.1] outline-none focus:ring-primary/50" />
        </label>
        <div className="mt-5 grid gap-5" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))" }}>
          {(["Left stick", "Right stick"] as const).map((name, i) => (
            <div key={name} className={panel}>
              <p className="text-[13px] text-foreground">{name}</p>
              {edit.sticks[i].curve === 3 ? (
                <p className="mt-2 text-[12px] text-muted-foreground/80">A drawn curve (set in Space Station; kept)</p>
              ) : (
                <label className="mt-2 flex items-center justify-between gap-2 text-[12px] text-muted-foreground">
                  Curve
                  <select value={edit.sticks[i].curve} onChange={(e) => set((p) => (p.sticks[i].curve = Number(e.target.value)))} className="rounded-lg bg-white/[0.04] px-2 py-1.5 text-[13px] text-foreground ring-1 ring-white/[0.1]">
                    {FD_CURVES.map((c, k) => (
                      <option key={c} value={k}>
                        {c}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <label className="mt-2 block text-[12px] text-muted-foreground">
                Dead zone <span className="tabular text-foreground">{edit.sticks[i].deadZone}</span> of 127
                <input type="range" min={0} max={127} value={edit.sticks[i].deadZone} onChange={(e) => set((p) => (p.sticks[i].deadZone = Number(e.target.value)))} className="mt-1 w-full accent-[var(--primary)]" />
              </label>
            </div>
          ))}
          <div className={panel}>
            <p className="text-[13px] text-foreground">Vibration</p>
            <button type="button" onClick={() => set((p) => (p.vibration = !p.vibration))} className={cn("mt-2 rounded-full px-3 py-1.5 text-[12.5px] ring-1", edit.vibration ? "bg-primary/[0.12] text-foreground ring-primary/40" : "bg-white/[0.04] text-muted-foreground ring-white/[0.1]")}>
              {edit.vibration ? "On" : "Off"}
            </button>
          </div>
        </div>

        <p className="mt-5 text-[13px] text-foreground">Buttons</p>
        <div className="mt-2 grid gap-2" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(190px, 1fr))" }}>
          {FD_KEYS.map((k) => {
            const t = edit.keys[k.id];
            const own = t === FD_IDENTITY || t === k.id;
            return (
              <label key={k.id} className="flex items-center justify-between gap-2 rounded-xl bg-white/[0.02] px-3 py-2 text-[12.5px] ring-1 ring-white/[0.06]">
                <span className="text-muted-foreground">{k.name}</span>
                {fdEditable(profiles[slot], k.id) ? (
                  <select value={own ? FD_IDENTITY : t} onChange={(e) => set((p) => (p.keys[k.id] = Number(e.target.value)))} className={cn("rounded-md bg-transparent text-right", own ? "text-foreground" : "text-primary")}>
                    <option value={FD_IDENTITY}>Own function</option>
                    {FD_KEYS.filter((x) => x.id !== k.id).map((x) => (
                      <option key={x.id} value={x.id}>
                        {x.name}
                      </option>
                    ))}
                  </select>
                ) : (
                  <span className="text-[12px] text-muted-foreground/80">{t === 0x20 ? "Macro" : t === 0xfe ? "Keyboard / mouse" : edit.turbo[k.id] ? `Turbo ${keyName(t, k.id)}` : keyName(t, k.id)} (kept)</span>
                )}
              </label>
            );
          })}
        </div>

        {invalid && <p className="mt-4 text-[12.5px] text-chart-3">{invalid}</p>}
        <div className="mt-5 flex flex-wrap items-center gap-2">
          <ActionButton testId="fd-save" disabled={!allow || !session.writable || !!invalid || !!busy} busy={busy === "Saved"} onClick={() => void run("Saved", () => session.write(edit))}>
            Save slot {slot + 1} to the pad
          </ActionButton>
          {session.backup && (
            <ActionButton disabled={!allow || !!busy} busy={busy === "Backup put back"} onClick={() => void run("Backup put back", () => session.restore(session.backup!.data))}>
              Put the backup back
            </ActionButton>
          )}
          {!allow && <span className="text-[12px] text-muted-foreground">Turn on Allow changes to write.</span>}
        </div>
      </Card>
      <p className="px-1 text-[12px] text-muted-foreground/80">
        Device id {info.deviceId} · firmware {info.firmware} · {info.wired ? "wired" : "wireless"}
      </p>
    </>
  );
}
