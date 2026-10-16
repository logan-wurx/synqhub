// A lamp page's connection: opened when the page opens, let go when it closes, and in the desktop app and on the
// website also while the window is in the background (the bridge closes any lamp left open 3 s after the window loses
// focus: the backstop).
// One lamp, or every lamp of "All lamps" (a lamp that doesn't answer is listed; the others still work). Nothing is
// written here: the controller writes, and only when the person changes something.
import { useEffect, useState } from "react";
import { useWindowActive } from "../activity";
import { inTauri, isWeb } from "../backend";
import { LampController, LampGroup, type LampControl } from "./lamp.ts";
import { specOf } from "./govee/spec.ts";
import { openLamp } from "./link.ts";
import type { LampInfo } from "./models.ts";

export interface MissedLamp {
  lamp: LampInfo;
  why: string;
}

export type LampPhase =
  /** The lamp isn't in the scan list (yet): the page waits for it. */
  | { kind: "looking" }
  | { kind: "connecting" }
  | { kind: "ready"; control: LampControl; scheme: string; reached: readonly LampInfo[]; missed: readonly MissedLamp[] }
  /** No lamp answered: out of range, switched off at the wall, or held by a phone. */
  | { kind: "failed"; missed: readonly MissedLamp[] }
  /** The window is in the background: the lamps were let go and come back with it. */
  | { kind: "paused" }
  /** The link dropped while the page was open. */
  | { kind: "lost"; why: string };

const reason = (e: unknown) => String(e instanceof Error ? e.message : e).replace(/^Error: /, "");

/** `targets` are the lamps to open (null while they aren't known); the same ids keep the same connection. */
export function useLampSession(targets: readonly LampInfo[] | null): { phase: LampPhase; retry: () => void } {
  const [phase, setPhase] = useState<LampPhase>({ kind: targets ? "connecting" : "looking" });
  const [attempt, setAttempt] = useState(0);
  const active = useWindowActive();
  // The desktop app and the website hold a radio link, let go in the background so a phone can have the lamp (and a
  // background tab's slowed timers can't starve the keep-alive); the preview's simulated lamps stay put.
  const background = (inTauri || isWeb) && !active;
  const key = targets?.map((t) => t.id).join() ?? "";

  useEffect(() => {
    if (!targets?.length) {
      setPhase({ kind: "looking" });
      return;
    }
    if (background) {
      setPhase({ kind: "paused" });
      return;
    }
    let live = true;
    let control: LampControl | null = null;
    const offs: (() => void)[] = [];
    setPhase({ kind: "connecting" });
    void (async () => {
      const results = await Promise.allSettled(targets.map((t) => openLamp(t)));
      const links = results.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
      if (!live) {
        await Promise.all(links.map((l) => l.close()));
        return;
      }
      const missed = results.flatMap((r, i) => (r.status === "rejected" ? [{ lamp: targets[i], why: reason(r.reason) }] : []));
      if (!links.length) {
        setPhase({ kind: "failed", missed });
        return;
      }
      // Every listed lamp is a model the table has (the scan lists no other).
      const members = links.map((l) => new LampController(l, specOf(targets.find((t) => t.id === l.id)?.sku ?? "")!));
      const open = members.length === 1 ? members[0] : new LampGroup(members);
      control = open;
      for (const l of links)
        offs.push(
          l.onLost((why) => {
            if (!live) return;
            live = false;
            void open.close();
            setPhase({ kind: "lost", why });
          }),
        );
      open.refresh();
      setPhase({ kind: "ready", control: open, scheme: links[0].scheme, reached: targets.filter((t) => links.some((l) => l.id === t.id)), missed });
    })();
    return () => {
      live = false;
      offs.forEach((off) => off());
      void control?.close();
    };
    // `key` stands in for `targets` (the same lamps keep their connection when the list is refreshed).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, attempt, background]);

  return { phase, retry: () => setAttempt((n) => n + 1) };
}
