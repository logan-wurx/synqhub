// The website's way into SYNQ's Discord (src/lib/web/links.ts): a line under the section headline, in the same type
// as Keep your feel, and a panel on Settings.
import { ArrowUpRight, DiscordLogo } from "@phosphor-icons/react";
import { DISCORD_URL } from "@/lib/web/links";

const SAID = "Bugs, device requests and release news.";

/** Under the headline on the section homes. */
export function DiscordLink() {
  return (
    <a href={DISCORD_URL} target="_blank" rel="noopener noreferrer" className="group flex items-center gap-6 text-left" data-slot="discord-link">
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2.5 text-[26px] font-bold tracking-[-0.035em] text-high">
          <DiscordLogo size={26} weight="light" className="shrink-0" />
          Join the Discord
        </span>
        <span className="mt-0.5 block text-[16px] text-medium">{SAID}</span>
      </span>
      <ArrowUpRight size={34} weight="thin" className="shrink-0 text-high transition-transform duration-500 ease-fluid group-hover:-translate-y-1 group-hover:translate-x-1" />
    </a>
  );
}

/** Settings, where the desktop app has its welcome tour. */
export function DiscordPanel() {
  return (
    <section aria-label="Discord" className="panel flex items-center gap-4 rounded-card px-6 py-5" data-slot="discord-panel">
      <span className="grid size-11 shrink-0 place-items-center rounded-control bg-white/[0.06] text-high ring-1 ring-white/[0.1]">
        <DiscordLogo size={20} weight="light" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-[15px] font-semibold text-high">SYNQ on Discord</p>
        <p className="text-[12.5px] text-medium">{SAID}</p>
      </div>
      <a href={DISCORD_URL} target="_blank" rel="noopener noreferrer" className="shrink-0 rounded-control bg-foreground px-4 py-2 text-[13px] font-medium text-background transition-transform duration-300 ease-fluid active:scale-[0.97]">
        Join
      </a>
    </section>
  );
}
