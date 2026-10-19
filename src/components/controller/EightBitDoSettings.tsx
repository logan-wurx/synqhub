// The 8BitDo Ultimate's three onboard profiles (wave C3), in its HID config mode: name, rumble, stick and trigger
// ranges, stick and trigger options, the button map. Experimental: changes go out only while "Allow changes" is on,
// after a full backup, and the whole config is read back after each save. Stick calibration is never sent.
import { useEffect, useMemo, useState } from "react";
import { PencilSimple } from "@phosphor-icons/react";
import { cn } from "@/lib/utils";
import { backend } from "@/lib/backend";
import { Card, CardHeader, ToggleCard, type Notice } from "@/components/ui/matte";
import { Banner } from "@/components/keyboard/parts";
import type { PadLink } from "@/lib/controllers/link";
import { EBD_DEFAULT_KEYS, EBD_FEATURES, EBD_INPUTS, EBD_TARGETS, checkEbdEdit, type EbdConfig, type EbdProfile } from "@/lib/controllers/eightbitdo";
import { EbdSession } from "@/lib/controllers/eightbitdo-session";
import { ActionButton } from "./parts";

type Notify = (n: Omit<Notice, "id">, key?: string) => void;
const err = (e: unknown) => String(e).replace(/^(Ebd)?(Refused)?Error: /, "");
const copy = (p: EbdProfile): EbdProfile => ({ ...p, rumble: [...p.rumble] as [number, number], sticks: [{ ...p.sticks[0] }, { ...p.sticks[1] }], triggers: [{ ...p.triggers[0] }, { ...p.triggers[1] }], keys: [...p.keys] });
const panel = "rounded-control bg-white/[0.02] p-3.5 ring-1 ring-white/[0.06]";

function Range({ label, lo, hi, value, onChange }: { label: string; lo: string; hi: string; value: { start: number; end: number }; onChange: (v: { start: number; end: number }) => void }) {
  return (
    <div className={panel}>
      <p className="text-[13px] text-high">
        {label}: <span className="tabular text-medium">{value.start} – {value.end}</span>
      </p>
      <label className="mt-2 block text-[12px] text-medium">
        {lo}
        <input type="range" min={0} max={255} value={value.start} onChange={(e) => onChange({ start: Math.min(Number(e.target.value), value.end), end: value.end })} className="mt-1 w-full accent-[var(--primary)]" />
      </label>
      <label className="mt-2 block text-[12px] text-medium">
        {hi}
        <input type="range" min={0} max={255} value={value.end} onChange={(e) => onChange({ start: value.start, end: Math.max(Number(e.target.value), value.start) })} className="mt-1 w-full accent-[var(--primary)]" />
      </label>
    </div>
  );
}

export function EightBitDoSettingsTab({ link, notify }: { link: PadLink; notify: Notify }) {
  const [allow, setAllow] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [config, setConfig] = useState<EbdConfig | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [slot, setSlot] = useState(0);
  const [edit, setEdit] = useState<EbdProfile | null>(null);
  const allowRef = useMemo(() => ({ on: false }), []);
  allowRef.on = allow;
  const session = useMemo(() => (link.hid ? new EbdSession({ device: link.hid, save: (prefix, json) => backend.padBackupSave(prefix, json), allowWrites: () => allowRef.on }) : null), [link, allowRef]);

  useEffect(() => {
    if (!session) return;
    let live = true;
    session.read().then(
      (c) => {
        if (!live) return;
        setConfig(c);
        setSlot(c.active <= 2 ? c.active : 0);
        setEdit(copy(c.profiles[c.active <= 2 ? c.active : 0]));
      },
      (e) => live && setProblem(err(e)),
    );
    return () => {
      live = false;
      session.close();
    };
  }, [session]);

  if (!session) return <Banner>The 8BitDo's settings are read through its HID config mode.</Banner>;
  if (problem) return <Banner>{problem}</Banner>;
  if (!config || !edit) return <Banner tone="info">Reading the three profiles…</Banner>;

  const pick = (s: number) => {
    setSlot(s);
    setEdit(copy(config.profiles[s]));
  };
  const set = (f: (p: EbdProfile) => void) =>
    setEdit((cur) => {
      if (!cur) return cur;
      const next = copy(cur);
      f(next);
      return next;
    });
  const run = async (what: string, f: () => Promise<EbdConfig>) => {
    setBusy(what);
    try {
      const c = await f();
      setConfig(c);
      setEdit(copy(c.profiles[slot]));
      notify({ tone: "ok", title: what, detail: session.backup ? `Read back from the pad. Backup: ${session.backup.where}` : "Read back from the pad." });
    } catch (e) {
      notify({ tone: "error", title: `${what} didn't go through`, detail: err(e) });
    } finally {
      setBusy(null);
    }
  };
  const invalid = checkEbdEdit(edit);
  const target = (bits: number) => EBD_TARGETS.find((t) => t.bits === bits);

  return (
    // Two columns on a wide window: the note, the switch and the profiles on the left, the profile being edited on the
    // right, so the whole editor is on screen at once.
    <div className="grid items-start gap-4 min-[1200px]:grid-cols-[320px_minmax(0,1fr)]">
      <div className="flex min-w-0 flex-col gap-4">
          <Banner tone="info">
            Experimental: built from an open-source 8BitDo tool (MIT) and not yet tried by SYNQ on a real Ultimate. Nothing is written until you turn on Allow changes; SYNQ then keeps a backup of
            the whole config first and reads it back after every save. Stick calibration and firmware stay with 8BitDo's own app.
          </Banner>
          {!config.crcOk && <Banner>This pad's config doesn't check out the way SYNQ expects (its layout may differ from the Ultimate's): SYNQ only shows it and writes nothing.</Banner>}
          <Card innerClassName="px-2 py-1">
            <ToggleCard icon={PencilSimple} title="Allow changes" status={allow ? "On: Save writes to the pad (after a backup)" : "Off: SYNQ only reads the profiles"} checked={allow} onCheckedChange={setAllow} />
          </Card>
          <div className="flex flex-col gap-2" data-testid="ebd-profiles">
            {config.profiles.map((p) => (
              <button
                key={p.slot}
                type="button"
                onClick={() => pick(p.slot)}
                data-testid={`ebd-profile-${p.slot}`}
                className={cn("min-w-0 rounded-control px-4 py-3.5 text-left ring-1 transition-colors duration-300", p.slot === slot ? "bg-primary/[0.08] ring-primary/40" : "bg-white/[0.025] ring-white/[0.06] hover:bg-white/[0.045]")}
              >
                <p className="text-[11.5px] text-medium">{p.slot === config.active ? "In use now" : `Profile ${p.slot + 1}`}</p>
                <p className="mt-1 truncate text-[15px] text-high">{p.name || `Profile ${p.slot + 1}`}</p>
                <p className="mt-1 truncate text-[11.5px] text-medium">
                  Rumble {Math.round(p.rumble[0] * 100)}% / {Math.round(p.rumble[1] * 100)}% · {p.keys.filter((k, i) => k !== EBD_DEFAULT_KEYS[i]).length} remapped
                </p>
              </button>
            ))}
          </div>
          {session.firmware && <p className="px-1 text-[12px] text-medium">Firmware {session.firmware}</p>}
      </div>
        <Card innerClassName="px-5 pb-5">
          <CardHeader title={edit.name || `Profile ${slot + 1}`} hint="Changes are made here first; Save writes the whole config to the pad and reads it back." />
          <label className="mt-4 block max-w-sm">
            <span className="text-[12.5px] text-medium">Name</span>
            <input value={edit.name} maxLength={32} onChange={(e) => set((p) => (p.name = e.target.value))} className="mt-1.5 w-full rounded-control bg-white/[0.04] px-3 py-2 text-[13.5px] text-high ring-1 ring-white/[0.1] outline-none focus:ring-primary/50" />
          </label>
          <div className="mt-5 grid gap-4" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))" }}>
            <div className={panel}>
              <p className="text-[13px] text-high">Rumble</p>
              {(["Left motor", "Right motor"] as const).map((label, i) => (
                <label key={label} className="mt-2 block text-[12px] text-medium">
                  {label} <span className="tabular text-high">{Math.round(edit.rumble[i] * 100)}%</span>
                  <input type="range" min={0} max={100} value={Math.round(edit.rumble[i] * 100)} onChange={(e) => set((p) => (p.rumble[i] = Number(e.target.value) / 100))} className="mt-1 w-full accent-[var(--primary)]" />
                </label>
              ))}
            </div>
            <Range label="Left stick" lo="Dead zone" hi="Full at" value={edit.sticks[0]} onChange={(v) => set((p) => (p.sticks[0] = v))} />
            <Range label="Right stick" lo="Dead zone" hi="Full at" value={edit.sticks[1]} onChange={(v) => set((p) => (p.sticks[1] = v))} />
            <Range label="LT" lo="Starts at" hi="Full at" value={edit.triggers[0]} onChange={(v) => set((p) => (p.triggers[0] = v))} />
            <Range label="RT" lo="Starts at" hi="Full at" value={edit.triggers[1]} onChange={(v) => set((p) => (p.triggers[1] = v))} />
          </div>

          <p className="mt-5 text-[13px] text-high">Options</p>
          <div className="mt-2 flex flex-wrap gap-2">
            {EBD_FEATURES.map((f) => {
              const on = (edit.features & f.bit) !== 0;
              return (
                <button
                  key={f.bit}
                  type="button"
                  onClick={() => set((p) => (p.features = on ? p.features & ~f.bit : p.features | f.bit))}
                  className={cn("rounded-full px-3 py-1.5 text-[12.5px] ring-1", on ? "bg-primary/[0.12] text-high ring-primary/40" : "bg-white/[0.04] text-medium ring-white/[0.1] hover:bg-white/[0.08]")}
                >
                  {f.name}
                </button>
              );
            })}
          </div>

          <p className="mt-5 text-[13px] text-high">Buttons</p>
          <div className="mt-2 grid gap-2" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(190px, 1fr))" }}>
            {EBD_INPUTS.map((input, i) => {
              const t = target(edit.keys[i]);
              return (
                <label key={input} className="flex items-center justify-between gap-2 rounded-small bg-white/[0.02] px-3 py-2 text-[12.5px] ring-1 ring-white/[0.06]">
                  <span className="text-medium">{input}</span>
                  {t ? (
                    <select value={t.bits} onChange={(e) => set((p) => (p.keys[i] = Number(e.target.value)))} className={cn("rounded-tight bg-transparent text-right", t.name !== input ? "text-primary" : "text-high")}>
                      {EBD_TARGETS.map((x) => (
                        <option key={x.name} value={x.bits}>
                          {x.name}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <span className="text-[12px] text-medium">{input === "P1" || input === "P2" || input === "Star" ? "Its own function" : "Set in 8BitDo's app"} (kept)</span>
                  )}
                </label>
              );
            })}
          </div>

          {invalid && <p className="mt-4 text-[12.5px] text-chart-3">{invalid}</p>}
          <div className="mt-5 flex flex-wrap items-center gap-2">
            <ActionButton testId="ebd-save" disabled={!allow || !config.crcOk || !!invalid || !!busy} busy={busy === "Saved"} onClick={() => void run("Saved", () => session.write(edit))}>
              Save profile {slot + 1}
            </ActionButton>
            {session.backup && (
              <ActionButton disabled={!allow || !!busy} busy={busy === "Backup put back"} onClick={() => void run("Backup put back", () => session.restore(session.backup!.data))}>
                Put the backup back
              </ActionButton>
            )}
            {!allow && <span className="text-[12px] text-medium">Turn on Allow changes to write.</span>}
          </div>
        </Card>
    </div>
  );
}
