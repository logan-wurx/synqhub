// State that outlives the component showing it. The Mouse and Keyboard pages unmount when they're
// not on screen, so their DOM, layout and pictures can go; what the person was doing on them lives
// here, keyed by name, and is there again exactly as it was when the page comes back.
// Nothing here talks to a device; device sessions are kept by src/lib/device-session.ts.
import { useCallback, useEffect, useRef, useSyncExternalStore, type Dispatch, type RefObject, type SetStateAction } from "react";

const values = new Map<string, unknown>();
const refs = new Map<string, { current: unknown }>();
const listeners = new Map<string, Set<() => void>>();

function emit(key: string) {
  const set = listeners.get(key);
  if (set) for (const l of [...set]) l();
}

/** The kept value under `key`, or `fallback` when there's none. */
export function peekKept<T>(key: string, fallback: T): T {
  return values.has(key) ? (values.get(key) as T) : fallback;
}

/** Sets a kept value, also while no component shows it (an answer that arrives after the page closed). */
export function setKept<T>(key: string, next: SetStateAction<T>): void {
  const prev = values.get(key) as T;
  const value = typeof next === "function" ? (next as (p: T) => T)(prev) : next;
  if (values.has(key) && Object.is(value, prev)) return;
  values.set(key, value);
  emit(key);
}

/** Forgets everything kept under `prefix` (values and refs) so the next mount starts fresh. */
export function forgetKept(prefix: string): void {
  for (const k of [...values.keys()]) if (k.startsWith(prefix) && !listeners.get(k)?.size) values.delete(k);
  for (const k of [...refs.keys()]) if (k.startsWith(prefix)) refs.delete(k);
}

/** useState that survives unmounting: same value and setter semantics, kept under `key`. */
export function useKeptState<T>(key: string, init: T | (() => T)): [T, Dispatch<SetStateAction<T>>] {
  if (!values.has(key)) values.set(key, typeof init === "function" ? (init as () => T)() : init);
  const subscribe = useCallback(
    (l: () => void) => {
      let set = listeners.get(key);
      if (!set) listeners.set(key, (set = new Set()));
      set.add(l);
      return () => {
        set.delete(l);
      };
    },
    [key],
  );
  const value = useSyncExternalStore(subscribe, () => values.get(key) as T);
  const set = useCallback((next: SetStateAction<T>) => setKept(key, next), [key]);
  return [value, set];
}

/** Several kept values at once, read only (`undefined` where nothing is kept): a view over many pages' state, like the
 * Gear home's live numbers. The same array comes back until one of the values changes. */
export function useKeptValues(keys: readonly string[]): readonly unknown[] {
  const joined = keys.join("\n");
  const subscribe = useCallback(
    (l: () => void) => {
      const sets = joined.split("\n").map((k) => {
        let set = listeners.get(k);
        if (!set) listeners.set(k, (set = new Set()));
        set.add(l);
        return set;
      });
      return () => sets.forEach((set) => set.delete(l));
    },
    [joined],
  );
  const last = useRef<readonly unknown[]>([]);
  const snapshot = () => {
    const next = keys.map((k) => values.get(k));
    const prev = last.current;
    if (prev.length === next.length && prev.every((v, i) => Object.is(v, next[i]))) return prev;
    return (last.current = next);
  };
  return useSyncExternalStore(subscribe, snapshot);
}

/** What a kept ref holds now (null when none was made), read from outside the component that keeps it. */
export function peekKeptRef<T>(key: string): T | null {
  return (refs.get(key)?.current as T | undefined) ?? null;
}

/** useRef that survives unmounting: every mount gets the same object. */
export function useKeptRef<T>(key: string, init: T): RefObject<T> {
  let r = refs.get(key);
  if (!r) refs.set(key, (r = { current: init }));
  return r as RefObject<T>;
}

/**
 * A draft seeded from saved values, like `useState(seed)` plus `useEffect(() => setDraft(seed),
 * [seedKey])`, but kept across unmounts: coming back to the page shows the same draft unless what
 * it was seeded from changed meanwhile.
 */
export function useKeptDraft<T>(key: string, seed: T, seedKey: string): [T, Dispatch<SetStateAction<T>>] {
  const [box, setBox] = useKeptState<{ k: string; v: T }>(key, () => ({ k: seedKey, v: seed }));
  const fresh = box.k === seedKey;
  const value = fresh ? box.v : seed;
  useEffect(() => {
    if (!fresh) setBox({ k: seedKey, v: seed });
    // seed is read when seedKey changes, as with the plain useState + effect it replaces.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fresh, seedKey]);
  const set = useCallback(
    (next: SetStateAction<T>) =>
      setBox((b) => {
        const cur = b.k === seedKey ? b.v : seed;
        return { k: seedKey, v: typeof next === "function" ? (next as (p: T) => T)(cur) : next };
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [seedKey, setBox],
  );
  return [value, set];
}

/**
 * Keeps a scroll container's position across unmounts. Returns a ref callback for the element
 * that scrolls: the position is put back when it mounts and noted as it scrolls.
 */
export function useKeptScroll(key: string): (el: HTMLElement | null) => void {
  const cleanup = useRef<(() => void) | null>(null);
  return useCallback(
    (el: HTMLElement | null) => {
      cleanup.current?.();
      cleanup.current = null;
      if (!el) return;
      const top = peekKept(key, 0);
      if (top) el.scrollTop = top;
      const onScroll = () => values.set(key, el.scrollTop);
      el.addEventListener("scroll", onScroll, { passive: true });
      cleanup.current = () => el.removeEventListener("scroll", onScroll);
    },
    [key],
  );
}
