// The website's "Add device" button. A browser only talks to a HID device the person has picked in its own
// chooser, so this opens it, with filters built from the driver registries (src/lib/web/policy.ts). One
// chooser per click: Chromium 153+ uses up the click in requestDevice(), so the button never opens a second
// one. After the pick it says what the website can do with each device (src/lib/web/availability.ts).
import { useEffect, useRef, useState } from "react";
import { Plus } from "@phosphor-icons/react";
import { cn } from "@/lib/utils";
import type { Notice } from "@/components/ui/matte";
import { setPicked, type PickedNote } from "@/lib/web/notes";
import { useHelperReady } from "@/lib/web/use-helper";

type Notify = (n: Omit<Notice, "id">, key?: string) => void;
type HidModule = typeof import("@/lib/web/hid");

export function AddDeviceButton({ notify, className, label = "Add device" }: { notify: Notify; className?: string; label?: string }) {
  // The chooser code loads when the button appears, so the click itself has nothing to wait for.
  const hid = useRef<HidModule | null>(null);
  const [busy, setBusy] = useState(false);
  // With SYNQ Helper connected every device on this PC is listed already: no browser chooser.
  const helper = useHelperReady();
  useEffect(() => {
    void import("@/lib/web/hid").then((m) => (hid.current = m));
  }, []);

  const add = async () => {
    // The chooser has to be the first thing the click does (its gesture is used up by it).
    const mod = hid.current ?? (await import("@/lib/web/hid"));
    setBusy(true);
    try {
      const r = await mod.pickDevices();
      if (r.status === "cancelled") return;
      if (r.status === "blocked") {
        notify({ title: "Couldn't open the device list", detail: r.message, tone: "error" }, "add-device");
        return;
      }
      const notes: PickedNote[] = r.devices.map((d) =>
        d.availability.status === "desktop"
          ? { name: d.name, status: "desktop", title: d.availability.title, message: d.availability.message }
          : d.known
            ? { name: d.name, status: "ok", title: "Added", message: "It shows up on this page. The browser remembers it for next time." }
            : { name: d.name, status: "unknown", title: "Not driven by SYNQ yet", message: "The browser let it in, but SYNQ has no driver for it. Nothing is sent to it." },
      );
      setPicked(notes);
      const ok = notes.filter((n) => n.status === "ok").length;
      if (ok) notify({ title: ok === 1 ? `Added ${notes.find((n) => n.status === "ok")!.name}` : `Added ${ok} devices`, tone: "ok" }, "add-device");
    } finally {
      setBusy(false);
    }
  };

  if (helper) return null;
  return (
    <button
      type="button"
      onClick={() => void add()}
      disabled={busy}
      data-slot="add-device"
      className={cn(
        "inline-flex items-center gap-2 rounded-control bg-foreground px-4 py-2 text-[13px] font-medium text-background transition-[transform,opacity] duration-300 ease-fluid active:scale-[0.97] disabled:opacity-50",
        className,
      )}
    >
      <Plus size={14} weight="bold" />
      {label}
    </button>
  );
}
