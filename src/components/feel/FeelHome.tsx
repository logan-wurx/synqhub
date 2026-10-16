// "Keep your feel" on the Devices home: the "New mouse. Match your setup?" banners, and the card with a summary
// of the saved feel (the mouse, the keyboard, the in-game sens) next to the sensitivity calculator. It reads
// only what the panels already keep; it never opens a device.
import { Suspense, lazy, useState } from "react";
import { CaretDown, Keyboard, Mouse as MouseIcon, Sparkle, Trophy, X } from "@phosphor-icons/react";
import { cn } from "@/lib/utils";
import { Card } from "@/components/ui/matte";
import { Chip, Pill } from "@/components/keyboard/parts";
import { peekKept, setKept, useKeptState } from "@/lib/keep";
import { openDevice } from "@/lib/nav";
import type { DeviceEntry } from "@/lib/device-model";
import { describeKeyboard, describeMouse } from "@/lib/feel/devices";
import { openKey, useFeel } from "@/lib/feel/hooks";
import { feelStore } from "@/lib/feel/persist";
import { keyboardSummary, mouseSummary, sameFeel } from "@/lib/feel/profile";
import { GAME_LABEL, calculate, cs2FromValorant, edpi, roundSens, valorantFromCs2, type Game } from "@/lib/feel/sens";
import { pendingOffers, suggestSource, type DeviceKind, type PresentDevice } from "@/lib/feel/store";
import type { KeyboardFeel, MouseFeel } from "@/lib/feel/types";
import { fmtNum } from "@/lib/feel/units";
import { OfferBanner, NumInput } from "./parts";

// "Try a pro's setup": the list of pros and the side-by-side diff load only when the section is opened.
const ProPicker = lazy(() => import("./ProPicker").then((m) => ({ default: m.ProPicker })));

type Entry = DeviceEntry & { kind: DeviceKind };
const inputs = (entries: readonly DeviceEntry[]): Entry[] => entries.filter((e): e is Entry => e.kind !== "sound");
const presentOf = (e: Entry): PresentDevice => ({ id: e.id, kind: e.kind, name: e.name });

/** What a device holds now, from the view its panel kept (null until the panel has read it). */
function nowOf(e: Entry): MouseFeel | KeyboardFeel | null {
  const view = e.viewKey ? peekKept<unknown>(e.viewKey, null) : null;
  return (e.kind === "mouse" ? describeMouse(e.family, view) : describeKeyboard(e.family, view))?.now ?? null;
}

const noun = (k: DeviceKind) => (k === "mouse" ? "mouse" : "keyboard");
const summaryOf = (k: DeviceKind, f: MouseFeel | KeyboardFeel) => (k === "mouse" ? mouseSummary(f as MouseFeel) : keyboardSummary(f as KeyboardFeel));

// ---------------------------------------------------------------------------------------------
// The banners
// ---------------------------------------------------------------------------------------------

/** One calm banner per new mouse or keyboard that the saved feel has something for. */
export function FeelOffers({ entries }: { entries: readonly DeviceEntry[] }) {
  const feel = useFeel();
  const list = inputs(entries);
  const offers = pendingOffers(feel, list.map(presentOf));
  if (!offers.length || !feel.profile) return null;
  return (
    <div className="flex flex-col gap-2.5" data-slot="feel-offers">
      {offers.map((o) => {
        const part = o.kind === "mouse" ? feel.profile!.mouse! : feel.profile!.keyboard!;
        return (
          <OfferBanner
            key={o.id}
            title={`New ${noun(o.kind)}. Match your setup?`}
            detail={`${o.name} · your feel: ${summaryOf(o.kind, part.feel)}`}
            primary="Match your setup"
            onPrimary={() => {
              // The preview opens on the device's page, where its panel can read it and apply through its session.
              setKept(openKey(o.id), true);
              openDevice(o.id);
            }}
            onDismiss={() => void feelStore.markSeen(o.id)}
          />
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// The card
// ---------------------------------------------------------------------------------------------

export function KeepYourFeel({ entries }: { entries: readonly DeviceEntry[] }) {
  const feel = useFeel();
  const list = inputs(entries);
  const profile = feel.profile;
  const sens = profile?.sens ?? { cs2: null, valorant: null };
  const mouse = profile?.mouse ?? null;
  const keyboard = profile?.keyboard ?? null;
  const dpi = mouse ? mouse.feel.stages[mouse.feel.active] : null;
  const empty = !mouse && !keyboard;
  // Folded until opened: the Gear page leads with the gear. Folded, the line under the title says what's saved.
  const [open, setOpen] = useKeptState<boolean>("feel.card.open", false);
  const saved = [mouse && `mouse from the ${mouse.from.name}`, keyboard && `keyboard from the ${keyboard.from.name}`].filter(Boolean).join(" · ");

  return (
    <section data-slot="keep-your-feel" aria-label="Keep your feel">
      <Card innerClassName="px-6 py-4">
        <button onClick={() => setOpen(!open)} aria-expanded={open} className="group -mx-2 flex w-[calc(100%+1rem)] items-center gap-3 rounded-xl px-2 py-1 text-left">
          <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-primary/[0.12] text-primary ring-1 ring-primary/25">
            <Sparkle size={17} weight="light" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-[15px] font-medium tracking-tight text-foreground">Keep your feel</span>
            <span className="block truncate text-[12.5px] text-muted-foreground">
              {open || !saved ? "Switch brands, not your aim. A new mouse or keyboard, any brand, takes your old setup in one click." : `Saved: ${saved}`}
            </span>
          </span>
          <CaretDown size={15} className={cn("shrink-0 text-muted-foreground transition-transform duration-300 ease-fluid group-hover:text-foreground", open && "rotate-180")} />
        </button>

        {open && (
        <>
        <div className="mt-5 grid grid-cols-[minmax(0,1fr)] gap-x-8 gap-y-6 min-[1100px]:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]">
          <div className="min-w-0">
            <p className="mb-1 text-[12.5px] text-muted-foreground">Your feel</p>
            <div className="divide-y divide-white/[0.05]">
              {(["mouse", "keyboard"] as const).map((kind) => (
                <FeelLine key={kind} kind={kind} entries={list} />
              ))}
            </div>
            {empty && feel.loaded && (
              <p className="mt-3 text-[12.5px] leading-relaxed text-muted-foreground">
                Nothing saved yet. Open a mouse or keyboard and press <span className="text-foreground">Save as my feel</span> on its Overview, or save the one you tuned last from here.
              </p>
            )}
            <div className="mt-4 flex flex-wrap items-end gap-3">
              <NumInput label="Your CS2 sens" value={sens.cs2} placeholder={sens.valorant ? fmtNum(roundSens(cs2FromValorant(sens.valorant))) : "0.55"} onCommit={(v) => void feelStore.setSens({ ...sens, cs2: v })} />
              <NumInput label="Your Valorant sens" value={sens.valorant} placeholder={sens.cs2 ? fmtNum(roundSens(valorantFromCs2(sens.cs2))) : "0.173"} onCommit={(v) => void feelStore.setSens({ ...sens, valorant: v })} />
              {dpi !== null && (sens.cs2 || sens.valorant) && (
                <p className="pb-2 text-[12px] text-muted-foreground">
                  at {fmtNum(dpi)} DPI: eDPI {fmtNum(edpi(dpi, sens.cs2 ?? cs2FromValorant(sens.valorant!)), 1)} in CS2
                </p>
              )}
            </div>
          </div>
          <Calculator key={dpi ?? "none"} dpi={dpi} sens={sens} />
        </div>
        <TryAPro mice={list.filter((e) => e.kind === "mouse")} />
        </>
        )}
      </Card>
    </section>
  );
}

/** The collapsed "Try a pro's setup" row; open, it holds the picker and the diff. */
function TryAPro({ mice }: { mice: readonly Entry[] }) {
  const [open, setOpen] = useKeptState<boolean>("feel.pros.open", false);
  return (
    <div className="mt-5 border-t border-white/[0.05] pt-3" data-slot="try-a-pro">
      <button onClick={() => setOpen(!open)} aria-expanded={open} className="group -mx-2 flex w-[calc(100%+1rem)] items-center gap-3 rounded-xl px-2 py-1.5 text-left transition-colors hover:bg-white/[0.03]">
        <Trophy size={16} weight="light" className="shrink-0 text-muted-foreground transition-colors group-hover:text-primary" />
        <span className="text-[13.5px] text-foreground">Try a pro's setup</span>
        <span className="min-w-0 flex-1 truncate text-[12px] text-muted-foreground">CS2 and Valorant pros: their DPI, polling and sens on your own mouse</span>
        <CaretDown size={14} className={cn("shrink-0 text-muted-foreground transition-transform duration-300", open && "rotate-180")} />
      </button>
      {open && (
        <div className="mt-4">
          <Suspense fallback={<p className="text-[12.5px] text-muted-foreground">Loading the list…</p>}>
            <ProPicker mice={mice} />
          </Suspense>
        </div>
      )}
    </div>
  );
}

function FeelLine({ kind, entries }: { kind: DeviceKind; entries: Entry[] }) {
  const feel = useFeel();
  const part = kind === "mouse" ? feel.profile?.mouse : feel.profile?.keyboard;
  const Icon = kind === "mouse" ? MouseIcon : Keyboard;
  const present = entries.map(presentOf);
  const byId = new Map(entries.map((e) => [e.id, e]));
  const src = suggestSource(feel, kind, present, (id) => !!nowOf(byId.get(id)!));
  const srcEntry = src ? byId.get(src.id)! : null;
  const srcNow = srcEntry ? nowOf(srcEntry) : null;
  // Nothing saved: offer the device configured most recently. Something saved: offer to update it only when
  // that device was changed since (it is the latest one configured, and it no longer matches).
  const lastId = feel.last[kind]?.id;
  const suggest = !!srcEntry && !!srcNow && (part ? lastId === srcEntry.id && !sameFeel(part.feel, srcNow) : true);

  return (
    <div className="flex items-start gap-3 py-3 first:pt-1">
      <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-white/[0.04] text-muted-foreground ring-1 ring-white/[0.07]">
        <Icon size={17} weight="light" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-[13.5px] text-foreground">
          {kind === "mouse" ? "Mouse" : "Keyboard"}
          {part && <span className="text-muted-foreground"> · from the {part.from.name}</span>}
        </p>
        <p className={cn("mt-0.5 text-[12.5px] leading-relaxed", part ? "text-muted-foreground" : "text-muted-foreground/80")}>
          {part ? summaryOf(kind, part.feel) : `No ${noun(kind)} saved`}
        </p>
        {suggest && srcEntry && srcNow && (
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Pill
              primary={!part}
              onClick={() =>
                void (kind === "mouse"
                  ? feelStore.saveFrom("mouse", srcNow as MouseFeel, { deviceId: srcEntry.id, name: srcEntry.name, brand: srcEntry.brand })
                  : feelStore.saveFrom("keyboard", srcNow as KeyboardFeel, { deviceId: srcEntry.id, name: srcEntry.name, brand: srcEntry.brand }))
              }
            >
              {part ? `Update from the ${srcEntry.name}` : `Save the ${srcEntry.name} as my feel`}
            </Pill>
            <span className="text-[11.5px] text-muted-foreground/80">{lastId === srcEntry.id ? "the one you configured most recently" : "its settings are known"}</span>
          </div>
        )}
      </div>
      {part && (
        <button
          onClick={() => void feelStore.forget(kind)}
          title={`Forget the saved ${noun(kind)} feel`}
          aria-label={`Forget the saved ${noun(kind)} feel`}
          className="grid size-7 shrink-0 place-items-center rounded-full text-muted-foreground/80 transition-colors hover:bg-white/[0.06] hover:text-foreground"
        >
          <X size={13} />
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// The calculator
// ---------------------------------------------------------------------------------------------

/** "I play CS2 at 0.55 on 800 DPI. What do I use at 1000?" Standalone: it needs no saved feel. */
export function Calculator({ dpi, sens }: { dpi: number | null; sens: { cs2: number | null; valorant: number | null } }) {
  const [game, setGame] = useState<Game>("cs2");
  const [typedSens, setTypedSens] = useState<number | null | undefined>(undefined);
  const [typedOld, setTypedOld] = useState<number | null | undefined>(undefined);
  const [newDpi, setNewDpi] = useState<number | null>(null);
  const saved = sens[game];
  const sensNow = typedSens === undefined ? saved : typedSens;
  const oldDpi = typedOld === undefined ? dpi : typedOld;
  const result = sensNow && oldDpi && newDpi ? calculate({ game, sens: sensNow, oldDpi, newDpi }) : null;

  return (
    <div className="min-w-0" data-slot="sens-calculator">
      <div className="mb-3 flex items-center gap-3">
        <p className="text-[12.5px] text-muted-foreground">Sensitivity calculator</p>
        <div className="ml-auto flex gap-1.5">
          {(["cs2", "valorant"] as const).map((g) => (
            <Chip
              key={g}
              on={game === g}
              onClick={() => {
                setGame(g);
                setTypedSens(undefined);
              }}
            >
              {GAME_LABEL[g]}
            </Chip>
          ))}
        </div>
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <NumInput label={`Your ${GAME_LABEL[game]} sens`} value={sensNow ?? null} placeholder={game === "cs2" ? "0.55" : "0.173"} onType={setTypedSens} />
        <NumInput label="Old DPI" value={oldDpi ?? null} placeholder="800" decimals={0} unit="DPI" onType={setTypedOld} />
        <NumInput label="New DPI" value={newDpi} placeholder="1000" decimals={0} unit="DPI" onType={setNewDpi} />
      </div>
      <div className="mt-4 grid grid-cols-2 gap-3">
        {(["cs2", "valorant"] as const).map((g) => {
          const line = result?.[g] ?? null;
          return (
            <div key={g} className="min-w-0 rounded-2xl bg-white/[0.025] px-4 py-3.5 ring-1 ring-white/[0.06]">
              <p className="text-[11.5px] text-muted-foreground">{GAME_LABEL[g]}</p>
              <p className="tabular mt-1.5 truncate text-[21px] leading-none text-foreground">{line ? fmtNum(line.next) : "—"}</p>
              <p className="tabular mt-1.5 truncate text-[11.5px] text-muted-foreground/80">{line ? `eDPI ${fmtNum(line.newEdpi, 1)}${line.derived ? " · from " + GAME_LABEL[game] : ""}` : "eDPI —"}</p>
            </div>
          );
        })}
      </div>
      <p className="mt-2.5 text-[11.5px] leading-relaxed text-muted-foreground/80">
        {result
          ? result.exact
            ? "Same DPI, so the sensitivity stays."
            : `New sens = old sens x ${fmtNum(result.oldDpi)} / ${fmtNum(result.newDpi)}. Valorant = CS2 / 3.181818.`
          : "Type your sens and both DPIs. Valorant = CS2 / 3.181818."}
      </p>
    </div>
  );
}
