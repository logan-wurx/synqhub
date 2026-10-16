// The DualSense Edge's onboard profiles (wave C2): the four slots as the pad keeps them, and an editor for the three
// custom ones (name, stick curves, trigger ranges, button map). Experimental: changes go out only while "Allow changes"
// is on, after a full backup, and every write is read back. The default profile (Triangle) is never changed. USB only.
import { useEffect, useMemo, useState } from "react";
import { PencilSimple } from "@phosphor-icons/react";
import { cn } from "@/lib/utils";
import { backend } from "@/lib/backend";
import { Card, CardHeader, ToggleCard, type Notice } from "@/components/ui/matte";
import { Banner } from "@/components/keyboard/parts";
import type { PadLink } from "@/lib/controllers/link";
import { EDGE_ADJUST_MAX, EDGE_BUTTONS, EDGE_CURVES, EDGE_INPUTS, EDGE_LABEL_MAX, checkEdgeEdit, edgeCurve, type EdgeEdit, type EdgeProfile } from "@/lib/controllers/edge";
import { EdgeSession } from "@/lib/controllers/edge-session";
import { ActionButton } from "./parts";

type Notify = (n: Omit<Notice, "id">, key?: string) => void;
const err = (e: unknown) => String(e).replace(/^(Edge)?(Refused)?Error: /, "");

const editOf = (p: EdgeProfile): EdgeEdit => ({
  label: p.empty ? `Profile ${p.slot.button}` : p.label,
  sticks: [
    { preset: p.sticks[0].preset, step: p.sticks[0].step ?? 0 },
    { preset: p.sticks[1].preset, step: p.sticks[1].step ?? 0 },
  ],
  triggers: [{ ...p.triggers[0] }, { ...p.triggers[1] }],
  buttons: [...p.buttons],
});

/** A stick curve: its six points as a line (input left to right, output bottom to top). */
function CurvePreview({ preset, step }: { preset: number; step: number }) {
  const pts = edgeCurve(preset, step);
  // Three (input, output) pairs from the six bytes, from the centre out.
  const pairs = [0, 2, 4].map((i) => [pts[i] / 255, pts[i + 1] / 255]);
  const line = [[0, 0], ...pairs, [1, 1]].map(([x, y]) => `${8 + x * 104},${112 - y * 104}`).join(" ");
  return (
    <svg viewBox="0 0 120 120" className="size-[96px] shrink-0" aria-hidden="true">
      <rect x="8" y="8" width="104" height="104" rx="6" fill="rgb(255 255 255 / 0.02)" stroke="rgb(255 255 255 / 0.08)" />
      <polyline points={line} fill="none" stroke="var(--primary)" strokeWidth="2" strokeLinejoin="round" />
    </svg>
  );
}

function SlotCard({ p, selected, onSelect }: { p: EdgeProfile; selected: boolean; onSelect: () => void }) {
  const remapped = p.buttons.filter((b, i) => b !== i).length;
  return (
    <button
      type="button"
      onClick={onSelect}
      disabled={p.slot.protected}
      data-testid={`edge-slot-${p.slot.slot}`}
      className={cn(
        "min-w-0 rounded-2xl px-4 py-3.5 text-left ring-1 transition-colors duration-300",
        selected ? "bg-primary/[0.08] ring-primary/40" : "bg-white/[0.025] ring-white/[0.06] hover:bg-white/[0.045]",
        p.slot.protected && "cursor-default",
      )}
    >
      <p className="text-[11.5px] text-muted-foreground">Fn + {p.slot.button}</p>
      <p className="mt-1 truncate text-[15px] text-foreground">{p.slot.protected ? `${p.label || "Default"} (default)` : p.empty ? "Empty" : p.label}</p>
      <p className="mt-1 truncate text-[11.5px] text-muted-foreground/90">
        {p.empty ? "No profile in this slot" : `${EDGE_CURVES[p.sticks[0].preset]?.name} / ${EDGE_CURVES[p.sticks[1].preset]?.name} · L2 ${p.triggers[0].min}–${p.triggers[0].max} · R2 ${p.triggers[1].min}–${p.triggers[1].max}${remapped ? ` · ${remapped} remapped` : ""}`}
      </p>
      {p.slot.protected && <p className="mt-1 text-[11px] text-muted-foreground/80">SYNQ never changes the default.</p>}
    </button>
  );
}

export function EdgeProfilesTab({ link, notify }: { link: PadLink; notify: Notify }) {
  const [allow, setAllow] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [profiles, setProfiles] = useState<EdgeProfile[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [slot, setSlot] = useState<1 | 2 | 3>(1);
  const [edit, setEdit] = useState<EdgeEdit | null>(null);
  const allowRef = useMemo(() => ({ on: false }), []);
  allowRef.on = allow;
  const session = useMemo(
    () => (link.hid ? new EdgeSession({ device: link.hid, link: link.info.link === "bt" ? "bt" : "usb", save: (prefix, json) => backend.padBackupSave(prefix, json), allowWrites: () => allowRef.on }) : null),
    [link, allowRef],
  );

  useEffect(() => {
    if (!session) return;
    let live = true;
    session.read().then(
      (p) => {
        if (!live) return;
        setProfiles(p);
        setEdit(editOf(p[1]));
      },
      (e) => live && setProblem(err(e)),
    );
    return () => {
      live = false;
    };
  }, [session]);

  if (!session) return <Banner>The Edge's profiles are read through its HID connection.</Banner>;
  if (problem) return <Banner>{problem}</Banner>;
  if (!profiles || !edit) return <Banner tone="info">Reading the four profile slots…</Banner>;

  const pick = (s: 1 | 2 | 3) => {
    setSlot(s);
    setEdit(editOf(profiles[s]));
  };
  const run = async (what: string, f: () => Promise<void>) => {
    setBusy(what);
    try {
      await f();
      setProfiles([...session.profiles]);
      notify({ tone: "ok", title: what, detail: session.backup ? `Read back from the pad. Backup: ${session.backup.where}` : "Read back from the pad." });
    } catch (e) {
      setProfiles([...session.profiles]);
      notify({ tone: "error", title: `${what} didn't go through`, detail: err(e) });
    } finally {
      setBusy(null);
    }
  };
  const invalid = checkEdgeEdit(edit);
  const set = (f: (e: EdgeEdit) => void) =>
    setEdit((cur) => {
      if (!cur) return cur;
      const next: EdgeEdit = { label: cur.label, sticks: [{ ...cur.sticks[0] }, { ...cur.sticks[1] }], triggers: [{ ...cur.triggers[0] }, { ...cur.triggers[1] }], buttons: [...cur.buttons] };
      f(next);
      return next;
    });
  const target = profiles[slot];

  return (
    <>
      <Banner tone="info">
        Experimental: built from an open-source Edge profile app (MIT) and not yet tried by SYNQ on a real Edge. Nothing is written until you turn on Allow changes;
        SYNQ then keeps a backup of all four slots first and reads every change back. Profiles are read and written over USB only.
      </Banner>
      <Card innerClassName="px-2 py-1">
        <ToggleCard icon={PencilSimple} title="Allow changes" status={allow ? "On: Save writes to the pad (after a backup)" : "Off: SYNQ only reads the profiles"} checked={allow} onCheckedChange={setAllow} />
      </Card>
      <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))" }} data-testid="edge-slots">
        {profiles.map((p) => (
          <SlotCard key={p.slot.slot} p={p} selected={p.slot.slot === slot} onSelect={() => !p.slot.protected && pick(p.slot.slot as 1 | 2 | 3)} />
        ))}
      </div>

      <Card innerClassName="px-5 pb-5">
        <CardHeader title={`Fn + ${target.slot.button}: ${target.empty ? "new profile" : target.label}`} hint="Changes are made here first; Save writes them to the pad." />
        <label className="mt-4 block max-w-sm">
          <span className="text-[12.5px] text-muted-foreground">Name</span>
          <input
            value={edit.label}
            maxLength={EDGE_LABEL_MAX}
            onChange={(e) => set((x) => (x.label = e.target.value))}
            className="mt-1.5 w-full rounded-xl bg-white/[0.04] px-3 py-2 text-[13.5px] text-foreground ring-1 ring-white/[0.1] outline-none focus:ring-primary/50"
          />
        </label>

        <div className="mt-5 grid gap-5" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))" }}>
          {(["Left stick", "Right stick"] as const).map((name, i) => (
            <div key={name} className="flex items-center gap-4 rounded-2xl bg-white/[0.02] p-3.5 ring-1 ring-white/[0.06]">
              <CurvePreview preset={edit.sticks[i].preset} step={edit.sticks[i].step} />
              <div className="min-w-0 flex-1">
                <p className="text-[13px] text-foreground">{name}</p>
                <select
                  value={edit.sticks[i].preset}
                  onChange={(e) => set((x) => (x.sticks[i] = { preset: Number(e.target.value), step: Number(e.target.value) === 0 ? 0 : x.sticks[i].step }))}
                  className="mt-1.5 w-full rounded-lg bg-white/[0.04] px-2 py-1.5 text-[13px] text-foreground ring-1 ring-white/[0.1]"
                >
                  {EDGE_CURVES.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
                <label className="mt-2 block text-[12px] text-muted-foreground">
                  Adjustment {edit.sticks[i].step} of {EDGE_ADJUST_MAX}
                  <input
                    type="range"
                    min={0}
                    max={EDGE_ADJUST_MAX}
                    disabled={edit.sticks[i].preset === 0}
                    value={edit.sticks[i].step}
                    onChange={(e) => set((x) => (x.sticks[i].step = Number(e.target.value)))}
                    className="mt-1 w-full accent-[var(--primary)]"
                  />
                </label>
              </div>
            </div>
          ))}
        </div>

        <div className="mt-5 grid gap-5" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))" }}>
          {(["L2 range", "R2 range"] as const).map((name, i) => (
            <div key={name} className="rounded-2xl bg-white/[0.02] p-3.5 ring-1 ring-white/[0.06]">
              <p className="text-[13px] text-foreground">
                {name}: <span className="tabular text-muted-foreground">{edit.triggers[i].min} – {edit.triggers[i].max}</span>
              </p>
              {(["min", "max"] as const).map((k) => (
                <label key={k} className="mt-2 block text-[12px] text-muted-foreground">
                  {k === "min" ? "Starts at" : "Full at"}
                  <input type="range" min={0} max={255} value={edit.triggers[i][k]} onChange={(e) => set((x) => (x.triggers[i][k] = Number(e.target.value)))} className="mt-1 w-full accent-[var(--primary)]" />
                </label>
              ))}
            </div>
          ))}
        </div>

        <p className="mt-5 text-[13px] text-foreground">Buttons</p>
        <div className="mt-2 grid gap-2" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(190px, 1fr))" }}>
          {EDGE_INPUTS.map((input, i) => (
            <label key={input} className="flex items-center justify-between gap-2 rounded-xl bg-white/[0.02] px-3 py-2 text-[12.5px] ring-1 ring-white/[0.06]">
              <span className="text-muted-foreground">{input}</span>
              <select value={edit.buttons[i]} onChange={(e) => set((x) => (x.buttons[i] = Number(e.target.value)))} className={cn("rounded-md bg-transparent text-right", edit.buttons[i] !== i ? "text-primary" : "text-foreground")}>
                {EDGE_BUTTONS.map((b) => (
                  <option key={b.value} value={b.value}>
                    {b.name}
                  </option>
                ))}
              </select>
            </label>
          ))}
        </div>

        {invalid && <p className="mt-4 text-[12.5px] text-chart-3">{invalid}</p>}
        <div className="mt-5 flex flex-wrap items-center gap-2">
          <ActionButton testId="edge-save" disabled={!allow || !!invalid || !!busy} busy={busy === "Saved"} onClick={() => void run("Saved", async () => void (await session.write(slot, edit)))}>
            Save to Fn + {target.slot.button}
          </ActionButton>
          {!target.empty && (
            <ActionButton disabled={!allow || !!busy} busy={busy === "Deleted"} onClick={() => void run("Deleted", async () => void (await session.remove(slot)))}>
              Delete this profile
            </ActionButton>
          )}
          {session.backup && (
            <ActionButton disabled={!allow || !!busy} busy={busy === "Restored"} onClick={() => void run("Restored", async () => void (await session.restore(session.backup!.data)))}>
              Put the backup back
            </ActionButton>
          )}
          {!allow && <span className="text-[12px] text-muted-foreground">Turn on Allow changes to write.</span>}
        </div>
      </Card>
    </>
  );
}
