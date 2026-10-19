// Which headphones, IEMs or headset are on a sound output: picked from every model SYNQ has a photo of, found by
// typing part of the name. Its photo then stands for the output on the Gear page and here; "No picture" keeps the
// EQ curve. The list is plain names (one photo, the highlighted model's, loads at a time).
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { CaretDown, Check, MagnifyingGlass } from "@phosphor-icons/react";
import { cn } from "@/lib/utils";
import { headphoneModel, headphoneModels, normName, type HeadphoneModel } from "@/lib/device-images";
import { DeviceArt } from "@/components/devices/DeviceArt";

const NONE = "none";

export function HeadphonePicker({ value, suggested, onChange }: { value: string | null; suggested: string | null; onChange: (key: string | null) => void }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [at, setAt] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const uid = useId();
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener("pointerdown", away);
    return () => document.removeEventListener("pointerdown", away);
  }, [open]);

  // Every word typed must be in the name; the model the output's name points to comes first while nothing is typed.
  const options = useMemo<(HeadphoneModel | null)[]>(() => {
    const words = normName(query).split(" ").filter(Boolean);
    const all = headphoneModels();
    const hits = words.length ? all.filter((m) => words.every((w) => normName(m.name).includes(w))) : all;
    const first = !words.length && suggested ? all.find((m) => m.key === suggested) : undefined;
    return [null, ...(first ? [first, ...hits.filter((m) => m.key !== first.key)] : hits)];
  }, [query, suggested]);
  // The highlight starts on the model picked now, and on the first match once something is typed.
  useEffect(() => {
    if (query) setAt(options.length > 1 ? 1 : 0);
    else setAt(Math.max(0, options.findIndex((m) => (m?.key ?? null) === (headphoneModel(value)?.key ?? null))));
    // Only when the search or the open state changes, not on every pick.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, open]);
  useEffect(() => {
    list.current?.querySelector<HTMLElement>(`[data-at="${at}"]`)?.scrollIntoView({ block: "nearest" });
  }, [at]);

  const current = headphoneModel(value);
  const shown = options[at] ?? null;
  const pick = (m: HeadphoneModel | null) => {
    onChange(m?.key ?? null);
    setOpen(false);
    setQuery("");
  };

  return (
    <div ref={box} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        className="flex h-11 max-w-[320px] items-center gap-2.5 rounded-control bg-white/[0.04] pl-4 pr-3 text-[14px] text-high ring-1 ring-white/[0.08] transition-colors hover:bg-white/[0.07]"
      >
        <span className="min-w-0 flex-1 truncate">{current ? current.name : "Which model?"}</span>
        <CaretDown size={14} className={cn("shrink-0 text-medium transition-transform duration-300 ease-fluid", open && "rotate-180")} />
      </button>
      {open && (
        // The menu: 22 px around 16 px rows with 6 px padding (concentric corners).
        <div className="absolute left-0 top-full z-40 mt-2 flex w-[560px] overflow-hidden rounded-popover bg-popover shadow-[0_24px_48px_rgb(0_0_0/0.6)] ring-1 ring-white/[0.12]">
          <div className="flex min-w-0 flex-1 flex-col p-1.5">
            <label className="flex h-11 items-center gap-2.5 px-3">
              <MagnifyingGlass size={14} className="shrink-0 text-medium" />
              <input
                autoFocus
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "ArrowDown") (e.preventDefault(), setAt((i) => Math.min(options.length - 1, i + 1)));
                  else if (e.key === "ArrowUp") (e.preventDefault(), setAt((i) => Math.max(0, i - 1)));
                  else if (e.key === "Enter") (e.preventDefault(), pick(options[at] ?? null));
                  else if (e.key === "Escape") (e.stopPropagation(), setOpen(false));
                }}
                role="combobox"
                aria-expanded
                aria-controls={`${uid}-list`}
                aria-activedescendant={`${uid}-${at}`}
                placeholder={`Search ${headphoneModels().length} headphones, IEMs and headsets`}
                aria-label="Search headphone models"
                className="min-w-0 flex-1 bg-transparent text-[14px] text-high outline-none placeholder:text-medium"
              />
            </label>
            <ul ref={list} id={`${uid}-list`} role="listbox" aria-label="Headphone models" className="max-h-[300px] overflow-y-auto border-t border-white/[0.06] pt-1">
              {options.map((m, i) => {
                const on = (m?.key ?? null) === (value ?? null) || (!m && !current);
                return (
                  <li key={m?.key ?? NONE} id={`${uid}-${i}`} data-at={i} role="option" aria-selected={on}>
                    <button
                      type="button"
                      onPointerEnter={() => setAt(i)}
                      onClick={() => pick(m)}
                      className={cn("flex w-full items-center gap-3 rounded-small px-3 py-2 text-left text-[13.5px] transition-colors", i === at ? "bg-white/[0.07] text-high" : "text-high")}
                    >
                      <span className="min-w-0 flex-1 truncate">{m ? m.name : "No picture (the EQ curve)"}</span>
                      {m?.key === suggested && !query && <span className="shrink-0 text-[11.5px] text-medium">Matches the name</span>}
                      {m?.kind === "headset" && <span className="shrink-0 text-[11.5px] text-medium">Headset</span>}
                      {on && <Check size={14} className="shrink-0 text-primary" />}
                    </button>
                  </li>
                );
              })}
              {options.length === 1 && <li className="px-3 py-3 text-[12.5px] text-medium">No model by that name yet. Pick No picture, or try fewer words.</li>}
            </ul>
          </div>
          {/* The highlighted model's photo, so the right one is easy to tell apart. */}
          <div className="grid w-[200px] shrink-0 place-items-center border-l border-white/[0.06] bg-shade/30 p-5">
            {shown ? (
              <DeviceArt key={shown.key} spec={{ kind: "sound", name: shown.name, picture: shown.key }} className="max-h-[180px] max-w-full drop-shadow-[0_18px_22px_rgb(0_0_0/0.55)]" />
            ) : (
              <p className="text-center text-[12.5px] leading-relaxed text-medium">The Sound tile shows the EQ curve you have on.</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
