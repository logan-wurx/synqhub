// The website's Gear page before anything is added: two steps side by side. First the mouse or keyboard (the browser's
// own device list; it remembers the pick), then SYNQ Helper for what a browser can't reach, with its steps lit as
// they're done. Shown until a mouse or keyboard is added; the helper step says it's connected once it is.
import { ShieldCheck } from "@phosphor-icons/react";
import type { Notice } from "@/components/ui/matte";
import { PlugIn } from "@/components/ui/brand";
import { AddDeviceButton } from "./AddDevice";
import { HelperSteps, useHelperOffer } from "./HelperConnect";

type Notify = (n: Omit<Notice, "id">, key?: string) => void;

export function WebStart({ notify }: { notify: Notify }) {
  const offer = useHelperOffer();
  return (
    <section aria-label="Get started" className="grid grow gap-4 min-[1180px]:min-h-[calc(100dvh-236px)] min-[1180px]:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)]">
      <div className="tile relative flex flex-col overflow-hidden rounded-card px-7 pb-7 pt-6">
        <span className="label-caps">Step 1</span>
        <h2 className="mt-2 text-[30px] font-bold leading-tight tracking-[-0.04em] text-high">Add your mouse or keyboard</h2>
        <p className="mt-2 max-w-[44ch] text-[14px] leading-relaxed text-medium">Plug it in (a receiver or a cable), press Add device and pick it in the browser's list. The browser remembers it for next time.</p>
        <div className="grid min-h-[120px] flex-1 place-items-center py-4">
          <PlugIn kind="mouse" className="h-full max-h-[200px] w-auto max-w-full" />
        </div>
        <AddDeviceButton notify={notify} className="self-start" label="Add device" />
        <p className="mt-3 text-[12px] text-faint">Chrome, Edge or Opera on a computer.</p>
      </div>
      <div className="tile relative flex flex-col overflow-hidden rounded-card px-7 pb-7 pt-6">
        <span className="label-caps">Step 2 · optional</span>
        <h2 className="mt-2 text-[30px] font-bold leading-tight tracking-[-0.04em] text-high">{offer.ready ? "SYNQ Helper is connected" : "Unlock the rest with SYNQ Helper"}</h2>
        <p className="mt-2 max-w-[56ch] text-[14px] leading-relaxed text-medium">
          {offer.ready ? "Every device on this PC is listed through it, the EQ included." : "A light tray app for this PC. It lets this page reach what a browser can't, with the same checks as the desktop app."}
        </p>
        <div className="mt-5 flex-1">
          <HelperSteps offer={offer} />
        </div>
        <p className="mt-5 flex items-center gap-2 text-[12px] text-medium">
          <ShieldCheck size={12} className="text-primary" />
          No account. Your devices and settings never leave this PC. Firmware is never touched.
        </p>
      </div>
    </section>
  );
}
