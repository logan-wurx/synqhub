// The website's "Add a light" button. A site reaches a Bluetooth lamp only after the person picks it in the browser's
// own chooser, so this opens it, filtered to the names Govee lamps advertise with (src/lib/lighting/web/link.ts). The
// lamp picked opens on its page, which connects to it; nothing is sent to a lamp until the person changes something.
import { useEffect, useRef, useState } from "react";
import { Plus } from "@phosphor-icons/react";
import { cn } from "@/lib/utils";
import type { Notice } from "@/components/ui/matte";
import { refreshLamps } from "@/lib/lighting/lamps";
import { lampTitle } from "@/lib/lighting/models";
import { lightId, openDevice } from "@/lib/nav";

type Notify = (n: Omit<Notice, "id">, key?: string) => void;
type LinkModule = typeof import("@/lib/lighting/web/link");

export function AddLightButton({ notify, className, label = "Add a light" }: { notify: Notify; className?: string; label?: string }) {
  // The chooser code loads when the button appears, so the click itself has nothing to wait for.
  const link = useRef<LinkModule | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void import("@/lib/lighting/web/link").then((m) => (link.current = m));
  }, []);

  const add = async () => {
    // The chooser has to be the first thing the click does (the browser needs the click for it).
    const mod = link.current ?? (await import("@/lib/lighting/web/link"));
    setBusy(true);
    try {
      const r = await mod.pickLamp();
      if (r.status === "cancelled") return;
      if (r.status === "blocked") return notify({ title: "Couldn't open the Bluetooth list", detail: r.message, tone: "error" }, "add-light");
      if (r.status === "unsupported")
        return notify({ title: "Not a light SYNQ drives yet", detail: `${r.name}: nothing was sent to it.`, tone: "info" }, "add-light");
      await refreshLamps();
      notify({ title: `Added ${lampTitle(r.lamp)}`, detail: "Connecting to it now.", tone: "ok" }, "add-light");
      openDevice(lightId(r.lamp.id));
    } finally {
      setBusy(false);
    }
  };

  return (
    <button
      type="button"
      onClick={() => void add()}
      disabled={busy}
      data-slot="add-light"
      className={cn(
        "inline-flex items-center gap-2 rounded-full bg-foreground px-4 py-2 text-[13px] font-medium text-background transition-[transform,opacity] duration-300 ease-fluid active:scale-[0.97] disabled:opacity-50",
        className,
      )}
    >
      <Plus size={15} weight="bold" />
      {label}
    </button>
  );
}
