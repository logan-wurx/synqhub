// "This is in the desktop app": the short card the website shows in place of a feature a browser can't
// have (Sound / EQ, the Advanced actions) and for a device the browser can't drive. One link, one
// placeholder URL (src/lib/web/links.ts).
import { lazy, Suspense, type ReactNode } from "react";
import { Desktop, Plugs } from "@phosphor-icons/react";
import { cn } from "@/lib/utils";
import { Card, Eyebrow, type Notice } from "@/components/ui/matte";
import { DESKTOP_APP_URL } from "@/lib/web/links";
import { goSettings } from "@/lib/nav";
import { useHelperReady } from "@/lib/web/use-helper";

// The real Sound page, loaded only when SYNQ Helper is connected (a relative path: the "@/" one is the
// website's empty stand-in, see vite.web.config.ts).
const HelperEqPage = lazy(() => import("../eq/EqPage").then((m) => ({ default: m.EqPage })));

/** "Use SYNQ Helper": to the Settings card that connects it. */
export function HelperLink({ className }: { className?: string }) {
  return (
    <button
      type="button"
      onClick={() => goSettings()}
      data-slot="helper-link"
      className={cn("inline-flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-[12.5px] text-foreground ring-1 ring-white/10 transition-colors hover:bg-white/[0.06]", className)}
    >
      <Plugs size={14} />
      Use SYNQ Helper
    </button>
  );
}

export function DesktopLink({ className, children = "Get the desktop app" }: { className?: string; children?: ReactNode }) {
  return (
    <a
      href={DESKTOP_APP_URL}
      target="_blank"
      rel="noopener noreferrer"
      data-slot="desktop-app-link"
      className={cn("inline-flex items-center rounded-full bg-foreground px-3.5 py-1.5 text-[12.5px] font-medium text-background transition-transform duration-300 ease-fluid active:scale-[0.97]", className)}
    >
      {children}
    </a>
  );
}

/** A card with a one-line reason and the link. `title` names what is missing here. */
export function DesktopOnlyCard({ title, text, className }: { title: string; text: string; className?: string }) {
  return (
    <Card className={className} innerClassName="flex items-center gap-4 px-5 py-4">
      <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-white/[0.04] text-muted-foreground ring-1 ring-white/[0.07]">
        <Desktop size={20} weight="light" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-[14px] font-medium tracking-tight text-foreground">{title}</p>
        <p className="mt-0.5 text-[12.5px] leading-relaxed text-muted-foreground">{text}</p>
      </div>
      <div className="flex shrink-0 flex-col items-end gap-2">
        <DesktopLink />
        <HelperLink />
      </div>
    </Card>
  );
}

/** The Sound page on the website: the real one through SYNQ Helper, else a pointer to it and the app. */
export function WebSoundPage({ notify }: { notify: (n: Omit<Notice, "id">, key?: string) => void }) {
  const helper = useHelperReady();
  if (helper)
    return (
      <Suspense fallback={null}>
        <HelperEqPage notify={notify} />
      </Suspense>
    );
  return (
    <div className="flex h-full flex-col gap-5 overflow-y-auto px-8 pb-10 pt-7 [&>*]:shrink-0">
      <header>
        <Eyebrow>Desktop app</Eyebrow>
        <h1 className="mt-3 text-[34px] font-semibold leading-[1.05] tracking-[-0.035em] text-foreground">Sound</h1>
        <p className="mt-2 text-[13.5px] text-muted-foreground">The EQ, your presets and the engine on your output.</p>
      </header>
      <DesktopOnlyCard
        title="Install the helper to use this in the browser"
        text="A browser can't reach your system's audio. SYNQ Helper can: get it from Settings here (one small file for Windows, it installs itself) and this page finds it. Or use the EQ in the desktop app."
      />
    </div>
  );
}
