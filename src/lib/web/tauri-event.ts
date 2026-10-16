// The website's stand-in for @tauri-apps/api/event (vite.web.config.ts aliases the package to this
// file). The keyboard and X68 HE services listen for "hid-input" and "hid-lost"; on the website the
// events come from WebHID input reports and disconnects (src/lib/web/tauri-core.ts emits them).
export type UnlistenFn = () => void;

export interface TauriEvent<T> {
  event: string;
  payload: T;
}

const handlers = new Map<string, Set<(e: TauriEvent<never>) => void>>();

export async function listen<T>(event: string, handler: (e: TauriEvent<T>) => void): Promise<UnlistenFn> {
  let set = handlers.get(event);
  if (!set) handlers.set(event, (set = new Set()));
  const h = handler as unknown as (e: TauriEvent<never>) => void;
  set.add(h);
  return () => void set.delete(h);
}

export function emit<T>(event: string, payload: T): void {
  for (const h of [...(handlers.get(event) ?? [])]) {
    try {
      (h as unknown as (e: TauriEvent<T>) => void)({ event, payload });
    } catch (e) {
      console.warn(`[onboard web] ${event} listener failed`, e);
    }
  }
}
