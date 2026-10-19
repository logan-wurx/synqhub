// "Find your headphones": AutoEq's preset for a headphone or IEM, by model name. The list of ~6000 models and the one
// preset picked are fetched from AutoEq on GitHub only when asked; nothing is bundled. The preset can be saved to the
// Presets list (the EQ playing now is untouched) or used now, which goes through the EQ page's own load (the current
// file is backed up first). Its own chunk, loaded when opened.
import { useEffect, useMemo, useState } from "react";
import { MagnifyingGlass, Warning } from "@phosphor-icons/react";
import { cn } from "@/lib/utils";
import { backend, liveHardware } from "@/lib/backend";
import { eqResponse, logFreqs, type EqState, type Limits } from "@/lib/eq";
import { AUTOEQ_INDEX, formOf, importParametricEq, parseIndex, presetName, presetUrl, searchAutoEq, type AutoEqEntry, type Imported } from "@/lib/audio/autoeq";
import { Pill } from "@/components/keyboard/parts";
import type { Notice } from "@/components/ui/matte";

let indexCache: AutoEqEntry[] | null = null;

/** A file from AutoEq on GitHub; the preview (no network wanted) reads its small sample instead. */
async function autoEqText(url: string, preview: "index" | "preset"): Promise<string> {
  if (!liveHardware) {
    const sample = await import("@/lib/audio/autoeq-preview");
    return preview === "index" ? sample.PREVIEW_INDEX : sample.PREVIEW_PRESET;
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`AutoEq answered ${res.status}`);
  return res.text();
}

async function loadIndex(): Promise<AutoEqEntry[]> {
  if (indexCache) return indexCache;
  indexCache = parseIndex(await autoEqText(AUTOEQ_INDEX, "index"));
  return indexCache;
}

/** The preset's curve, small: ±12 dB around 0, 20 Hz to 20 kHz. */
function Curve({ state, fs }: { state: EqState; fs: number }) {
  const freqs = useMemo(() => logFreqs(120, 20, 20000), []);
  const ys = useMemo(() => eqResponse(state, freqs, fs).map((g) => g + state.preamp), [state, freqs, fs]);
  const W = 520;
  const H = 110;
  const y = (db: number) => H / 2 - (Math.max(-12, Math.min(12, db)) / 12) * (H / 2 - 6);
  const d = ys.map((g, i) => `${i ? "L" : "M"}${((i / (ys.length - 1)) * W).toFixed(1)},${y(g).toFixed(1)}`).join("");
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-[110px] w-full" preserveAspectRatio="none" role="img" aria-label="The preset's EQ curve">
      <path d={`M0,${H / 2}H${W}`} stroke="rgb(255 255 255 / 0.1)" strokeDasharray="3 4" />
      <path d={d} fill="none" stroke="var(--primary)" strokeWidth="2" vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
    </svg>
  );
}

export function AutoEqFinder({ limits, readOnly, onSaved, onUse, notify }: { limits: Limits; readOnly: boolean; onSaved: () => void; onUse: (state: EqState, name: string) => void; notify: (n: Omit<Notice, "id">, key?: string) => void }) {
  const [index, setIndex] = useState<AutoEqEntry[] | null>(indexCache);
  const [problem, setProblem] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<AutoEqEntry | null>(null);
  const [preset, setPreset] = useState<Imported | { error: string } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (index) return;
    let live = true;
    loadIndex().then(
      (list) => live && setIndex(list),
      (e) => live && setProblem(`Couldn't reach AutoEq on GitHub (${e instanceof Error ? e.message : "offline"}).`),
    );
    return () => {
      live = false;
    };
  }, [index]);

  const results = useMemo(() => (index ? searchAutoEq(index, query, 30) : []), [index, query]);

  const pick = async (e: AutoEqEntry) => {
    setPicked(e);
    setPreset(null);
    try {
      setPreset(importParametricEq(await autoEqText(presetUrl(e), "preset"), limits));
    } catch (err) {
      setPreset({ error: `Couldn't fetch this preset (${err instanceof Error ? err.message : "offline"}).` });
    }
  };

  const save = async () => {
    if (!picked || !preset || "error" in preset) return;
    setBusy(true);
    try {
      await backend.eqPresetSave(presetName(picked), preset.state);
      notify({ title: `Saved "${presetName(picked)}"`, detail: "It's in your presets; the EQ playing now is unchanged.", tone: "ok" }, "preset");
      onSaved();
    } catch (err) {
      notify({ title: "Preset not saved", detail: err instanceof Error ? err.message : String(err), tone: "error" }, "preset");
    } finally {
      setBusy(false);
    }
  };

  const ready = preset && !("error" in preset) ? preset : null;

  return (
    <div className="space-y-3 rounded-control bg-white/[0.02] p-4 ring-1 ring-white/[0.06]" data-slot="autoeq-finder">
      <label className="flex h-10 items-center gap-2 rounded-control bg-white/[0.04] px-4 ring-1 ring-white/[0.08] focus-within:ring-primary/60">
        <MagnifyingGlass size={14} className="shrink-0 text-medium" />
        <input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={index ? `Your headphones or IEMs (${index.length.toLocaleString()} models)` : "Loading the list from AutoEq…"}
          aria-label="Search headphones"
          className="min-w-0 flex-1 bg-transparent text-[13.5px] text-high outline-none placeholder:text-medium"
        />
      </label>
      {problem && <p className="text-[12.5px] text-chart-3">{problem}</p>}
      {query.trim() && index && (
        <ul className="max-h-[220px] overflow-y-auto" role="listbox" aria-label="Models">
          {results.map((e) => (
            <li key={e.path}>
              <button
                role="option"
                aria-selected={picked?.path === e.path}
                onClick={() => void pick(e)}
                className={cn("flex w-full items-center gap-3 rounded-small px-3 py-1.5 text-left text-[13px] transition-colors", picked?.path === e.path ? "bg-white/[0.07]" : "hover:bg-white/[0.04]")}
              >
                <span className="min-w-0 flex-1 truncate text-high">{e.name}</span>
                <span className="shrink-0 text-[11.5px] text-medium">
                  {formOf(e)} · {e.source}
                </span>
              </button>
            </li>
          ))}
          {!results.length && <li className="px-3 py-2 text-[12.5px] text-medium">No model matches that. AutoEq names them by maker and model.</li>}
        </ul>
      )}
      {picked && (
        <div className="space-y-3 border-t border-white/[0.05] pt-3">
          <div className="flex items-baseline gap-2">
            <p className="min-w-0 flex-1 truncate text-[13.5px] text-high">{picked.name}</p>
            <span className="shrink-0 text-[11.5px] text-medium">measured by {picked.source}</span>
          </div>
          {!preset && <p className="text-[12.5px] text-medium">Fetching the preset…</p>}
          {preset && "error" in preset && <p className="text-[12.5px] text-chart-3">{preset.error}</p>}
          {ready && (
            <>
              <Curve state={ready.state} fs={limits.sampleRateHz} />
              <p className="text-[12px] text-medium">
                {ready.state.filters.length} filters, preamp {ready.state.preamp} dB.
              </p>
              {ready.adjusted.length > 0 && (
                <p className="flex gap-2 text-[12px] leading-relaxed text-chart-3">
                  <Warning size={14} className="mt-0.5 shrink-0" />
                  <span>{ready.adjusted.join(" ")}</span>
                </p>
              )}
              <div className="flex flex-wrap items-center gap-2">
                <Pill primary onClick={() => void save()} disabled={busy}>
                  Save as preset
                </Pill>
                <Pill onClick={() => onUse(ready.state, presetName(picked))} disabled={readOnly || busy}>
                  Use it now
                </Pill>
                <span className="text-[11.5px] text-medium">Using it backs up your current EQ first; History has it.</span>
              </div>
            </>
          )}
        </div>
      )}
      <p className="text-[11px] leading-relaxed text-medium">
        Presets by AutoEq (MIT, Jaakko Pasanen), computed from the measurements of the source named on each model. Find your headphones downloads the headphone list from GitHub when you open it, and a preset when you pick one; nothing about you is sent and no measurement data is bundled.
      </p>
    </div>
  );
}
