// The controller tester on the browser's Gamepad API alone: for a browser without WebHID (Firefox, Safari) and without
// SYNQ Helper. It reads the pads the browser shows (after a button press) and sends nothing to any of them. The
// polling figure is capped by the Gamepad API (about 250 Hz), and the page says so.
import { useEffect, useState } from "react";
import { ArrowLeft } from "@phosphor-icons/react";
import { cn } from "@/lib/utils";
import { Card, NoticeStack, type Notice } from "@/components/ui/matte";
import { gamepadIds, identifyPad, type PadIdentity } from "@/lib/controllers/identify";
import { openGamepadLink, type PadLink } from "@/lib/controllers/link";
import { Gamepad } from "@/components/ui/silhouettes";
import { PollingTab, TestTab } from "./tabs";
import { arrowPick } from "@/lib/roving";

/** A generic identity for a pad the controller table doesn't know (or whose id the browser hides). */
function identityOf(g: Gamepad): PadIdentity {
  const ids = gamepadIds(g.id);
  const known = ids ? identifyPad({ vid: ids.vid, pid: ids.pid, product: ids.name, via: "gamepad" }) : null;
  if (known) return { ...known, guard: "input" };
  const name = (ids?.name || g.id.replace(/\s*\(.*\)\s*$/, "")).trim() || "Game controller";
  return {
    family: `gamepad:${g.index}`,
    model: null,
    name,
    brand: "",
    kind: /xinput|xbox/i.test(g.id) ? "xbox360" : "generic",
    transport: "hid",
    guard: "input",
    support: "tester",
    settings: "none",
    personality: null,
    vid: ids?.vid ?? 0,
    pid: ids?.pid ?? 0,
    via: "gamepad",
    caps: { sticks: g.axes.length >= 4 ? 2 : g.axes.length >= 2 ? 1 : 0, triggers: { bits: 8 }, paddles: 0, gyro: false, touchpad: false, battery: false, rumble: false, lights: false, adaptiveTriggers: false },
    mismatch: null,
  };
}

export function GamepadTester({ onBack }: { onBack: () => void }) {
  const [pads, setPads] = useState<Gamepad[]>([]);
  const [index, setIndex] = useState<number | null>(null);
  const [link, setLink] = useState<PadLink | null>(null);
  const [tab, setTab] = useState<"test" | "polling">("test");
  const [notices, setNotices] = useState<Notice[]>([]);
  const notify = (n: Omit<Notice, "id">) => setNotices((ns) => [...ns, { ...n, id: Date.now() }]);

  // The browser shows a pad only after one of its buttons is pressed on this page.
  useEffect(() => {
    const read = () => setPads((navigator.getGamepads?.() ?? []).filter((g): g is Gamepad => !!g));
    read();
    window.addEventListener("gamepadconnected", read);
    window.addEventListener("gamepaddisconnected", read);
    const t = setInterval(read, 1000);
    return () => {
      window.removeEventListener("gamepadconnected", read);
      window.removeEventListener("gamepaddisconnected", read);
      clearInterval(t);
    };
  }, []);

  const pad = pads.find((g) => g.index === index) ?? pads[0] ?? null;
  const padIndex = pad?.index ?? null;
  useEffect(() => {
    if (padIndex === null) return;
    const g = (navigator.getGamepads?.() ?? [])[padIndex];
    if (!g) return;
    let live = true;
    let opened: PadLink | null = null;
    void openGamepadLink(identityOf(g), padIndex).then((l) => {
      if (!live) return void l.close();
      opened = l;
      setLink(l);
    });
    return () => {
      live = false;
      setLink(null);
      void opened?.close();
    };
  }, [padIndex]);

  return (
    <div className="mx-auto flex min-h-full w-full max-w-[1100px] flex-col gap-5 px-6 py-8" data-slot="gamepad-tester">
      <button onClick={onBack} className="-ml-2 flex w-fit items-center gap-1 rounded-tight px-2 py-1 text-[12.5px] text-medium hover:bg-white/[0.05] hover:text-high">
        <ArrowLeft size={12} /> Back
      </button>
      <div>
        <h1 className="text-[34px] font-semibold leading-[1.05] tracking-[-0.035em] text-high">Controller tester</h1>
        <p className="mt-2 max-w-2xl text-[13px] leading-relaxed text-medium">
          Sticks, triggers, buttons and a polling estimate, from what this browser's Gamepad API shows. Nothing is sent to the controller. For exact polling rates
          and a pad's own details, use Chrome or Edge, or the desktop app.
        </p>
      </div>
      {pads.length > 1 && (
        <div className="flex flex-wrap gap-2">
          {pads.map((g) => (
            <button key={g.index} onClick={() => setIndex(g.index)} className={cn("rounded-full px-3 py-1.5 text-[12.5px] ring-1", g.index === padIndex ? "bg-primary/15 text-high ring-primary/40" : "bg-white/[0.04] text-medium ring-white/[0.08]")}>
              {identityOf(g).name}
            </button>
          ))}
        </div>
      )}
      {!pad && (
        <Card innerClassName="flex flex-col items-center px-8 pb-10 pt-8 text-center">
          <Gamepad className="mb-4 h-[150px] animate-pulse opacity-80" />
          <p className="text-[17px] font-medium text-high">Press any button on your controller</p>
          <p className="mx-auto mt-2 max-w-md text-[13.5px] text-medium">Browsers only show a controller to a page after one of its buttons is pressed.</p>
        </Card>
      )}
      {link && (
        <>
          <div role="tablist" onKeyDown={arrowPick} className="flex w-fit gap-0.5 rounded-full bg-white/[0.04] p-1 ring-1 ring-white/[0.07]">
            {(["test", "polling"] as const).map((t) => (
              <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)} className={cn("rounded-full px-4 py-1.5 text-[13px]", tab === t ? "bg-white/[0.08] text-high" : "text-medium")}>
                {t === "test" ? "Test" : "Polling"}
              </button>
            ))}
          </div>
          <p className="text-[15px] font-medium text-high">{link.identity.name}</p>
          {tab === "test" ? <TestTab link={link} notify={notify} /> : <PollingTab link={link} notify={notify} />}
        </>
      )}
      <NoticeStack notices={notices} onDismiss={(id) => setNotices((ns) => ns.filter((n) => n.id !== id))} />
    </div>
  );
}
