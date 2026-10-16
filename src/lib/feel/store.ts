// The feature's state: the saved feel, the list of devices SYNQ has already accounted for ("seen"), and
// the mouse and keyboard configured most recently. One small JSON document, kept by whatever `Persist` the
// app gives it (the desktop's app-data file, the browser's IndexedDB, or memory in the preview); the tests
// give it a stand-in. No React and no device access here.
import { emptyProfile, keyboardFeelOf, mouseFeelOf, profileOf } from "./profile.ts";
import type { FeelProfile, FeelSource, GameSens, KeyboardFeel, MouseFeel } from "./types.ts";

export type DeviceKind = "mouse" | "keyboard";

/** A mouse or keyboard that is plugged in now (the navigation id, `mouse:atk`, `kb:falchion`). */
export interface PresentDevice {
  id: string;
  kind: DeviceKind;
  name: string;
}

export interface Persist {
  load(): Promise<string | null>;
  save(json: string): Promise<void>;
}

interface Last {
  id: string;
  at: number;
}

export interface FeelDoc {
  version: 1;
  profile: FeelProfile | null;
  /** Device ids SYNQ has accounted for: a new mouse or keyboard is one that isn't here. */
  seen: string[];
  /** The seen list has been started. Until then every device found is simply taken as seen. */
  baselined: boolean;
  last: { mouse: Last | null; keyboard: Last | null };
}

export interface FeelState extends FeelDoc {
  /** The saved document has been read (or there was none). */
  loaded: boolean;
  /** Why the last save failed, when it did. */
  saveError: string | null;
}

const MAX_SEEN = 400;
const idOf = (v: unknown): string | null => (typeof v === "string" && v.length > 0 && v.length <= 80 ? v : null);

const lastOf = (v: unknown): Last | null => {
  const o = v && typeof v === "object" ? (v as Record<string, unknown>) : null;
  const id = o ? idOf(o.id) : null;
  return o && id && typeof o.at === "number" && Number.isFinite(o.at) ? { id, at: o.at } : null;
};

export function emptyDoc(): FeelDoc {
  return { version: 1, profile: null, seen: [], baselined: false, last: { mouse: null, keyboard: null } };
}

/** The stored document, with anything damaged dropped. */
export function docOf(text: string | null): FeelDoc {
  if (!text) return emptyDoc();
  try {
    const o = JSON.parse(text) as Record<string, unknown> | null;
    if (!o || typeof o !== "object" || o.version !== 1) return emptyDoc();
    const last = (o.last && typeof o.last === "object" ? o.last : {}) as Record<string, unknown>;
    return {
      version: 1,
      profile: profileOf(o.profile),
      seen: Array.isArray(o.seen) ? [...new Set(o.seen.map(idOf).filter((x): x is string => !!x))].slice(-MAX_SEEN) : [],
      baselined: o.baselined === true,
      last: { mouse: lastOf(last.mouse), keyboard: lastOf(last.keyboard) },
    };
  } catch {
    return emptyDoc();
  }
}

const docJson = (d: FeelDoc): string => JSON.stringify({ version: d.version, profile: d.profile, seen: d.seen, baselined: d.baselined, last: d.last });

const withSeen = (seen: readonly string[], ...ids: string[]): string[] => {
  const add = ids.filter((id) => !seen.includes(id));
  return add.length ? [...seen, ...add].slice(-MAX_SEEN) : (seen as string[]);
};

export interface FeelStore {
  getState(): FeelState;
  subscribe(listener: () => void): () => void;
  /** Reads the saved document (once). */
  ready(): Promise<void>;
  /** "Save as my feel": the mouse (or keyboard) part of the feel, taken from this device. */
  saveFrom(kind: "mouse", feel: MouseFeel, from: Omit<FeelSource, "savedAt">): Promise<void>;
  saveFrom(kind: "keyboard", feel: KeyboardFeel, from: Omit<FeelSource, "savedAt">): Promise<void>;
  setSens(sens: GameSens): Promise<void>;
  /** Forgets one part of the feel (or all of it with no kind). */
  forget(kind?: DeviceKind): Promise<void>;
  /** The list of devices plugged in changed: the first call starts the seen list; later ones settle devices nothing can be offered for. */
  observe(present: readonly PresentDevice[]): Promise<void>;
  /** The person dealt with this device (matched it, or said not now). */
  markSeen(id: string): Promise<void>;
  /** A change was written to this device just now. */
  noteConfigured(kind: DeviceKind, id: string): Promise<void>;
}

export function createFeelStore(persist: Persist | null, now: () => number = Date.now): FeelStore {
  let state: FeelState = { ...emptyDoc(), loaded: false, saveError: null };
  const listeners = new Set<() => void>();
  let loading: Promise<void> | null = null;
  let writing: Promise<void> = Promise.resolve();

  const emit = () => {
    for (const l of [...listeners]) l();
  };

  const ready = (): Promise<void> => {
    loading ??= (async () => {
      let doc = emptyDoc();
      try {
        doc = docOf(persist ? await persist.load() : null);
      } catch {
        // Unreadable storage: start empty, and say so on the first save that fails too.
      }
      state = { ...doc, loaded: true, saveError: null };
      emit();
    })();
    return loading;
  };

  /** Applies a change to the document, tells listeners, and writes it (writes never overlap). */
  const change = async (f: (d: FeelDoc) => FeelDoc | null): Promise<void> => {
    await ready();
    const next = f({ version: 1, profile: state.profile, seen: state.seen, baselined: state.baselined, last: state.last });
    if (!next) return;
    state = { ...next, loaded: true, saveError: null };
    emit();
    if (!persist) return;
    const json = docJson(next);
    writing = writing.then(async () => {
      try {
        await persist.save(json);
        if (state.saveError) {
          state = { ...state, saveError: null };
          emit();
        }
      } catch (e) {
        state = { ...state, saveError: String(e instanceof Error ? e.message : e) };
        emit();
      }
    });
    await writing;
  };

  const touch = (d: FeelDoc, f: (p: FeelProfile) => FeelProfile): FeelProfile => f(d.profile ?? emptyProfile(now()));

  return {
    getState: () => state,
    subscribe(l) {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    ready,
    saveFrom(kind: DeviceKind, feel: MouseFeel | KeyboardFeel, from: Omit<FeelSource, "savedAt">) {
      return change((d) => {
        const t = now();
        const source = { ...from, savedAt: t };
        const clean = kind === "mouse" ? mouseFeelOf(feel) : keyboardFeelOf(feel);
        if (!clean) return null;
        const profile = touch(d, (p) => ({
          ...p,
          updatedAt: t,
          mouse: kind === "mouse" ? { feel: clean as MouseFeel, from: source } : p.mouse,
          keyboard: kind === "keyboard" ? { feel: clean as KeyboardFeel, from: source } : p.keyboard,
        }));
        return { ...d, profile, seen: withSeen(d.seen, from.deviceId) };
      });
    },
    setSens(sens) {
      return change((d) => ({ ...d, profile: touch(d, (p) => ({ ...p, updatedAt: now(), sens })) }));
    },
    forget(kind) {
      return change((d) => {
        if (!d.profile) return null;
        const p = d.profile;
        const profile: FeelProfile = !kind ? emptyProfile(now()) : { ...p, updatedAt: now(), mouse: kind === "mouse" ? null : p.mouse, keyboard: kind === "keyboard" ? null : p.keyboard };
        return { ...d, profile };
      });
    },
    observe(present) {
      return change((d) => {
        const part = (k: DeviceKind) => (k === "mouse" ? d.profile?.mouse : d.profile?.keyboard);
        // The first look: everything plugged in now is old news. Afterwards a device is settled at once when there is
        // no feel to offer it, and stays unseen (an offer) when there is.
        const settle = d.baselined ? present.filter((x) => !part(x.kind)).map((x) => x.id) : present.map((x) => x.id);
        const seen = withSeen(d.seen, ...settle);
        return seen === d.seen && d.baselined ? null : { ...d, seen, baselined: true };
      });
    },
    markSeen(id) {
      return change((d) => (d.seen.includes(id) ? null : { ...d, seen: withSeen(d.seen, id) }));
    },
    noteConfigured(kind, id) {
      return change((d) => {
        const cur = d.last[kind];
        // Seconds are enough: this is called after every write, and a burst is one configuring.
        if (cur?.id === id && now() - cur.at < 2000) return null;
        return { ...d, last: { ...d.last, [kind]: { id, at: now() } } };
      });
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Questions the pages ask of the state (pure)
// ---------------------------------------------------------------------------------------------

/** Devices plugged in that SYNQ hasn't seen and the saved feel has something for: the "Match your setup?" offers. */
export function pendingOffers(state: Pick<FeelDoc, "baselined" | "seen" | "profile">, present: readonly PresentDevice[]): PresentDevice[] {
  if (!state.baselined || !state.profile) return [];
  const p = state.profile;
  return present.filter((d) => !state.seen.includes(d.id) && !!(d.kind === "mouse" ? p.mouse : p.keyboard));
}

export const isOffered = (state: Pick<FeelDoc, "baselined" | "seen" | "profile">, d: PresentDevice): boolean => pendingOffers(state, [d]).length === 1;

/**
 * Which device to suggest saving the feel from: the one configured most recently if it is here and its settings
 * are known, else the first that is known. `known` says whether a device's panel has read it this session.
 */
export function suggestSource(state: Pick<FeelDoc, "last">, kind: DeviceKind, present: readonly PresentDevice[], known: (id: string) => boolean): PresentDevice | null {
  const candidates = present.filter((d) => d.kind === kind && known(d.id));
  const last = state.last[kind];
  return candidates.find((d) => d.id === last?.id) ?? candidates[0] ?? null;
}
