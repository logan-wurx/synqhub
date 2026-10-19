// A lamp page's Scenes tab: the lamp's whole scene catalogue (58 for the H6076), grouped like Govee's app, each card
// with a moving preview in the scene's own colours. One tap applies it: a scene with data is uploaded first (checked
// byte for byte against the catalogue by the bridge), then switched on.
import { useState } from "react";
import { MagnifyingGlass } from "@phosphor-icons/react";
import { scenesFor, type LightScene } from "@/lib/lighting/govee/scenes.generated";
import type { LampControl, LampView } from "@/lib/lighting/lamp";
import { useKeptState } from "@/lib/keep";
import { Card, CardHeader } from "@/components/ui/matte";
import { Segmented } from "./controls";
import { SceneTile } from "./SceneTile";
import { LightPreview, type Motion } from "./preview";

// How a scene's preview moves: a guess from its name (the catalogue doesn't say), so calm scenes breathe, lively
// ones flash and the rest flow.
const CALM = /night|study|work|warm|leisure|sunset|sunrise|forest|tender|sweet|romantic|morning|lake|glacier|dream|profound|light|rustling|cave/i;
const LIVELY = /firework|electro|party|heartbeat|fight|rush|carnival|game|birthday|halloween|flash|downpour/i;
export const sceneMotion = (s: LightScene): Motion => (LIVELY.test(s.name) ? "flash" : CALM.test(s.name) ? "breathe" : "flow");

export function ScenesTab({ control, view, onError, fill = false }: { control: LampControl; view: LampView; onError: (why: string) => void; fill?: boolean }) {
  const scenes = scenesFor(control.spec.sku);
  const categories = ["All", ...new Set(scenes.map((s) => s.category))];
  const [kept, setCategory] = useKeptState<string>("light.scenes.category", "All");
  const category = categories.includes(kept) ? kept : "All";
  const [query, setQuery] = useState("");
  const [sending, setSending] = useState<number | null>(null);
  const q = query.trim().toLowerCase();
  const shown = scenes.filter((s) => (category === "All" || s.category === category) && (!q || s.name.toLowerCase().includes(q)));

  const apply = async (s: LightScene) => {
    setSending(s.code);
    try {
      await control.applyScene(s);
    } catch (e) {
      onError(String(e).replace(/^Error: /, ""));
    } finally {
      setSending(null);
    }
  };

  return (
    // The card is as tall as the window allows (`fill`: the rest of its column, under the colour) and the catalogue
    // scrolls inside it, fading at the edge, so the page itself stays put however many scenes the light has.
    <Card className={fill ? "flex min-h-[240px] flex-1 basis-0 flex-col" : "flex max-h-[calc(100dvh-290px)] min-h-[380px] flex-col"} innerClassName="flex min-h-0 flex-1 flex-col">
      <CardHeader title="Scenes" hint={`${scenes.length} scenes from the light's own library. Tap one to switch to it.`} />
      <div className="mt-4 flex flex-wrap items-center gap-3 px-5">
        <Segmented wrap label="Scene group" value={category} options={categories.map((c) => ({ id: c, label: c }))} onChange={setCategory} />
        <label className="ml-auto flex h-9 min-w-[180px] items-center gap-2 rounded-control bg-white/[0.04] px-3 text-[13px] ring-1 ring-white/[0.08] focus-within:ring-white/20">
          <MagnifyingGlass size={14} className="shrink-0 text-medium" />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Find a scene" aria-label="Find a scene" className="min-w-0 flex-1 bg-transparent text-high outline-none placeholder:text-medium" />
        </label>
      </div>
      <div className="mt-4 min-h-0 flex-1 overflow-y-auto px-5 pb-6 [mask-image:linear-gradient(to_bottom,#000_calc(100%-32px),transparent)]">
      <div className="grid gap-2" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(118px, 1fr))" }} data-testid="light-scenes">
        {shown.map((s) => {
          const on = view.mode === "scene" && view.scene === s.code;
          return (
            <SceneTile
              key={s.code}
              name={s.name}
              picture={<LightPreview colours={s.colours} motion={sceneMotion(s)} seconds={5} className="h-10 w-full" />}
              on={on}
              sending={sending === s.code}
              disabled={sending !== null}
              onClick={() => void apply(s)}
            />
          );
        })}
        {!shown.length && <p className="col-span-full py-6 text-center text-[13px] text-medium">No scene by that name.</p>}
      </div>
      </div>
    </Card>
  );
}
