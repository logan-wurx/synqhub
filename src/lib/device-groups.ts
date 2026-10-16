// How the Devices home groups its cards: kinds that read as one group ("Sound" is the EQ output and any headset), the
// order the groups come in, and when a list is long and mixed enough to be worth filtering. Pure; the filter itself is
// src/components/devices/KindFilter.tsx.

/** The filter appears from this many cards… */
export const MIN_CARDS = 7;
/** …of at least this many groups. */
export const MIN_GROUPS = 3;

const GROUPS: Readonly<Record<string, { id: string; label: string }>> = {
  mouse: { id: "mice", label: "Mice" },
  keyboard: { id: "keyboards", label: "Keyboards" },
  sound: { id: "sound", label: "Sound" },
  headset: { id: "sound", label: "Sound" },
  controller: { id: "controllers", label: "Controllers" },
  light: { id: "lights", label: "Lights" },
  lamparray: { id: "lights", label: "Lights" },
  rgbhub: { id: "lights", label: "Lights" },
  monitor: { id: "monitors", label: "Monitors" },
  webcam: { id: "webcams", label: "Webcams" },
};

/** The order groups are listed in; a group not listed here comes last. */
const ORDER = ["mice", "keyboards", "sound", "controllers", "lights", "monitors", "webcams"];

/** The app's top-level sections, each a tab in the sidebar: Devices (what you hold and hear), Lights, Displays. */
export type Section = "devices" | "lights" | "displays";
const SECTION: Readonly<Record<string, Section>> = { light: "lights", lamparray: "lights", rgbhub: "lights", monitor: "displays" };
/** The section a kind of device lives in; anything not listed is a Devices card. */
export const sectionOf = (kind: string): Section => SECTION[kind] ?? "devices";

/** A kind's group; a kind not listed is its own group, named after it. */
export const groupOf = (kind: string) => GROUPS[kind] ?? { id: kind, label: kind.charAt(0).toUpperCase() + kind.slice(1) + "s" };
const rank = (id: string) => (ORDER.includes(id) ? ORDER.indexOf(id) : ORDER.length);

/** The entries in group order, keeping the order they came in within a group. */
export function byGroup<T extends { kind: string }>(entries: readonly T[]): T[] {
  return entries
    .map((e, i) => ({ e, i, r: rank(groupOf(e.kind).id) }))
    .sort((a, b) => a.r - b.r || a.i - b.i)
    .map((x) => x.e);
}

export interface Group {
  id: string;
  label: string;
  /** Devices in the group (a card for several, like "All lamps", is not one). */
  n: number;
}

/** The groups present, in order, with how many devices each has; `counts` says whether a card is a device of its own. */
export function groupsIn<T extends { kind: string }>(entries: readonly T[], counts: (e: T) => boolean = () => true): Group[] {
  const groups = new Map<string, Group>();
  for (const e of entries) {
    const g = groupOf(e.kind);
    const c = groups.get(g.id) ?? groups.set(g.id, { ...g, n: 0 }).get(g.id)!;
    if (counts(e)) c.n++;
  }
  return [...groups.values()].sort((a, b) => rank(a.id) - rank(b.id));
}

/** What the filter shows for a pick: whether it is offered at all, the pick in effect ("all" when the picked group is gone or the list is short), and the entries to draw. */
export function filterEntries<T extends { kind: string }>(entries: readonly T[], picked: string, counts?: (e: T) => boolean) {
  const groups = groupsIn(entries, counts);
  const offered = entries.length >= MIN_CARDS && groups.length >= MIN_GROUPS;
  const value = offered && groups.some((g) => g.id === picked) ? picked : "all";
  return { offered, groups, value, shown: value === "all" ? [...entries] : entries.filter((e) => groupOf(e.kind).id === value) };
}
