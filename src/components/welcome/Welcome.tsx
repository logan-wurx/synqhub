// First-run welcome: three short, skippable steps (hello, SYNQ Helper, accent). Nothing is changed
// unless a button says so: the helper stays off unless "Turn it on" is pressed. Shown once; Settings can
// open it again.
import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { BatteryWarning, Check, GameController, Globe, ShieldCheck, SlidersHorizontal, Waveform } from "@phosphor-icons/react";
import { cn } from "@/lib/utils";
import { isWeb } from "@/lib/backend";
import { helper } from "@/lib/helper";
import { publishHelper, useHelperStatus } from "@/lib/helper-state";
import { closeWelcome } from "@/lib/welcome";
import { ACCENTS, Card, type Notice } from "@/components/ui/matte";
import { AppTile } from "@/components/ui/brand";

type Notify = (n: Omit<Notice, "id">, key?: string) => void;
type Step = "hello" | "helper" | "accent";
const STEPS: Step[] = isWeb ? ["hello", "accent"] : ["hello", "helper", "accent"];

function Point({ icon: IconCmp, title, text }: { icon: typeof Check; title: string; text: string }) {
  return (
    <li className="flex items-start gap-3.5">
      <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-white/[0.04] text-primary ring-1 ring-white/[0.07]">
        <IconCmp size={17} weight="light" />
      </span>
      <span className="min-w-0">
        <span className="block text-[14px] text-foreground">{title}</span>
        <span className="block text-[12.5px] leading-relaxed text-muted-foreground">{text}</span>
      </span>
    </li>
  );
}

const btn = "h-10 rounded-full px-5 text-[13px] transition-all duration-300 ease-fluid active:scale-[0.98] disabled:opacity-40";
const primary = cn(btn, "bg-foreground font-medium text-background");
const ghost = cn(btn, "bg-white/[0.05] text-foreground ring-1 ring-white/[0.08] hover:bg-white/[0.09]");

export function Welcome({ accent, onAccent, notify }: { accent: string; onAccent: (id: string) => void; notify: Notify }) {
  const [i, setI] = useState(0);
  const step = STEPS[i];
  const status = useHelperStatus();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && closeWelcome();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const next = () => (i < STEPS.length - 1 ? setI(i + 1) : closeWelcome());

  const turnOnHelper = async () => {
    if (!status || busy) return;
    setBusy(true);
    try {
      publishHelper(await helper.set({ ...status.settings, enabled: true }));
      next();
    } catch (e) {
      notify({ title: "SYNQ Helper wasn't turned on", detail: String(e), tone: "error" }, "helper");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[55] grid place-items-center bg-black/70 p-6 backdrop-blur-sm" role="dialog" aria-modal="true" aria-label="Welcome to SYNQ">
      <div className="w-full max-w-[640px]">
        <Card innerClassName="relative flex flex-col px-9 pb-7 pt-8">
          <button onClick={closeWelcome} className="absolute right-5 top-5 rounded-full px-3 py-1.5 text-[12.5px] text-muted-foreground transition-colors hover:bg-white/[0.06] hover:text-foreground">
            Skip setup
          </button>
          <div className="min-h-[330px]">
            <AnimatePresence mode="wait" initial={false}>
              <motion.div key={step} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }} transition={{ duration: 0.28, ease: [0.32, 0.72, 0, 1] }}>
                {step === "hello" && (
                  <>
                    <AppTile size={52} />
                    <h2 className="mt-5 text-[26px] font-semibold leading-tight tracking-[-0.03em] text-foreground">Welcome to SYNQ</h2>
                    <p className="label-mono mt-1.5">Every device. One system.</p>
                    <p className="mt-3 text-[13.5px] leading-relaxed text-muted-foreground">One app for all your gear, from your mouse to your lights. A minute of setup, and you can skip all of it.</p>
                    <ul className="mt-6 flex flex-col gap-4">
                      <Point icon={SlidersHorizontal} title="Settings live on your gear" text="What you change is written to the device itself, so it stays without SYNQ running." />
                      <Point icon={ShieldCheck} title="Careful by default" text="Every change is backed up first and read back after. Firmware is never touched." />
                      <Point icon={Waveform} title="Nothing in the background" text="SYNQ only runs while it's open, unless you turn on the optional Helper next." />
                    </ul>
                  </>
                )}
                {step === "helper" && (
                  <>
                    <span className="inline-flex rounded-full bg-white/[0.04] px-2.5 py-1 text-[11px] uppercase tracking-[0.16em] text-muted-foreground ring-1 ring-white/[0.06]">Optional</span>
                    <h2 className="mt-4 text-[26px] font-semibold leading-tight tracking-[-0.03em] text-foreground">Turn on SYNQ Helper?</h2>
                    <p className="mt-2 text-[13.5px] leading-relaxed text-muted-foreground">
                      A tiny background process with no window. It stays off unless you turn it on, and you can change your mind any time in Settings.
                    </p>
                    <ul className="mt-6 flex flex-col gap-4">
                      <Point icon={GameController} title="Game profiles" text="Your DPI, polling and key settings switch when a game starts, and go back when it closes." />
                      <Point icon={BatteryWarning} title="Battery alerts" text="A notification at 20%, 10% and 5%, once per charge." />
                      <Point icon={Globe} title="Website bridge" text="Lets the SYNQ website reach the EQ and Razer settings on this PC (this PC only, with your consent)." />
                    </ul>
                  </>
                )}
                {step === "accent" && (
                  <>
                    <h2 className="text-[26px] font-semibold leading-tight tracking-[-0.03em] text-foreground">Pick your accent</h2>
                    <p className="mt-2 text-[13.5px] leading-relaxed text-muted-foreground">The colour of whatever is on or selected. You can change it later in Settings.</p>
                    <div className="mt-7 flex flex-wrap gap-3">
                      {ACCENTS.map((a) => {
                        const on = accent === a.id;
                        return (
                          <button
                            key={a.id}
                            onClick={() => onAccent(a.id)}
                            aria-pressed={on}
                            className={cn(
                              "flex items-center gap-3 rounded-2xl py-2.5 pl-2.5 pr-5 text-[13px] ring-1 transition-colors duration-500 ease-fluid",
                              on ? "bg-white/[0.06] text-foreground ring-white/[0.16]" : "bg-white/[0.025] text-muted-foreground ring-white/[0.06] hover:bg-white/[0.05] hover:text-foreground",
                            )}
                          >
                            <span className="grid size-8 place-items-center rounded-full ring-1 ring-white/20" style={{ background: a.color }}>
                              {on && <Check size={15} weight="bold" className="text-black/70" />}
                            </span>
                            {a.label}
                          </button>
                        );
                      })}
                    </div>
                  </>
                )}
              </motion.div>
            </AnimatePresence>
          </div>

          <div className="mt-6 flex items-center gap-3">
            <div role="img" className="flex items-center gap-1.5" aria-label={`Step ${i + 1} of ${STEPS.length}`}>
              {STEPS.map((s, k) => (
                <span key={s} className={cn("h-1.5 rounded-full transition-all duration-500 ease-fluid", k === i ? "w-6 bg-primary" : "w-1.5 bg-white/15")} />
              ))}
            </div>
            <span className="flex-1" />
            {i > 0 && (
              <button onClick={() => setI(i - 1)} className={ghost}>
                Back
              </button>
            )}
            {step === "helper" ? (
              <>
                <button onClick={next} className={ghost}>
                  {status?.settings.enabled ? "Keep it on" : "Not now"}
                </button>
                {!status?.settings.enabled && (
                  <button onClick={() => void turnOnHelper()} disabled={!status || busy} className={primary}>
                    {busy ? "Turning on…" : "Turn it on"}
                  </button>
                )}
              </>
            ) : (
              <button onClick={next} className={primary}>
                {i === STEPS.length - 1 ? "Start" : "Next"}
              </button>
            )}
          </div>
        </Card>
      </div>
    </div>
  );
}
