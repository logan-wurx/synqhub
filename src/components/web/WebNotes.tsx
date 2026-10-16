// What the Devices home adds on the website: the confirmation after "Add device" (what the browser can do
// with what was picked), and a card for every device the browser has but SYNQ can't drive here (a Razer
// on Windows Chromium 153+, a device with no driver), each with the reason and a way out.
import { useSyncExternalStore } from "react";
import { CheckCircle, Desktop, Question, X } from "@phosphor-icons/react";
import { cn } from "@/lib/utils";
import { Card } from "@/components/ui/matte";
import { getPicked, getWebNotes, setPicked, subscribePicked, subscribeWebNotes, type WebNote } from "@/lib/web/notes";
import { DesktopLink, HelperLink } from "./DesktopCard";

export function WebPicked() {
  const picked = useSyncExternalStore(subscribePicked, getPicked);
  if (!picked.length) return null;
  return (
    <section data-slot="web-picked" className="flex flex-col gap-2.5">
      {picked.map((p, i) => (
        <div
          key={`${p.name}-${i}`}
          className={cn(
            "flex items-start gap-3 rounded-2xl px-4 py-3 text-[13px] leading-relaxed ring-1",
            p.status === "ok" ? "bg-white/[0.03] ring-white/[0.07]" : "bg-chart-3/[0.06] ring-chart-3/20",
          )}
        >
          {p.status === "ok" ? <CheckCircle size={18} weight="light" className="mt-0.5 shrink-0 text-primary" /> : p.status === "desktop" ? <Desktop size={18} weight="light" className="mt-0.5 shrink-0 text-chart-3" /> : <Question size={18} weight="light" className="mt-0.5 shrink-0 text-chart-3" />}
          <div className="min-w-0 flex-1">
            <p className="text-foreground">
              {p.name}
              <span className="ml-2 text-muted-foreground">{p.title}</span>
            </p>
            <p className="text-[12.5px] text-muted-foreground">{p.message}</p>
            {p.status === "desktop" && (
              <div className="mt-2 flex flex-wrap gap-2">
                <HelperLink />
                <DesktopLink />
              </div>
            )}
          </div>
          <button type="button" aria-label="Dismiss" onClick={() => setPicked(getPicked().filter((_, k) => k !== i))} className="grid size-7 shrink-0 place-items-center rounded-full text-muted-foreground transition-colors hover:bg-white/[0.06] hover:text-foreground">
            <X size={14} />
          </button>
        </div>
      ))}
    </section>
  );
}

function NoteCard({ note }: { note: WebNote }) {
  const remove = () => {
    const [vid, pid] = note.id.split(":").map((h) => parseInt(h, 16));
    void import("@/lib/web/hid").then((m) => m.forgetDevice(vid, pid));
  };
  return (
    <Card innerClassName="flex flex-col p-5" className="h-full">
      <div className="grid h-[88px] place-items-center text-muted-foreground/80">
        <Desktop size={44} weight="light" />
      </div>
      <p className="mt-3 truncate text-[16px] font-medium tracking-tight text-foreground">{note.name}</p>
      <p className="mt-0.5 text-[12.5px] font-medium text-chart-3">{note.title}</p>
      <p className="mt-1 text-[12.5px] leading-relaxed text-muted-foreground">{note.message}</p>
      <div className="mt-4 flex items-center gap-2 border-t border-white/[0.05] pt-3.5">
        {note.kind === "desktop" && (
          <>
            <HelperLink />
            <DesktopLink />
          </>
        )}
        <button type="button" onClick={remove} className="rounded-full px-3 py-1.5 text-[12.5px] text-muted-foreground ring-1 ring-white/10 transition-colors hover:bg-white/[0.06] hover:text-foreground">
          Remove from this browser
        </button>
      </div>
    </Card>
  );
}

/** The cards for devices the website can't drive. They sit in the same grid as the device cards. */
export function WebNoteCards() {
  const notes = useSyncExternalStore(subscribeWebNotes, getWebNotes);
  return (
    <>
      {notes.map((n) => (
        <div key={n.id} className="h-full" data-slot="web-note">
          <NoteCard note={n} />
        </div>
      ))}
    </>
  );
}
