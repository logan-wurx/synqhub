// The Overview tab every mouse shares: the pointer speed big inside a dial with the mouse floating beside it, the
// "Current status" strip (polling, lift-off, battery) and a battery + firmware card.
import type { ReactNode } from "react";
import { Card, DetailRows } from "@/components/ui/matte";
import { OverviewHero, StatusPill, StatusStrip, useAside, type Stat } from "@/components/devices/shell";
import { FeelCard, FeelOffer, type FeelDevice } from "@/components/feel/FeelPanel";
import { cn } from "@/lib/utils";
import { BatteryRing } from "./parts";

export function MouseOverview({
  art,
  link,
  name,
  detail,
  badges,
  stats,
  battery,
  feel,
}: {
  art: ReactNode;
  link: string | null;
  name: string;
  detail?: ReactNode;
  badges?: ReactNode;
  stats: Stat[];
  battery: { show: boolean; percent: number | null; charging: boolean; state: string; title: string; rows: [string, ReactNode][] };
  /** "Keep your feel": the new-mouse offer sits on top, the save / copy card under the status. */
  feel?: FeelDevice;
}) {
  // The DPI goes in the dial; the strip keeps the rest.
  const dpiStat = stats.find((s) => s.label === "DPI");
  const dpi = typeof dpiStat?.value === "number" && dpiStat.value > 0 ? dpiStat.value : null;
  return (
    <>
      {feel && <FeelOffer {...feel} />}
      {dpi === null ? (
        <OverviewHero art={art} live connection={link} name={name} detail={detail} badges={badges} />
      ) : (
        <DpiHero dpi={dpi} art={art} link={link} detail={detail} badges={badges} />
      )}
      <StatusStrip stats={dpi === null ? stats : stats.filter((s) => s !== dpiStat)} />
      {feel && <FeelCard {...feel} />}
      <Card innerClassName="flex items-center gap-6 px-6 py-5">
        {battery.show && <BatteryRing percent={battery.percent} charging={battery.charging} />}
        <div className="min-w-0 flex-1">
          <p className="text-[13px] text-muted-foreground">{battery.title}</p>
          <p className="mt-1 text-[15px] text-foreground">{battery.state}</p>
          <div className="mt-3">
            <DetailRows rows={battery.rows} />
          </div>
        </div>
      </Card>
    </>
  );
}

/** The dial's range, on a log scale so the usual 400 to 3200 sit in the middle of the ring. */
const DIAL_MIN = 100;
const DIAL_MAX = 32000;

/** The pointer speed, big, inside a ring that fills with it; the mouse floats beside it. Shows, doesn't set (Sensitivity does). */
function DpiHero({ dpi, art, link, detail, badges }: { dpi: number; art: ReactNode; link: string | null; detail?: ReactNode; badges?: ReactNode }) {
  const aside = useAside();
  const share = Math.min(1, Math.max(0.02, Math.log(dpi / DIAL_MIN) / Math.log(DIAL_MAX / DIAL_MIN)));
  const r = 140;
  const around = 2 * Math.PI * r;
  const angle = share * 2 * Math.PI - Math.PI / 2;
  return (
    <Card innerClassName={cn("relative flex overflow-hidden", aside ? "flex-col items-center gap-2 px-6 py-7" : "items-center gap-10 px-10 py-8")}>
      <div className={cn("relative shrink-0", aside ? "size-[260px]" : "size-[300px]")}>
        <svg viewBox="0 0 300 300" className="absolute inset-0 size-full" aria-hidden="true">
          <circle cx="150" cy="150" r={r} fill="none" stroke="rgb(255 255 255 / 0.08)" strokeWidth="2" />
          <circle
            cx="150"
            cy="150"
            r={r}
            fill="none"
            stroke="var(--glow-a)"
            strokeWidth="5"
            strokeLinecap="round"
            strokeDasharray={`${share * around} ${around}`}
            transform="rotate(-90 150 150)"
            className="transition-[stroke-dasharray] duration-700 ease-fluid"
          />
          {[0, 1, 2, 3, 4, 5, 6, 7].map((i) => {
            const a = (i / 8) * 2 * Math.PI;
            return <line key={i} x1={150 + Math.sin(a) * 128} y1={150 - Math.cos(a) * 128} x2={150 + Math.sin(a) * 120} y2={150 - Math.cos(a) * 120} stroke="rgb(255 255 255 / 0.22)" strokeWidth="1.5" />;
          })}
          <circle cx={150 + Math.cos(angle) * r} cy={150 + Math.sin(angle) * r} r="7" fill="var(--foreground)" />
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <p className="label-mono tracking-[0.12em]">Pointer speed</p>
          <p className="display-num mt-1 text-[clamp(64px,6.4vw,92px)] tracking-[-0.06em] text-foreground">{dpi.toLocaleString("en-US")}</p>
          <p className="mt-2 font-mono text-[12.5px] text-muted-foreground">DPI</p>
        </div>
      </div>
      <div className={cn("min-w-0", aside ? "flex w-full flex-col items-center gap-4" : "flex flex-1 items-center gap-8")}>
        <div className={cn("flex items-center justify-center [&>img]:max-h-full [&>img]:max-w-full [&>img]:drop-shadow-[0_30px_40px_rgb(0_0_0/0.5)] [&>svg]:max-h-full", aside ? "h-[150px] w-full" : "order-last h-[230px] w-[44%] shrink-0 -rotate-[8deg]")}>{art}</div>
        <div className={cn("min-w-0", aside ? "text-center" : "flex-1")}>
          <StatusPill live>{`Connected${link ? ` · ${link}` : ""}`}</StatusPill>
          {detail && <div className="mt-3 max-w-[420px] text-[13px] leading-relaxed text-muted-foreground">{detail}</div>}
          {badges && <div className={cn("mt-4 flex flex-wrap items-center gap-2", aside && "justify-center")}>{badges}</div>}
        </div>
      </div>
    </Card>
  );
}
