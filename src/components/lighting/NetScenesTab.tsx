// A Wi-Fi light's Scenes tab: the scenes it already has, recalled by a tap (src/lib/lighting/net/scenes.ts). A Hue
// light shows the bridge's scenes that include it, with their colours; a Nanoleaf controller its effects, by name.
// SYNQ never makes, changes or deletes a scene.
import { useEffect, useState } from "react";
import type { Rgb } from "@/lib/lighting/govee/frames";
import type { NetDevice } from "@/lib/lighting/net/brands";
import { netSend } from "@/lib/lighting/net/link";
import { currentScene, listScenes, recallMessage, sceneColours, type NetScene } from "@/lib/lighting/net/scenes";
import { Card, CardHeader } from "@/components/ui/matte";
import { css } from "./controls";
import { SceneTile } from "./SceneTile";

/** A scene's swatches: its colours side by side, or a quiet panel when the light doesn't say them. */
function Swatches({ colours }: { colours: readonly Rgb[] | null }) {
  const bg = colours?.length ? `linear-gradient(to right, ${colours.length === 1 ? `${css(colours[0])}, ${css(colours[0])}` : colours.map(css).join(", ")})` : "linear-gradient(135deg, rgb(255 255 255 / 0.06), rgb(255 255 255 / 0.02))";
  return <span className="block h-14 w-full rounded-xl ring-1 ring-white/[0.06]" style={{ background: bg }} aria-hidden="true" />;
}

export function NetScenesTab({ device, onError, onRecalled }: { device: NetDevice; onError: (why: string) => void; onRecalled: () => void }) {
  const [scenes, setScenes] = useState<NetScene[] | null>(null);
  const [colours, setColours] = useState<Record<string, Rgb[]>>({});
  const [on, setOn] = useState<string | null>(null);
  const [sending, setSending] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    listScenes(device, netSend).then(
      async (list) => {
        if (!live) return;
        setScenes(list);
        setOn(await currentScene(device, netSend).catch(() => null));
        // Hue gives each scene's colours on its own; a few at a time, as they come.
        for (let i = 0; i < list.length && live; i += 4) {
          const got = await Promise.all(list.slice(i, i + 4).map((s) => sceneColours(device, s, netSend).then((c) => [s.id, c] as const, () => [s.id, []] as const)));
          if (live) setColours((now) => ({ ...now, ...Object.fromEntries(got) }));
        }
      },
      (e: unknown) => {
        if (!live) return;
        setScenes([]);
        onError(e instanceof Error ? e.message : String(e));
      },
    );
    return () => {
      live = false;
    };
  }, [device, onError]);

  const recall = async (s: NetScene) => {
    setSending(s.id);
    try {
      await netSend(device.brand, device.id, recallMessage(device, s));
      setOn(s.id);
      onRecalled();
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setSending(null);
    }
  };

  const hue = device.brand === "hue";
  return (
    <Card innerClassName="pb-5">
      <CardHeader
        title="Scenes"
        hint={
          scenes === null
            ? "Asking the light for its scenes…"
            : hue
              ? `${scenes.length} of the bridge's scenes include this light. A scene sets every light in it.`
              : `${scenes.length} effects on the controller. Tap one to switch to it.`
        }
      />
      <div className="mt-4 grid gap-3 px-5" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))" }} data-testid="net-scenes">
        {(scenes ?? []).map((s) => (
          <SceneTile key={s.id} name={s.name} picture={<Swatches colours={hue ? (colours[s.id] ?? null) : null} />} on={on === s.id} sending={sending === s.id} disabled={sending !== null} onClick={() => void recall(s)} />
        ))}
        {scenes?.length === 0 && <p className="col-span-full py-6 text-center text-[13px] text-muted-foreground">{hue ? "No scene on the bridge includes this light. Scenes are made in the Hue app." : "No effects on the controller yet."}</p>}
      </div>
    </Card>
  );
}
