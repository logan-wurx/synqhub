// The top of every mouse's Overview (the shared OverviewStrip): the mouse, how it's connected, what it reports
// (the battery as a cell, lift-off unless the console sets it), its firmware and sensor on one quiet line, and "Keep your feel" as a line with two
// small actions. The Sensitivity console sits under it on the same page (most people come to change the DPI and go)
// with the polling rate's switch beside the speed, so the card repeats neither.
import type { ReactNode } from "react";
import { FeelCard, FeelOffer, type FeelDevice } from "@/components/feel/FeelPanel";
import { OverviewStrip, type Stat } from "@/components/devices/shell";

export function MouseOverview({
  art,
  link,
  detail,
  badges,
  stats,
  battery,
  feel,
  pollingInConsole = false,
  liftOffInConsole = false,
}: {
  art: ReactNode;
  link: string | null;
  name: string;
  detail?: ReactNode;
  badges?: ReactNode;
  stats: Stat[];
  battery: { show: boolean; percent: number | null; charging: boolean; state: string; title: string; rows: [string, ReactNode][] };
  /** "Keep your feel": the new-mouse offer sits on top, the saved feel as a line in the card. */
  feel?: FeelDevice;
  /** The polling rate is set from the console's switch, so the card leaves it out. */
  pollingInConsole?: boolean;
  /** Lift-off is set from the console too, so the card leaves it out. */
  liftOffInConsole?: boolean;
}) {
  return (
    <>
      {feel && <FeelOffer {...feel} />}
      <OverviewStrip
        art={art}
        connection={link}
        detail={detail}
        badges={badges}
        stats={stats.filter((s) => s.label !== "DPI" && s.label !== "Battery" && !(pollingInConsole && s.label === "Polling") && !(liftOffInConsole && s.label === "Lift-off"))}
        battery={battery.show ? { percent: battery.percent, charging: battery.charging, state: battery.state } : null}
        line={feel && <FeelCard {...feel} compact />}
        facts={battery.rows}
      />
    </>
  );
}
